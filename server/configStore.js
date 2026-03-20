import fs from 'fs/promises';
import path from 'path';
import {
  BATYUSHKA_AVATAR_MODEL_URL,
  BATYUSHKA_GREETING,
  BATYUSHKA_SYSTEM_PROMPT,
  DEFAULT_APP_CONFIG,
  DEFAULT_AVATAR_MODEL_URL,
  DEFAULT_KNOWLEDGE_REFRESH_POLICY,
  DEFAULT_KNOWLEDGE_SOURCES,
  DEFAULT_WEB_PROVIDERS,
  DEFAULT_VOICE_MODEL,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_PRAYER_READ_MODE,
  DEFAULT_SAFETY_SWITCHES,
  DEFAULT_SPEECH_STABILITY_PROFILE,
  SUPPORTED_PRAYER_READ_MODES,
  SUPPORTED_SPEECH_STABILITY_PROFILES,
  SUPPORTED_VOICE_NAMES,
} from './defaultAppConfig.js';
import { DEFAULT_APP_CONFIG_PATH } from './runtimePaths.js';

const APP_CONFIG_PATH = DEFAULT_APP_CONFIG_PATH;
const LEGACY_VOICE_MODELS = new Set([
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
]);

const REMOTE_ALESYA_AVATAR_ID = '6940682e5917bffe25eb75ed';
const REMOTE_BATYUSHKA_AVATAR_ID = '69ae9e904d98c76821037766';

const LEGACY_SOURCE_URL_REMAP = new Map([
  ['https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash/', 'https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash.html'],
  ['https://www.pravmir.ru/otche-nash/', 'https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash.html'],
  ['https://www.pravmir.ru/otche-nash-ili-otche-moj-ili-o-vazhnejshej-utrate-prixozhan-i-zaxozhan-1/', 'https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash.html'],
  ['https://azbyka.ru/molitvoslov/bogorodice-devo-radujsya/', 'https://www.pravmir.ru/bogorodice-devo-radujsya/'],
  ['https://arfox.by/faq/', 'https://arfox.by/'],
  ['https://arfox.by/faq', 'https://arfox.by/'],
]);
const CONFIG_SNAPSHOT_DIR = process.env.APP_CONFIG_SNAPSHOT_DIR || path.resolve(path.dirname(APP_CONFIG_PATH), 'safety-snapshots');
const MAX_CONFIG_SNAPSHOTS = 40;
const BATYUSHKA_CHARACTER_ID = 'alesya-puck';

function normalizeVoiceModelId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || LEGACY_VOICE_MODELS.has(normalized)) {
    return DEFAULT_VOICE_MODEL;
  }
  return normalized;
}

function templateUsesPreferredDomain(urlTemplate) {
  try {
    const candidate = new URL(String(urlTemplate || '').replace('{query}', 'test'));
    return candidate.hostname.endsWith('.by') || candidate.hostname.endsWith('.ru');
  } catch {
    return false;
  }
}

function normalizeAvatarModelUrl(value, fallbackUrl = DEFAULT_AVATAR_MODEL_URL) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallbackUrl;
  }

  const lowered = normalized.toLowerCase();
  if (lowered.includes(REMOTE_ALESYA_AVATAR_ID)) {
    return DEFAULT_AVATAR_MODEL_URL;
  }
  if (lowered.includes(REMOTE_BATYUSHKA_AVATAR_ID)) {
    return BATYUSHKA_AVATAR_MODEL_URL;
  }
  if (lowered.includes('models.readyplayer.me')) {
    return fallbackUrl;
  }
  if (lowered.startsWith('/avatars/')) {
    return normalized.slice(1);
  }
  if (lowered.startsWith('./avatars/')) {
    return normalized.slice(2);
  }

  return normalized;
}

