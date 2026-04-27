const { createLogger, format, transports } = require("winston");

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable meta]";
  }
}

const isProd = process.env.NODE_ENV === "production";

const devFormat = format.printf(({ timestamp, level, message, ...meta }) => {
  const metaKeys = Object.keys(meta);
  const metaStr = metaKeys.length > 0 ? ` ${safeJsonStringify(meta)}` : "";
  return `${timestamp} ${level}: ${message}${metaStr}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    isProd ? format.json() : format.combine(format.colorize(), devFormat),
  ),
  transports: [new transports.Console()],
});

module.exports = logger;

