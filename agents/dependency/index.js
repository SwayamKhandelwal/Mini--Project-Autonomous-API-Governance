require('dotenv').config();

const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery, initSchema } = require('../../shared/neo4j');

const SERVICE_NAME = 'dependency-agent';

/**
 * Build or update dependency edges between services in Neo4j
 */
async function mapDependency({ callerService, calleeService, endpoint, latencyMs }) {
  await runQuery(
    `MERGE (s1:Service {name: $caller})
     MERGE (s2:Service {name: $callee})
     MERGE (s1)-[r:CALLS]->(s2)
     ON CREATE SET r.callCount = 1, r.avgLatencyMs = $latency, r.firstSeen = $now
     ON MATCH SET r.callCount = r.callCount + 1,
                  r.avgLatencyMs = (r.avgLatencyMs * (r.callCount - 1) + $latency) / r.callCount,
                  r.lastSeen = $now`,
    {
      caller: callerService,
      callee: calleeService,
      latency: latencyMs || 0,
      now: new Date().toISOString(),
    }
  );

  logger.info(`Dependency mapped: ${callerService} -> ${calleeService}`, { service: SERVICE_NAME });
}

/**
 * Process API discovery events and infer inter-service dependencies
 * from service-to-service call patterns
 */
async function processDiscoveryEvent(producer, event) {
  const { serviceName, endpoints } = event;

  // Look for endpoints that reference other known services (heuristic approach)
  const records = await runQuery(`MATCH (s:Service) WHERE s.name <> $name RETURN s.name as name`, {
    name: serviceName,
  });
  const knownServices = records.map((r) => r.get('name'));

  for (const ep of endpoints) {
    for (const svc of knownServices) {
      if (ep.path.toLowerCase().includes(svc.toLowerCase())) {
        await mapDependency({
          callerService: serviceName,
          calleeService: svc,
          endpoint: ep.path,
          latencyMs: 0,
        });

        await publish(producer, TOPICS.DEPENDENCY_MAPPED, {
          callerService: serviceName,
          calleeService: svc,
          endpoint: ep.path,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

/**
 * Handle explicit dependency report from a service (via governance command)
 */
async function handleDependencyReport(producer, payload) {
  const { callerService, calleeService, endpoint, latencyMs } = payload;
  await mapDependency({ callerService, calleeService, endpoint, latencyMs });
  await publish(producer, TOPICS.DEPENDENCY_MAPPED, {
    callerService, calleeService, endpoint, latencyMs,
    timestamp: new Date().toISOString(),
  });
}

async function main() {
  logger.info('Starting Dependency Mapping Agent...', { service: SERVICE_NAME });

  await initSchema();

  const producer = await createProducer();
  const consumer = await createConsumer('dependency-agent-group');

  await consumer.subscribe({ topics: [TOPICS.API_DISCOVERED, TOPICS.GOVERNANCE_COMMAND], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());

        if (topic === TOPICS.API_DISCOVERED) {
          await processDiscoveryEvent(producer, payload);
        } else if (topic === TOPICS.GOVERNANCE_COMMAND && payload.command === 'REPORT_DEPENDENCY') {
          await handleDependencyReport(producer, payload.payload);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  logger.info('Dependency Mapping Agent is running', { service: SERVICE_NAME });
}

main().catch((err) => {
  logger.error('Dependency agent failed', { error: err.message });
  process.exit(1);
});
