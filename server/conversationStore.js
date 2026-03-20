import fs from 'fs/promises';
import path from 'path';
import { logRuntime } from './runtimeLogger.js';
import { DEFAULT_APP_CONFIG_PATH } from './runtimePaths.js';

const defaultConfigPath = DEFAULT_APP_CONFIG_PATH;
const CONVERSATIONS_DIR = process.env.CONVERSATIONS_DIR || path.resolve(path.dirname(defaultConfigPath), 'conversations');
const MAX_RECENT_TURNS = 8;
const MAX_TURN_TEXT_LENGTH = 360;
const MAX_ACTION_LOG = 48;
const MAX_KNOWLEDGE_HITS = 5;
let conversationWriteQueue = Promise.resolve();

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength = MAX_TURN_TEXT_LENGTH) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

async function ensureConversationsDir() {
  await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
}

function getConversationPath(sessionId) {
  return path.join(CONVERSATIONS_DIR, `${sessionId}.json`);
}

async function readConversation(sessionId) {
  try {
    const raw = await fs.readFile(getConversationPath(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeConversation(session) {
  await ensureConversationsDir();
  await fs.writeFile(getConversationPath(session.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function enqueueConversationOperation(operation) {
  const nextOperation = conversationWriteQueue
    .catch(() => {})
    .then(operation);
  conversationWriteQueue = nextOperation.catch(() => {});
  return nextOperation;
}

function buildSummary(turns = [], browserContext = null, knowledgeHits = []) {
  const recentTurns = turns.slice(-MAX_RECENT_TURNS);
  const lines = recentTurns.map((turn) => `${turn.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${truncate(turn.text, 220)}`);

  if (browserContext?.url) {
    lines.push(`Открытый сайт: ${browserContext.title || browserContext.url} (${browserContext.url})`);
  }

  if (knowledgeHits.length) {
    lines.push(`Последние знания: ${knowledgeHits.map((hit) => `${hit.title}: ${truncate(hit.text, 100)}`).join(' | ')}`);
  }

  return lines.join('\n');
}

function createEmptySession(sessionId, { characterId = '' } = {}) {
  return {
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCharacterId: characterId,
    status: 'active',
    turns: [],
    actionLog: [],
    browserSessionId: '',
    browserContext: null,
    activeSttSessionId: '',
    greetingSent: false,
    lastFinalTranscriptHash: '',
    knowledgeHits: [],
    summary: '',
  };
}

async function upsertConversation(sessionId, updater, meta = {}) {
  return enqueueConversationOperation(async () => {
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) {
      throw new Error('conversationSessionId не передан');
    }

    const current = await readConversation(safeSessionId) || createEmptySession(safeSessionId, meta);
    const next = updater(current) || current;
    next.updatedAt = new Date().toISOString();
    next.summary = buildSummary(next.turns, next.browserContext, next.knowledgeHits);
    await writeConversation(next);
    return next;
  });
}

export async function ensureConversationSession(sessionId, meta = {}) {
  return upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    status: current.status || 'active',
  }), meta);
}

export async function appendConversationTurn(sessionId, turn, meta = {}) {
  const role = turn?.role === 'assistant' ? 'assistant' : 'user';
  const text = truncate(turn?.text || '');
  if (!text) {
    return ensureConversationSession(sessionId, meta);
  }

  const session = await upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    turns: [
      ...current.turns,
      {
        ts: new Date().toISOString(),
        role,
        source: String(turn?.source || 'live').trim() || 'live',
        text,
      },
    ].slice(-64),
  }), meta);

  logRuntime('conversation.turn', {
    conversationSessionId: session.id,
    role,
    source: turn?.source || 'live',
    textLength: text.length,
  });

  return session;
}

export async function appendConversationAction(sessionId, event, details = {}, meta = {}) {
  const safeEvent = normalizeWhitespace(event);
  if (!safeEvent) {
    return ensureConversationSession(sessionId, meta);
  }

  const session = await upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    actionLog: [
      ...current.actionLog,
      {
        ts: new Date().toISOString(),
        event: safeEvent,
        details,
      },
    ].slice(-MAX_ACTION_LOG),
  }), meta);

  logRuntime(safeEvent, {
    conversationSessionId: session.id,
    ...details,
  });

  return session;
}

export async function setConversationBrowserState(sessionId, browserState = {}, meta = {}) {
  return upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    browserSessionId: String(browserState.browserSessionId || '').trim(),
    browserContext: browserState.browserSessionId
      ? {
        browserSessionId: String(browserState.browserSessionId || '').trim(),
        title: truncate(browserState.title || '', 220),
        url: truncate(browserState.url || '', 240),
        lastUpdated: browserState.lastUpdated || null,
      }
      : null,
  }), meta);
}

export async function setConversationKnowledgeHits(sessionId, hits = [], meta = {}) {
  const normalizedHits = (Array.isArray(hits) ? hits : []).slice(0, MAX_KNOWLEDGE_HITS).map((hit) => ({
    title: truncate(hit?.title || '', 160),
    canonicalUrl: truncate(hit?.canonicalUrl || '', 220),
    text: truncate(hit?.text || '', 180),
    score: Number(hit?.score || 0),
  }));

  return upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    knowledgeHits: normalizedHits,
  }), meta);
}

export async function closeConversationSession(sessionId) {
  return upsertConversation(sessionId, (current) => ({
    ...current,
    status: 'closed',
    activeSttSessionId: '',
  }));
}

export async function updateConversationSessionState(sessionId, state = {}, meta = {}) {
  const nextGreetingSent = typeof state.greetingSent === 'boolean' ? state.greetingSent : undefined;
  const nextLastFinalTranscriptHash = normalizeWhitespace(state.lastFinalTranscriptHash || '');
  const nextActiveSttSessionId = normalizeWhitespace(state.activeSttSessionId || '');

  return upsertConversation(sessionId, (current) => ({
    ...current,
    lastCharacterId: meta.characterId || current.lastCharacterId || '',
    greetingSent: typeof nextGreetingSent === 'boolean' ? nextGreetingSent : Boolean(current.greetingSent),
    lastFinalTranscriptHash: nextLastFinalTranscriptHash || current.lastFinalTranscriptHash || '',
    activeSttSessionId: nextActiveSttSessionId || (state.activeSttSessionId === '' ? '' : current.activeSttSessionId || ''),
  }), meta);
}

export async function getConversationRestoreContext(sessionId) {
  const session = await readConversation(String(sessionId || '').trim());
  if (!session) {
    return null;
  }

  return {
    conversationSessionId: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastCharacterId: session.lastCharacterId || '',
    summary: session.summary || '',
    recentTurns: Array.isArray(session.turns) ? session.turns.slice(-MAX_RECENT_TURNS) : [],
    actionLog: Array.isArray(session.actionLog) ? session.actionLog.slice(-MAX_ACTION_LOG) : [],
    browserSessionId: session.browserSessionId || '',
    browserContext: session.browserContext || null,
    activeSttSessionId: session.activeSttSessionId || '',
    greetingSent: Boolean(session.greetingSent),
    lastFinalTranscriptHash: session.lastFinalTranscriptHash || '',
    knowledgeHits: Array.isArray(session.knowledgeHits) ? session.knowledgeHits : [],
    status: session.status || 'active',
  };
}