function normalizeSystemPrompt(characterId, value, fallbackValue = DEFAULT_SYSTEM_PROMPT) {
  const prompt = String(value || '').trim();
  const fallbackPrompt = String(fallbackValue || DEFAULT_SYSTEM_PROMPT).trim();
  if (characterId !== BATYUSHKA_CHARACTER_ID) {
    return prompt || fallbackPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  const normalized = prompt.toLowerCase();
  if (!normalized) {
    return BATYUSHKA_SYSTEM_PROMPT;
  }

  const hasModernChurchRole = /религиозн|церковн|прихожан|митрополит|богослужени/.test(normalized);
  const hasLegacyTourBias = /алатантур|туроператор|визов|подобрат[ьа]\s+тур|выбором\s+тур|бюджет|состав\s+путешественников/.test(normalized);
  if (!hasModernChurchRole || hasLegacyTourBias) {
    return BATYUSHKA_SYSTEM_PROMPT;
  }

  return prompt;
}

function sanitizeCharacter(rawCharacter, fallbackId, fallbackCharacter = null) {
  const character = rawCharacter || {};
  const characterId = String(character.id || fallbackId);
  const voiceName = String(character.voiceName || 'Aoede');
  const greetingFallback = characterId === BATYUSHKA_CHARACTER_ID
    ? BATYUSHKA_GREETING
    : DEFAULT_GREETING;
  const explicitPriorityTags = Array.isArray(character.knowledgePriorityTags)
    ? character.knowledgePriorityTags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const fallbackPriorityTags = Array.isArray(fallbackCharacter?.knowledgePriorityTags)
    ? fallbackCharacter.knowledgePriorityTags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const mergedPriorityTags = Array.from(new Set([
    ...fallbackPriorityTags,
    ...explicitPriorityTags,
  ]));

  return {
    id: characterId,
    displayName: String(character.displayName || 'Персонаж'),
    voiceModelId: normalizeVoiceModelId(character.voiceModelId || DEFAULT_VOICE_MODEL),
    systemPrompt: normalizeSystemPrompt(characterId, character.systemPrompt, fallbackCharacter?.systemPrompt),
    voiceName: SUPPORTED_VOICE_NAMES.includes(voiceName) ? voiceName : 'Aoede',
    backgroundPreset: String(character.backgroundPreset || 'aurora'),
    greetingText: String(character.greetingText || fallbackCharacter?.greetingText || greetingFallback),
    avatarModelUrl: normalizeAvatarModelUrl(
      character.avatarModelUrl,
      String(fallbackCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL),
    ),
    avatarInstanceId: String(character.avatarInstanceId || `avatar-${characterId}`),
    knowledgePriorityTags: mergedPriorityTags,
  };
}

function sanitizeKnowledgeSource(rawSource, fallback) {
  const source = rawSource || {};
  const fallbackSource = fallback || {};
  const remapLegacySourceUrl = (value = '') => {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return '';
    }
    return LEGACY_SOURCE_URL_REMAP.get(normalized) || normalized;
  };
  const canonicalUrl = remapLegacySourceUrl(source.canonicalUrl || fallbackSource.canonicalUrl || '');
  const seedUrl = remapLegacySourceUrl(source.seedUrl || fallbackSource.seedUrl || source.canonicalUrl || canonicalUrl || '');
  const sourceId = String(source.id || fallbackSource.id || 'source').trim();
  const mergedTags = Array.from(new Set([
    ...(Array.isArray(fallbackSource.tags) ? fallbackSource.tags.map((tag) => String(tag).trim()) : []),
    ...(Array.isArray(source.tags) ? source.tags.map((tag) => String(tag).trim()) : []),
  ].filter(Boolean)));
  const mergedAliases = Array.from(new Set([
    ...(Array.isArray(fallbackSource.aliases) ? fallbackSource.aliases.map((alias) => String(alias).trim()) : []),
    ...(Array.isArray(source.aliases) ? source.aliases.map((alias) => String(alias).trim()) : []),
  ].filter(Boolean)));
  let title = String(source.title || fallbackSource.title || 'Источник').trim();
  if (
    sourceId === 'arfox-faq'
    && canonicalUrl === 'https://arfox.by/'
    && /(?:faq|ответы)/i.test(title)
    && fallbackSource.title
  ) {
    title = String(fallbackSource.title).trim();
  }

  return {
    id: sourceId,
    title,
    canonicalUrl,
    seedUrl,
    scope: String(source.scope || fallbackSource.scope || 'shared').trim() || 'shared',
    tags: mergedTags,
    aliases: mergedAliases,
    refreshMode: String(source.refreshMode || fallbackSource.refreshMode || 'manual-publish').trim() || 'manual-publish',
    lastFetchedAt: source.lastFetchedAt || null,
    lastPublishedAt: source.lastPublishedAt || null,
    status: String(source.status || fallbackSource.status || 'approved').trim() || 'approved',
  };
}

function sanitizeKnowledgeSources(rawSources) {
  const incomingSources = Array.isArray(rawSources) ? rawSources : [];
  const incomingById = new Map(
    incomingSources
      .map((source) => [String(source?.id || '').trim(), source])
      .filter(([id]) => Boolean(id)),
  );
  const seenIds = new Set();

  const merged = [];
  DEFAULT_KNOWLEDGE_SOURCES.forEach((fallbackSource) => {
    const fallbackId = String(fallbackSource.id || '').trim();
    const incoming = incomingById.get(fallbackId) || null;
    const nextSource = sanitizeKnowledgeSource(incoming || fallbackSource, fallbackSource);
    merged.push(nextSource);
    if (fallbackId) {
      seenIds.add(fallbackId);
    }
  });

  incomingSources.forEach((source) => {
    const sourceId = String(source?.id || '').trim();
    if (!sourceId || seenIds.has(sourceId)) {
      return;
    }
    merged.push(sanitizeKnowledgeSource(source));
    seenIds.add(sourceId);
  });

  return merged
    .filter((source) => source.canonicalUrl && source.seedUrl);
}

