import { WebSocket } from 'ws';
import {
  detectBrowserIntent,
  getBrowserSessionContext,
  getBrowserSessionView,
  openBrowserIntent,
  queryBrowserSession,
} from './browserController.js';
import { loadAppConfig } from './configStore.js';
import { searchKnowledge } from './knowledgeStore.js';
import { getConversationRestoreContext, setConversationBrowserState, setConversationKnowledgeHits } from './conversationStore.js';
import { logRuntime } from './runtimeLogger.js';

const YANDEX_REALTIME_URL = process.env.YANDEX_REALTIME_URL || 'wss://ai.api.cloud.yandex.net/v1/realtime/openai';
const YANDEX_API_KEY = normalizeWhitespace(process.env.YANDEX_API_KEY || '');
const YANDEX_IAM_TOKEN = normalizeWhitespace(process.env.YANDEX_IAM_TOKEN || '');
const YANDEX_FOLDER_ID = normalizeWhitespace(process.env.YANDEX_FOLDER_ID || '');
const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;
const DEFAULT_MAX_TOOL_RESULTS = 4;
const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const FORCED_REPLY_TTS_SAMPLE_RATE = 48000;
const FORCED_REPLY_AUDIO_CHUNK_BYTES = 262144;
const RESPONSE_DONE_GRACE_MS = 140;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildYandexApiAuthorizationHeader() {
  if (YANDEX_API_KEY) {
    return `Api-Key ${YANDEX_API_KEY}`;
  }
  if (YANDEX_IAM_TOKEN) {
    return `Bearer ${YANDEX_IAM_TOKEN}`;
  }
  throw new Error('Yandex auth is not configured');
}

function buildYandexAuthHeaders() {
  return {
    Authorization: buildYandexApiAuthorizationHeader(),
    'OpenAI-Beta': 'realtime=v1',
  };
}

