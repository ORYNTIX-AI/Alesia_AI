import { WebSocket } from 'ws';
import { loadServerEnv } from '../env.js';

const SERVER_ENV = loadServerEnv(process.env);
const YANDEX_REALTIME_URL = SERVER_ENV.yandex.realtimeUrl;
const YANDEX_API_KEY = SERVER_ENV.yandex.apiKey;
const YANDEX_IAM_TOKEN = SERVER_ENV.yandex.iamToken;
const YANDEX_FOLDER_ID = SERVER_ENV.yandex.folderId;
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;
export const DEFAULT_MAX_TOOL_RESULTS = 4;
export const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
export const FORCED_REPLY_TTS_SAMPLE_RATE = 48000;
export const FORCED_REPLY_AUDIO_CHUNK_BYTES = 262144;
export const RESPONSE_DONE_GRACE_MS = 140;

export function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function buildYandexApiAuthorizationHeader() {
  if (YANDEX_API_KEY) {
    return `Api-Key ${YANDEX_API_KEY}`;
  }
  if (YANDEX_IAM_TOKEN) {
    return `Bearer ${YANDEX_IAM_TOKEN}`;
  }
  throw new Error('Yandex auth is not configured');
}

export function buildYandexAuthHeaders() {
  return {
    Authorization: buildYandexApiAuthorizationHeader(),
    'OpenAI-Beta': 'realtime=v1',
  };
}

export function buildYandexModelId(modelId = '') {
  const normalizedModelId = normalizeWhitespace(modelId || 'speech-realtime-250923');
  if (!normalizedModelId) {
    throw new Error('Yandex realtime model is not configured');
  }
  if (/^[a-z]+:\/\//i.test(normalizedModelId) || normalizedModelId.startsWith('gpt://')) {
    return normalizedModelId;
  }
  if (!YANDEX_FOLDER_ID) {
    throw new Error('YANDEX_FOLDER_ID is not configured');
  }
  return `gpt://${YANDEX_FOLDER_ID}/${normalizedModelId}`;
}

export function buildYandexRealtimeSocketUrl(modelId = '') {
  const socketUrl = new URL(YANDEX_REALTIME_URL);
  socketUrl.searchParams.set('model', buildYandexModelId(modelId || 'speech-realtime-250923'));
  return socketUrl.toString();
}

export function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

