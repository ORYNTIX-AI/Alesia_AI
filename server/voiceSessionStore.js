import { randomUUID } from 'crypto';

const DEFAULT_TTL_MS = Math.max(30000, Number(process.env.VOICE_SESSION_TTL_MS || 120000));
const sessions = new Map();

function normalizeValue(value) {
  return String(value || '').trim();
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function issueVoiceSessionToken({
  conversationSessionId = '',
  characterId = '',
} = {}) {
  cleanupExpiredSessions();
  const normalizedConversationSessionId = normalizeValue(conversationSessionId);
  if (!normalizedConversationSessionId) {
    throw new Error('Не передан идентификатор голосовой сессии');
  }

  const token = randomUUID();
  const expiresAt = Date.now() + DEFAULT_TTL_MS;
  sessions.set(token, {
    token,
    conversationSessionId: normalizedConversationSessionId,
    characterId: normalizeValue(characterId),
    expiresAt,
  });

  return {
    token,
    expiresAt,
  };
}

export function consumeVoiceSessionToken(token) {
  cleanupExpiredSessions();
  const normalizedToken = normalizeValue(token);
  if (!normalizedToken) {
    return null;
  }

  const session = sessions.get(normalizedToken) || null;
  if (!session) {
    return null;
  }

  sessions.delete(normalizedToken);
  return session;
}

export function getVoiceSessionStoreStats() {
  cleanupExpiredSessions();
  return {
    activeTokens: sessions.size,
    ttlMs: DEFAULT_TTL_MS,
  };
}