function buildYandexModelId(modelId = '') {
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

function buildYandexRealtimeSocketUrl(modelId = '') {
  const socketUrl = new URL(YANDEX_REALTIME_URL);
  socketUrl.searchParams.set('model', buildYandexModelId(modelId || 'speech-realtime-250923'));
  return socketUrl.toString();
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function closeBothSockets(clientWs, upstreamWs, code = 1011, reason = 'Upstream closed') {
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

function truncate(text, maxLength = 800) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function summarizeText(text, maxLength = 420) {
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

function normalizeEnabledTools(runtimeConfig = {}) {
  return new Set(
    (Array.isArray(runtimeConfig.enabledTools) ? runtimeConfig.enabledTools : [])
      .map((tool) => normalizeWhitespace(tool).toLowerCase())
      .filter(Boolean),
  );
}

function buildRealtimeInstructions(runtimeConfig = {}, restoreContext = null) {
  const parts = [];
  const systemPrompt = normalizeWhitespace(runtimeConfig.systemPrompt || '');
  const sessionContextText = normalizeWhitespace(runtimeConfig.sessionContextText || '');
  const summary = normalizeWhitespace(restoreContext?.summary || '');

  if (systemPrompt) {
    parts.push(systemPrompt);
  }

  parts.push(`Realtime voice rules:
1. Speak as a polished live voice avatar in Russian: calm, warm, confident.
2. By default answer in 1-2 short sentences with one main idea.
3. Do not repeat greetings, do not re-introduce yourself, and do not start with long ceremonial prefaces unless the user explicitly asks for that.
4. Do not speak bureaucratically and do not repeat the user's question almost word for word.
5. If clarification is needed, ask only one short follow-up question.
6. If the user interrupts, stop the current answer and continue from the new request.
7. If you are waiting for a tool or browser action, one short neutral phrase is enough.
8. Use browser tools only when the user explicitly asks to open or inspect a site.
9. Prefer confirmed knowledge first. Do not invent church facts or prayer texts.
10. If the user asks who you are or what your name is, say only that your name is Nikolai. Never call yourself "Batyushka 3".`);

  if (sessionContextText) {
    parts.push(`Session bootstrap:\n${sessionContextText}`);
  } else if (summary) {
    parts.push(`Conversation memory:\n${summary}`);
  }

  return parts.join('\n\n');
}

function buildBrowserToolDefinitions(enabledTools) {
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

function buildKnowledgeToolDefinition(enabledTools, runtimeConfig) {
  if (!enabledTools.has('file_search')) {
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
    name: 'knowledge_search',
    description: 'Search confirmed church knowledge when file search is not yet configured.',
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

function buildWebSearchToolDefinition(runtimeConfig) {
  if (runtimeConfig.webSearchEnabled !== true) {
    return [];
  }

  return [{
    type: 'web_search',
  }];
}

function buildSessionStartPayload(runtimeConfig = {}, restoreContext = null) {
  const enabledTools = normalizeEnabledTools(runtimeConfig);
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
            prefix_padding_ms: 300,
            silence_duration_ms: 400,
            create_response: false,
            interrupt_response: true,
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

function buildResponseCreatePayload() {
  return {
    type: 'response.create',
    response: {
      modalities: ['audio'],
      conversation: 'default',
    },
  };
}

async function requestYandexTts({ text, voice = 'ermil', sampleRateHertz = FORCED_REPLY_TTS_SAMPLE_RATE } = {}) {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) {
    return { audioBase64: '', sampleRateHertz };
  }

  const form = new URLSearchParams({
    text: normalizedText,
    lang: 'ru-RU',
    voice: normalizeWhitespace(voice || 'ermil') || 'ermil',
    format: 'lpcm',
    sampleRateHertz: String(sampleRateHertz || FORCED_REPLY_TTS_SAMPLE_RATE),
  });

  const response = await fetch(YANDEX_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: buildYandexApiAuthorizationHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const audioArrayBuffer = await response.arrayBuffer();
  if (!response.ok) {
    const errorText = Buffer.from(audioArrayBuffer).toString('utf8');
    throw new Error(normalizeWhitespace(errorText) || `Yandex TTS failed (${response.status})`);
  }

  return {
    audioBase64: Buffer.from(audioArrayBuffer).toString('base64'),
    sampleRateHertz: Number(sampleRateHertz || FORCED_REPLY_TTS_SAMPLE_RATE) || FORCED_REPLY_TTS_SAMPLE_RATE,
  };
}

function splitAudioBase64(audioBase64, chunkBytes = FORCED_REPLY_AUDIO_CHUNK_BYTES) {
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

function buildSyntheticResponseId(prefix = 'forced') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rememberClosedResponseId(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized) {
    return;
  }
  connectionState.closedResponseIds.add(normalized);
  if (connectionState.closedResponseIds.size > 48) {
    connectionState.closedResponseIds = new Set(Array.from(connectionState.closedResponseIds).slice(-24));
  }
}

function clearPendingResponseDone(connectionState, responseId = '') {
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

function isClosedResponseId(connectionState, responseId = '') {
  const normalized = normalizeWhitespace(responseId);
  if (!normalized) {
    return false;
  }
  return connectionState.closedResponseIds.has(normalized);
}

function scheduleAssistantTurnDone(clientWs, connectionState, responseId = '', delayMs = RESPONSE_DONE_GRACE_MS) {
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

function isBrowserOpeningAckPrompt(text = '') {
  return /^RUNTIME_BROWSER_OPENING_ACK:/i.test(normalizeWhitespace(text));
}

async function sendForcedAssistantReply(clientWs, connectionState, text, options = {}) {
  const normalizedText = normalizeWhitespace(text);
  const responseId = normalizeWhitespace(options.responseId || '') || buildSyntheticResponseId('forced');
  clearPendingResponseDone(connectionState, responseId);
  if (!normalizedText) {
    rememberClosedResponseId(connectionState, responseId);
    sendJson(clientWs, { type: 'assistant_turn_done', responseId });
    return;
  }

  sendJson(clientWs, { type: 'assistant_text_delta', responseId, text: normalizedText });

  try {
    const ttsResult = await requestYandexTts({
      text: normalizedText,
      voice: normalizeWhitespace(connectionState.runtimeConfig?.ttsVoiceName || connectionState.runtimeConfig?.voiceName || 'ermil') || 'ermil',
    });
    splitAudioBase64(ttsResult.audioBase64).forEach((audioChunk) => {
      sendJson(clientWs, {
        type: 'assistant_audio_delta',
        responseId,
        audio: audioChunk,
        sampleRate: ttsResult.sampleRateHertz,
      });
    });
  } catch (error) {
    logRuntime('yandex.realtime.forced-tts.error', {
      route: connectionState.route,
      conversationSessionId: connectionState.conversationSessionId,
      characterId: connectionState.characterId,
      error,
    }, 'error');
  }

  rememberClosedResponseId(connectionState, responseId);
  sendJson(clientWs, { type: 'assistant_turn_done', responseId });
}

function _shouldForceBrowserOpenRuLegacy(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(^|\s)(открой|открыть|зайди|перейди|покажи\s+сайт|открой\s+сайт|загрузи\s+сайт)(?=\s|$)/i.test(normalized);
}

function _buildForcedBrowserReply(result = {}) {
  const title = normalizeWhitespace(result.title || '');
  const url = normalizeWhitespace(result.url || '');
  const summary = truncate(result.summary || '', 120);
  if (summary) {
    return `Открыл сайт${title ? ` «${title}»` : ''}${url ? `: ${url}` : ''}. Коротко: ${summary}`;
  }
  if (title || url) {
    return `Открыл сайт${title ? ` «${title}»` : ''}${url ? `: ${url}` : ''}.`;
  }
  return 'Сайт открыт.';
}

function _resolveKnownChurchSiteUrl(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return '';
  }
  if (/(московск(?:ого|ий)\s+патриархат|московский\s+патриархат|патриархия)/i.test(normalized)) {
    return 'https://patriarchia.ru/';
  }
  if (/(белорусск(?:ая|ой)\s+православн(?:ая|ой)\s+церк|church\.by|минск(?:ая|ой)\s+епарх)/i.test(normalized)) {
    return 'http://church.by/';
  }
  if (/(азбук[аи]|azbyka)/i.test(normalized)) {
    return 'https://azbyka.ru/';
  }
  if (/(правмир|pravmir)/i.test(normalized)) {
    return 'https://www.pravmir.ru/';
  }
  return '';
}

function _shouldForceSelfIntro(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(кто\s+ты|кто\s+вы|как\s+тебя\s+зовут|как\s+вас\s+зовут|представься|представьтесь)/i.test(normalized);
}

function _buildForcedSelfIntroReply(connectionState) {
  if (connectionState.characterId === 'batyushka-3') {
    return 'Я Николай. Спокойно и по делу помогаю по церковным вопросам, могу подсказать и открыть нужный церковный сайт.';
  }
  return 'Я голосовой помощник. Могу коротко и естественно ответить на вопрос и, если нужно, открыть сайт.';
}


function shouldForceBrowserOpenRu(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(^|\s)(открой|открыть|зайди|перейди|покажи\s+сайт|открой\s+сайт|загрузи\s+сайт)(?=\s|$)/i.test(normalized);
}

function buildForcedBrowserReplyRu(result = {}) {
  const title = normalizeWhitespace(result.title || '');
  const url = normalizeWhitespace(result.url || '');
  const summary = truncate(result.summary || '', 120);
  if (summary) {
    return `Открыл сайт${title ? ` «${title}»` : ''}${url ? `: ${url}` : ''}. Коротко: ${summary}`;
  }
  if (title || url) {
    return `Открыл сайт${title ? ` «${title}»` : ''}${url ? `: ${url}` : ''}.`;
  }
  return 'Сайт открыт.';
}

function resolveKnownChurchSiteUrlRu(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return '';
  }
  if (/(московск(?:ого|ий)\s+патриархат|патриархия)/i.test(normalized)) {
    return 'https://patriarchia.ru/';
  }
  if (/(белорусск(?:ая|ой)\s+православн(?:ая|ой)\s+церк|church\.by|минск(?:ая|ой)\s+епарх)/i.test(normalized)) {
    return 'http://church.by/';
  }
  if (/(азбук[аи]|azbyka)/i.test(normalized)) {
    return 'https://azbyka.ru/';
  }
  if (/(правмир|pravmir)/i.test(normalized)) {
    return 'https://www.pravmir.ru/';
  }
  return '';
}

function shouldForceSelfIntroRu(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(кто\s+ты|кто\s+вы|как\s+тебя\s+зовут|как\s+вас\s+зовут|представься|представьтесь)/i.test(normalized);
}

function buildForcedSelfIntroReplyRu(connectionState) {
  if (connectionState.characterId === 'batyushka-3') {
    return 'Я Николай. Спокойно и по делу помогаю по церковным вопросам, могу подсказать и открыть нужный церковный сайт.';
  }
  return 'Я голосовой помощник. Могу коротко и естественно ответить на вопрос и, если нужно, открыть сайт.';
}


async function resolveCharacterConfig(characterId = '') {
  const appConfig = await loadAppConfig();
  const character = Array.isArray(appConfig?.characters)
    ? appConfig.characters.find((item) => item.id === characterId) || appConfig.characters[0] || null
    : null;
  return { appConfig, character };
}

async function resolveActiveBrowserSessionId(conversationSessionId = '', requestedSessionId = '') {
  const explicitSessionId = normalizeWhitespace(requestedSessionId);
  if (explicitSessionId) {
    return explicitSessionId;
  }
  if (!conversationSessionId) {
    return '';
  }
  const restoreContext = await getConversationRestoreContext(conversationSessionId).catch(() => null);
  return normalizeWhitespace(restoreContext?.browserSessionId || '');
}

async function toolOpenSite(args = {}, connectionState) {
  const transcript = normalizeWhitespace(args.query || args.url || '');
  if (!transcript) {
    throw new Error('open_site requires query or url');
  }
  if (/^RUNTIME_[A-Z_]+:/i.test(transcript) || /ассистент уже поздоровался/i.test(transcript)) {
    throw new Error('Browser tool is blocked for runtime system prompts');
  }

  const { appConfig, character } = await resolveCharacterConfig(connectionState.characterId);
  const restoreContext = await getConversationRestoreContext(connectionState.conversationSessionId).catch(() => null);
  const directUrl = normalizeWhitespace(args.url || '');
  const traceId = `rt-browser-${Date.now().toString(36)}`;
  const intent = directUrl
    ? {
      type: 'direct-site',
      url: directUrl,
      traceId,
      titleHint: normalizeWhitespace(args.query || directUrl),
      resolutionSource: 'tool-direct-url',
      confidence: 1,
      candidates: [{ title: normalizeWhitespace(args.query || directUrl), url: directUrl, score: 1 }],
    }
    : await detectBrowserIntent({
      transcript,
      webProviders: appConfig?.webProviders || {},
      knowledgeSources: appConfig?.knowledgeSources || [],
      recentTurns: Array.isArray(restoreContext?.recentTurns) ? restoreContext.recentTurns : [],
      contextHint: character?.systemPrompt || '',
      sessionHistory: [],
      traceId,
    });

  if (!intent || intent.type === 'none' || intent.type === 'unresolved-site' || !intent.url) {
    throw new Error(intent?.error || 'Не удалось определить сайт для открытия');
  }

  const opened = await openBrowserIntent(intent);
  const browserSessionId = normalizeWhitespace(opened?.browserSessionId || '');
  if (!browserSessionId) {
    throw new Error('Browser session was not created');
  }
  const [view, pageContext] = await Promise.all([
    getBrowserSessionView(browserSessionId, { refresh: true }),
    getBrowserSessionContext(browserSessionId).catch(() => null),
  ]);

  await setConversationBrowserState(connectionState.conversationSessionId, {
    browserSessionId,
    title: opened?.title || view?.title || '',
    url: opened?.url || view?.url || '',
    lastUpdated: view?.lastUpdated || pageContext?.lastUpdated || null,
  }, { characterId: connectionState.characterId });

  return {
    ok: true,
    browserSessionId,
    title: opened?.title || view?.title || '',
    url: opened?.url || view?.url || '',
    summary: summarizeText(pageContext?.readerText || ''),
    view,
  };
}

async function toolViewPage(args = {}, connectionState) {
  const browserSessionId = await resolveActiveBrowserSessionId(
    connectionState.conversationSessionId,
    args.browserSessionId,
  );
  if (!browserSessionId) {
    throw new Error('Нет активного сайта для просмотра');
  }
  const [view, pageContext] = await Promise.all([
    getBrowserSessionView(browserSessionId, { refresh: args.refresh === true }),
    getBrowserSessionContext(browserSessionId),
  ]);
  await setConversationBrowserState(connectionState.conversationSessionId, {
    browserSessionId,
    title: view?.title || pageContext?.title || '',
    url: view?.url || pageContext?.url || '',
    lastUpdated: view?.lastUpdated || pageContext?.lastUpdated || null,
  }, { characterId: connectionState.characterId });
  return {
    ok: true,
    browserSessionId,
    title: pageContext?.title || view?.title || '',
    url: pageContext?.url || view?.url || '',
    summary: summarizeText(pageContext?.readerText || ''),
    view,
  };
}

async function toolExtractPageContext(args = {}, connectionState) {
  const question = normalizeWhitespace(args.question || '');
  if (!question) {
    throw new Error('extract_page_context requires question');
  }
  const browserSessionId = await resolveActiveBrowserSessionId(
    connectionState.conversationSessionId,
    args.browserSessionId,
  );
  if (!browserSessionId) {
    throw new Error('Нет активного сайта для чтения контекста');
  }

  const result = await queryBrowserSession({
    sessionId: browserSessionId,
    question,
  });
  await setConversationBrowserState(connectionState.conversationSessionId, {
    browserSessionId,
    title: result?.title || '',
    url: result?.url || '',
    lastUpdated: result?.lastUpdated || null,
  }, { characterId: connectionState.characterId });
  return {
    ok: true,
    browserSessionId,
    title: result?.title || '',
    url: result?.url || '',
    answer: result?.answer || '',
    contextSnippet: result?.contextSnippet || '',
  };
}

async function toolSummarizeVisiblePage(args = {}, connectionState) {
  const browserSessionId = await resolveActiveBrowserSessionId(
    connectionState.conversationSessionId,
    args.browserSessionId,
  );
  if (!browserSessionId) {
    throw new Error('Нет активного сайта для краткого пересказа');
  }

  const pageContext = await getBrowserSessionContext(browserSessionId);
  const maxChars = Math.max(120, Number(args.maxChars || 420) || 420);
  await setConversationBrowserState(connectionState.conversationSessionId, {
    browserSessionId,
    title: pageContext?.title || '',
    url: pageContext?.url || '',
    lastUpdated: pageContext?.lastUpdated || null,
  }, { characterId: connectionState.characterId });
  return {
    ok: true,
    browserSessionId,
    title: pageContext?.title || '',
    url: pageContext?.url || '',
    summary: summarizeText(pageContext?.readerText || '', maxChars),
  };
}

async function toolKnowledgeSearch(args = {}, connectionState) {
  const question = normalizeWhitespace(args.question || '');
  if (!question) {
    throw new Error('knowledge_search requires question');
  }
  const { character } = await resolveCharacterConfig(connectionState.characterId);
  const limit = Math.max(1, Math.min(6, Number(args.limit || DEFAULT_MAX_TOOL_RESULTS) || DEFAULT_MAX_TOOL_RESULTS));
  const result = await searchKnowledge({
    question,
    character,
    limit,
  });
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  await setConversationKnowledgeHits(connectionState.conversationSessionId, hits, {
    characterId: connectionState.characterId,
  });
  return {
    ok: true,
    count: hits.length,
    hits: hits.map((hit) => ({
      title: hit.title,
      canonicalUrl: hit.canonicalUrl,
      text: truncate(hit.confirmedExcerpt || hit.text || '', 800),
      score: Number(hit.score || 0),
    })),
  };
}

async function executeToolCall(toolName, rawArgs, connectionState) {
  switch (toolName) {
    case 'open_site':
      return toolOpenSite(rawArgs, connectionState);
    case 'view_page':
      return toolViewPage(rawArgs, connectionState);
    case 'extract_page_context':
      return toolExtractPageContext(rawArgs, connectionState);
    case 'summarize_visible_page':
      return toolSummarizeVisiblePage(rawArgs, connectionState);
    case 'knowledge_search':
      return toolKnowledgeSearch(rawArgs, connectionState);
    default:
      throw new Error(`Unsupported realtime tool: ${toolName}`);
  }
}

function buildModelSafeToolPayload(toolName, payload) {
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
      return {
        ok: base?.ok !== false,
        browserSessionId: normalizeWhitespace(base?.browserSessionId || ''),
        title: truncate(base?.title || '', 220),
        url: truncate(base?.url || '', 260),
        summary: truncate(base?.summary || '', 1200),
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
    case 'summarize_visible_page':
      return {
        ok: base?.ok !== false,
        browserSessionId: normalizeWhitespace(base?.browserSessionId || ''),
        title: truncate(base?.title || '', 220),
        url: truncate(base?.url || '', 260),
        summary: truncate(base?.summary || '', 1200),
      };
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

function extractToolCall(eventPayload) {
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

function extractResponseId(eventPayload) {
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

function normalizeTranscriptEvent(eventPayload) {
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

function normalizeAssistantOutputEvent(eventPayload, connectionState = null) {
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

export function attachYandexRealtimeBridgeConnection(clientWs, { voiceSession = null, route = 'yandex-realtime-proxy' } = {}) {
  let upstreamWs = null;
  let upstreamConnectPromise = null;
  const connectionState = {
    route,
    conversationSessionId: normalizeWhitespace(voiceSession?.conversationSessionId || ''),
    characterId: normalizeWhitespace(voiceSession?.characterId || ''),
    runtimeConfig: {},
    restoreContext: null,
    upstreamReady: false,
    sessionConfigured: false,
    clientClosed: false,
    clientQueue: [],
    responseCreateTimer: null,
    awaitingToolResult: false,
    readySent: false,
    responseIdsWithTextDelta: new Set(),
    activeResponseId: '',
    pendingResponseDoneTimers: new Map(),
    closedResponseIds: new Set(),
  };

  const clearResponseCreateTimer = () => {
    if (connectionState.responseCreateTimer) {
      clearTimeout(connectionState.responseCreateTimer);
      connectionState.responseCreateTimer = null;
    }
  };

  const scheduleResponseCreate = (delayMs = 260) => {
    if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
      return;
    }
    if (connectionState.awaitingToolResult) {
      return;
    }
    clearResponseCreateTimer();
    connectionState.responseCreateTimer = setTimeout(() => {
      connectionState.responseCreateTimer = null;
      if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
        return;
      }
      upstreamWs.send(JSON.stringify(buildResponseCreatePayload()));
    }, delayMs);
  };

  const flushQueuedClientMessages = async () => {
    if (!connectionState.upstreamReady || !connectionState.clientQueue.length) {
      return;
    }
    const queued = [...connectionState.clientQueue];
    connectionState.clientQueue = [];
    for (const message of queued) {
      await handleClientMessage(message);
    }
  };

  const attachUpstreamHandlers = () => {
    upstreamWs.on('open', async () => {
      connectionState.upstreamReady = true;
      logRuntime('yandex.realtime.connected', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
      });
      await flushQueuedClientMessages();
    });

    upstreamWs.on('message', async (rawData) => {
      const asText = rawData instanceof Buffer ? rawData.toString('utf8') : String(rawData || '');
      const eventPayload = safeJsonParse(asText, null);
      if (!eventPayload || typeof eventPayload !== 'object') {
        return;
      }

      const toolCall = extractToolCall(eventPayload);
      if (toolCall?.name && toolCall.callId) {
        clearResponseCreateTimer();
        connectionState.awaitingToolResult = true;
        await handleToolCall(toolCall);
        return;
      }

      if (eventPayload.type === 'session.updated') {
        if (!connectionState.readySent) {
          connectionState.readySent = true;
          sendJson(clientWs, {
            type: 'ready',
            resumed: false,
            shouldSendGreeting: connectionState.runtimeConfig.shouldSendGreeting !== false,
          });
        }
        return;
      }

      const transcriptEvent = normalizeTranscriptEvent(eventPayload);
      if (transcriptEvent) {
        sendJson(clientWs, transcriptEvent);
        return;
      }

      if (eventPayload.type === 'response.created') {
        connectionState.activeResponseId = extractResponseId(eventPayload) || connectionState.activeResponseId;
        return;
      }

      const assistantEvent = normalizeAssistantOutputEvent(eventPayload, connectionState);
      if (assistantEvent) {
        const responseId = normalizeWhitespace(assistantEvent.responseId || extractResponseId(eventPayload) || '');
        if (eventPayload.type === 'response.output_text.delta' && responseId) {
          connectionState.responseIdsWithTextDelta.add(responseId);
        }
        if (
          eventPayload.type === 'response.output_audio_transcript.done'
          && responseId
          && connectionState.responseIdsWithTextDelta.has(responseId)
        ) {
          return;
        }
        if (responseId && isClosedResponseId(connectionState, responseId)) {
          return;
        }
        if (
          responseId
          && (
            assistantEvent.type === 'assistant_text_delta'
            || assistantEvent.type === 'assistant_audio_delta'
          )
        ) {
          const hadPendingDone = clearPendingResponseDone(connectionState, responseId);
          if (hadPendingDone) {
            scheduleAssistantTurnDone(clientWs, connectionState, responseId);
          }
        }
        if (eventPayload.type === 'response.done' && responseId) {
          connectionState.responseIdsWithTextDelta.delete(responseId);
          if (connectionState.activeResponseId === responseId) {
            connectionState.activeResponseId = '';
          }
          scheduleAssistantTurnDone(clientWs, connectionState, responseId);
          return;
        }
        sendJson(clientWs, assistantEvent);
        return;
      }

      if (eventPayload.type === 'error') {
        const errorMessage = normalizeWhitespace(eventPayload?.error?.message || eventPayload?.message || 'Yandex realtime error');
        if (/no such response|unknown response/i.test(errorMessage)) {
          logRuntime('yandex.realtime.response-cancel.ignored', {
            route,
            conversationSessionId: connectionState.conversationSessionId,
            characterId: connectionState.characterId,
            message: errorMessage,
          });
          return;
        }
        sendJson(clientWs, {
          type: 'error',
          message: errorMessage,
          details: eventPayload,
        });
      }
    });

    upstreamWs.on('error', (error) => {
      logRuntime('yandex.realtime.error', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        error,
      }, 'error');
      sendJson(clientWs, {
        type: 'error',
        message: normalizeWhitespace(error?.message || 'Yandex realtime connection failed'),
      });
    });

    upstreamWs.on('close', (code, reason) => {
      connectionState.upstreamReady = false;
      connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
      connectionState.pendingResponseDoneTimers.clear();
      const closeReason = normalizeWhitespace(reason?.toString?.() || '');
      logRuntime('yandex.realtime.closed', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        code,
        reason: closeReason,
      });
      if (!connectionState.clientClosed) {
        closeBothSockets(clientWs, upstreamWs, Number(code) || 1011, closeReason || 'Yandex realtime closed');
      }
    });
  };

  const ensureUpstreamConnection = async (runtimeConfig = {}) => {
    if (connectionState.upstreamReady && upstreamWs) {
      return upstreamWs;
    }
    if (upstreamConnectPromise) {
      await upstreamConnectPromise;
      return upstreamWs;
    }

    upstreamWs = new WebSocket(buildYandexRealtimeSocketUrl(runtimeConfig.modelId || 'speech-realtime-250923'), {
      headers: buildYandexAuthHeaders(),
    });
    attachUpstreamHandlers();

    upstreamConnectPromise = new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        upstreamWs?.off('open', handleOpen);
        upstreamWs?.off('error', handleError);
        upstreamConnectPromise = null;
      };
      upstreamWs.on('open', handleOpen);
      upstreamWs.on('error', handleError);
    });

    await upstreamConnectPromise;
    return upstreamWs;
  };

  const configureSession = async (runtimeConfig = {}) => {
    connectionState.runtimeConfig = {
      ...runtimeConfig,
    };
    connectionState.restoreContext = connectionState.conversationSessionId
      ? await getConversationRestoreContext(connectionState.conversationSessionId).catch(() => null)
      : null;

    upstreamWs.send(JSON.stringify(buildSessionStartPayload(connectionState.runtimeConfig, connectionState.restoreContext)));
    connectionState.sessionConfigured = true;
  };

  const sendToolOutputBackToModel = (callId, payload) => {
    connectionState.awaitingToolResult = false;
    upstreamWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(payload),
      },
    }));
    scheduleResponseCreate();
  };

  const handleToolCall = async (toolCall) => {
    const rawArgs = safeJsonParse(toolCall.argumentsText, {}) || {};
    sendJson(clientWs, {
      type: 'tool_call',
      name: toolCall.name,
      callId: toolCall.callId,
      arguments: rawArgs,
    });

    let payload;
    let modelPayload;
    try {
      const result = await executeToolCall(toolCall.name, rawArgs, connectionState);
      payload = result;
      modelPayload = buildModelSafeToolPayload(toolCall.name, result);
      sendJson(clientWs, {
        type: 'tool_result',
        name: toolCall.name,
        callId: toolCall.callId,
        result,
      });
      logRuntime('yandex.realtime.tool.ok', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        toolName: toolCall.name,
      });
    } catch (toolError) {
      payload = {
        ok: false,
        error: normalizeWhitespace(toolError?.message || 'Tool failed'),
      };
      modelPayload = payload;
      sendJson(clientWs, {
        type: 'tool_result',
        name: toolCall.name,
        callId: toolCall.callId,
        result: payload,
      });
      logRuntime('yandex.realtime.tool.error', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        toolName: toolCall.name,
        error: toolError,
      }, 'error');
    }

    sendToolOutputBackToModel(toolCall.callId, modelPayload);
  };

  async function handleClientMessage(messageText) {
    const payload = safeJsonParse(messageText, null);
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'session.start' && !connectionState.upstreamReady) {
      connectionState.clientQueue.push(messageText);
      await ensureUpstreamConnection(payload.runtimeConfig || {});
      return;
    }

    if (!connectionState.upstreamReady) {
      connectionState.clientQueue.push(messageText);
      return;
    }

    switch (payload.type) {
      case 'session.start': {
        await configureSession(payload.runtimeConfig || {});
        break;
      }
      case 'audio.append': {
        if (!connectionState.sessionConfigured) {
          return;
        }
        upstreamWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: String(payload.audio || ''),
        }));
        break;
      }
      case 'input_text': {
        const text = normalizeWhitespace(payload.text || '');
        const origin = normalizeWhitespace(payload.origin || 'user_text') || 'user_text';
        const allowForceHandlers = payload.allowForceHandlers !== false && origin === 'user_text';
        if (!text || !connectionState.sessionConfigured) {
          return;
        }
        if (isBrowserOpeningAckPrompt(text)) {
          await sendForcedAssistantReply(clientWs, connectionState, 'Открываю сайт, одну секунду.', {
            responseId: buildSyntheticResponseId('browser-ack'),
          });
          return;
        }
        if (allowForceHandlers && shouldForceSelfIntroRu(text)) {
          await sendForcedAssistantReply(clientWs, connectionState, buildForcedSelfIntroReplyRu(connectionState));
          return;
        }
        if (
          allowForceHandlers
          && shouldForceBrowserOpenRu(text)
          && normalizeEnabledTools(connectionState.runtimeConfig).has('open_site')
        ) {
          const callId = `forced-open-site-${Date.now().toString(36)}`;
          const directUrl = resolveKnownChurchSiteUrlRu(text);
          sendJson(clientWs, {
            type: 'tool_call',
            name: 'open_site',
            callId,
            arguments: directUrl ? { query: text, url: directUrl } : { query: text },
          });
          await sendForcedAssistantReply(clientWs, connectionState, 'Открываю сайт, одну секунду.');
          void (async () => {
            try {
              const result = await toolOpenSite(
                directUrl ? { query: text, url: directUrl } : { query: text },
                connectionState,
              );
              sendJson(clientWs, {
                type: 'tool_result',
                name: 'open_site',
                callId,
                result,
              });
              const replyText = buildForcedBrowserReplyRu(result);
              await sendForcedAssistantReply(clientWs, connectionState, replyText);
            } catch (error) {
              sendJson(clientWs, {
                type: 'error',
                message: normalizeWhitespace(error?.message || 'Не удалось открыть сайт'),
              });
            }
          })();
          return;
        }
        upstreamWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text,
              },
            ],
          },
        }));
        upstreamWs.send(JSON.stringify(buildResponseCreatePayload()));
        break;
      }
      case 'interrupt': {
        // Yandex realtime may close the whole upstream socket after response.cancel.
        // Keep the local barge-in behavior, but avoid cancelling upstream here.
        const responseId = normalizeWhitespace(payload.responseId || connectionState.activeResponseId || '');
        if (responseId) {
          clearPendingResponseDone(connectionState, responseId);
          rememberClosedResponseId(connectionState, responseId);
          sendJson(clientWs, {
            type: 'assistant_turn_cancelled',
            responseId,
            reason: 'client_interrupt',
          });
        }
        if (connectionState.activeResponseId === responseId) {
          connectionState.activeResponseId = '';
        }
        break;
      }
      case 'session.stop': {
        closeBothSockets(clientWs, upstreamWs, 1000, 'Session stopped');
        break;
      }
      default:
        break;
    }
  }

  clientWs.on('message', (rawData) => {
    const asText = rawData instanceof Buffer ? rawData.toString('utf8') : String(rawData || '');
    void handleClientMessage(asText);
  });

  clientWs.on('close', (code, reason) => {
    connectionState.clientClosed = true;
    clearResponseCreateTimer();
    connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
    connectionState.pendingResponseDoneTimers.clear();
    logRuntime('yandex.realtime.client.closed', {
      route,
      conversationSessionId: connectionState.conversationSessionId,
      characterId: connectionState.characterId,
      code,
      reason: normalizeWhitespace(reason?.toString?.() || ''),
    });
    closeBothSockets(clientWs, upstreamWs, 1000, 'Client disconnected');
  });

  clientWs.on('error', (error) => {
    connectionState.clientClosed = true;
    clearResponseCreateTimer();
    connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
    connectionState.pendingResponseDoneTimers.clear();
    logRuntime('yandex.realtime.client.error', {
      route,
      conversationSessionId: connectionState.conversationSessionId,
      characterId: connectionState.characterId,
      message: normalizeWhitespace(error?.message || 'Client websocket error'),
    });
    closeBothSockets(clientWs, upstreamWs, 1011, 'Client error');
  });
}
