import fs from 'fs/promises';
import path from 'path';
import {
  BATYUSHKA_AVATAR_MODEL_URL,
  BATYUSHKA_GREETING,
  BATYUSHKA_SYSTEM_PROMPT,
  createCharacterRuntimeConfig,
  DEFAULT_APP_CONFIG,
  DEFAULT_AVATAR_MODEL_URL,
  DEFAULT_KNOWLEDGE_REFRESH_POLICY,
  DEFAULT_KNOWLEDGE_SOURCES,
  DEFAULT_RUNTIME_PROVIDER,
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
  YANDEX_LEGACY_RUNTIME_PROVIDER,
  YANDEX_REALTIME_RUNTIME_PROVIDER,
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
const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3']);
let bootstrapSnapshotCreated = false;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeVoiceModelId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || LEGACY_VOICE_MODELS.has(normalized)) {
    return DEFAULT_VOICE_MODEL;
  }
  return normalized;
}

function normalizeRuntimeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_RUNTIME_PROVIDER;
  }
  if (normalized === 'yandex-full') {
    return YANDEX_LEGACY_RUNTIME_PROVIDER;
  }
  if (
    normalized === DEFAULT_RUNTIME_PROVIDER
    || normalized === YANDEX_LEGACY_RUNTIME_PROVIDER
    || normalized === YANDEX_REALTIME_RUNTIME_PROVIDER
  ) {
    return normalized;
  }
  return DEFAULT_RUNTIME_PROVIDER;
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
  if (!BATYUSHKA_CHARACTER_IDS.has(characterId)) {
    return prompt || fallbackPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  return BATYUSHKA_SYSTEM_PROMPT;
}

function normalizeGreetingText(characterId, value, fallbackValue = DEFAULT_GREETING) {
  const greeting = String(value || '').trim();
  const fallbackGreeting = String(fallbackValue || DEFAULT_GREETING).trim();
  if (!BATYUSHKA_CHARACTER_IDS.has(characterId)) {
    return greeting || fallbackGreeting || DEFAULT_GREETING;
  }

  return BATYUSHKA_GREETING;
}

