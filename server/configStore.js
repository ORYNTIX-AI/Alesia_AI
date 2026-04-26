import fs from 'fs/promises';
import path from 'path';
import {
  BATYUSHKA_AVATAR_MODEL_URL,
  DEFAULT_APP_CONFIG,
  DEFAULT_AVATAR_MODEL_URL,
  DEFAULT_RUNTIME_PROVIDER,
  DEFAULT_VOICE_MODEL,
  DEFAULT_YANDEX_ENABLED_TOOLS,
  GEMINI_31_FLASH_TTS_MODEL,
  SUPPORTED_VOICE_NAMES,
  YANDEX_LEGACY_RUNTIME_PROVIDER,
  YANDEX_REALTIME_RUNTIME_PROVIDER,
  createCharacterRuntimeConfig,
  getCharacterContentDefaults,
  getVectorStoreFallbackForCharacter,
  resolveGreetingRef,
  resolvePromptRef,
} from './defaultAppConfig.js';
import { DEFAULT_APP_CONFIG_PATH } from './runtimePaths.js';

const APP_CONFIG_PATH = DEFAULT_APP_CONFIG_PATH;
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

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeThemeMode(value) {
  return String(value || '').trim() === 'dark' ? 'dark' : 'light';
}

function normalizeVoiceModelId(value) {
  const normalized = String(value || '').trim();
  const modelCode = normalized.replace(/^models\//, '');
  if (!normalized || (modelCode.startsWith('gemini-') && !modelCode.startsWith('gemini-3.1-'))) {
    return DEFAULT_VOICE_MODEL;
  }
  return normalized;
}

function normalizeGeminiTtsModelId(value) {
  const normalized = String(value || '').trim();
  const modelCode = normalized.replace(/^models\//, '');
  if (!normalized || (modelCode.startsWith('gemini-') && !modelCode.startsWith('gemini-3.1-'))) {
    return GEMINI_31_FLASH_TTS_MODEL;
  }
  return modelCode;
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

function normalizeVoiceName(value, fallback = SUPPORTED_VOICE_NAMES[0]) {
  const normalized = String(value || '').trim();
  if (SUPPORTED_VOICE_NAMES.includes(normalized)) {
    return normalized;
  }
  return String(fallback || SUPPORTED_VOICE_NAMES[0]).trim() || SUPPORTED_VOICE_NAMES[0];
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

function normalizePromptRef(value, fallback = '') {
  const normalized = normalizeWhitespace(value);
  return normalized || fallback;
}

function normalizeGreetingRef(value, fallback = '') {
  const normalized = normalizeWhitespace(value);
  return normalized || fallback;
}

function normalizeBrowserPanelMode(value) {
  return String(value || '').trim() === 'client-inline' ? 'client-inline' : 'remote';
}

function normalizePageContextMode(value) {
  return String(value || '').trim() === 'url-fetch' ? 'url-fetch' : 'browser-session';
}

function normalizeKnowledgePriorityTags(rawValue = [], fallbackValue = []) {
  return Array.from(new Set([
    ...(Array.isArray(fallbackValue) ? fallbackValue : []),
    ...(Array.isArray(rawValue) ? rawValue : []),
  ].map((tag) => String(tag).trim()).filter(Boolean)));
}

function normalizeToolList(rawValue = [], fallbackValue = []) {
  return Array.from(new Set([
    ...(Array.isArray(fallbackValue) ? fallbackValue : []),
    ...(Array.isArray(rawValue) ? rawValue : []),
  ].map((tool) => String(tool).trim()).filter(Boolean)));
}

function buildPromptState(source = {}, rawCharacter = {}, defaults = {}) {
  const promptSource = source.prompt || {};
  return {
    ref: normalizePromptRef(promptSource.ref || rawCharacter.systemPromptRef, defaults.promptRef),
    text: normalizeMultilineText(promptSource.text ?? rawCharacter.systemPrompt ?? ''),
  };
}

function buildGreetingState(source = {}, rawCharacter = {}, defaults = {}) {
  const greetingSource = source.greeting || {};
  return {
    ref: normalizeGreetingRef(greetingSource.ref || rawCharacter.greetingRef, defaults.greetingRef),
    text: normalizeMultilineText(greetingSource.text ?? rawCharacter.greetingText ?? ''),
  };
}

function sanitizeStoredCharacter(rawCharacter = {}, fallbackCharacter = null) {
  const identitySource = rawCharacter.identity || rawCharacter;
  const fallbackIdentitySource = fallbackCharacter?.identity || fallbackCharacter || {};
  const characterId = normalizeWhitespace(identitySource.id || rawCharacter.id || fallbackIdentitySource.id || '');
  const defaults = getCharacterContentDefaults(characterId);
  const runtimeSource = rawCharacter.runtime || rawCharacter;
  const fallbackRuntimeSource = fallbackCharacter?.runtime || fallbackCharacter || {};
  const avatarSource = rawCharacter.avatar || rawCharacter;
  const fallbackAvatarSource = fallbackCharacter?.avatar || fallbackCharacter || {};
  const backgroundSource = rawCharacter.background || rawCharacter;
  const fallbackBackgroundSource = fallbackCharacter?.background || fallbackCharacter || {};
  const browserSource = rawCharacter.browser || rawCharacter;
  const fallbackBrowserSource = fallbackCharacter?.browser || fallbackCharacter || {};
  const knowledgeSource = rawCharacter.knowledge || rawCharacter;
  const fallbackKnowledgeSource = fallbackCharacter?.knowledge || fallbackCharacter || {};
  const prompt = buildPromptState(rawCharacter.content || {}, rawCharacter, defaults);
  const greeting = buildGreetingState(rawCharacter.content || {}, rawCharacter, defaults);
  const runtimeProvider = normalizeRuntimeProvider(
    runtimeSource.provider
    || runtimeSource.runtimeProvider
    || fallbackRuntimeSource.provider
    || fallbackRuntimeSource.runtimeProvider
    || DEFAULT_RUNTIME_PROVIDER,
  );
  const modelId = normalizeVoiceModelId(
    runtimeSource.modelId
    || runtimeSource.voiceModelId
    || fallbackRuntimeSource.modelId
    || fallbackRuntimeSource.voiceModelId
    || DEFAULT_VOICE_MODEL,
  );
  const runtimeDefaults = createCharacterRuntimeConfig({
    runtimeProvider,
    modelId,
    ttsModelId: normalizeGeminiTtsModelId(runtimeSource.ttsModelId || fallbackRuntimeSource.ttsModelId || ''),
    liveInputEnabled: runtimeSource.liveInputEnabled === undefined
      ? fallbackRuntimeSource.liveInputEnabled
      : runtimeSource.liveInputEnabled,
    voiceGatewayUrl: runtimeSource.voiceGatewayUrl || fallbackRuntimeSource.voiceGatewayUrl || '',
    voiceName: runtimeSource.voiceName || fallbackRuntimeSource.voiceName || SUPPORTED_VOICE_NAMES[0],
    ttsVoiceName: runtimeSource.ttsVoiceName || fallbackRuntimeSource.ttsVoiceName || runtimeSource.voiceName || fallbackRuntimeSource.voiceName || '',
    sttProfile: runtimeSource.sttProfile || fallbackRuntimeSource.sttProfile || 'general',
    outputAudioTranscription: runtimeSource.outputAudioTranscription === undefined
      ? fallbackRuntimeSource.outputAudioTranscription !== false
      : runtimeSource.outputAudioTranscription !== false,
    vectorStoreId: runtimeSource.vectorStoreId || fallbackRuntimeSource.vectorStoreId || getVectorStoreFallbackForCharacter(characterId),
    enabledTools: normalizeToolList(runtimeSource.enabledTools, fallbackRuntimeSource.enabledTools),
    webSearchEnabled: runtimeSource.webSearchEnabled === undefined
      ? fallbackRuntimeSource.webSearchEnabled === true
      : runtimeSource.webSearchEnabled === true,
    maxToolResults: runtimeSource.maxToolResults || fallbackRuntimeSource.maxToolResults || 4,
    fallbackRuntimeProvider: runtimeSource.fallbackProvider
      || runtimeSource.fallbackRuntimeProvider
      || fallbackRuntimeSource.fallbackProvider
      || fallbackRuntimeSource.fallbackRuntimeProvider
      || (runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : ''),
  });
  const fallbackVoiceName = normalizeVoiceName(
    fallbackRuntimeSource.voiceName
    || fallbackCharacter?.voiceName
    || runtimeDefaults.ttsVoiceName
    || SUPPORTED_VOICE_NAMES[0],
  );
  const voiceName = runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER
    ? normalizeWhitespace(runtimeSource.voiceName || fallbackRuntimeSource.voiceName || runtimeDefaults.ttsVoiceName || 'ermil') || 'ermil'
    : normalizeVoiceName(runtimeSource.voiceName || fallbackRuntimeSource.voiceName, fallbackVoiceName);
  const ttsVoiceName = normalizeWhitespace(runtimeSource.ttsVoiceName || fallbackRuntimeSource.ttsVoiceName || runtimeDefaults.ttsVoiceName || voiceName) || voiceName;
  const enabledTools = runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER
    ? normalizeToolList(runtimeSource.enabledTools, fallbackRuntimeSource.enabledTools?.length ? fallbackRuntimeSource.enabledTools : DEFAULT_YANDEX_ENABLED_TOOLS)
    : normalizeToolList(runtimeSource.enabledTools, fallbackRuntimeSource.enabledTools);

  return {
    identity: {
      id: characterId || normalizeWhitespace(fallbackIdentitySource.id),
      displayName: String(identitySource.displayName || rawCharacter.displayName || fallbackIdentitySource.displayName || fallbackCharacter?.displayName || 'Character').trim() || 'Character',
    },
    avatar: {
      modelUrl: normalizeAvatarModelUrl(
        avatarSource.modelUrl || rawCharacter.avatarModelUrl,
        normalizeAvatarModelUrl(fallbackAvatarSource.modelUrl || fallbackCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL),
      ),
      instanceId: normalizeWhitespace(
        avatarSource.instanceId
        || rawCharacter.avatarInstanceId
        || fallbackAvatarSource.instanceId
        || fallbackCharacter?.avatarInstanceId
        || `avatar-${characterId || 'character'}`,
      ) || `avatar-${characterId || 'character'}`,
    },
    background: {
      preset: normalizeWhitespace(backgroundSource.preset || rawCharacter.backgroundPreset || fallbackBackgroundSource.preset || fallbackCharacter?.backgroundPreset || 'aurora') || 'aurora',
    },
    runtime: {
      provider: runtimeDefaults.runtimeProvider,
      modelId: runtimeDefaults.modelId,
      ttsModelId: runtimeDefaults.ttsModelId,
      liveInputEnabled: runtimeDefaults.liveInputEnabled,
      voiceName,
      ttsVoiceName,
      sttProfile: normalizeWhitespace(runtimeDefaults.sttProfile || 'general') || 'general',
      outputAudioTranscription: runtimeDefaults.outputAudioTranscription !== false,
      voiceGatewayUrl: normalizeWhitespace(runtimeDefaults.voiceGatewayUrl),
      vectorStoreId: normalizeWhitespace(runtimeDefaults.vectorStoreId || getVectorStoreFallbackForCharacter(characterId)),
      enabledTools,
      webSearchEnabled: runtimeDefaults.webSearchEnabled === true,
      maxToolResults: Math.max(1, Number(runtimeDefaults.maxToolResults || 4) || 4),
      fallbackProvider: normalizeRuntimeProvider(
        runtimeDefaults.fallbackRuntimeProvider
        || (runtimeDefaults.runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : DEFAULT_RUNTIME_PROVIDER),
      ),
    },
    browser: {
      panelMode: normalizeBrowserPanelMode(browserSource.panelMode || rawCharacter.browserPanelMode || fallbackBrowserSource.panelMode || fallbackCharacter?.browserPanelMode),
      pageContextMode: normalizePageContextMode(browserSource.pageContextMode || rawCharacter.pageContextMode || fallbackBrowserSource.pageContextMode || fallbackCharacter?.pageContextMode),
    },
    content: {
      prompt,
      greeting,
    },
    knowledge: {
      priorityTags: normalizeKnowledgePriorityTags(
        knowledgeSource.priorityTags || rawCharacter.knowledgePriorityTags,
        fallbackKnowledgeSource.priorityTags || fallbackCharacter?.knowledgePriorityTags,
      ),
    },
  };
}

function remapLegacySourceUrl(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return LEGACY_SOURCE_URL_REMAP.get(normalized) || normalized;
}

function sanitizeKnowledgeSource(rawSource = {}, fallbackSource = {}) {
  const canonicalUrl = remapLegacySourceUrl(rawSource.canonicalUrl || fallbackSource.canonicalUrl || '');
  const seedUrl = remapLegacySourceUrl(rawSource.seedUrl || fallbackSource.seedUrl || canonicalUrl || '');
  return {
    id: normalizeWhitespace(rawSource.id || fallbackSource.id || 'source') || 'source',
    title: String(rawSource.title || fallbackSource.title || 'Источник').trim() || 'Источник',
    canonicalUrl,
    seedUrl,
    scope: normalizeWhitespace(rawSource.scope || fallbackSource.scope || 'shared') || 'shared',
    tags: normalizeKnowledgePriorityTags(rawSource.tags, fallbackSource.tags),
    aliases: normalizeKnowledgePriorityTags(rawSource.aliases, fallbackSource.aliases),
    refreshMode: normalizeWhitespace(rawSource.refreshMode || fallbackSource.refreshMode || 'manual-publish') || 'manual-publish',
    lastFetchedAt: rawSource.lastFetchedAt || fallbackSource.lastFetchedAt || null,
    lastPublishedAt: rawSource.lastPublishedAt || fallbackSource.lastPublishedAt || null,
    status: normalizeWhitespace(rawSource.status || fallbackSource.status || 'approved') || 'approved',
  };
}

function sanitizeKnowledgeSources(rawSources = [], fallbackSources = []) {
  const incoming = Array.isArray(rawSources) ? rawSources : [];
  const fallback = Array.isArray(fallbackSources) ? fallbackSources : [];
  const fallbackById = new Map(fallback.map((source) => [normalizeWhitespace(source?.id), source]));
  const seen = new Set();
  const merged = [];

  fallback.forEach((source) => {
    const sourceId = normalizeWhitespace(source?.id);
    const incomingSource = incoming.find((entry) => normalizeWhitespace(entry?.id) === sourceId);
    const nextSource = sanitizeKnowledgeSource(incomingSource || source, source);
    merged.push(nextSource);
    seen.add(sourceId);
  });

  incoming.forEach((source) => {
    const sourceId = normalizeWhitespace(source?.id);
    if (!sourceId || seen.has(sourceId)) {
      return;
    }
    merged.push(sanitizeKnowledgeSource(source, fallbackById.get(sourceId)));
    seen.add(sourceId);
  });

  return merged.filter((source) => source.canonicalUrl && source.seedUrl);
}

function sanitizeWebProviders(rawProviders = {}, fallbackProviders = {}) {
  const nextProviders = {};
  const fallbackEntries = Object.entries(fallbackProviders || {});

  fallbackEntries.forEach(([key, fallbackValue]) => {
    const currentValue = rawProviders?.[key] || {};
    nextProviders[key] = {
      label: String(currentValue.label || fallbackValue.label || key).trim() || key,
      urlTemplate: String(currentValue.urlTemplate || fallbackValue.urlTemplate || '').trim(),
    };
  });

  return nextProviders;
}

function sanitizeStoredAppConfig(rawConfig = {}) {
  const fallbackConfig = DEFAULT_APP_CONFIG;
  const incomingCharacters = Array.isArray(rawConfig.characters) ? rawConfig.characters : [];
  const fallbackCharacters = Array.isArray(fallbackConfig.characters) ? fallbackConfig.characters : [];
  const fallbackById = new Map(
    fallbackCharacters.map((character) => [normalizeWhitespace(character?.identity?.id || character?.id), character]),
  );
  const seenCharacterIds = new Set();
  const characters = [];

  incomingCharacters.forEach((character, index) => {
    const sourceId = normalizeWhitespace(character?.identity?.id || character?.id);
    const fallbackCharacter = fallbackById.get(sourceId) || fallbackCharacters[index] || null;
    const nextCharacter = sanitizeStoredCharacter(character, fallbackCharacter);
    if (!nextCharacter.identity.id || seenCharacterIds.has(nextCharacter.identity.id)) {
      return;
    }
    characters.push(nextCharacter);
    seenCharacterIds.add(nextCharacter.identity.id);
  });

  fallbackCharacters.forEach((character, index) => {
    const sourceId = normalizeWhitespace(character?.identity?.id || character?.id);
    if (!sourceId || seenCharacterIds.has(sourceId)) {
      return;
    }
    characters.push(sanitizeStoredCharacter(character, fallbackCharacters[index] || null));
    seenCharacterIds.add(sourceId);
  });

  const activeCharacterId = characters.some((character) => character.identity.id === rawConfig.activeCharacterId)
    ? rawConfig.activeCharacterId
    : characters[0]?.identity.id || fallbackConfig.activeCharacterId;

  return {
    schemaVersion: 2,
    themeMode: normalizeThemeMode(rawConfig.themeMode || fallbackConfig.themeMode),
    activeCharacterId,
    characters,
    webProviders: sanitizeWebProviders(rawConfig.webProviders, fallbackConfig.webProviders),
    knowledgeSources: sanitizeKnowledgeSources(rawConfig.knowledgeSources, fallbackConfig.knowledgeSources),
  };
}

function resolvePromptText(promptState = {}) {
  return normalizeMultilineText(promptState.text || '') || resolvePromptRef(promptState.ref);
}

function resolveGreetingText(greetingState = {}) {
  return normalizeMultilineText(greetingState.text || '') || resolveGreetingRef(greetingState.ref);
}

function hydrateCharacter(character) {
  const promptRef = normalizePromptRef(character?.content?.prompt?.ref);
  const greetingRef = normalizeGreetingRef(character?.content?.greeting?.ref);
  const systemPrompt = resolvePromptText(character?.content?.prompt);
  const greetingText = resolveGreetingText(character?.content?.greeting);
  return {
    id: character.identity.id,
    displayName: character.identity.displayName,
    runtimeProvider: character.runtime.provider,
    modelId: character.runtime.modelId,
    voiceModelId: character.runtime.modelId,
    ttsModelId: character.runtime.ttsModelId,
    liveInputEnabled: character.runtime.liveInputEnabled,
    voiceName: character.runtime.voiceName,
    ttsVoiceName: character.runtime.ttsVoiceName,
    sttProfile: character.runtime.sttProfile,
    outputAudioTranscription: character.runtime.outputAudioTranscription !== false,
    voiceGatewayUrl: character.runtime.voiceGatewayUrl,
    vectorStoreId: character.runtime.vectorStoreId,
    enabledTools: Array.isArray(character.runtime.enabledTools) ? [...character.runtime.enabledTools] : [],
    webSearchEnabled: character.runtime.webSearchEnabled === true,
    maxToolResults: character.runtime.maxToolResults,
    fallbackRuntimeProvider: character.runtime.fallbackProvider,
    backgroundPreset: character.background.preset,
    avatarModelUrl: character.avatar.modelUrl,
    avatarInstanceId: character.avatar.instanceId,
    browserPanelMode: character.browser.panelMode,
    pageContextMode: character.browser.pageContextMode,
    knowledgePriorityTags: Array.isArray(character.knowledge.priorityTags) ? [...character.knowledge.priorityTags] : [],
    systemPromptRef: promptRef,
    greetingRef,
    systemPrompt,
    greetingText,
  };
}

function toRuntimeAppConfig(storedConfig) {
  return {
    schemaVersion: 2,
    themeMode: storedConfig.themeMode,
    activeCharacterId: storedConfig.activeCharacterId,
    characters: storedConfig.characters.map(hydrateCharacter),
    webProviders: storedConfig.webProviders,
    knowledgeSources: storedConfig.knowledgeSources,
  };
}

async function ensureConfigFile() {
  await fs.mkdir(path.dirname(APP_CONFIG_PATH), { recursive: true });

  try {
    await fs.access(APP_CONFIG_PATH);
  } catch {
    await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(sanitizeStoredAppConfig(DEFAULT_APP_CONFIG), null, 2)}\n`, 'utf8');
  }
}

async function readStoredConfig() {
  await ensureConfigFile();
  const raw = await fs.readFile(APP_CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

export function sanitizeAppConfig(rawConfig) {
  return toRuntimeAppConfig(sanitizeStoredAppConfig(rawConfig));
}

export async function loadAppConfig() {
  const rawConfig = await readStoredConfig();
  const storedConfig = sanitizeStoredAppConfig(rawConfig);

  if (JSON.stringify(rawConfig) !== JSON.stringify(storedConfig)) {
    await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(storedConfig, null, 2)}\n`, 'utf8');
  }

  return toRuntimeAppConfig(storedConfig);
}

export async function saveAppConfig(nextConfig) {
  await ensureConfigFile();
  const storedConfig = sanitizeStoredAppConfig(nextConfig);
  await fs.writeFile(APP_CONFIG_PATH, `${JSON.stringify(storedConfig, null, 2)}\n`, 'utf8');
  return toRuntimeAppConfig(storedConfig);
}

export function getAppConfigPath() {
  return APP_CONFIG_PATH;
}
