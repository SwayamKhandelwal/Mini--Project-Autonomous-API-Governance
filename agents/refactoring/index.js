require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery } = require('../../shared/neo4j');

const SERVICE_NAME = 'refactoring-agent';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gatherArchitectureContext() {
  const [serviceRecords, apiRecords, securityRecords, perfRecords] = await Promise.all([
    runQuery('MATCH (s:Service) RETURN s'),
    runQuery('MATCH (a:API) RETURN a LIMIT 100'),
    runQuery('MATCH (a:SecurityAlert) WHERE a.resolved = false RETURN a LIMIT 50'),
    runQuery('MATCH (a:API) WHERE a.avgLatencyMs > 500 RETURN a LIMIT 20'),
  ]);
  return {
    services: serviceRecords.map(r => r.get('s').properties),
    apis: apiRecords.map(r => r.get('a').properties),
    unresolvedAlerts: securityRecords.map(r => r.get('a').properties),
    problematicEndpoints: perfRecords.map(r => r.get('a').properties),
  };
}

async function generateSuggestions(producer, context) {
  logger.info('Running LLM architecture analysis...', { service: SERVICE_NAME });
  const serviceNames = context.services.map(s => s.name).join(', ') || 'none';
  const prompt = `You are a software architect. Return ONLY a JSON array with no markdown or extra text.
System: services=[${serviceNames}], apis=${context.apis.length}, security_alerts=${context.unresolvedAlerts.length}, perf_issues=${context.problematicEndpoints.length}
Return a JSON array of exactly 3 objects. Each object must have: title(max 5 words), category(security/performance/architecture/cleanup), priority(high/medium/low), description(max 20 words), affectedServices(array), estimatedImpact(max 10 words). No markdown. Only the array.`;

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    });
    let raw = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
    logger.info('Gemini raw response: ' + raw, { service: SERVICE_NAME });
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in Gemini response');
    const suggestions = JSON.parse(jsonMatch[0]);
    for (const suggestion of suggestions) {
      const doc = {
        id: uuidv4(), title: suggestion.title, category: suggestion.category,
        priority: suggestion.priority, description: suggestion.description,
        affectedServices: Array.isArray(suggestion.affectedServices) ? suggestion.affectedServices.join(',') : suggestion.affectedServices,
        estimatedImpact: suggestion.estimatedImpact, status: 'pending', createdAt: new Date().toISOString(),
      };
      await runQuery('CREATE (s:RefactorSuggestion $props)', { props: doc });
      await publish(producer, TOPICS.REFACTOR_SUGGESTION, doc);
      logger.info(`Suggestion generated: ${doc.title}`, { service: SERVICE_NAME });
    }
  } catch (err) {
    logger.error('LLM analysis failed', { error: err.message, service: SERVICE_NAME });
  }
}

async function main() {
  logger.info('Starting Refactoring Agent...', { service: SERVICE_NAME });

  let producer, consumer;
  while (true) {
    try {
      producer = await createProducer();
      consumer = await createConsumer('refactoring-agent-group');
      await consumer.subscribe({ topics: [TOPICS.SECURITY_ALERT, TOPICS.PERFORMANCE_ISSUE, TOPICS.GOVERNANCE_COMMAND], fromBeginning: false });
      break;
    } catch (err) {
      logger.warn('Kafka not ready, retrying in 10s...', { service: SERVICE_NAME });
      await sleep(10000);
    }
  }

  let pendingTrigger = false;
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        const isCritical = (topic === TOPICS.SECURITY_ALERT && payload.severity === 'critical') || (topic === TOPICS.PERFORMANCE_ISSUE && payload.severity === 'critical');
        const isCommand = topic === TOPICS.GOVERNANCE_COMMAND && payload.command === 'RUN_REFACTOR_ANALYSIS';
        if ((isCritical && !pendingTrigger) || isCommand) {
          pendingTrigger = true;
          setTimeout(async () => { const context = await gatherArchitectureContext(); await generateSuggestions(producer, context); pendingTrigger = false; }, 5000);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  setInterval(async () => { const context = await gatherArchitectureContext(); await generateSuggestions(producer, context); }, 6 * 60 * 60 * 1000);
  logger.info('Refactoring Agent is running', { service: SERVICE_NAME });
}

main().catch(err => { logger.error('Refactoring agent failed', { error: err.message }); process.exit(1); });
