const express = require('express');
const router = express.Router();
const { runQuery } = require('../../shared/neo4j');
const logger = require('../../shared/logger');

// GET /api/security/alerts - All security alerts
router.get('/alerts', async (req, res) => {
  try {
    const { severity, resolved } = req.query;
    let cypher = `MATCH (a:SecurityAlert) WHERE 1=1`;
    const params = {};

    if (severity) {
      cypher += ` AND a.severity = $severity`;
      params.severity = severity;
    }
    if (resolved !== undefined) {
      cypher += ` AND a.resolved = $resolved`;
      params.resolved = resolved === 'true';
    }

    cypher += ` RETURN a ORDER BY a.detectedAt DESC LIMIT 100`;
    const records = await runQuery(cypher, params);
    const alerts = records.map((r) => r.get('a').properties);
    res.json({ count: alerts.length, alerts });
  } catch (err) {
    logger.error('Failed to fetch security alerts', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/security/alerts/:id/resolve - Mark alert as resolved
router.patch('/alerts/:id/resolve', async (req, res) => {
  try {
    await runQuery(
      `MATCH (a:SecurityAlert {id: $id}) SET a.resolved = true, a.resolvedAt = $now`,
      { id: req.params.id, now: new Date().toISOString() }
    );
    res.json({ message: 'Alert marked as resolved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/security/summary - Security summary by severity
router.get('/summary', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (a:SecurityAlert)
      RETURN a.severity as severity, count(a) as count, 
             sum(CASE WHEN a.resolved THEN 1 ELSE 0 END) as resolved
      ORDER BY count DESC
    `);
    const summary = records.map((r) => ({
      severity: r.get('severity'),
      total: r.get('count').toNumber(),
      resolved: r.get('resolved').toNumber(),
    }));
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
