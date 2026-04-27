require('dotenv').config();

const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery } = require('../../shared/neo4j');

const SERVICE_NAME = 'security-agent';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const securityChecks = [
  { id: 'NO_AUTH', severity: 'high', description: 'Endpoint accessible without authentication', check: ep => !ep.requiresAuth && ep.method !== 'GET' },
  { id: 'DEPRECATED_ENDPOINT', severity: 'medium', description: 'Deprecated endpoint still active', check: ep => ep.deprecated === true },
  { id: 'DELETE_WITHOUT_AUTH', severity: 'critical', description: 'DELETE endpoint without authentication', check: ep => ep.method === 'DELETE' && !ep.requiresAuth },
  { id: 'HIGH_ERROR_RATE', severity: 'high', description: 'Endpoint error rate > 10%', check: ep => ep.errorRate > 0.1 },
];

async function analyzeEndpoint(producer, endpoint) {
  for (const rule of securityChecks) {
    if (rule.check(endpoint)) {
      const alert = {
        id: uuidv4(), ruleId: rule.id, severity: rule.severity,
        description: rule.description,
        endpoint: `${endpoint.method} ${endpoint.path}`,
        serviceName: endpoint.serviceName,
        resolved: false, detectedAt: new Date().toISOString(),
      };
      await runQuery(
        `MERGE (a:API {path: $path, method: $method, serviceName: $serviceName})
         CREATE (alert:SecurityAlert $props) MERGE (alert)-[:AFFECTS]->(a)`,
        { path: endpoint.path, method: endpoint.method, serviceName: endpoint.serviceName, props: alert }
      );
      await publish(producer, TOPICS.SECURITY_ALERT, alert);
    }
  }
}

async function runFullScan(producer) {
  const records = await runQuery('MATCH (a:API) RETURN a');
  for (const r of records) await analyzeEndpoint(producer, r.get('a').properties);
  logger.info('Security scan complete', { service: SERVICE_NAME });
}

async function main() {
  logger.info('Starting Security Analysis Agent...', { service: SERVICE_NAME });

  let producer, consumer;
  while (true) {
    try {
      producer = await createProducer();
      consumer = await createConsumer('security-agent-group');
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
        if (topic === TOPICS.API_DISCOVERED) {
          for (const ep of payload.endpoints || []) await analyzeEndpoint(producer, { ...ep, serviceName: payload.serviceName });
        } else if (topic === TOPICS.GOVERNANCE_COMMAND && payload.command === 'RUN_SECURITY_SCAN') {
          await runFullScan(producer);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  setInterval(() => runFullScan(producer), parseInt(process.env.SECURITY_SCAN_INTERVAL_MS || '300000'));
  logger.info('Security Analysis Agent is running', { service: SERVICE_NAME });
}

main().catch(err => { logger.error('Security agent failed', { error: err.message }); process.exit(1); });
