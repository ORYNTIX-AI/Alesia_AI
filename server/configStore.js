import fs from 'fs/promises';
import path from 'path';
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_WEB_PROVIDERS,
  DEFAULT_VOICE_MODEL,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
  SUPPORTED_VOICE_NAMES,
} from './defaultAppConfig.js';

const APP_CONFIG_PATH = process.env.APP_CONFIG_PATH || path.resolve(process.cwd(), '.runtime-data/app-config.json');

function templateUsesPreferredDomain(urlTemplate) {
  try {
    const candidate = new URL(String(urlTemplate || '').replace('{query}', 'test'));
    return candidate.hostname.endsWith('.by') || candidate.hostname.endsWith('.ru');
  } catch {
    return false;
  }
}

function sanitizeCharacter(rawCharacter, fallbackId) {
  const character = rawCharacter || {};
  const voiceName = String(character.voiceName || 'Aoede');

  return {
    id: String(character.id || fallbackId),
    displayName: String(character.displayName || 'Персонаж'),
    voiceModelId: String(character.voiceModelId || DEFAULT_VOICE_MODEL),
    systemPrompt: String(character.systemPrompt || DEFAULT_SYSTEM_PROMPT),
    voiceName: SUPPORTED_VOICE_NAMES.includes(voiceName) ? voiceName : 'Aoede',
    backgroundPreset: String(character.backgroundPreset || 'aurora'),
    greetingText: String(character.greetingText || DEFAULT_GREETING),
  };
}

function sanitizeWebProviders(webProviders) {
  const providers = webProviders || {};
  const sanitized = {};

  for (const [key, fallback] of Object.entries(DEFAULT_WEB_PROVIDERS)) {
    const value = providers[key] || {};
    const nextTemplate = String(value?.urlTemplate || fallback.urlTemplate || '');
    const useFallbackTemplate = !templateUsesPreferredDomain(nextTemplate)
      || key === 'search'
      || (key === 'news' && nextTemplate.includes('/search/'))
      || (key === 'currency' && nextTemplate.includes('search'))
      || (key === 'wiki' && nextTemplate.includes('/w/index.php'))
      || (key === 'news' && nextTemplate !== fallback.urlTemplate)
      || (key === 'currency' && nextTemplate !== fallback.urlTemplate)
      || (key === 'wiki' && nextTemplate !== fallback.urlTemplate);

    sanitized[key] = {
      label: String(useFallbackTemplate ? fallback.label : (value?.label || fallback.label || key)),
      urlTemplate: String(useFallbackTemplate ? fallback.urlTemplate : nextTemplate),
    };
  }

  return sanitized;
}

export function sanitizeAppConfig(rawConfig) {
  const config = rawConfig || {};
  const characters = Array.isArray(config.characters) && config.characters.length > 0
    ? config.characters.map((character, index) => sanitizeCharacter(character, `character-${index + 1}`))
    : DEFAULT_APP_CONFIG.characters.map((character) => ({ ...character }));

  const activeCharacterId = characters.some((character) => character.id === config.activeCharacterId)
    ? config.activeCharacterId
    : characters[0].id;

  return {
    themeMode: config.themeMode === 'dark' ? 'dark' : 'light',
    activeCharacterId,
    characters,
    webProviders: sanitizeWebProviders(config.webProviders),
  };
}

async function ensureConfigFile() {
  await fs.mkdir(path.dirname(APP_CONFIG_PATH), { recursive: true });

  try {
    await fs.access(APP_CONFIG_PATH);
  } catch {
    const seeded = sanitizeAppConfig(DEFAULT_APP_CONFIG);
    await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');
  }
}

export async function loadAppConfig() {
  await ensureConfigFile();
  const raw = await fs.readFile(APP_CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const sanitized = sanitizeAppConfig(parsed);

  if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
    await saveAppConfig(sanitized);
  }

  return sanitized;
}

export async function saveAppConfig(nextConfig) {
  await ensureConfigFile();
  const sanitized = sanitizeAppConfig(nextConfig);
  await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  return sanitized;
}

export function getAppConfigPath() {
  return APP_CONFIG_PATH;
}
