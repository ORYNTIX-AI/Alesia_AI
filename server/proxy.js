import express from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { WebSocketServer, WebSocket } from 'ws';
import {
  closeBrowser,
  configureBrowserController,
  cancelPendingBrowserOperations,
  detectBrowserIntent,
  fetchBrowserUrlContext,
  getBrowserSessionContext,
  getBrowserSessionView,
  openBrowserIntent,
  performBrowserSessionAction,
  queryBrowserSession,
} from './browser/index.js';
import { getAppConfigPath, loadAppConfig, saveAppConfig } from './configStore.js';
import {
  DEFAULT_VOICE_MODEL,
  SUPPORTED_VOICE_NAMES,
  SUPPORTED_VOICES,
} from './defaultAppConfig.js';
import {
  buildKnowledgeBootstrapContext,
  ensureKnowledgePublished,
  getKnowledgeSources,
  getKnowledgeStatus,
  publishKnowledgeDraft,
  refreshKnowledgeDraft,
  searchKnowledge,
} from './knowledgeStore.js';
import {
  appendConversationAction,
  appendConversationTurn,
  closeConversationSession,
  ensureConversationSession,
  getConversationRestoreContext,
  setConversationBrowserState,
  setConversationKnowledgeHits,
  updateConversationSessionState,
} from './conversationStore.js';
import { getRuntimeLogPath, logRuntime } from './runtimeLogger.js';
import {
  consumeVoiceSessionToken,
  getVoiceSessionStoreStats,
  issueVoiceSessionToken,
} from './voiceSessionStore.js';
import { attachYandexRealtimeBridgeConnection } from './ws/yandexRealtimeGateway.js';
import { createGeminiBridgeConnectionHandler } from './ws/geminiBridgeGateway.js';
import { createSttGatewayConnectionHandler } from './ws/sttGateway.js';
import { registerCoreRoutes } from './routes/coreRoutes.js';
import { registerConversationRoutes } from './routes/conversationRoutes.js';
import { registerKnowledgeRoutes } from './routes/knowledgeRoutes.js';
import { registerYandexRoutes } from './routes/yandexRoutes.js';
import { registerBrowserRoutes } from './routes/browserRoutes.js';
import { createYandexRuntimeService } from './services/yandexRuntimeService.js';
import { registerFrontendFallback } from './http/registerFrontendFallback.js';
import { registerUpgradeHandlers } from './ws/registerUpgradeHandlers.js';
import { loadServerEnv } from './env.js';

const SERVER_ENV = loadServerEnv(process.env);
const PROXY_SCHEME = SERVER_ENV.proxy.scheme;
const PROXY_HOST = SERVER_ENV.proxy.host;
const PROXY_PORT = SERVER_ENV.proxy.port;
const PROXY_URL = SERVER_ENV.proxy.url;
const PROXY_CONNECT_TIMEOUT_MS = SERVER_ENV.proxy.connectTimeoutMs;
const GEMINI_CONNECT_MAX_ATTEMPTS = SERVER_ENV.gemini.connectMaxAttempts;
const GEMINI_CONNECT_RETRY_DELAY_MS = SERVER_ENV.gemini.connectRetryDelayMs;
const proxyAgentOptions = { timeout: PROXY_CONNECT_TIMEOUT_MS };
const proxyAgent = PROXY_URL
  ? (PROXY_SCHEME.startsWith('socks')
    ? new SocksProxyAgent(PROXY_URL, proxyAgentOptions)
    : new HttpsProxyAgent(PROXY_URL, proxyAgentOptions))
  : null;

