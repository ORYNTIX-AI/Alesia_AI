export const DEFAULT_RUNTIME_CONFIG = {
  voiceModelId: 'models/gemini-3.1-flash-live-preview',
  voiceName: 'Aoede',
  systemPrompt: '',
  greetingText: 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.',
  sessionContextText: '',
  shouldSendGreeting: true,
  captureUserAudio: true,
  voiceGatewayUrl: '',
  conversationSessionId: '',
  characterId: '',
};

export const DEFAULT_CALLBACKS = {
  onInputTranscription: null,
  onInputTranscriptionCommit: null,
  onAssistantTurnStart: null,
  onAssistantTurnCommit: null,
  onAssistantTurnCancel: null,
  onAssistantInterrupted: null,
  onSessionGoAway: null,
  onSessionReady: null,
};

const DEFAULT_BACKEND_WS_BASE =
  String(import.meta.env?.VITE_BACKEND_WS_BASE || '').trim().replace(/\/+$/, '');
const DEFAULT_BACKEND_HTTP_BASE =
  String(import.meta.env?.VITE_BACKEND_HTTP_BASE || '').trim().replace(/\/+$/, '');

const defaultBackendUrl = (pathname = '/gemini-proxy') => {
  if (DEFAULT_BACKEND_WS_BASE) {
    return `${DEFAULT_BACKEND_WS_BASE}${pathname}`;
  }

  if (typeof window === 'undefined') {
    return `ws://127.0.0.1:8200${pathname}`;
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${window.location.host}${pathname}`;
};

const defaultBackendHttpUrl = (pathname = '/api/voice/session') => {
  if (DEFAULT_BACKEND_HTTP_BASE) {
    return `${DEFAULT_BACKEND_HTTP_BASE}${pathname}`;
  }

  if (typeof window === 'undefined') {
    return `http://127.0.0.1:8200${pathname}`;
  }

  return `${window.location.origin}${pathname}`;
};

const ASSISTANT_TURN_IDLE_FLUSH_MS = 3200;
export const TRANSIENT_CLOSE_CODES = new Set([1005, 1006, 1012, 1013]);
const GEMINI_31_FLASH_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3']);
const BATYUSHKA_2_STABLE_CHARACTER_ID = 'batyushka-2';

export function isGemini31FlashLiveModel(modelId) {
  return String(modelId || '').trim() === GEMINI_31_FLASH_LIVE_MODEL;
}

export function isBatyushka2StableRuntime(runtimeConfig) {
  return String(runtimeConfig?.characterId || '').trim() === BATYUSHKA_2_STABLE_CHARACTER_ID;
}

function buildGemini31SystemInstruction(runtimeConfig) {
  const basePrompt = normalizeAssistantText(runtimeConfig?.systemPrompt || '');
  const prayerInstruction = buildPrayerInstruction(runtimeConfig);
  const characterInstruction = buildCharacterInstruction(runtimeConfig);
  const sessionContextText = normalizeAssistantText(runtimeConfig?.sessionContextText || '');
  const sections = [];

  if (basePrompt) {
    sections.push(`Персона:\n${basePrompt}`);
  }

  sections.push(`Правила разговора:
1. ОТВЕЧАЙ ТОЛЬКО НА РУССКОМ ЯЗЫКЕ. ОТВЕЧАЙ ОДНОЗНАЧНО НА РУССКОМ.
2. Отвечай коротко и естественно. Обычно 1-3 предложения, если пользователь не просит прочитать текст целиком.
3. Каждая реплика должна добавлять новый смысл. Не повторяй вопрос пользователя и не запускай новую реплику без нового пользовательского запроса или служебного контекста.
4. Если служебный контекст сообщает об открытом сайте или действии на странице, опирайся только на него и не противоречь ему.
5. Не говори, что сайт открыт или действие выполнено, пока это не подтверждено служебным контекстом.
6. Не выдумывай факты и не вступай в политические обсуждения.`);

  sections.push(`Служебный web-контекст:
1. WEB_CONTEXT_RESULT значит сайт уже подтвержденно открыт.
2. WEB_CONTEXT_ACTIVE значит вопрос относится к уже открытой странице.
3. WEB_CONTEXT_ERROR значит текущая попытка не удалась и надо сказать об этом прямо, без общих отказов.
4. WEB_ACTION_RESULT значит действие на странице уже выполнено.`);

  if (prayerInstruction) {
    sections.push(prayerInstruction);
  }

  if (characterInstruction) {
    sections.push(characterInstruction);
  }

  if (sessionContextText) {
    sections.push(`Текущий контекст сессии:\n${sessionContextText}`);
  }

  return sections.join('\n\n');
}

