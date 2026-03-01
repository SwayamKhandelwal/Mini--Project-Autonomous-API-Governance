require('dotenv').config();

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery, initSchema } = require('../../shared/neo4j');

const SERVICE_NAME = 'security-agent';

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/**
 * Security checks on an API endpoint
 */
const securityChecks = [
  {
    id: 'NO_AUTH',
    description: 'Endpoint is publicly accessible without authentication',
    severity: SEVERITY.HIGH,
    check: (endpoint) => !endpoint.requiresAuth && endpoint.method !== 'GET',
  },
  {
    id: 'DEPRECATED_ENDPOINT',
    description: 'Deprecated endpoint still in use',
    severity: SEVERITY.MEDIUM,
    check: (endpoint) => endpoint.deprecated === true,
  },
  {
    id: 'UNUSED_ENDPOINT',
    description: 'Endpoint has not been called in over 30 days — potential dead code with exposure',
    severity: SEVERITY.LOW,
    check: (endpoint) => {
      if (!endpoint.lastCalledAt) return true;
      const daysSince = (Date.now() - new Date(endpoint.lastCalledAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 30;
    },
  },
  {
    id: 'HIGH_ERROR_RATE',
    description: 'Endpoint has error rate > 10%, may be broken or misconfigured',
    severity: SEVERITY.HIGH,
    check: (endpoint) => endpoint.errorRate > 0.1,
  },
  {
    id: 'DELETE_WITHOUT_AUTH',
    description: 'DELETE endpoint without authentication is critically dangerous',
    severity: SEVERITY.CRITICAL,
    check: (endpoint) => endpoint.method === 'DELETE' && !endpoint.requiresAuth,
  },
];

/**
 * Run all security checks against an endpoint and store alerts
 */
async function analyzeEndpoint(producer, endpoint) {
  for (const rule of securityChecks) {
    if (rule.check(endpoint)) {
      const alert = {
        id: uuidv4(),
        ruleId: rule.id,
        severity: rule.severity,
        description: rule.description,
        endpoint: `${endpoint.method} ${endpoint.path}`,
        serviceName: endpoint.serviceName,
        resolved: false,
        detectedAt: new Date().toISOString(),
      };

      // Store in Neo4j
      await runQuery(
        `MERGE (a:API {path: $path, method: $method, serviceName: $serviceName})
         CREATE (alert:SecurityAlert $props)
         MERGE (alert)-[:AFFECTS]->(a)`,
        {
          path: endpoint.path,
          method: endpoint.method,
          serviceName: endpoint.serviceName,
          props: alert,
        }
      );

      // Publish to Kafka
      await publish(producer, TOPICS.SECURITY_ALERT, alert);

      logger.warn(`[${rule.severity.toUpperCase()}] ${rule.id}: ${endpoint.method} ${endpoint.path} (${endpoint.serviceName})`, {
        service: SERVICE_NAME,
      });
    }
  }
}

/**
 * Run security analysis on all known endpoints
 */
async function runFullSecurityScan(producer) {
  logger.info('Running full security scan...', { service: SERVICE_NAME });
  const records = await runQuery(`MATCH (a:API) RETURN a`);
  let count = 0;

  for (const r of records) {
    await analyzeEndpoint(producer, r.get('a').properties);
    count++;
  }

  logger.info(`Security scan complete: ${count} endpoints analyzed`, { service: SERVICE_NAME });
}

async function main() {
  logger.info('Starting Security Analysis Agent...', { service: SERVICE_NAME });

  await initSchema();

  const producer = await createProducer();
  const consumer = await createConsumer('security-agent-group');

  await consumer.subscribe({ topics: [TOPICS.API_DISCOVERED, TOPICS.GOVERNANCE_COMMAND], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());

        if (topic === TOPICS.API_DISCOVERED) {
          // Scan newly discovered endpoints
          for (const ep of payload.endpoints || []) {
            await analyzeEndpoint(producer, { ...ep, serviceName: payload.serviceName });
          }
        } else if (topic === TOPICS.GOVERNANCE_COMMAND && payload.command === 'RUN_SECURITY_SCAN') {
          await runFullSecurityScan(producer);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  // Scheduled full security scans
  setInterval(() => runFullSecurityScan(producer), parseInt(process.env.SECURITY_SCAN_INTERVAL_MS || '300000'));

  logger.info('Security Analysis Agent is running', { service: SERVICE_NAME });
}

main().catch((err) => {
  logger.error('Security agent failed', { error: err.message });
  process.exit(1);
});
