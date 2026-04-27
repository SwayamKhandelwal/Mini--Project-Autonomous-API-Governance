require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const client = require('prom-client');

const logger = require('../shared/logger');
const { createTopics } = require('../shared/kafka');
const { initSchema } = require('../shared/neo4j');

// Route imports
const discoveryRoutes = require('./routes/discovery');
const dependencyRoutes = require('./routes/dependency');
const securityRoutes = require('./routes/security');
const performanceRoutes = require('./routes/performance');
const refactoringRoutes = require('./routes/refactoring');
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Prometheus Metrics ────────────────────────────────────────────────────
client.collectDefaultMetrics({ prefix: 'project42_' });

const httpRequestDuration = new client.Histogram({
  name: 'project42_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
});

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.path, status: res.statusCode });
    logger.info(`${req.method} ${req.path} - ${res.statusCode}`, { service: 'gateway' });
  });
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─── Routes ───────────────────────────────────────────────────────────────
app.use('/api/discovery', discoveryRoutes);
app.use('/api/dependency', dependencyRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/refactoring', refactoringRoutes);
app.use('/health', healthRoutes);

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ─── Global Error Handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, service: 'gateway' });
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bootstrap() {
  try {
    logger.info('Initializing Project42 Gateway...', { service: 'gateway' });

    // Retry Kafka until ready
    while (true) {
      try {
        await createTopics();
        break;
      } catch (err) {
        logger.warn('Kafka not ready, retrying in 10s...', { service: 'gateway' });
        await sleep(10000);
      }
    }

    // Setup Neo4j schema
    await initSchema();

    app.listen(PORT, () => {
      logger.info(`Gateway running on http://localhost:${PORT}`, { service: 'gateway' });
      logger.info(`Metrics available at http://localhost:${PORT}/metrics`, { service: 'gateway' });
    });
  } catch (err) {
    logger.error('Failed to bootstrap gateway', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

bootstrap();

module.exports = app;
