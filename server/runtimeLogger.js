import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_APP_CONFIG_PATH } from './runtimePaths.js';

const defaultConfigPath = DEFAULT_APP_CONFIG_PATH;
const runtimeLogPath = process.env.RUNTIME_LOG_PATH || path.resolve(path.dirname(defaultConfigPath), 'runtime.log');

let writeQueue = Promise.resolve();

function normalizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return details;
  }

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (value instanceof Error) {
        return [key, {
          name: value.name,
          message: value.message,
          stack: value.stack,
        }];
      }
      return [key, value];
    }),
  );
}

export function getRuntimeLogPath() {
  return runtimeLogPath;
}

export function logRuntime(event, details = {}, level = 'info') {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    details: normalizeDetails(details),
  };
  const line = `${JSON.stringify(entry)}\n`;
  const writer = level === 'error' ? console.error : console.log;
  writer(`[runtime] ${event}`, JSON.stringify(entry.details || {}));

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(path.dirname(runtimeLogPath), { recursive: true });
      await fs.appendFile(runtimeLogPath, line, 'utf8');
    })
    .catch(() => {});
}
