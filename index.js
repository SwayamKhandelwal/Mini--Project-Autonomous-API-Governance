const neo4j = require("neo4j-driver");
const logger = require("./shared/logger");

require("dotenv").config();

let driver;

function getDriver() {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER || "neo4j",
        process.env.NEO4J_PASSWORD || "password",
      ),
    );
    logger.info("Neo4j driver initialized");
  }
  return driver;
}

async function runQuery(cypher, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

// Only called by the gateway - agents skip this
async function initSchema() {
  // Run constraints one at a time, never in parallel
  const constraints = [
    `CREATE CONSTRAINT IF NOT EXISTS FOR (s:Service) REQUIRE s.id IS UNIQUE`,
    `CREATE CONSTRAINT IF NOT EXISTS FOR (a:API) REQUIRE a.id IS UNIQUE`,
    `CREATE INDEX IF NOT EXISTS FOR (a:API) ON (a.path)`,
    `CREATE INDEX IF NOT EXISTS FOR (s:Service) ON (s.name)`,
  ];

  for (const query of constraints) {
    await runQuery(query);
  }
  logger.info("Neo4j schema initialized");
}

async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
    logger.info("Neo4j driver closed");
  }
}

module.exports = { getDriver, runQuery, initSchema, closeDriver };
