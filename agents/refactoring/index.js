require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery, initSchema } = require('../../shared/neo4j');

const SERVICE_NAME = 'refactoring-agent';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/**
 * Gather full architecture context for LLM analysis
 */
async function gatherArchitectureContext() {
  const [serviceRecords, apiRecords, securityRecords, perfRecords, depRecords] = await Promise.all([
    runQuery(`MATCH (s:Service) RETURN s`),
    runQuery(`MATCH (a:API) RETURN a LIMIT 100`),
    runQuery(`MATCH (a:SecurityAlert) WHERE a.resolved = false RETURN a LIMIT 50`),
    runQuery(`MATCH (a:API) WHERE a.avgLatencyMs > 500 OR a.errorRate > 0.05 RETURN a LIMIT 20`),
    runQuery(`MATCH (s1:Service)-[r:CALLS]->(s2:Service) RETURN s1.name as from, s2.name as to, r`),
  ]);

  return {
    services: serviceRecords.map((r) => r.get('s').properties),
    apis: apiRecords.map((r) => r.get('a').properties),
    unresolvedAlerts: securityRecords.map((r) => r.get('a').properties),
    problematicEndpoints: perfRecords.map((r) => r.get('a').properties),
    dependencies: depRecords.map((r) => ({
      from: r.get('from'),
      to: r.get('to'),
      ...r.get('r').properties,
    })),
  };
}

/**
 * Use LLM to analyze architecture and generate refactoring suggestions
 */
async function generateSuggestions(producer, context) {
  logger.info('Running LLM architecture analysis...', { service: SERVICE_NAME });

  const prompt = `You are an expert software architect analyzing a microservice system.

SYSTEM OVERVIEW:
- Services: ${context.services.map((s) => s.name).join(', ')}
- Total APIs discovered: ${context.apis.length}
- Unresolved security alerts: ${context.unresolvedAlerts.length}
- Problematic endpoints (high latency/error rate): ${context.problematicEndpoints.length}

SERVICE DEPENDENCIES:
${context.dependencies.map((d) => `${d.from} -> ${d.to} (calls: ${d.callCount}, avgLatency: ${d.avgLatencyMs}ms)`).join('\n') || 'None mapped yet'}

TOP SECURITY ISSUES:
${context.unresolvedAlerts.slice(0, 5).map((a) => `[${a.severity}] ${a.ruleId}: ${a.endpoint}`).join('\n') || 'None'}

PERFORMANCE BOTTLENECKS:
${context.problematicEndpoints.map((e) => `${e.method} ${e.path} - latency: ${e.avgLatencyMs}ms, errorRate: ${(e.errorRate * 100).toFixed(1)}%`).join('\n') || 'None'}

Based on this data, provide exactly 3 architectural refactoring suggestions in this JSON format:
[
  {
    "title": "Short suggestion title",
    "category": "security|performance|architecture|cleanup",
    "priority": "high|medium|low",
    "description": "Detailed explanation of the issue and recommendation",
    "affectedServices": ["service1", "service2"],
    "estimatedImpact": "Description of expected improvement"
  }
]

Return ONLY valid JSON, no markdown.`;

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    });

    const raw = result.response.text().trim().replace(/```json|```/g, '');
    const suggestions = JSON.parse(raw);

    for (const suggestion of suggestions) {
      const doc = {
        id: uuidv4(),
        ...suggestion,
        affectedServices: suggestion.affectedServices.join(','),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      // Store in Neo4j
      await runQuery(`CREATE (s:RefactorSuggestion $props)`, { props: doc });

      // Publish to Kafka
      await publish(producer, TOPICS.REFACTOR_SUGGESTION, doc);

      logger.info(`Refactoring suggestion generated: ${doc.title}`, { service: SERVICE_NAME });
    }
  } catch (err) {
    logger.error('LLM analysis failed', { error: err.message, service: SERVICE_NAME });
  }
}

async function main() {
  logger.info('Starting Refactoring Agent...', { service: SERVICE_NAME });

  await initSchema();

  const producer = await createProducer();
  const consumer = await createConsumer('refactoring-agent-group');

  await consumer.subscribe({
    topics: [TOPICS.SECURITY_ALERT, TOPICS.PERFORMANCE_ISSUE, TOPICS.GOVERNANCE_COMMAND],
    fromBeginning: false,
  });

  let pendingTrigger = false;

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());

        // Trigger analysis on critical events or explicit command
        const isCriticalAlert =
          (topic === TOPICS.SECURITY_ALERT && payload.severity === 'critical') ||
          (topic === TOPICS.PERFORMANCE_ISSUE && payload.severity === 'critical');
        const isCommand = topic === TOPICS.GOVERNANCE_COMMAND && payload.command === 'RUN_REFACTOR_ANALYSIS';

        if ((isCriticalAlert && !pendingTrigger) || isCommand) {
          pendingTrigger = true;
          // Debounce: wait 10s before triggering to batch events
          setTimeout(async () => {
            const context = await gatherArchitectureContext();
            await generateSuggestions(producer, context);
            pendingTrigger = false;
          }, 10000);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  // Scheduled full analysis every 6 hours
  setInterval(async () => {
    const context = await gatherArchitectureContext();
    await generateSuggestions(producer, context);
  }, 6 * 60 * 60 * 1000);

  logger.info('Refactoring Agent is running', { service: SERVICE_NAME });
}

main().catch((err) => {
  logger.error('Refactoring agent failed', { error: err.message });
  process.exit(1);
});