const API_KEY = SERVER_ENV.gemini.apiKey;
if (!API_KEY) {
  console.warn('WARN: GEMINI_API_KEY is not set. Gemini voice runtime will stay unavailable until the key is provided.');
}
configureBrowserController({
  apiKey: API_KEY,
  agent: proxyAgent || undefined,
});
const GEMINI_WS_URL = API_KEY
  ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`
  : '';
const STT_MODEL = SERVER_ENV.gemini.sttModel || DEFAULT_VOICE_MODEL;

const YANDEX_API_KEY = SERVER_ENV.yandex.apiKey;
const YANDEX_IAM_TOKEN = SERVER_ENV.yandex.iamToken;
const YANDEX_FOLDER_ID = SERVER_ENV.yandex.folderId;
const YANDEX_DEFAULT_MODEL_ID = SERVER_ENV.yandex.modelId;
const YANDEX_STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const YANDEX_LLM_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const {
  requestYandexCompletion,
  requestYandexStt,
  requestYandexTts,
} = createYandexRuntimeService({
  normalizeWhitespace,
  yandexApiKey: YANDEX_API_KEY,
  yandexDefaultModelId: YANDEX_DEFAULT_MODEL_ID,
  yandexFolderId: YANDEX_FOLDER_ID,
  yandexIamToken: YANDEX_IAM_TOKEN,
  yandexLlmUrl: YANDEX_LLM_URL,
  yandexSttUrl: YANDEX_STT_URL,
  yandexTtsUrl: YANDEX_TTS_URL,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const app = express();
app.set('trust proxy', true);
const server = createServer(app);
const geminiProxyWss = new WebSocketServer({ noServer: true });
const voiceGatewayWss = new WebSocketServer({ noServer: true });
const yandexRealtimeGatewayWss = new WebSocketServer({ noServer: true });
const sttWss = new WebSocketServer({ noServer: true });
let shutdownInProgress = false;
const INVALID_FORWARD_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);
const MAX_CLOSE_REASON_BYTES = 123;
const STT_FALLBACK_SILENCE_MS = 1100;
const STT_FALLBACK_SETTLE_MS = 240;
const STT_FALLBACK_MIN_TEXT_LENGTH = 2;
const STT_PCM_RMS_THRESHOLD = 0.012;

function normalizeWhitespace(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function calculatePcm16Rms(base64Data) {
  const audioBuffer = Buffer.from(String(base64Data || ''), 'base64');
  if (!audioBuffer.byteLength) {
    return { rms: 0, durationMs: 0 };
  }

  const sampleCount = Math.floor(audioBuffer.byteLength / 2);
  if (!sampleCount) {
    return { rms: 0, durationMs: 0 };
  }

  let sum = 0;
  for (let offset = 0; offset < sampleCount * 2; offset += 2) {
    const sample = audioBuffer.readInt16LE(offset) / 32768;
    sum += sample * sample;
  }

  return {
    rms: Math.sqrt(sum / sampleCount),
    durationMs: Math.round((sampleCount / 16000) * 1000),
  };
}

function sanitizeGeminiProxySetupMessage(rawData) {
  try {
    const asText = typeof rawData === 'string'
      ? rawData
      : (Buffer.isBuffer(rawData) ? rawData.toString('utf8') : '');
    if (!asText || !asText.includes('"setup"')) {
      return rawData;
    }

    const payload = JSON.parse(asText);
    const activityDetection = payload?.setup?.realtimeInputConfig?.automaticActivityDetection;
    if (!activityDetection || typeof activityDetection !== 'object') {
      return rawData;
    }

    const normalized = {};
    const assignString = (targetKey, value) => {
      const safeValue = normalizeWhitespace(value);
      if (safeValue) {
        normalized[targetKey] = safeValue;
      }
    };
    const assignNumber = (targetKey, value) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) {
        normalized[targetKey] = Math.round(numeric);
      }
    };

    assignString('startOfSpeechSensitivity', activityDetection.startOfSpeechSensitivity ?? activityDetection.start_of_speech_sensitivity);
    assignString('endOfSpeechSensitivity', activityDetection.endOfSpeechSensitivity ?? activityDetection.end_of_speech_sensitivity);
    assignNumber('prefixPaddingMs', activityDetection.prefixPaddingMs ?? activityDetection.prefix_padding_ms);
    assignNumber('silenceDurationMs', activityDetection.silenceDurationMs ?? activityDetection.silence_duration_ms);

    if (!Object.keys(normalized).length) {
      return rawData;
    }

    payload.setup.realtimeInputConfig.automaticActivityDetection = normalized;

    if (activityDetection.activityHandling !== undefined || activityDetection.activity_handling !== undefined) {
      logRuntime('ws.gemini.setup.sanitized', {
        removedField: 'activityHandling',
      });
    }

    return JSON.stringify(payload);
  } catch {
    return rawData;
  }
}

function shouldUseDirectGeminiFallback(attempt = 1) {
  return Boolean(proxyAgent) && Number(attempt) > 1 && Number(attempt) % 2 === 0;
}

function createGeminiUpstreamSocket({ attempt = 1, route = 'gemini', conversationSessionId = '' } = {}) {
  if (!GEMINI_WS_URL) {
    throw new Error('Gemini API key is not configured');
  }
  const useDirectFallback = shouldUseDirectGeminiFallback(attempt);
  if (useDirectFallback) {
    logRuntime('ws.gemini.proxy-bypass', {
      route,
      attempt,
      conversationSessionId,
    });
  }
  return new WebSocket(GEMINI_WS_URL, {
    agent: useDirectFallback ? undefined : (proxyAgent || undefined),
    handshakeTimeout: PROXY_CONNECT_TIMEOUT_MS,
  });
}

function shouldRetryGeminiConnect({ attempt = 1, error = null, code = 0, reason = '' } = {}) {
  if (attempt >= GEMINI_CONNECT_MAX_ATTEMPTS) {
    return false;
  }

  const closeCode = Number(code) || 0;
  const message = normalizeWhitespace(error?.message || reason || '').toLowerCase();
  if (!message && !closeCode) {
    return false;
  }

  if (closeCode === 1006) {
    return true;
  }

  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('network')
    || message.includes('proxy');
}

function getGeminiRetryDelayMs(attempt = 1) {
  return GEMINI_CONNECT_RETRY_DELAY_MS * Math.max(1, attempt);
}

function isSendableCloseCode(code) {
  const numericCode = Number(code);
  if (!Number.isInteger(numericCode)) {
    return false;
  }
  if (numericCode >= 3000 && numericCode <= 4999) {
    return true;
  }
  if (numericCode < 1000 || numericCode > 1014) {
    return false;
  }
  return !INVALID_FORWARD_CLOSE_CODES.has(numericCode);
}

function normalizeCloseReason(reason, fallback = '') {
  let normalized = normalizeWhitespace(reason || fallback);
  if (!normalized) {
    return '';
  }

  while (normalized && Buffer.byteLength(normalized, 'utf8') > MAX_CLOSE_REASON_BYTES) {
    normalized = normalized.slice(0, -1).trimEnd();
  }

  return normalized;
}

function safeCloseSocket(socket, code, reason = '', context = 'socket-close') {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const requestedCode = Number.isInteger(Number(code)) ? Number(code) : null;
  const requestedReason = normalizeWhitespace(reason || '');
  const forwardedCode = isSendableCloseCode(requestedCode) ? requestedCode : 1011;
  const fallbackReason = forwardedCode === 1000 ? 'Connection closed' : 'Upstream connection closed';
  const forwardedReason = normalizeCloseReason(requestedReason, fallbackReason);

  if (requestedCode !== forwardedCode || requestedReason !== forwardedReason) {
    logRuntime('ws.close.normalized', {
      context,
      requestedCode,
      forwardedCode,
      requestedReason,
      forwardedReason,
    });
  }

  try {
    if (forwardedReason) {
      socket.close(forwardedCode, forwardedReason);
      return;
    }
    socket.close(forwardedCode);
  } catch (error) {
    logRuntime('ws.close.failed', {
      context,
      requestedCode,
      forwardedCode,
      error,
    }, 'error');

    try {
      socket.close(1011, 'Connection closed');
    } catch {
      // Ignore secondary close failures.
    }
  }
}

function sanitizeRecentTurns(turns = []) {
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .slice(-12)
    .map((turn) => ({
      role: turn?.role === 'assistant' ? 'assistant' : 'user',
      text: normalizeWhitespace(turn?.text || '').slice(0, 260),
      source: normalizeWhitespace(turn?.source || 'live').slice(0, 64) || 'live',
    }))
    .filter((turn) => turn.text.length >= 2);
}

function mergeRecentTurns(restoreTurns = [], requestTurns = []) {
  const merged = [...sanitizeRecentTurns(restoreTurns), ...sanitizeRecentTurns(requestTurns)];
  if (!merged.length) {
    return [];
  }

  const deduped = [];
  const seen = new Set();
  merged.forEach((turn) => {
    const key = `${turn.role}:${turn.text.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(turn);
  });

  return deduped.slice(-12);
}

