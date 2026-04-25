export function registerConversationRoutes(app, {
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
} = {}) {
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
}
