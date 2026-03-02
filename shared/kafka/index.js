const { Kafka, logLevel } = require('kafkajs');
const logger = require('../logger');

require('dotenv').config();

// Kafka Topics
const TOPICS = {
  API_DISCOVERED: 'api.discovered',
  DEPENDENCY_MAPPED: 'dependency.mapped',
  SECURITY_ALERT: 'security.alert',
  PERFORMANCE_ISSUE: 'performance.issue',
  REFACTOR_SUGGESTION: 'refactor.suggestion',
  GOVERNANCE_COMMAND: 'governance.command',
};

// Kafka client singleton
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'project42-governance',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
});

/**
 * Create and connect a Kafka producer
 */
async function createProducer() {
  const producer = kafka.producer();
  await producer.connect();
  logger.info('Kafka producer connected');
  return producer;
}

/**
 * Create and connect a Kafka consumer
 * @param {string} groupId - Consumer group ID
 */
async function createConsumer(groupId) {
  const consumer = kafka.consumer({
    groupId: groupId || process.env.KAFKA_GROUP_ID || 'governance-group',
  });
  await consumer.connect();
  logger.info(`Kafka consumer connected [group: ${groupId}]`);
  return consumer;
}

/**
 * Create all required Kafka topics (run once on init)
 */
async function createTopics() {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  const toCreate = Object.values(TOPICS)
    .filter((t) => !existing.includes(t))
    .map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 }));

  if (toCreate.length > 0) {
    await admin.createTopics({ topics: toCreate });
    logger.info(`Created Kafka topics: ${toCreate.map((t) => t.topic).join(', ')}`);
  } else {
    logger.info('All Kafka topics already exist');
  }
  await admin.disconnect();
}

/**
 * Helper to publish a message to a topic
 */
async function publish(producer, topic, payload) {
  await producer.send({
    topic,
    messages: [{ value: JSON.stringify(payload) }],
  });
}

module.exports = { kafka, TOPICS, createProducer, createConsumer, createTopics, publish };
