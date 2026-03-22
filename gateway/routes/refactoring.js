const express = require("express");
const router = express.Router();
const { runQuery } = require("../../shared/neo4j");
const { createProducer, publish, TOPICS } = require("../../shared/kafka");
const logger = require("../../shared/logger");

// GET /api/refactoring/suggestions
router.get("/suggestions", async (req, res) => {
  try {
    const records = await runQuery(`
      MATCH (s:RefactorSuggestion)
      RETURN s ORDER BY s.createdAt DESC LIMIT 50
    `);
    const suggestions = records.map((r) => r.get("s").properties);
    res.json({ count: suggestions.length, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/refactoring/trigger - Manually trigger Gemini analysis
router.post("/trigger", async (req, res) => {
  try {
    const producer = await createProducer();
    await publish(producer, TOPICS.GOVERNANCE_COMMAND, {
      command: "RUN_REFACTOR_ANALYSIS",
      timestamp: new Date().toISOString(),
    });
    await producer.disconnect();
    logger.info("Refactor analysis triggered manually", {
      service: "refactoring-route",
    });
    res.json({
      message:
        "Refactor analysis triggered. Check /api/refactoring/suggestions in 15 seconds.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/refactoring/suggestions/:id/status
router.patch("/suggestions/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["accepted", "dismissed"].includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be accepted or dismissed" });
  }
  try {
    await runQuery(
      `MATCH (s:RefactorSuggestion {id: $id}) SET s.status = $status, s.updatedAt = $now`,
      { id: req.params.id, status, now: new Date().toISOString() },
    );
    res.json({ message: `Suggestion ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