function sanitizeKnowledgeRefreshPolicy(rawPolicy) {
  const policy = rawPolicy || {};
  return {
    mode: String(policy.mode || DEFAULT_KNOWLEDGE_REFRESH_POLICY.mode || 'draft-publish'),
    autoRefresh: Boolean(
      policy.autoRefresh === undefined
        ? DEFAULT_KNOWLEDGE_REFRESH_POLICY.autoRefresh
        : policy.autoRefresh,
    ),
  };
}

function sanitizeWebProviders(webProviders) {
  const providers = webProviders || {};
  const sanitized = {};

  for (const [key, fallback] of Object.entries(DEFAULT_WEB_PROVIDERS)) {
    const value = providers[key] || {};
    const nextTemplate = String(value?.urlTemplate || fallback.urlTemplate || '');
    const nextTemplateLower = nextTemplate.toLowerCase();
    const useFallbackTemplate = !templateUsesPreferredDomain(nextTemplate)
      || key === 'search'
      || (key === 'weather' && nextTemplateLower.includes('gismeteo.by'))
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

function sanitizeSpeechStabilityProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  if (!profile || !SUPPORTED_SPEECH_STABILITY_PROFILES.includes(profile)) {
    return DEFAULT_SPEECH_STABILITY_PROFILE;
  }
  return profile;
}

function sanitizePrayerReadMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || !SUPPORTED_PRAYER_READ_MODES.includes(mode)) {
    return DEFAULT_PRAYER_READ_MODE;
  }
  return mode;
}

function sanitizeSafetySwitches(rawSafetySwitches = {}) {
  const switches = rawSafetySwitches && typeof rawSafetySwitches === 'object'
    ? rawSafetySwitches
    : {};

  return {
    safeSpeechFlowEnabled: switches.safeSpeechFlowEnabled === undefined
      ? Boolean(DEFAULT_SAFETY_SWITCHES.safeSpeechFlowEnabled)
      : Boolean(switches.safeSpeechFlowEnabled),
  };
}

export function sanitizeAppConfig(rawConfig) {
  const config = rawConfig || {};
  const defaultCharactersById = new Map(
    (Array.isArray(DEFAULT_APP_CONFIG.characters) ? DEFAULT_APP_CONFIG.characters : [])
      .map((character) => [String(character.id || ''), character]),
  );
  const characters = Array.isArray(config.characters) && config.characters.length > 0
    ? config.characters.map((character, index) => {
      const characterId = String(character?.id || '').trim();
      const fallbackCharacter = defaultCharactersById.get(characterId)
        || DEFAULT_APP_CONFIG.characters[index]
        || null;
      return sanitizeCharacter(character, `character-${index + 1}`, fallbackCharacter);
    })
    : DEFAULT_APP_CONFIG.characters.map((character) => ({ ...character }));

  const activeCharacterId = characters.some((character) => character.id === config.activeCharacterId)
    ? config.activeCharacterId
    : characters[0].id;

  return {
    themeMode: config.themeMode === 'dark' ? 'dark' : 'light',
    activeCharacterId,
    characters,
    safetySwitches: sanitizeSafetySwitches(config.safetySwitches),
    speechStabilityProfile: sanitizeSpeechStabilityProfile(config.speechStabilityProfile),
    prayerReadMode: sanitizePrayerReadMode(config.prayerReadMode),
    webProviders: sanitizeWebProviders(config.webProviders),
    knowledgeRefreshPolicy: sanitizeKnowledgeRefreshPolicy(config.knowledgeRefreshPolicy),
    knowledgeSources: sanitizeKnowledgeSources(config.knowledgeSources),
  };
}

async function createConfigSnapshot(reason = 'save') {
  try {
    const raw = await fs.readFile(APP_CONFIG_PATH, 'utf8');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.mkdir(CONFIG_SNAPSHOT_DIR, { recursive: true });
    const snapshotPath = path.join(CONFIG_SNAPSHOT_DIR, `app-config.${timestamp}.${reason}.json`);
    await fs.writeFile(snapshotPath, raw, 'utf8');

    const files = (await fs.readdir(CONFIG_SNAPSHOT_DIR))
      .filter((file) => file.startsWith('app-config.') && file.endsWith('.json'))
      .sort();
    if (files.length > MAX_CONFIG_SNAPSHOTS) {
      const staleFiles = files.slice(0, files.length - MAX_CONFIG_SNAPSHOTS);
      await Promise.all(staleFiles.map((file) => fs.unlink(path.join(CONFIG_SNAPSHOT_DIR, file)).catch(() => {})));
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    // Snapshot errors should not block config flow.
  }
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
  await createConfigSnapshot('save');
  const sanitized = sanitizeAppConfig(nextConfig);
  await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  return sanitized;
}

export function getAppConfigPath() {
  return APP_CONFIG_PATH;
}