function sanitizeCharacter(rawCharacter, fallbackId, fallbackCharacter = null) {
  const character = rawCharacter || {};
  const characterId = String(character.id || fallbackId).trim() || fallbackId;
  const fallbackRuntime = createCharacterRuntimeConfig(fallbackCharacter || {});
  const rawRuntimeProvider = normalizeWhitespace(character.runtimeProvider || '');
  const runtimeProvider = normalizeRuntimeProvider(
    character.runtimeProvider
    || fallbackRuntime.runtimeProvider
    || DEFAULT_RUNTIME_PROVIDER,
  );
  const rawModelId = normalizeWhitespace(character.modelId || character.voiceModelId || '');
  const modelId = normalizeVoiceModelId(
    character.modelId || character.voiceModelId || fallbackRuntime.modelId || DEFAULT_VOICE_MODEL,
  );
  const voiceName = String(character.voiceName || fallbackCharacter?.voiceName || 'Aoede').trim() || 'Aoede';
  const greetingFallback = BATYUSHKA_CHARACTER_IDS.has(characterId)
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
  const runtimeDefaults = createCharacterRuntimeConfig({
    ...fallbackRuntime,
    runtimeProvider,
    modelId,
    voiceModelId: modelId,
    liveInputEnabled: character.liveInputEnabled === undefined
      ? fallbackRuntime.liveInputEnabled
      : character.liveInputEnabled,
    voiceGatewayUrl: String(character.voiceGatewayUrl || fallbackRuntime.voiceGatewayUrl || '').trim(),
    voiceName,
    ttsVoiceName: String(character.ttsVoiceName || fallbackRuntime.ttsVoiceName || voiceName).trim() || voiceName,
    sttProfile: String(character.sttProfile || fallbackRuntime.sttProfile || 'general').trim() || 'general',
    outputAudioTranscription: character.outputAudioTranscription === undefined
      ? fallbackRuntime.outputAudioTranscription !== false
      : character.outputAudioTranscription !== false,
    vectorStoreId: String(character.vectorStoreId || fallbackRuntime.vectorStoreId || '').trim(),
    enabledTools: Array.isArray(character.enabledTools)
      ? character.enabledTools
      : fallbackRuntime.enabledTools,
    webSearchEnabled: character.webSearchEnabled === undefined
      ? fallbackRuntime.webSearchEnabled === true
      : character.webSearchEnabled === true,
    maxToolResults: Math.max(1, Number(character.maxToolResults || fallbackRuntime.maxToolResults || 4) || 4),
    fallbackRuntimeProvider: normalizeRuntimeProvider(
      character.fallbackRuntimeProvider
      || fallbackRuntime.fallbackRuntimeProvider
      || (runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : DEFAULT_RUNTIME_PROVIDER),
    ),
  });

  return {
    id: characterId,
    displayName: String(character.displayName || fallbackCharacter?.displayName || 'Character'),
    runtimeProvider: runtimeDefaults.runtimeProvider,
    modelId: runtimeDefaults.modelId,
    voiceModelId: runtimeDefaults.voiceModelId,
    systemPrompt: normalizeSystemPrompt(characterId, character.systemPrompt, fallbackCharacter?.systemPrompt),
    voiceName,
    ttsVoiceName: String(character.ttsVoiceName || runtimeDefaults.ttsVoiceName || voiceName).trim() || voiceName,
    sttProfile: String(character.sttProfile || runtimeDefaults.sttProfile || 'general').trim() || 'general',
    outputAudioTranscription: runtimeDefaults.outputAudioTranscription !== false,
    backgroundPreset: String(character.backgroundPreset || fallbackCharacter?.backgroundPreset || 'aurora'),
    greetingText: normalizeGreetingText(characterId, character.greetingText, fallbackCharacter?.greetingText || greetingFallback),
    avatarModelUrl: normalizeAvatarModelUrl(
      character.avatarModelUrl,
      String(fallbackCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL),
    ),
    avatarInstanceId: String(character.avatarInstanceId || fallbackCharacter?.avatarInstanceId || ('avatar-' + characterId)),
    knowledgePriorityTags: mergedPriorityTags,
    liveInputEnabled: runtimeDefaults.liveInputEnabled,
    voiceGatewayUrl: String(character.voiceGatewayUrl || runtimeDefaults.voiceGatewayUrl || '').trim(),
    vectorStoreId: String(character.vectorStoreId || runtimeDefaults.vectorStoreId || '').trim(),
    enabledTools: Array.isArray(runtimeDefaults.enabledTools) ? runtimeDefaults.enabledTools : [],
    webSearchEnabled: runtimeDefaults.webSearchEnabled === true,
    maxToolResults: Math.max(1, Number(runtimeDefaults.maxToolResults || 4) || 4),
    fallbackRuntimeProvider: normalizeRuntimeProvider(
      character.fallbackRuntimeProvider
      || runtimeDefaults.fallbackRuntimeProvider
      || (runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : DEFAULT_RUNTIME_PROVIDER),
    ),
    browserPanelMode: String(character.browserPanelMode || fallbackCharacter?.browserPanelMode || 'remote').trim() === 'client-inline'
      ? 'client-inline'
      : 'remote',
    pageContextMode: String(character.pageContextMode || fallbackCharacter?.pageContextMode || 'browser-session').trim() === 'url-fetch'
      ? 'url-fetch'
      : 'browser-session',
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
  const defaultCharacters = Array.isArray(DEFAULT_APP_CONFIG.characters) ? DEFAULT_APP_CONFIG.characters : [];
  const defaultCharactersById = new Map(
    defaultCharacters.map((character) => [String(character.id || '').trim(), character]),
  );
  const incomingCharacters = Array.isArray(config.characters) ? config.characters : [];
  const mergedCharacters = [];
  const seenCharacterIds = new Set();

  incomingCharacters.forEach((character, index) => {
    const characterId = String(character?.id || '').trim();
    const fallbackCharacter = defaultCharactersById.get(characterId)
      || defaultCharacters[index]
      || null;
    const sanitizedCharacter = sanitizeCharacter(character, 'character-' + (index + 1), fallbackCharacter);
    if (!sanitizedCharacter.id || seenCharacterIds.has(sanitizedCharacter.id)) {
      return;
    }
    mergedCharacters.push(sanitizedCharacter);
    seenCharacterIds.add(sanitizedCharacter.id);
  });

  defaultCharacters.forEach((defaultCharacter, index) => {
    const characterId = String(defaultCharacter?.id || '').trim();
    if (!characterId || seenCharacterIds.has(characterId)) {
      return;
    }
    mergedCharacters.push(sanitizeCharacter(defaultCharacter, 'default-character-' + (index + 1), defaultCharacter));
    seenCharacterIds.add(characterId);
  });

  const characters = mergedCharacters.length > 0
    ? mergedCharacters
    : defaultCharacters.map((character, index) => sanitizeCharacter(character, 'default-character-' + (index + 1), character));

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
  if (!bootstrapSnapshotCreated) {
    await createConfigSnapshot('bootstrap');
    bootstrapSnapshotCreated = true;
  }
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
