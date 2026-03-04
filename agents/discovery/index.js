require('dotenv').config();

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery } = require('../../shared/neo4j');

const SERVICE_NAME = 'discovery-agent';

/**
 * Fetch OpenAPI/Swagger spec from a service and extract endpoints
 */
async function fetchOpenApiSpec(baseUrl) {
  const commonPaths = ['/openapi.json', '/swagger.json', '/api-docs', '/v3/api-docs'];
  for (const path of commonPaths) {
    try {
      const res = await axios.get(`${baseUrl}${path}`, { timeout: 5000 });
      if (res.data && res.data.paths) {
        return res.data;
      }
    } catch {
      // try next path
    }
  }
  return null;
}

/**
 * Parse OpenAPI spec and extract API endpoint objects
 */
function extractEndpoints(spec, serviceName, baseUrl) {
  const endpoints = [];
  const paths = spec.paths || {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method)) {
        endpoints.push({
          id: uuidv4(),
          path,
          method: method.toUpperCase(),
          serviceName,
          baseUrl,
          summary: details.summary || '',
          operationId: details.operationId || '',
          tags: (details.tags || []).join(','),
          deprecated: details.deprecated || false,
          requiresAuth: !!(details.security && details.security.length > 0),
          discoveredAt: new Date().toISOString(),
          lastCalledAt: null,
          avgLatencyMs: 0,
          errorRate: 0,
        });
      }
    }
  }
  return endpoints;
}

/**
 * Store discovered endpoints in Neo4j
 */
async function storeEndpoints(endpoints, serviceName) {
  for (const ep of endpoints) {
    await runQuery(
      `MERGE (s:Service {name: $serviceName})
       MERGE (a:API {path: $path, method: $method, serviceName: $serviceName})
       ON CREATE SET a += $props
       ON MATCH SET a.lastSeen = $now
       MERGE (a)-[:BELONGS_TO]->(s)`,
      {
        serviceName,
        path: ep.path,
        method: ep.method,
        props: ep,
        now: new Date().toISOString(),
      }
    );
  }
  logger.info(`Stored ${endpoints.length} endpoints for service: ${serviceName}`, { service: SERVICE_NAME });
}

/**
 * Main scan function for a service
 */
async function scanService(producer, { serviceName, baseUrl, environment }) {
  logger.info(`Scanning service: ${serviceName} @ ${baseUrl}`, { service: SERVICE_NAME });

  const spec = await fetchOpenApiSpec(baseUrl);
  if (!spec) {
    logger.warn(`No OpenAPI spec found for ${serviceName}`, { service: SERVICE_NAME });
    return;
  }

  const endpoints = extractEndpoints(spec, serviceName, baseUrl);
  await storeEndpoints(endpoints, serviceName);

  // Publish discovery events to Kafka for other agents
  await publish(producer, TOPICS.API_DISCOVERED, {
    serviceName,
    baseUrl,
    environment,
    endpointCount: endpoints.length,
    endpoints: endpoints.map((e) => ({ path: e.path, method: e.method, deprecated: e.deprecated })),
    timestamp: new Date().toISOString(),
  });

  logger.info(`Discovery complete for ${serviceName}: ${endpoints.length} endpoints found`, {
    service: SERVICE_NAME,
  });
}

/**
 * Bootstrap the discovery agent
 */
async function main() {
  logger.info('Starting API Discovery Agent...', { service: SERVICE_NAME });

  

  const producer = await createProducer();
  const consumer = await createConsumer('discovery-agent-group');

  await consumer.subscribe({ topic: TOPICS.GOVERNANCE_COMMAND, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const { command, payload } = JSON.parse(message.value.toString());
        if (command === 'SCAN_SERVICE') {
          await scanService(producer, payload);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  // Periodic re-scan of all registered services
  setInterval(async () => {
    logger.info('Running scheduled re-scan of all services...', { service: SERVICE_NAME });
    const records = await runQuery(`MATCH (s:Service) RETURN s`);
    for (const r of records) {
      const s = r.get('s').properties;
      await scanService(producer, { serviceName: s.name, baseUrl: s.baseUrl, environment: s.environment });
    }
  }, parseInt(process.env.SCAN_INTERVAL_MS || '60000'));

  logger.info('API Discovery Agent is running', { service: SERVICE_NAME });
}

main().catch((err) => {
  logger.error('Discovery agent failed', { error: err.message });
  process.exit(1);
});
