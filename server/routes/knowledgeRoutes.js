export function registerKnowledgeRoutes(app, {
  getKnowledgeSources,
  getKnowledgeStatus,
  loadAppConfig,
  logRuntime,
  publishKnowledgeDraft,
  refreshKnowledgeDraft,
  saveAppConfig,
  searchKnowledge,
  setConversationKnowledgeHits,
} = {}) {
  app.get('/api/knowledge/status', async (_req, res) => {
    try {
      const config = await loadAppConfig();
      const status = await getKnowledgeStatus(config.knowledgeSources);
      return res.json(status);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Не удалось получить статус базы знаний' });
    }
  });

  app.get('/api/knowledge/sources', async (_req, res) => {
    try {
      const config = await loadAppConfig();
      const sources = await getKnowledgeSources(config.knowledgeSources);
      return res.json({ sources });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Не удалось получить источники базы знаний' });
    }
  });

  app.post('/api/knowledge/refresh', async (_req, res) => {
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

  app.post('/api/knowledge/publish', async (_req, res) => {
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
}
