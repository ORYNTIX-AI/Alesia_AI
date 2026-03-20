import fs from 'fs';
import path from 'path';

const CWD = process.cwd();
const LEGACY_RUNTIME_DIR = path.resolve(CWD, '.runtime-data');
const DEFAULT_RUNTIME_DIR = path.resolve(CWD, 'runtime-data');

function hasAppConfigFile(dirPath) {
  if (!dirPath) {
    return false;
  }
  try {
    return fs.existsSync(path.join(dirPath, 'app-config.json'));
  } catch {
    return false;
  }
}

function hasRuntimeDir(dirPath) {
  if (!dirPath) {
    return false;
  }
  try {
    return fs.existsSync(dirPath);
  } catch {
    return false;
  }
}

function resolveRuntimeDataDir() {
  const configuredRuntimeDir = String(process.env.RUNTIME_DATA_DIR || '').trim();
  if (configuredRuntimeDir) {
    return path.resolve(configuredRuntimeDir);
  }

  if (hasAppConfigFile(DEFAULT_RUNTIME_DIR)) {
    return DEFAULT_RUNTIME_DIR;
  }
  if (hasAppConfigFile(LEGACY_RUNTIME_DIR)) {
    return LEGACY_RUNTIME_DIR;
  }

  if (hasRuntimeDir(DEFAULT_RUNTIME_DIR)) {
    return DEFAULT_RUNTIME_DIR;
  }
  if (hasRuntimeDir(LEGACY_RUNTIME_DIR)) {
    return LEGACY_RUNTIME_DIR;
  }

  return DEFAULT_RUNTIME_DIR;
}

export const RUNTIME_DATA_DIR = resolveRuntimeDataDir();
export const DEFAULT_APP_CONFIG_PATH = process.env.APP_CONFIG_PATH
  ? path.resolve(process.env.APP_CONFIG_PATH)
  : path.resolve(RUNTIME_DATA_DIR, 'app-config.json');
