const express = require('express');
const router = express.Router();
const { getDriver } = require('../../shared/neo4j');

router.get('/', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'project42-gateway',
    checks: {},
  };

  // Neo4j check
  try {
    const session = getDriver().session();
    await session.run('RETURN 1');
    await session.close();
    health.checks.neo4j = 'connected';
  } catch {
    health.checks.neo4j = 'disconnected';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

module.exports = router;