export function closeBothSockets(clientWs, upstreamWs, code = 1011, reason = 'Upstream closed') {
  try {
    if (clientWs?.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  } catch {
    // Ignore close failures.
  }
  try {
    if (upstreamWs?.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
  } catch {
    // Ignore close failures.
  }
}

export function truncate(text, maxLength = 800) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function summarizeText(text, maxLength = 420) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const compact = truncate(sentences.slice(0, 3).join(' '), maxLength);
  return compact || truncate(normalized, maxLength);
}

export function normalizeEnabledTools(runtimeConfig = {}) {
  return new Set(
    (Array.isArray(runtimeConfig.enabledTools) ? runtimeConfig.enabledTools : [])
      .map((tool) => normalizeWhitespace(tool).toLowerCase())
      .filter(Boolean),
  );
}

export function normalizeVoiceInteractionTuning(runtimeConfig = {}) {
  const tuning = runtimeConfig?.voiceInteractionTuning && typeof runtimeConfig.voiceInteractionTuning === 'object'
    ? runtimeConfig.voiceInteractionTuning
    : {};

  const pauseMs = Math.min(900, Math.max(260, Number(tuning.pauseMs || 400) || 400));
  const firstReplySentences = Math.min(3, Math.max(1, Number(tuning.firstReplySentences || 2) || 2));
  const memoryTurnCount = Math.min(12, Math.max(2, Number(tuning.memoryTurnCount || 6) || 6));

  return {
    pauseMs,
    firstReplySentences,
    memoryTurnCount,
    prefixPaddingMs: Math.min(420, Math.max(180, Math.round(pauseMs * 0.72))),
  };
}

export function normalizeRealtimeTurnDetectionTuning(runtimeConfig = {}) {
  const tuning = normalizeVoiceInteractionTuning(runtimeConfig);
  return {
    pauseMs: Math.min(700, Math.max(360, tuning.pauseMs)),
    prefixPaddingMs: Math.max(180, Math.min(360, tuning.prefixPaddingMs)),
  };
}

export function formatRecentTurnsMemory(recentTurns = [], maxTurns = 6) {
  const safeTurns = (Array.isArray(recentTurns) ? recentTurns : [])
    .slice(-Math.max(2, maxTurns))
    .map((turn) => {
      const role = turn?.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}: ${truncate(turn?.text || '', 180)}`;
    })
    .filter(Boolean);

  if (!safeTurns.length) {
    return '';
  }

  return safeTurns.join('\n');
}

export function buildRealtimeInstructions(runtimeConfig = {}, restoreContext = null) {
  const parts = [];
  const systemPrompt = normalizeWhitespace(runtimeConfig.systemPrompt || '');
  const sessionContextText = normalizeWhitespace(runtimeConfig.sessionContextText || '');
  const summary = normalizeWhitespace(restoreContext?.summary || '');
  const tuning = normalizeVoiceInteractionTuning(runtimeConfig);
  const recentTurnsMemory = formatRecentTurnsMemory(restoreContext?.recentTurns, tuning.memoryTurnCount);
  const greetingCriticalRule = 'Critical: On greeting or name-call turns without a real user request, answer with one short natural greeting sentence and stop. This includes a greeting alone, a greeting plus your name/role, or a greeting plus a provider name. The greeting answer must not contain a question mark. Never ask what you can do, how you can help, how you can be useful, or how you can serve.';

  if (systemPrompt) {
    parts.push(`${systemPrompt}\n\n${greetingCriticalRule}`);
  } else {
    parts.push(greetingCriticalRule);
  }

  parts.push(`Правила живого голосового диалога:
1. Говори по-русски как живой собеседник: спокойно, тепло, уверенно, без канцелярита.
2. По умолчанию отвечай коротко: ${tuning.firstReplySentences} короткое предложение или меньше, если этого достаточно.
3. Не превращай разговор в справочный скрипт и не добавляй дежурное предложение помощи к каждой реплике.
4. Сам решай, когда уместно здороваться, уточнять или молчать; не повторяй приветствие без причины.
5. Если пользователь только поздоровался, ответь как живой собеседник и остановись; не задавай встречный вопрос и не начинай справочную поддержку сам.
6. Если пользователь перебил, сразу переключись на новую реплику.
7. Если уточнение действительно нужно, задай один короткий вопрос.
8. Используй browser tools, когда пользователь просит открыть сайт, посмотреть страницу или спрашивает, что видно на текущей странице.
9. Не говори, что сайт открыт, пока tool result не подтвердил ok=true, реальный URL, title и видимое содержимое.
10. Если browser tool вернул ошибку или страницу загрузить не удалось, честно скажи, что видишь ошибку загрузки.
11. Опирайся на подтвержденные знания и видимую страницу. Не выдумывай церковные факты, тексты молитв или содержимое сайта.
12. Если пользователь спрашивает, кто ты или как тебя зовут, отвечай по своей роли из системного промпта, не называй себя техническим id.
13. После ответа остановись и жди следующую реплику пользователя.`);

  const enabledTools = normalizeEnabledTools(runtimeConfig);
  if (enabledTools.size) {
    parts.push(`Realtime tool policy:
There is a browser panel below the avatar. It can be empty, loading, ready with a website, or failed with an error.
You do not see that panel automatically. When your answer depends on the lower browser panel, call get_browser_state or get_visible_page_summary.
When the user asks to open a site, call open_site. Do not say a site is open until the tool result confirms it.
Use query_knowledge only when a small confirmed knowledge lookup is useful. For normal conversation, answer directly without mentioning tools.`);
  } else if (runtimeConfig.advertiseTools !== true) {
    parts.push(`Runtime tool policy:
Browser and website actions are not available in this realtime session.
Do not claim that a website is opened or visible from the user's request alone.
For normal conversation, answer directly and naturally without mentioning tools.`);
  }

  if (sessionContextText) {
    parts.push(`Session bootstrap:\n${sessionContextText}`);
  } else {
    if (summary) {
      parts.push(`Conversation memory:\n${summary}`);
    }
    if (recentTurnsMemory) {
      parts.push(`Recent turns:\n${recentTurnsMemory}`);
    }
  }

  return parts.join('\n\n');
}

export function buildBrowserToolDefinitions(enabledTools) {
  const tools = [];
  if (enabledTools.has('open_site')) {
    tools.push({
      type: 'function',
      name: 'open_site',
      description: 'Open a public website or church resource only when the user explicitly asks to open or view a site.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'User request or site name to open.' },
          url: { type: 'string', description: 'Direct URL when already known.' },
        },
        additionalProperties: false,
      },
    });
  }
  if (enabledTools.has('view_page')) {
    tools.push({
      type: 'function',
      name: 'view_page',
      description: 'Get the current visible state of the active browser page.',
      parameters: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          refresh: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    });
  }
  if (enabledTools.has('get_browser_state')) {
    tools.push({
      type: 'function',
      name: 'get_browser_state',
      description: 'Return the lower browser panel state: empty, ready, or error, including current URL, title, page summary, screenshot metadata, and visible links when available.',
      parameters: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          refresh: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    });
  }
  if (enabledTools.has('extract_page_context')) {
    tools.push({
      type: 'function',
      name: 'extract_page_context',
      description: 'Read the active browser page and extract the answer to a specific question.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          browserSessionId: { type: 'string' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    });
  }
  if (enabledTools.has('get_visible_page_summary')) {
    tools.push({
      type: 'function',
      name: 'get_visible_page_summary',
      description: 'Read the current lower browser page and return a compact summary or answer to a question about what is visible there.',
      parameters: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          question: { type: 'string' },
          maxChars: { type: 'integer' },
        },
        additionalProperties: false,
      },
    });
  }
  if (enabledTools.has('summarize_visible_page')) {
    tools.push({
      type: 'function',
      name: 'summarize_visible_page',
      description: 'Summarize the visible browser page briefly before answering the user.',
      parameters: {
        type: 'object',
        properties: {
          browserSessionId: { type: 'string' },
          maxChars: { type: 'integer' },
        },
        additionalProperties: false,
      },
    });
  }
  return tools;
}

export function buildKnowledgeToolDefinition(enabledTools, runtimeConfig) {
  if (!enabledTools.has('file_search') && !enabledTools.has('query_knowledge') && !enabledTools.has('knowledge_search')) {
    return [];
  }

  const vectorStoreId = normalizeWhitespace(runtimeConfig.vectorStoreId || '');
  const maxToolResults = Math.max(1, Number(runtimeConfig.maxToolResults || DEFAULT_MAX_TOOL_RESULTS) || DEFAULT_MAX_TOOL_RESULTS);

  if (vectorStoreId) {
    return [{
      type: 'file_search',
      vector_store_ids: [vectorStoreId],
      max_num_results: maxToolResults,
    }];
  }

  return [{
    type: 'function',
    name: enabledTools.has('knowledge_search') && !enabledTools.has('query_knowledge') ? 'knowledge_search' : 'query_knowledge',
    description: 'Search the small confirmed local knowledge base for prompts, known sites, FAQ, prayers, or church demo facts.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  }];
}

export function buildWebSearchToolDefinition(runtimeConfig) {
  if (runtimeConfig.webSearchEnabled !== true) {
    return [];
  }

  return [{
    type: 'web_search',
  }];
}

export function buildSessionStartPayload(runtimeConfig = {}, restoreContext = null) {
  const enabledTools = runtimeConfig.advertiseTools === false
    ? new Set()
    : normalizeEnabledTools(runtimeConfig);
  const tools = [
    ...buildKnowledgeToolDefinition(enabledTools, runtimeConfig),
    ...buildWebSearchToolDefinition(runtimeConfig),
    ...buildBrowserToolDefinitions(enabledTools),
  ];

  return {
    type: 'session.update',
    session: {
      model: buildYandexModelId(runtimeConfig.modelId || 'speech-realtime-250923'),
      instructions: buildRealtimeInstructions(runtimeConfig, restoreContext),
      temperature: 0.2,
      voice: normalizeWhitespace(runtimeConfig.ttsVoiceName || runtimeConfig.voiceName || 'ermil') || 'ermil',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: 24000,
            channels: 1,
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 400,
          },
        },
        output: {
          format: {
            type: 'audio/pcm',
            rate: 24000,
          },
          voice: normalizeWhitespace(runtimeConfig.ttsVoiceName || runtimeConfig.voiceName || 'ermil') || 'ermil',
        },
      },
      tools,
    },
  };
}

export function buildResponseCreatePayload() {
  return {
    type: 'response.create',
    response: {
      modalities: ['audio'],
      conversation: 'default',
    },
  };
}

export function splitAudioBase64(audioBase64, chunkBytes = FORCED_REPLY_AUDIO_CHUNK_BYTES) {
  const audioBuffer = Buffer.from(String(audioBase64 || ''), 'base64');
  if (!audioBuffer.length) {
    return [];
  }

  const chunks = [];
  for (let offset = 0; offset < audioBuffer.length; offset += chunkBytes) {
    chunks.push(audioBuffer.subarray(offset, offset + chunkBytes).toString('base64'));
  }
  return chunks;
}

export function buildSyntheticResponseId(prefix = 'forced') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function rememberClosedResponseId(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized) {
    return;
  }
  connectionState.closedResponseIds.add(normalized);
  if (connectionState.closedResponseIds.size > 48) {
    connectionState.closedResponseIds = new Set(Array.from(connectionState.closedResponseIds).slice(-24));
  }
}

export function clearPendingResponseDone(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized) {
    return false;
  }
  const timerId = connectionState.pendingResponseDoneTimers.get(normalized);
  if (timerId) {
    clearTimeout(timerId);
    connectionState.pendingResponseDoneTimers.delete(normalized);
    return true;
  }
  return false;
}

export function isClosedResponseId(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized) {
    return false;
  }
  return connectionState.closedResponseIds.has(normalized);
}

export function shouldForwardResponseCancel(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized || isClosedResponseId(connectionState, normalized)) {
    return false;
  }
  return normalizeWhitespace(connectionState?.activeResponseId || '') === normalized;
}

export function scheduleAssistantTurnDone(clientWs, connectionState, responseId = '', delayMs = RESPONSE_DONE_GRACE_MS) {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized || isClosedResponseId(connectionState, normalized)) {
    return;
  }
  clearPendingResponseDone(connectionState, normalized);
  const timerId = setTimeout(() => {
    connectionState.pendingResponseDoneTimers.delete(normalized);
    if (isClosedResponseId(connectionState, normalized)) {
      return;
    }
    rememberClosedResponseId(connectionState, normalized);
    sendJson(clientWs, { type: 'assistant_turn_done', responseId: normalized });
  }, Math.max(0, Number(delayMs) || RESPONSE_DONE_GRACE_MS));
  connectionState.pendingResponseDoneTimers.set(normalized, timerId);
}

export function isBrowserOpeningAckPrompt(text = '') {
  return /^RUNTIME_BROWSER_OPENING_ACK:/i.test(normalizeWhitespace(text));
}

export function buildModelSafeToolPayload(toolName, payload) {
  const base = payload && typeof payload === 'object' ? payload : { ok: Boolean(payload) };
  const browserPreview = Array.isArray(base?.view?.actionableElements)
    ? base.view.actionableElements
      .slice(0, 8)
      .map((item) => ({
        label: truncate(item?.label || '', 120),
        href: truncate(item?.href || '', 220),
      }))
    : [];

  switch (toolName) {
    case 'open_site':
    case 'view_page':
    case 'get_browser_state':
      return {
        ok: base?.ok !== false,
        status: normalizeWhitespace(base?.status || (base?.ok === false ? 'error' : 'ready')),
        browserSessionId: normalizeWhitespace(base?.browserSessionId || ''),
        verified: base?.verified === true || toolName === 'view_page',
        verificationReason: normalizeWhitespace(base?.verification?.reason || ''),
        title: truncate(base?.title || '', 220),
        url: truncate(base?.url || '', 260),
        summary: truncate(base?.summary || '', 1200),
        error: truncate(base?.error || '', 400),
        visibleLinks: browserPreview,
      };
    case 'extract_page_context':
      return {
        ok: base?.ok !== false,
        browserSessionId: normalizeWhitespace(base?.browserSessionId || ''),
        title: truncate(base?.title || '', 220),
        url: truncate(base?.url || '', 260),
        answer: truncate(base?.answer || '', 1200),
        contextSnippet: truncate(base?.contextSnippet || '', 900),
      };
    case 'get_visible_page_summary':
    case 'summarize_visible_page':
      return {
        ok: base?.ok !== false,
        status: normalizeWhitespace(base?.status || (base?.ok === false ? 'error' : 'ready')),
        browserSessionId: normalizeWhitespace(base?.browserSessionId || ''),
        title: truncate(base?.title || '', 220),
        url: truncate(base?.url || '', 260),
        summary: truncate(base?.summary || base?.answer || '', 1200),
        answer: truncate(base?.answer || '', 1200),
        error: truncate(base?.error || '', 400),
      };
    case 'query_knowledge':
    case 'knowledge_search':
      return {
        ok: base?.ok !== false,
        count: Math.max(0, Number(base?.count || 0) || 0),
        hits: Array.isArray(base?.hits)
          ? base.hits.slice(0, 4).map((hit) => ({
            title: truncate(hit?.title || '', 200),
            canonicalUrl: truncate(hit?.canonicalUrl || '', 260),
            text: truncate(hit?.text || '', 900),
            score: Number(hit?.score || 0),
          }))
          : [],
      };
    default:
      return safeJsonParse(JSON.stringify(base), {
        ok: base?.ok !== false,
      });
  }
}

export function extractToolCall(eventPayload) {
  const eventType = normalizeWhitespace(eventPayload?.type || '');
  if (eventType === 'response.function_call_arguments.done') {
    return {
      name: normalizeWhitespace(eventPayload?.name || ''),
      callId: normalizeWhitespace(eventPayload?.call_id || ''),
      argumentsText: typeof eventPayload?.arguments === 'string' ? eventPayload.arguments : '{}',
    };
  }

  if (eventType === 'response.output_item.done' && eventPayload?.item?.type === 'function_call') {
    return {
      name: normalizeWhitespace(eventPayload?.item?.name || ''),
      callId: normalizeWhitespace(eventPayload?.item?.call_id || ''),
      argumentsText: typeof eventPayload?.item?.arguments === 'string' ? eventPayload.item.arguments : '{}',
    };
  }

  return null;
}

export function extractResponseId(eventPayload) {
  const directId = normalizeWhitespace(eventPayload?.response_id || '');
  if (directId) {
    return directId;
  }
  const nestedId = normalizeWhitespace(eventPayload?.response?.id || '');
  if (nestedId) {
    return nestedId;
  }
  const itemResponseId = normalizeWhitespace(eventPayload?.item?.response_id || '');
  if (itemResponseId) {
    return itemResponseId;
  }
  return '';
}

export function normalizeTranscriptEvent(eventPayload) {
  const eventType = normalizeWhitespace(eventPayload?.type || '');
  if (
    eventType === 'conversation.item.input_audio_transcription.delta'
    || eventType === 'input_audio_transcription.delta'
  ) {
    const text = normalizeWhitespace(eventPayload?.delta || eventPayload?.transcript || '');
    if (!text) {
      return null;
    }
    return {
      type: 'partial_transcript',
      text,
    };
  }
  if (
    eventType === 'conversation.item.input_audio_transcription.completed'
    || eventType === 'input_audio_transcription.completed'
  ) {
    const text = normalizeWhitespace(eventPayload?.transcript || eventPayload?.text || '');
    if (!text) {
      return null;
    }
    return {
      type: 'final_transcript',
      text,
    };
  }
  return null;
}

export function normalizeAssistantOutputEvent(eventPayload, connectionState = null) {
  const eventType = normalizeWhitespace(eventPayload?.type || '');
  const responseId = extractResponseId(eventPayload) || normalizeWhitespace(connectionState?.activeResponseId || '');
  if (eventType === 'response.output_text.delta' || eventType === 'response.text.delta') {
    return {
      type: 'assistant_text_delta',
      responseId,
      text: String(eventPayload?.delta || ''),
    };
  }
  if (eventType === 'response.output_audio_transcript.done') {
    return {
      type: 'assistant_text_delta',
      responseId,
      text: String(eventPayload?.transcript || ''),
    };
  }
  if (eventType === 'response.output_audio.delta' || eventType === 'response.audio.delta') {
    return {
      type: 'assistant_audio_delta',
      responseId,
      audio: String(eventPayload?.delta || ''),
      sampleRate: DEFAULT_OUTPUT_SAMPLE_RATE,
    };
  }
  if (eventType === 'response.done') {
    const outputItems = Array.isArray(eventPayload?.response?.output) ? eventPayload.response.output : [];
    if (outputItems.some((item) => normalizeWhitespace(item?.type || '') === 'function_call')) {
      return null;
    }
    return { type: 'assistant_turn_done', responseId };
  }
  if (eventType === 'input_audio_buffer.speech_started') {
    return { type: 'speech_started' };
  }
  return null;
}