function buildSttHints(config = {}) {
  const phrases = new Set();
  const characters = Array.isArray(config?.characters) ? config.characters : [];
  const knowledgeSources = Array.isArray(config?.knowledgeSources) ? config.knowledgeSources : [];

  characters.forEach((character) => {
    [character?.displayName, character?.id].forEach((value) => {
      const normalized = normalizeWhitespace(value);
      if (normalized) {
        phrases.add(normalized);
      }
    });
  });

  knowledgeSources.forEach((source) => {
    [source?.title, source?.canonicalUrl, ...(Array.isArray(source?.aliases) ? source.aliases : [])]
      .forEach((value) => {
        const normalized = normalizeWhitespace(value);
        if (normalized) {
          phrases.add(normalized);
        }
      });
  });

  return Array.from(phrases).slice(0, 40);
}

function buildSttSystemInstruction(language, hints = []) {
  const phraseHints = hints.length
    ? `Предпочитай точные написания для этих брендов, имен и доменов: ${hints.join(', ')}.`
    : '';

  return `Ты серверный сервис распознавания речи.
Твоя задача: точно транскрибировать пользовательскую речь и не вести диалог.
Не отвечай пользователю, не добавляй комментарии и не придумывай слова, которых не было.
Игнорируй голос ассистента и аудио с динамиков/браузера, распознавай только живую речь человека у микрофона.
Если слышен только синтезированный голос ассистента, музыка или шум, возвращай пустую транскрипцию.
Язык распознавания: ${language || 'ru-RU'}.
${phraseHints}`;
}

