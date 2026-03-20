import express from 'express';
import fs from 'fs';
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
  detectBrowserIntent,
  getBrowserSessionView,
  getBrowserSessionContext,
  openBrowserIntent,
  performBrowserSessionAction,
  queryBrowserSession,
} from './browserController.js';
import { getAppConfigPath, loadAppConfig, saveAppConfig } from './configStore.js';
import {
  DEFAULT_VOICE_MODEL,
  SUPPORTED_PRAYER_READ_MODES,
  SUPPORTED_SPEECH_STABILITY_PROFILES,
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

const PROXY_SCHEME = (process.env.PROXY_SCHEME || 'socks5h').toLowerCase();
const PROXY_HOST = process.env.PROXY_HOST || '45.145.57.227';
const PROXY_PORT = process.env.PROXY_PORT || 13475;
const PROXY_USER = process.env.PROXY_USER || 'PhKW0n';
const PROXY_PASS = process.env.PROXY_PASS || 'zaahsk';
const encodedProxyUser = encodeURIComponent(PROXY_USER);
const encodedProxyPass = encodeURIComponent(PROXY_PASS);
const proxyAuth = PROXY_USER && PROXY_PASS ? `${encodedProxyUser}:${encodedProxyPass}@` : '';
const PROXY_URL = `${PROXY_SCHEME}://${proxyAuth}${PROXY_HOST}:${PROXY_PORT}`;
const proxyAgent = PROXY_SCHEME.startsWith('socks')
  ? new SocksProxyAgent(PROXY_URL)
  : new HttpsProxyAgent(PROXY_URL);

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set in environment variables!');
  process.exit(1);
}
configureBrowserController({
  apiKey: API_KEY,
  agent: proxyAgent,
});
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
const STT_MODEL = process.env.STT_MODEL || DEFAULT_VOICE_MODEL;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
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

app.get('/health', async (req, res) => {
  const config = await loadAppConfig();
  res.json({
    status: 'ok',
    proxy: PROXY_HOST,
    proxyScheme: PROXY_SCHEME,
    configPath: getAppConfigPath(),
    logPath: getRuntimeLogPath(),
    characters: config.characters.length,
    knowledgeSources: Array.isArray(config.knowledgeSources) ? config.knowledgeSources.length : 0,
  });
});

app.get('/api/app-config', async (req, res) => {
  try {
    const config = await loadAppConfig();
    res.json({
      ...config,
      supportedVoiceNames: SUPPORTED_VOICE_NAMES,
      supportedVoices: SUPPORTED_VOICES,
      supportedSpeechStabilityProfiles: SUPPORTED_SPEECH_STABILITY_PROFILES,
      supportedPrayerReadModes: SUPPORTED_PRAYER_READ_MODES,
    });
  } catch (error) {
    console.error('Failed to load app config', error);
    res.status(500).json({ error: 'Не удалось загрузить конфиг приложения' });
  }
});

app.put('/api/app-config', async (req, res) => {
  try {
    const saved = await saveAppConfig(req.body);
    res.json({
      ...saved,
      supportedVoiceNames: SUPPORTED_VOICE_NAMES,
      supportedVoices: SUPPORTED_VOICES,
      supportedSpeechStabilityProfiles: SUPPORTED_SPEECH_STABILITY_PROFILES,
      supportedPrayerReadModes: SUPPORTED_PRAYER_READ_MODES,
    });
  } catch (error) {
    console.error('Failed to save app config', error);
    res.status(400).json({ error: 'Не удалось сохранить конфиг приложения' });
  }
});