export function buildThinkingConfig(runtimeConfig) {
  if (isGemini31FlashLiveModel(runtimeConfig?.voiceModelId)) {
    return {
      thinkingLevel: 'minimal',
    };
  }

  return {
    thinkingBudget: 0,
  };
}

export function resolveAssistantTurnIdleFlushMs(runtimeConfig) {
  if (isBatyushka2StableRuntime(runtimeConfig)) {
    return 4300;
  }

  return ASSISTANT_TURN_IDLE_FLUSH_MS;
}

export function resolveRealtimeInputConfig(runtimeConfig) {
  const stableBatyushkaProfile = isBatyushka2StableRuntime(runtimeConfig);

  return {
    automaticActivityDetection: {
      startOfSpeechSensitivity: stableBatyushkaProfile ? 'START_SENSITIVITY_HIGH' : 'START_SENSITIVITY_LOW',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: stableBatyushkaProfile ? 90 : 40,
      silenceDurationMs: stableBatyushkaProfile ? 640 : 780,
    },
    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
  };
}

function buildPrayerInstruction(runtimeConfig) {
  const mode = String(runtimeConfig?.prayerReadMode || 'knowledge-only').trim().toLowerCase();

  if (mode === 'free') {
    return 'Правила по молитвам: при запросе на молитву отвечай уважительно и кратко, не выдумывай факты вне подтвержденного контекста.';
  }

  if (mode === 'hybrid') {
    return `Правила по молитвам:
1. Сначала опирайся на подтвержденные фрагменты из утвержденной базы знаний и актуального веб-контекста.
2. Если подтвержденного текста недостаточно, честно скажи об этом и предложи открыть источник.
3. Не выдавай непроверенный текст как точную официальную версию.`;
  }

  return `Правила по молитвам:
1. Читать молитвы можно только по подтвержденным фрагментам из утвержденной базы знаний или актуального веб-контекста.
2. Если подтвержденного текста нет, честно скажи, что нужен источник, и предложи открыть страницу с текстом молитвы.
3. Не придумывай текст молитвы по памяти и не выдавай непроверенный текст как точный.`;
}

function buildCharacterInstruction(runtimeConfig) {
  const characterId = String(runtimeConfig?.characterId || '').trim();
  if (!BATYUSHKA_CHARACTER_IDS.has(characterId)) {
    return '';
  }

  return `Role of Nikolay:
1. You are Nikolay, an assistant for parishioners and church-related questions in Belarus.
2. Religious and church topics are allowed: churches, parishes, services, prayers, and Metropolitan Veniamin.
3. Speak respectfully, calmly, and briefly.
4. If the question is not political, do not mention politics and do not refuse by inertia.
5. If a political refusal is required, do it once and then return to the user's practical request.`;
}