function classifyBrowserOpenErrorReason(error) {
  const explicitCode = normalizeWhitespace(error?.code || '').toLowerCase();
  if (explicitCode) {
    return explicitCode;
  }
  const message = normalizeWhitespace(error?.message || '').toLowerCase();
  if (!message) {
    return 'navigation_failed';
  }
  if (message.includes('таймаут') || message.includes('timeout')) {
    return 'network_timeout';
  }
  if (
    message.includes('запрещ')
    || message.includes('домен')
    || message.includes('локальн')
    || message.includes('приватн')
    || message.includes('внутрен')
  ) {
    return 'navigation_blocked';
  }
  if (message.includes('не удалось определить сайт') || message.includes('назовите его точнее')) {
    return 'resolve_low_confidence';
  }
  return 'navigation_failed';
}

app.use(express.json({ limit: '2mb' }));

registerCoreRoutes(app, {
  getAppConfigPath,
  getRuntimeLogPath,
  getVoiceSessionStoreStats,
  issueVoiceSessionToken,
  loadAppConfig,
  logRuntime,
  normalizeWhitespace,
  proxyInfo: {
    host: PROXY_HOST || PROXY_URL,
    scheme: PROXY_SCHEME,
  },
  saveAppConfig,
  supportedVoiceNames: SUPPORTED_VOICE_NAMES,
  supportedVoices: SUPPORTED_VOICES,
});

registerConversationRoutes(app, {
  appendConversationAction,
  appendConversationTurn,
  buildKnowledgeBootstrapContext,
  closeConversationSession,
  ensureConversationSession,
  getConversationRestoreContext,
  loadAppConfig,
  randomUUID,
  setConversationKnowledgeHits,
  updateConversationSessionState,
});

registerKnowledgeRoutes(app, {
  getKnowledgeSources,
  getKnowledgeStatus,
  loadAppConfig,
  logRuntime,
  publishKnowledgeDraft,
  refreshKnowledgeDraft,
  saveAppConfig,
  searchKnowledge,
  setConversationKnowledgeHits,
});

registerYandexRoutes(app, {
  normalizeWhitespace,
  requestYandexCompletion,
  requestYandexStt,
  requestYandexTts,
  yandexDefaultModelId: YANDEX_DEFAULT_MODEL_ID,
});