app.post('/api/browser/intent', async (req, res) => {
  const startedAt = Date.now();
  const traceId = String(req.body?.traceId || `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    const config = await loadAppConfig();
    const transcript = String(req.body?.transcript || '');
    const sessionHistory = Array.isArray(req.body?.sessionHistory) ? req.body.sessionHistory : [];
    const conversationSessionId = normalizeWhitespace(req.body?.conversationSessionId || '');
    const restoreContext = conversationSessionId
      ? await getConversationRestoreContext(conversationSessionId).catch(() => null)
      : null;
    const recentTurns = mergeRecentTurns(
      Array.isArray(restoreContext?.recentTurns) ? restoreContext.recentTurns : [],
      Array.isArray(req.body?.recentTurns) ? req.body.recentTurns : [],
    );
    const requestedCharacterId = String(req.body?.activeCharacterId || '').trim();
    const activeCharacterId = requestedCharacterId || String(config?.activeCharacterId || '').trim();
    const activeCharacter = Array.isArray(config?.characters)
      ? config.characters.find((character) => character.id === activeCharacterId)
      : null;
    const sharedContextHint = String(activeCharacter?.systemPrompt || '');
    logRuntime('browser.intent.request', {
      traceId,
      transcript,
      activeCharacterId,
      historySize: sessionHistory.length,
      recentTurnsSize: recentTurns.length,
    });
    const intent = await detectBrowserIntent({
      traceId,
      transcript,
      contextHint: sharedContextHint,
      sessionHistory,
      recentTurns,
      webProviders: config.webProviders,
      knowledgeSources: config.knowledgeSources,
    });
    logRuntime('browser.intent.result', {
      traceId,
      type: intent?.type || 'none',
      intentType: intent?.intentType || intent?.type || 'none',
      url: intent?.url || '',
      error: intent?.error || '',
      errorReason: intent?.errorReason || '',
      resolutionSource: intent?.resolutionSource || '',
      confidence: intent?.confidence ?? 0,
      confidenceMargin: intent?.confidenceMargin ?? 0,
      candidateCount: intent?.candidateCount ?? 0,
      ms: Date.now() - startedAt,
    });
    logRuntime('resolver.candidates', {
      traceId,
      candidates: Array.isArray(intent?.candidates) ? intent.candidates : [],
    });
    res.json({ ...intent, traceId });
  } catch (error) {
    logRuntime('browser.intent.error', {
      traceId,
      ms: Date.now() - startedAt,
      error,
    }, 'error');
    const errorReason = /таймаут|timeout/i.test(String(error?.message || '')) ? 'resolve_timeout' : 'navigation_failed';
    res.status(500).json({
      error: 'Не удалось определить browser intent',
      errorReason,
    });
  }
});

app.post('/api/browser/open', async (req, res) => {
  const startedAt = Date.now();
  const traceId = String(req.body?.traceId || `open-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  const characterId = String(req.body?.characterId || '').trim();
  const requestId = Number.isFinite(Number(req.body?.requestId)) ? Number(req.body?.requestId) : 0;
  try {
    const intent = req.body || {};
    if (!intent.url) {
      return res.status(400).json({ error: 'URL для открытия не передан' });
    }

    logRuntime('browser.open.request', {
      requestId,
      traceId,
      type: intent?.type || '',
      providerKey: intent?.providerKey || '',
      url: intent?.url || '',
      query: intent?.query || '',
    });
    const result = await openBrowserIntent({ ...intent, traceId });
    const conversationSessionId = String(req.body?.conversationSessionId || '').trim();
    if (conversationSessionId) {
      await setConversationBrowserState(conversationSessionId, {
        browserSessionId: result?.browserSessionId || '',
        title: result?.title || '',
        url: result?.url || '',
        lastUpdated: result?.lastUpdated || null,
      }, { characterId });
      await appendConversationAction(conversationSessionId, 'browser.open.ready', {
        requestId,
        traceId,
        browserSessionId: result?.browserSessionId || '',
        url: result?.url || '',
        title: result?.title || '',
      }, { characterId });
    }
    logRuntime('browser.open.result', {
      requestId,
      traceId,
      status: result?.status || '',
      url: result?.url || '',
      embeddable: Boolean(result?.embeddable),
      title: result?.title || '',
      ms: Date.now() - startedAt,
    });
    res.json({ ...result, traceId });
  } catch (error) {
    const errorReason = classifyBrowserOpenErrorReason(error);
    logRuntime('browser.open.error', {
      traceId,
      ms: Date.now() - startedAt,
      errorReason,
      error,
    }, 'error');
    res.status(400).json({
      status: 'error',
      error: error.message || 'Не удалось открыть страницу',
      errorReason,
    });
  }
});

app.get('/api/browser/session/:id/view', async (req, res) => {
  const startedAt = Date.now();
  const browserSessionId = String(req.params?.id || '').trim();
  try {
    if (!browserSessionId) {
      return res.status(400).json({ error: 'Идентификатор browser session не передан' });
    }

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const view = await getBrowserSessionView(browserSessionId, { refresh });
    logRuntime('browser.session.view.result', {
      browserSessionId,
      revision: view?.revision || 0,
      ms: Date.now() - startedAt,
    });
    return res.json(view);
  } catch (error) {
    logRuntime('browser.session.view.error', {
      browserSessionId,
      ms: Date.now() - startedAt,
      error,
    }, 'error');
    return res.status(400).json({ error: error.message || 'Не удалось получить состояние веб-панели' });
  }
});

app.post('/api/browser/session/:id/action', async (req, res) => {
  const startedAt = Date.now();
  const browserSessionId = String(req.params?.id || '').trim();
  const conversationSessionId = String(req.body?.conversationSessionId || '').trim();
  const characterId = String(req.body?.characterId || '').trim();
  const requestId = Number.isFinite(Number(req.body?.requestId)) ? Number(req.body?.requestId) : 0;
  try {
    if (!browserSessionId) {
      return res.status(400).json({ error: 'Идентификатор browser session не передан' });
    }

    const result = await performBrowserSessionAction({
      sessionId: browserSessionId,
      action: req.body || {},
    });

    if (conversationSessionId) {
      await setConversationBrowserState(conversationSessionId, {
        browserSessionId: result?.browserSessionId || browserSessionId,
        title: result?.title || '',
        url: result?.url || '',
        lastUpdated: result?.lastUpdated || null,
      }, { characterId });
      await appendConversationAction(conversationSessionId, 'browser.action.complete', {
        requestId,
        browserSessionId,
        actionType: String(req.body?.type || '').trim(),
        url: result?.url || '',
        title: result?.title || '',
      }, { characterId });
    }

    logRuntime('browser.session.action.result', {
      requestId,
      browserSessionId,
      actionType: String(req.body?.type || '').trim(),
      revision: result?.revision || 0,
      ms: Date.now() - startedAt,
    });
    return res.json(result);
  } catch (error) {
    const errorReason = classifyBrowserOpenErrorReason(error);
    if (conversationSessionId) {
      await appendConversationAction(conversationSessionId, 'browser.action.fail', {
        requestId,
        browserSessionId,
        actionType: String(req.body?.type || '').trim(),
        errorReason,
        error: error.message || 'Не удалось выполнить действие',
      }, { characterId }).catch(() => {});
    }
    logRuntime('browser.session.action.error', {
      requestId,
      browserSessionId,
      actionType: String(req.body?.type || '').trim(),
      ms: Date.now() - startedAt,
      errorReason,
      error,
    }, 'error');
    return res.status(400).json({
      error: error.message || 'Не удалось выполнить действие на странице',
      errorReason,
    });
  }
});

app.get('/api/browser/session/:id/context', async (req, res) => {
  const startedAt = Date.now();
  const browserSessionId = String(req.params?.id || '').trim();
  try {
    if (!browserSessionId) {
      return res.status(400).json({ error: 'Идентификатор browser session не передан' });
    }

    const context = await getBrowserSessionContext(browserSessionId);
    logRuntime('browser.session.context.result', {
      browserSessionId,
      url: context?.url || '',
      title: context?.title || '',
      ms: Date.now() - startedAt,
    });
    return res.json(context);
  } catch (error) {
    logRuntime('browser.session.context.error', {
      browserSessionId,
      ms: Date.now() - startedAt,
      error,
    }, 'error');
    return res.status(400).json({ error: error.message || 'Не удалось прочитать контекст страницы' });
  }
});

app.post('/api/browser/session/:id/query', async (req, res) => {
  const startedAt = Date.now();
  const browserSessionId = String(req.params?.id || '').trim();
  const question = String(req.body?.question || '').trim();
  const conversationSessionId = String(req.body?.conversationSessionId || '').trim();
  const characterId = String(req.body?.characterId || '').trim();
  const requestId = Number.isFinite(Number(req.body?.requestId)) ? Number(req.body?.requestId) : 0;
  try {
    if (!browserSessionId) {
      return res.status(400).json({ error: 'Идентификатор browser session не передан' });
    }
    if (!question) {
      return res.status(400).json({ error: 'Вопрос по странице не передан' });
    }

    const result = await queryBrowserSession({ sessionId: browserSessionId, question });
    if (conversationSessionId) {
      await setConversationBrowserState(conversationSessionId, {
        browserSessionId: result?.browserSessionId || browserSessionId,
        title: result?.title || '',
        url: result?.url || '',
        lastUpdated: result?.lastUpdated || null,
      }, { characterId });
      await appendConversationAction(conversationSessionId, 'browser.query.answer', {
        requestId,
        browserSessionId,
        question,
      }, { characterId });
    }
    logRuntime('browser.session.query.result', {
      requestId,
      browserSessionId,
      question,
      answerLength: result?.answer?.length || 0,
      ms: Date.now() - startedAt,
    });
    return res.json(result);
  } catch (error) {
    logRuntime('browser.session.query.error', {
      requestId,
      browserSessionId,
      question,
      ms: Date.now() - startedAt,
      error,
    }, 'error');
    return res.status(400).json({ error: error.message || 'Не удалось ответить по текущей странице' });
  }
});

app.post('/api/conversation/session', async (req, res) => {
  try {
    const conversationSessionId = String(req.body?.conversationSessionId || randomUUID()).trim();
    const characterId = String(req.body?.characterId || '').trim();
    const session = await ensureConversationSession(conversationSessionId, { characterId });
    return res.json({
      conversationSessionId: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось создать сессию разговора' });
  }
});

app.post('/api/conversation/session/:id/turn', async (req, res) => {
  try {
    const conversationSessionId = String(req.params?.id || '').trim();
    const role = String(req.body?.role || '').trim();
    const text = String(req.body?.text || '').trim();
    const source = String(req.body?.source || 'live').trim();
    const characterId = String(req.body?.characterId || '').trim();
    const session = await appendConversationTurn(conversationSessionId, { role, text, source }, { characterId });
    return res.json({
      conversationSessionId: session.id,
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось записать реплику' });
  }
});

app.post('/api/conversation/session/:id/action', async (req, res) => {
  try {
    const conversationSessionId = String(req.params?.id || '').trim();
    const event = String(req.body?.event || '').trim();
    const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};
    const characterId = String(req.body?.characterId || '').trim();
    const session = await appendConversationAction(conversationSessionId, event, details, { characterId });
    return res.json({
      conversationSessionId: session.id,
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось записать действие сессии' });
  }
});

app.post('/api/conversation/session/:id/knowledge', async (req, res) => {
  try {
    const conversationSessionId = String(req.params?.id || '').trim();
    const hits = Array.isArray(req.body?.hits) ? req.body.hits : [];
    const characterId = String(req.body?.characterId || '').trim();
    const session = await setConversationKnowledgeHits(conversationSessionId, hits, { characterId });
    return res.json({
      conversationSessionId: session.id,
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось обновить знания сессии' });
  }
});

app.post('/api/conversation/session/:id/state', async (req, res) => {
  try {
    const conversationSessionId = String(req.params?.id || '').trim();
    const characterId = String(req.body?.characterId || '').trim();
    const session = await updateConversationSessionState(conversationSessionId, {
      greetingSent: typeof req.body?.greetingSent === 'boolean' ? req.body.greetingSent : undefined,
      lastFinalTranscriptHash: String(req.body?.lastFinalTranscriptHash || ''),
      activeSttSessionId: typeof req.body?.activeSttSessionId === 'string' ? req.body.activeSttSessionId : undefined,
    }, { characterId });
    return res.json({
      conversationSessionId: session.id,
      updatedAt: session.updatedAt,
      greetingSent: Boolean(session.greetingSent),
      lastFinalTranscriptHash: session.lastFinalTranscriptHash || '',
      activeSttSessionId: session.activeSttSessionId || '',
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось обновить состояние сессии' });
  }
});

app.get('/api/conversation/session/:id/restore', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const conversationSessionId = String(req.params?.id || '').trim();
    const requestedCharacterId = String(req.query?.characterId || '').trim();
    const activeCharacterId = requestedCharacterId || String(config?.activeCharacterId || '').trim();
    const character = Array.isArray(config?.characters)
      ? config.characters.find((entry) => entry.id === activeCharacterId)
      : null;
    const restore = await getConversationRestoreContext(conversationSessionId);
    const knowledgeContext = await buildKnowledgeBootstrapContext(character);
    return res.json({
      conversationSessionId,
      restore: restore || null,
      knowledgeContext,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось восстановить контекст разговора' });
  }
});

app.post('/api/conversation/session/:id/close', async (req, res) => {
  try {
    const conversationSessionId = String(req.params?.id || '').trim();
    const session = await closeConversationSession(conversationSessionId);
    return res.json({
      conversationSessionId: session.id,
      status: session.status,
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось завершить сессию разговора' });
  }
});

app.get('/api/knowledge/status', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const status = await getKnowledgeStatus(config.knowledgeSources);
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось получить статус базы знаний' });
  }
});

app.get('/api/knowledge/sources', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const sources = await getKnowledgeSources(config.knowledgeSources);
    return res.json({ sources });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось получить источники базы знаний' });
  }
});

app.post('/api/knowledge/refresh', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const draft = await refreshKnowledgeDraft(config.knowledgeSources);
    await saveAppConfig({
      ...config,
      knowledgeSources: config.knowledgeSources.map((source) => ({
        ...source,
        lastFetchedAt: draft.builtAt,
      })),
    });
    return res.json({
      builtAt: draft.builtAt,
      sourceCount: draft.documents?.length || 0,
      failures: draft.failures || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось обновить черновик базы знаний' });
  }
});

app.post('/api/knowledge/publish', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const published = await publishKnowledgeDraft(config.knowledgeSources);
    await saveAppConfig({
      ...config,
      knowledgeSources: config.knowledgeSources.map((source) => ({
        ...source,
        lastPublishedAt: published.publishedAt,
        lastFetchedAt: source.lastFetchedAt || published.builtAt,
      })),
    });
    return res.json({
      builtAt: published.builtAt,
      publishedAt: published.publishedAt,
      sourceCount: published.documents?.length || 0,
      failures: published.failures || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось опубликовать базу знаний' });
  }
});

app.post('/api/knowledge/query', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const question = String(req.body?.question || '').trim();
    const conversationSessionId = String(req.body?.conversationSessionId || '').trim();
    const requestedCharacterId = String(req.body?.characterId || '').trim();
    const activeCharacterId = requestedCharacterId || String(config?.activeCharacterId || '').trim();
    const character = Array.isArray(config?.characters)
      ? config.characters.find((entry) => entry.id === activeCharacterId)
      : null;
    const result = await searchKnowledge({ question, character });
    if (conversationSessionId) {
      await setConversationKnowledgeHits(conversationSessionId, result.hits, { characterId: activeCharacterId });
    }
    logRuntime('knowledge.query', {
      conversationSessionId,
      characterId: activeCharacterId,
      hitCount: result.hits.length,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось выполнить поиск по базе знаний' });
  }
});

app.post('/api/browser/client-event', (req, res) => {
  const event = String(req.body?.event || '').trim();
  const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};
  if (!event) {
    return res.status(400).json({ error: 'Не передано имя client event' });
  }

  logRuntime('browser.client.event', {
    event,
    ...details,
  });
  return res.json({ ok: true });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
}

wss.on('connection', (clientWs) => {
  logRuntime('ws.client.connected');

  let geminiWs = null;
  let messageBuffer = [];
  let isConnected = false;

  try {
    geminiWs = new WebSocket(GEMINI_WS_URL, { agent: proxyAgent });

    geminiWs.on('open', () => {
      logRuntime('ws.gemini.connected');
      isConnected = true;

      if (messageBuffer.length > 0) {
        logRuntime('ws.gemini.flush-buffer', { messageCount: messageBuffer.length });
        messageBuffer.forEach((message) => geminiWs.send(message));
        messageBuffer = [];
      }
    });

    clientWs.on('message', (data) => {
      const outgoing = sanitizeGeminiProxySetupMessage(data);
      if (isConnected && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(outgoing);
      } else {
        messageBuffer.push(outgoing);
      }
    });

    geminiWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    geminiWs.on('error', (error) => {
      logRuntime('ws.gemini.error', { error }, 'error');
      if (clientWs.readyState === WebSocket.OPEN) {
        safeCloseSocket(clientWs, 1011, `Gemini Error: ${error.message}`, 'gemini-proxy-upstream-error');
      }
    });

    geminiWs.on('close', (code, reason) => {
      logRuntime('ws.gemini.closed', { code, reason: reason.toString() });
      if (clientWs.readyState === WebSocket.OPEN) {
        safeCloseSocket(clientWs, code, reason.toString(), 'gemini-proxy-upstream-close');
      }
    });
  } catch (error) {
    logRuntime('ws.gemini.create-failed', { error }, 'error');
    safeCloseSocket(clientWs, 1011, 'Proxy Error', 'gemini-proxy-create-failed');
  }

  clientWs.on('close', () => {
    logRuntime('ws.client.disconnected');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  clientWs.on('error', (error) => {
    logRuntime('ws.client.error', { error }, 'error');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const parsed = new URL(request.url || '/', 'http://localhost');
    if (parsed.pathname === '/gemini-proxy') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }

    if (!/^\/api\/stt\/session\/[^/]+\/stream$/.test(parsed.pathname)) {
      socket.destroy();
      return;
    }

    sttWss.handleUpgrade(request, socket, head, (ws) => {
      sttWss.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

sttWss.on('connection', (clientWs, request) => {
  const parsed = new URL(request.url || '/', 'http://localhost');
  const match = parsed.pathname.match(/^\/api\/stt\/session\/([^/]+)\/stream$/);
  const conversationSessionId = decodeURIComponent(match?.[1] || '').trim();
  let geminiWs = null;
  let geminiReady = false;
  let setupSent = false;
  let started = false;
  let inputTranscriptBuffer = '';
  let lastPartialText = '';
  let lastPartialUpdatedAt = 0;
  let trailingSilenceMs = 0;
  let voicedAudioSeen = false;
  let pendingAudioMessages = [];
  let sttLanguage = 'ru-RU';
  const configPromise = loadAppConfig().catch(() => null);

  const flushPendingAudio = () => {
    if (!setupSent || !geminiWs || geminiWs.readyState !== WebSocket.OPEN || !pendingAudioMessages.length) {
      return;
    }

    pendingAudioMessages.forEach((message) => {
      geminiWs.send(message);
    });
    pendingAudioMessages = [];
  };

  const sendToClient = (payload) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  const getBufferedTranscript = () => normalizeWhitespace(inputTranscriptBuffer || lastPartialText || '');

  const finalizeBufferedTranscript = (reason = 'fallback') => {
    const finalText = getBufferedTranscript();
    if (finalText.length < STT_FALLBACK_MIN_TEXT_LENGTH) {
      inputTranscriptBuffer = '';
      lastPartialText = '';
      trailingSilenceMs = 0;
      voicedAudioSeen = false;
      return '';
    }

    sendToClient({ type: 'final', text: finalText });
    sendToClient({ type: 'partial', text: '' });
    logRuntime('stt.stream.finalized', {
      conversationSessionId,
      reason,
      textLength: finalText.length,
    });
    inputTranscriptBuffer = '';
    lastPartialText = '';
    lastPartialUpdatedAt = 0;
    trailingSilenceMs = 0;
    voicedAudioSeen = false;
    return finalText;
  };

  const sendSttSetup = async () => {
    if (!started || !geminiReady || setupSent || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
      return;
    }

    const config = await configPromise;
    const hints = buildSttHints(config);
    geminiWs.send(JSON.stringify({
      setup: {
        model: STT_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Aoede',
              },
            },
          },
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
            prefixPaddingMs: 60,
            silenceDurationMs: 900,
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
        },
        inputAudioTranscription: {},
        systemInstruction: {
          parts: [{
            text: buildSttSystemInstruction(sttLanguage, hints),
          }],
        },
      },
    }));
    setupSent = true;
    logRuntime('stt.stream.start', {
      conversationSessionId,
      sttSessionId: `gemini-live:${conversationSessionId}`,
      language: sttLanguage,
    });
  };

  try {
    geminiWs = new WebSocket(GEMINI_WS_URL, { agent: proxyAgent });
  } catch (error) {
    logRuntime('stt.stream.error', {
      conversationSessionId,
      error,
    }, 'error');
    safeCloseSocket(clientWs, 1011, 'STT proxy create failed', 'stt-proxy-create-failed');
    return;
  }

  geminiWs.on('open', () => {
    geminiReady = true;
    void sendSttSetup();
  });

  geminiWs.on('message', async (raw) => {
    try {
      const data = raw instanceof Blob ? JSON.parse(await raw.text()) : JSON.parse(raw);

      if (data.setupComplete) {
        sendToClient({ type: 'ready' });
        logRuntime('stt.stream.ready', {
          conversationSessionId,
          sttSessionId: `gemini-live:${conversationSessionId}`,
        });
        flushPendingAudio();
        return;
      }

      if (data.serverContent?.inputTranscription?.text) {
        inputTranscriptBuffer += data.serverContent.inputTranscription.text;
        lastPartialText = normalizeWhitespace(inputTranscriptBuffer);
        lastPartialUpdatedAt = Date.now();
        sendToClient({
          type: 'partial',
          text: lastPartialText,
        });
      }

      if (data.serverContent?.turnComplete || data.serverContent?.generationComplete) {
        finalizeBufferedTranscript('upstream-turn-complete');
        return;
      }

      if (data.serverContent?.interrupted) {
        inputTranscriptBuffer = '';
        lastPartialText = '';
        lastPartialUpdatedAt = 0;
        trailingSilenceMs = 0;
        voicedAudioSeen = false;
        sendToClient({ type: 'partial', text: '' });
      }

      if (data.error) {
        sendToClient({ type: 'error', error: data.error.message || 'STT upstream error' });
      }
    } catch (error) {
      logRuntime('stt.stream.message.error', {
        conversationSessionId,
        error,
      }, 'error');
    }
  });

  geminiWs.on('error', (error) => {
    logRuntime('stt.stream.error', {
      conversationSessionId,
      error,
    }, 'error');
    sendToClient({ type: 'error', error: error.message || 'STT upstream error' });
    if (clientWs.readyState === WebSocket.OPEN) {
      safeCloseSocket(clientWs, 1011, error.message || 'STT upstream error', 'stt-upstream-error');
    }
  });

  geminiWs.on('close', (code, reason) => {
    finalizeBufferedTranscript('upstream-close');
    logRuntime('stt.stream.closed', {
      conversationSessionId,
      code,
      reason: reason.toString(),
    });
    if (clientWs.readyState === WebSocket.OPEN) {
      safeCloseSocket(clientWs, code, reason.toString(), 'stt-upstream-close');
    }
  });

  clientWs.on('message', (raw) => {
    try {
      const payload = raw instanceof Buffer ? JSON.parse(raw.toString('utf8')) : JSON.parse(String(raw));
      if (payload?.type === 'start') {
        started = true;
        sttLanguage = normalizeWhitespace(payload?.language || 'ru-RU') || 'ru-RU';
        void sendSttSetup();
        return;
      }

      if (payload?.type === 'audio' && payload?.data) {
        const { rms, durationMs } = calculatePcm16Rms(payload.data);
        if (rms >= STT_PCM_RMS_THRESHOLD) {
          voicedAudioSeen = true;
          trailingSilenceMs = 0;
        } else if (voicedAudioSeen) {
          trailingSilenceMs += durationMs;
          if (
            trailingSilenceMs >= STT_FALLBACK_SILENCE_MS
            && lastPartialText
            && (Date.now() - lastPartialUpdatedAt) >= STT_FALLBACK_SETTLE_MS
          ) {
            finalizeBufferedTranscript('silence-fallback');
          }
        }

        const message = JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: payload.data }],
          },
        });

        if (setupSent && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(message);
        } else {
          pendingAudioMessages.push(message);
        }
        return;
      }

      if (payload?.type === 'stop') {
        finalizeBufferedTranscript('client-stop');
        safeCloseSocket(clientWs, 1000, 'Client stop', 'stt-client-stop');
      }
    } catch (error) {
      sendToClient({ type: 'error', error: error.message || 'Invalid STT client payload' });
    }
  });

  clientWs.on('close', () => {
    finalizeBufferedTranscript('client-close');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  clientWs.on('error', (error) => {
    logRuntime('stt.client.error', {
      conversationSessionId,
      error,
    }, 'error');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && path.extname(req.path)) {
    return res.status(404).type('text/plain; charset=utf-8').send('Static file not found');
  }

  if (fs.existsSync(indexHtmlPath)) {
    return res.sendFile(indexHtmlPath);
  }

  return res.status(404).send('Frontend bundle not found');
});

const PORT = Number(process.env.PORT || 3001);
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
    for (const client of wss.clients) {
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
      wss.close(() => resolve());
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