export function buildSystemInstruction(runtimeConfig) {
  if (isGemini31FlashLiveModel(runtimeConfig?.voiceModelId)) {
    return buildGemini31SystemInstruction(runtimeConfig);
  }

  const prayerInstruction = buildPrayerInstruction(runtimeConfig);
  const characterInstruction = buildCharacterInstruction(runtimeConfig);
  const base = `${runtimeConfig.systemPrompt || ''}

Системные возможности:
1. Внешняя система реально умеет открывать сайты, читать страницы и выполнять действия на уже открытом сайте.
2. До подтвержденного служебного события не говори, что сайт уже открыт или действие уже выполнено.
3. Если ждёшь служебный результат, не заполняй паузу длинными фразами. Допустима одна короткая нейтральная реплика.

Правила web-режима:
1. "WEB_CONTEXT_RESULT:" означает, что сайт уже подтверждено открыт. Ответь по факту, коротко.
2. "WEB_CONTEXT_ACTIVE:" означает, что вопрос относится к уже открытой странице. Отвечай только по этому контексту.
3. "WEB_CONTEXT_ERROR:" означает, что именно сейчас сайт не открылся или не распознался. Не обобщай это как постоянное ограничение.
4. "WEB_ACTION_RESULT:" означает, что действие на странице уже выполнено. Коротко подтверди итог.
5. Не противоречь служебному контексту и не выдумывай состояние сайта.

Политическая безопасность:
1. Не вступай в политические обсуждения.
2. Не повторяй политические лозунги пользователя.
3. На провокации отвечай коротко и нейтрально.`;
  const withPrayerInstruction = prayerInstruction ? `${base}\n\n${prayerInstruction}` : base;
  const withCharacterInstruction = characterInstruction
    ? `${withPrayerInstruction}\n\n${characterInstruction}`
    : withPrayerInstruction;

  if (!runtimeConfig.sessionContextText) {
    return withCharacterInstruction;
  }

  return `${withCharacterInstruction}

SESSION_BOOTSTRAP:
${runtimeConfig.sessionContextText}`;
}

export function normalizeAssistantText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function mergeAssistantText(currentValue, nextValue) {
  const current = normalizeAssistantText(currentValue);
  const next = normalizeAssistantText(nextValue);

  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  if (current.startsWith(next)) {
    return current;
  }
  if (next.includes(current)) {
    return next;
  }
  if (current.includes(next)) {
    return current;
  }
  return normalizeAssistantText(`${current} ${next}`);
}

function normalizeWsLikeUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }

  if (/^wss?:\/\//i.test(value)) {
    return value;
  }

  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^http/i, 'ws');
  }

  if (value.startsWith('/')) {
    return defaultBackendUrl(value);
  }

  if (/^[a-z0-9.-]+(?::\d+)?\/.+$/i.test(value)) {
    const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${wsProtocol}://${value.replace(/^\/+/, '')}`;
  }

  return value;
}

export async function requestVoiceGatewaySession(runtimeConfig) {
  const conversationSessionId = String(runtimeConfig?.conversationSessionId || '').trim();
  if (!conversationSessionId) {
    return null;
  }

  const response = await fetch(defaultBackendHttpUrl('/api/voice/session'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversationSessionId,
      characterId: String(runtimeConfig?.characterId || '').trim(),
      requestedGatewayUrl: String(runtimeConfig?.voiceGatewayUrl || '').trim(),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Не удалось подготовить голосовую сессию (HTTP ${response.status})`);
  }

  return {
    gatewayUrl: normalizeWsLikeUrl(payload?.voiceGatewayUrl || ''),
    sessionToken: String(payload?.sessionToken || '').trim(),
    expiresAt: String(payload?.expiresAt || '').trim(),
  };
}

export function resolveBackendUrl(runtimeConfig) {
  const explicitUrl = normalizeWsLikeUrl(
    runtimeConfig?.voiceGatewayUrl || import.meta.env.VITE_VOICE_GATEWAY_URL || import.meta.env.VITE_BACKEND_URL || '',
  );
  if (explicitUrl) {
    return explicitUrl;
  }

  const defaultPath = runtimeConfig?.captureUserAudio !== false
    ? '/voice-proxy'
    : '/gemini-proxy';
  return defaultBackendUrl(defaultPath);
}

