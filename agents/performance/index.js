require('dotenv').config();

const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { createConsumer, createProducer, publish, TOPICS } = require('../../shared/kafka');
const { runQuery } = require('../../shared/neo4j');

const SERVICE_NAME = 'performance-agent';

const THRESHOLDS = {
  LATENCY_WARNING_MS: 500,
  LATENCY_CRITICAL_MS: 2000,
  ERROR_RATE_WARNING: 0.05,
  ERROR_RATE_CRITICAL: 0.15,
  THROUGHPUT_MIN_RPS: 0.01, // below this = effectively unused
};

/**
 * Ingest a performance metric data point for an API endpoint
 */
async function ingestMetric({ serviceName, path, method, latencyMs, statusCode }) {
  const isError = statusCode >= 400;
  const now = new Date().toISOString();

  await runQuery(
    `MATCH (a:API {path: $path, method: $method, serviceName: $serviceName})
     SET a.lastCalledAt = $now,
         a.totalCalls = coalesce(a.totalCalls, 0) + 1,
         a.totalErrors = coalesce(a.totalErrors, 0) + $errorIncrement,
         a.avgLatencyMs = (coalesce(a.avgLatencyMs, 0) * coalesce(a.totalCalls - 1, 0) + $latency) / coalesce(a.totalCalls, 1),
         a.errorRate = toFloat(coalesce(a.totalErrors, 0)) / toFloat(coalesce(a.totalCalls, 1))`,
    {
      path, method, serviceName,
      latency: latencyMs,
      errorIncrement: isError ? 1 : 0,
      now,
    }
  );
}

/**
 * Detect performance issues and publish alerts
 */
async function detectBottlenecks(producer) {
  // High latency endpoints
  const latencyRecords = await runQuery(`
    MATCH (a:API)
    WHERE a.avgLatencyMs > $threshold
    RETURN a
    ORDER BY a.avgLatencyMs DESC LIMIT 20
  `, { threshold: THRESHOLDS.LATENCY_WARNING_MS });

  for (const r of latencyRecords) {
    const ep = r.get('a').properties;
    const severity = ep.avgLatencyMs > THRESHOLDS.LATENCY_CRITICAL_MS ? 'critical' : 'warning';

    await publish(producer, TOPICS.PERFORMANCE_ISSUE, {
      id: uuidv4(),
      type: 'HIGH_LATENCY',
      severity,
      serviceName: ep.serviceName,
      endpoint: `${ep.method} ${ep.path}`,
      avgLatencyMs: ep.avgLatencyMs,
      timestamp: new Date().toISOString(),
    });

    logger.warn(`[PERF] High latency: ${ep.method} ${ep.path} - ${ep.avgLatencyMs}ms`, { service: SERVICE_NAME });
  }

  // High error rate endpoints
  const errorRecords = await runQuery(`
    MATCH (a:API)
    WHERE a.errorRate > $threshold AND a.totalCalls > 10
    RETURN a
    ORDER BY a.errorRate DESC LIMIT 20
  `, { threshold: THRESHOLDS.ERROR_RATE_WARNING });

  for (const r of errorRecords) {
    const ep = r.get('a').properties;
    await publish(producer, TOPICS.PERFORMANCE_ISSUE, {
      id: uuidv4(),
      type: 'HIGH_ERROR_RATE',
      severity: ep.errorRate > THRESHOLDS.ERROR_RATE_CRITICAL ? 'critical' : 'warning',
      serviceName: ep.serviceName,
      endpoint: `${ep.method} ${ep.path}`,
      errorRate: ep.errorRate,
      timestamp: new Date().toISOString(),
    });
  }

  logger.info('Bottleneck detection complete', { service: SERVICE_NAME });
}

async function main() {
  logger.info('Starting Performance Agent...', { service: SERVICE_NAME });

  

  const producer = await createProducer();
  const consumer = await createConsumer('performance-agent-group');

  await consumer.subscribe({ topic: TOPICS.GOVERNANCE_COMMAND, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const { command, payload } = JSON.parse(message.value.toString());

        if (command === 'INGEST_METRIC') {
          await ingestMetric(payload);
        } else if (command === 'RUN_PERF_ANALYSIS') {
          await detectBottlenecks(producer);
        }
      } catch (err) {
        logger.error('Error processing message', { error: err.message, service: SERVICE_NAME });
      }
    },
  });

  // Scheduled bottleneck detection every 2 minutes
  setInterval(() => detectBottlenecks(producer), 120000);

  logger.info('Performance Agent is running', { service: SERVICE_NAME });
}

main().catch((err) => {
  logger.error('Performance agent failed', { error: err.message });
  process.exit(1);
});
