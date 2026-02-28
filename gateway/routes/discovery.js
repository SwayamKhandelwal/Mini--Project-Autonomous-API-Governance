const express = require('express');
const router = express.Router();
const { runQuery } = require('../../shared/neo4j');
const { createProducer, publish, TOPICS } = require('../../shared/kafka');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');

// GET /api/discovery/apis - List all discovered APIs
router.get('/apis', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (a:API)-[:BELONGS_TO]->(s:Service)
      RETURN a, s.name as serviceName
      ORDER BY a.discoveredAt DESC
    `);
    const apis = records.map((r) => ({
      ...r.get('a').properties,
      serviceName: r.get('serviceName'),
    }));
    res.json({ count: apis.length, apis });
  } catch (err) {
    logger.error('Failed to fetch APIs', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discovery/register - Manually register a service for discovery
router.post('/register', async (req, res) => {
  const { serviceName, baseUrl, environment = 'production' } = req.body;
  if (!serviceName || !baseUrl) {
    return res.status(400).json({ error: 'serviceName and baseUrl are required' });
  }

  try {
    const serviceId = uuidv4();
    await runQuery(
      `MERGE (s:Service {name: $name})
       ON CREATE SET s.id = $id, s.baseUrl = $baseUrl, s.environment = $environment, s.registeredAt = $now
       ON MATCH SET s.baseUrl = $baseUrl, s.lastSeen = $now`,
      { id: serviceId, name: serviceName, baseUrl, environment, now: new Date().toISOString() }
    );

    // Emit discovery command to Kafka
    const producer = await createProducer();
    await publish(producer, TOPICS.GOVERNANCE_COMMAND, {
      command: 'SCAN_SERVICE',
      payload: { serviceName, baseUrl, environment },
      timestamp: new Date().toISOString(),
    });
    await producer.disconnect();

    logger.info(`Service registered: ${serviceName}`, { service: 'discovery-route' });
    res.status(201).json({ message: `Service '${serviceName}' registered and queued for scanning` });
  } catch (err) {
    logger.error('Failed to register service', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
