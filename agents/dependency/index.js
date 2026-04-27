require('dotenv').config();

const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery } = require('../../shared/neo4j');

const SERVICE_NAME = 'dependency-agent';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mapDependency({ callerService, calleeService, latencyMs }) {
  await runQuery(
    `MERGE (s1:Service {name: $caller}) MERGE (s2:Service {name: $callee})
     MERGE (s1)-[r:CALLS]->(s2)
     ON CREATE SET r.callCount = 1, r.avgLatencyMs = $latency, r.firstSeen = $now
     ON MATCH SET r.callCount = r.callCount + 1, r.lastSeen = $now`,
    { caller: callerService, callee: calleeService, latency: latencyMs || 0, now: new Date().toISOString() }
  );
}

async function processDiscoveryEvent(producer, event) {
  const { serviceName, endpoints } = event;
  const records = await runQuery('MATCH (s:Service) WHERE s.name <> $name RETURN s.name as name', { name: serviceName });
  const knownServices = records.map(r => r.get('name'));
  for (const ep of endpoints) {
    for (const svc of knownServices) {
      if (ep.path.toLowerCase().includes(svc.toLowerCase())) {
        await mapDependency({ callerService: serviceName, calleeService: svc, latencyMs: 0 });
        await publish(producer, TOPICS.DEPENDENCY_MAPPED, { callerService: serviceName, calleeService: svc, timestamp: new Date().toISOString() });
      }
    }
  }
}

async function main() {
  logger.info('Starting Dependency Mapping Agent...', { service: SERVICE_NAME });

  let producer, consumer;
  while (true) {
    try {
      producer = await createProducer();
      consumer = await createConsumer('dependency-agent-group');
      await consumer.subscribe({ topics: [TOPICS.API_DISCOVERED, TOPICS.GOVERNANCE_COMMAND], fromBeginning: false });
      break;
    } catch (err) {
      logger.warn('Kafka not ready, retrying in 10s...', { service: SERVICE_NAME });
      await sleep(10000);
    }
  }

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        if (topic === TOPICS.API_DISCOVERED) await processDiscoveryEvent(producer, payload);
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  logger.info('Dependency Mapping Agent is running', { service: SERVICE_NAME });
}

main().catch(err => { logger.error('Dependency agent failed', { error: err.message }); process.exit(1); });
