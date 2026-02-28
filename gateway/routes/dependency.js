const express = require('express');
const router = express.Router();
const { runQuery } = require('../../shared/neo4j');
const logger = require('../../shared/logger');

// GET /api/dependency/graph - Full service dependency graph
router.get('/graph', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (s1:Service)-[r:CALLS]->(s2:Service)
      RETURN s1.name as source, s2.name as target, r.callCount as callCount, r.avgLatencyMs as avgLatencyMs
    `);
    const edges = records.map((r) => ({
      source: r.get('source'),
      target: r.get('target'),
      callCount: r.get('callCount'),
      avgLatencyMs: r.get('avgLatencyMs'),
    }));

    const nodeSet = new Set();
    edges.forEach((e) => { nodeSet.add(e.source); nodeSet.add(e.target); });

    res.json({
      nodes: Array.from(nodeSet).map((name) => ({ id: name, label: name })),
      edges,
    });
  } catch (err) {
    logger.error('Failed to fetch dependency graph', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dependency/orphans - Services with no dependencies
router.get('/orphans', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (s:Service)
      WHERE NOT (s)-[:CALLS]->() AND NOT ()-[:CALLS]->(s)
      RETURN s
    `);
    const orphans = records.map((r) => r.get('s').properties);
    res.json({ count: orphans.length, orphans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dependency/circular - Detect circular dependencies
router.get('/circular', async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH path = (s:Service)-[:CALLS*2..]->(s)
      RETURN [node IN nodes(path) | node.name] as cycle
      LIMIT 20
    `);
    const cycles = records.map((r) => r.get('cycle'));
    res.json({ count: cycles.length, cycles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
