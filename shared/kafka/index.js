const { Kafka, logLevel } = require('kafkajs');
const logger = require('../logger');

require('dotenv').config();

const TOPICS = {
  API_DISCOVERED: 'api.discovered',
  DEPENDENCY_MAPPED: 'dependency.mapped',
  SECURITY_ALERT: 'security.alert',
  PERFORMANCE_ISSUE: 'performance.issue',
  REFACTOR_SUGGESTION: 'refactor.suggestion',
  GOVERNANCE_COMMAND: 'governance.command',
};

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'project42-governance',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.ERROR,
  retry: {
    initialRetryTime: 5000,
    retries: 30,
    maxRetryTime: 60000,
    factor: 1.5,
  },
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createProducer() {
  const producer = kafka.producer();
  await producer.connect();
  logger.info('Kafka producer connected');
  return producer;
}

async function createConsumer(groupId) {
  const consumer = kafka.consumer({
    groupId: groupId || process.env.KAFKA_GROUP_ID || 'governance-group',
    retry: {
      initialRetryTime: 5000,
      retries: 30,
      maxRetryTime: 60000,
    },
  });
  await consumer.connect();
  logger.info(`Kafka consumer connected [group: ${groupId}]`);
  return consumer;
}

async function createTopics() {
  const admin = kafka.admin();
  await admin.connect();

  // Wait for Kafka leader election to complete
  await sleep(10000);

  const existing = await admin.listTopics();
  const toCreate = Object.values(TOPICS)
    .filter(t => !existing.includes(t))
    .map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 }));

  if (toCreate.length > 0) {
    await admin.createTopics({ topics: toCreate, waitForLeaders: true });
    logger.info(`Created Kafka topics: ${toCreate.map(t => t.topic).join(', ')}`);
  } else {
    logger.info('All Kafka topics already exist');
  }

  // Extra wait after topic creation for leader election
  await sleep(5000);
  await admin.disconnect();
}

async function publish(producer, topic, payload) {
  await producer.send({
    topic,
    messages: [{ value: JSON.stringify(payload) }],
  });
}

module.exports = { kafka, TOPICS, createProducer, createConsumer, createTopics, publish };