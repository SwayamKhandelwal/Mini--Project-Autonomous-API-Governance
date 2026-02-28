const express = require('express');
const router = express.Router();
const { runQuery } = require('../../shared/neo4j');

// GET /api/performance/bottlenecks
router.get('/bottlenecks', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (a:API)
      WHERE a.avgLatencyMs > 500 OR a.errorRate > 0.05
      RETURN a ORDER BY a.avgLatencyMs DESC LIMIT 20
    `);
    const bottlenecks = records.map((r) => r.get('a').properties);
    res.json({ count: bottlenecks.length, bottlenecks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/performance/unused - APIs with no recent traffic
router.get('/unused', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    const records = await runQuery(
      `MATCH (a:API) WHERE a.lastCalledAt < $cutoff OR a.lastCalledAt IS NULL RETURN a`,
      { cutoff }
    );
    const unused = records.map((r) => r.get('a').properties);
    res.json({ count: unused.length, unused });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