registerBrowserRoutes(app, {
  appendConversationAction,
  cancelPendingBrowserOperations,
  classifyBrowserOpenErrorReason,
  detectBrowserIntent,
  fetchBrowserUrlContext,
  getBrowserSessionContext,
  getBrowserSessionView,
  getConversationRestoreContext,
  loadAppConfig,
  logRuntime,
  mergeRecentTurns,
  normalizeWhitespace,
  openBrowserIntent,
  performBrowserSessionAction,
  queryBrowserSession,
  setConversationBrowserState,
});

registerFrontendFallback(app, {
  distDir,
  indexHtmlPath,
});

const attachGeminiBridgeConnection = createGeminiBridgeConnectionHandler({
  WebSocket,
  createGeminiUpstreamSocket,
  getGeminiRetryDelayMs,
  logRuntime,
  normalizeWhitespace,
  safeCloseSocket,
  sanitizeGeminiProxySetupMessage,
  shouldRetryGeminiConnect,
});

geminiProxyWss.on('connection', (clientWs) => {
  attachGeminiBridgeConnection(clientWs, { route: 'gemini-proxy' });
});

voiceGatewayWss.on('connection', (clientWs, _request, voiceSession) => {
  attachGeminiBridgeConnection(clientWs, {
    route: 'voice-proxy',
    voiceSession,
  });
});

yandexRealtimeGatewayWss.on('connection', (clientWs, _request, voiceSession) => {
  attachYandexRealtimeBridgeConnection(clientWs, {
    route: 'yandex-realtime-proxy',
    voiceSession,
  });
});

registerUpgradeHandlers({
  consumeVoiceSessionToken,
  geminiProxyWss,
  normalizeWhitespace,
  server,
  sttWss,
  voiceGatewayWss,
  yandexRealtimeGatewayWss,
});

const handleSttGatewayConnection = createSttGatewayConnectionHandler({
  STT_FALLBACK_MIN_TEXT_LENGTH,
  STT_FALLBACK_SETTLE_MS,
  STT_FALLBACK_SILENCE_MS,
  STT_MODEL,
  STT_PCM_RMS_THRESHOLD,
  WebSocket,
  buildSttHints,
  buildSttSystemInstruction,
  calculatePcm16Rms,
  createGeminiUpstreamSocket,
  getGeminiRetryDelayMs,
  loadAppConfig,
  logRuntime,
  normalizeWhitespace,
  safeCloseSocket,
  shouldRetryGeminiConnect,
});

sttWss.on('connection', handleSttGatewayConnection);

const PORT = SERVER_ENV.port;
server.listen(PORT, () => {
  logRuntime('server.started', {
    port: PORT,
    proxyHost: PROXY_HOST,
    proxyScheme: PROXY_SCHEME,
    configPath: getAppConfigPath(),
    logPath: getRuntimeLogPath(),
  });
});

void (async () => {
  try {
    const config = await loadAppConfig();
    const published = await ensureKnowledgePublished(config.knowledgeSources, { autoPublishMissing: true });
    if (published?.publishedAt || published?.builtAt) {
      await saveAppConfig({
        ...config,
        knowledgeSources: config.knowledgeSources.map((source) => ({
          ...source,
          lastFetchedAt: source.lastFetchedAt || published.builtAt || null,
          lastPublishedAt: source.lastPublishedAt || published.publishedAt || published.builtAt || null,
        })),
      });
    }
    logRuntime('knowledge.bootstrap.ready', {
      sourceCount: Array.isArray(config.knowledgeSources) ? config.knowledgeSources.length : 0,
    });
  } catch (error) {
    logRuntime('knowledge.bootstrap.error', { error }, 'error');
  }
})();

async function shutdown(signal) {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  console.log(`Received ${signal}, shutting down gracefully`);
  const forcedExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000);
  forcedExitTimer.unref?.();

  try {
    for (const client of geminiProxyWss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    for (const client of voiceGatewayWss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    for (const client of sttWss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    await new Promise((resolve) => {
      geminiProxyWss.close(() => resolve());
    });

    await new Promise((resolve) => {
      voiceGatewayWss.close(() => resolve());
    });

    await new Promise((resolve) => {
      sttWss.close(() => resolve());
    });

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await closeBrowser();
    clearTimeout(forcedExitTimer);
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed', error);
    clearTimeout(forcedExitTimer);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}


