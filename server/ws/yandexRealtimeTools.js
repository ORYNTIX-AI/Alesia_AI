import {
  detectBrowserIntent,
  getBrowserSessionContext,
  getBrowserSessionView,
  openBrowserIntent,
  queryBrowserSession,
} from '../browser/index.js';
import { loadAppConfig } from '../configStore.js';
import { searchKnowledge } from '../knowledgeStore.js';
import { getConversationRestoreContext, setConversationBrowserState, setConversationKnowledgeHits } from '../conversationStore.js';
import {
  DEFAULT_MAX_TOOL_RESULTS,
  FORCED_REPLY_AUDIO_CHUNK_BYTES,
  FORCED_REPLY_TTS_SAMPLE_RATE,
  RESPONSE_DONE_GRACE_MS,
  YANDEX_TTS_URL,
  buildYandexApiAuthorizationHeader,
  buildSyntheticResponseId,
  normalizeEnabledTools,
  normalizeWhitespace,
  sendJson,
  splitAudioBase64,
  summarizeText,
  truncate,
} from './yandexRealtimeShared.js';
import { logRuntime } from '../runtimeLogger.js';

export async function requestYandexTts({ text, voice = 'ermil', sampleRateHertz = FORCED_REPLY_TTS_SAMPLE_RATE } = {}) {
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

export async function sendForcedAssistantReply(clientWs, connectionState, text, options = {}) {
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



export function shouldForceBrowserOpenRu(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(^|\s)(открой|открыть|зайди|перейди|покажи\s+сайт|открой\s+сайт|загрузи\s+сайт)(?=\s|$)/i.test(normalized);
}

export function buildForcedBrowserReplyRu(result = {}) {
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

export function resolveKnownChurchSiteUrlRu(text = '') {
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

export function shouldForceSelfIntroRu(text = '') {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(кто\s+ты|кто\s+вы|как\s+тебя\s+зовут|как\s+вас\s+зовут|представься|представьтесь)/i.test(normalized);
}

export function buildForcedSelfIntroReplyRu(connectionState) {
  if (connectionState.characterId === 'batyushka-3') {
    return 'Я Николай. Спокойно и по делу помогаю по церковным вопросам, могу подсказать и открыть нужный церковный сайт.';
  }
  return 'Я голосовой помощник. Могу коротко и естественно ответить на вопрос и, если нужно, открыть сайт.';
}


export async function resolveCharacterConfig(characterId = '') {
  const appConfig = await loadAppConfig();
  const character = Array.isArray(appConfig?.characters)
    ? appConfig.characters.find((item) => item.id === characterId) || appConfig.characters[0] || null
    : null;
  return { appConfig, character };
}

export async function resolveActiveBrowserSessionId(conversationSessionId = '', requestedSessionId = '') {
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

export async function toolOpenSite(args = {}, connectionState) {
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
    verified: opened?.verified === true,
    verification: opened?.verification || null,
    summary: summarizeText(pageContext?.readerText || ''),
    view,
  };
}

export async function toolViewPage(args = {}, connectionState) {
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

export async function toolExtractPageContext(args = {}, connectionState) {
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

export async function toolSummarizeVisiblePage(args = {}, connectionState) {
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

export async function toolKnowledgeSearch(args = {}, connectionState) {
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

export async function executeToolCall(toolName, rawArgs, connectionState) {
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

