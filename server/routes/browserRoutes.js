export function registerBrowserRoutes(app, {
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
} = {}) {
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

  app.post('/api/browser/cancel', async (req, res) => {
    try {
      const reason = normalizeWhitespace(req.body?.reason || 'client-cancel') || 'client-cancel';
      cancelPendingBrowserOperations(reason);
      return res.json({ ok: true, reason });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось отменить открытие сайта' });
    }
  });

  app.post('/api/browser/url-context', async (req, res) => {
    const startedAt = Date.now();
    const url = String(req.body?.url || '').trim();
    const question = String(req.body?.question || '').trim();
    const requestId = Number.isFinite(Number(req.body?.requestId)) ? Number(req.body?.requestId) : 0;

    try {
      if (!url) {
        return res.status(400).json({ error: 'URL страницы не передан' });
      }

      const result = await fetchBrowserUrlContext({ url, question });
      logRuntime('browser.url-context.result', {
        requestId,
        url: result?.url || url,
        title: result?.title || '',
        textLength: result?.readerText?.length || 0,
        ms: Date.now() - startedAt,
      });
      return res.json(result);
    } catch (error) {
      logRuntime('browser.url-context.error', {
        requestId,
        url,
        ms: Date.now() - startedAt,
        error,
      }, 'error');
      return res.status(400).json({ error: error.message || 'Не удалось прочитать страницу по URL' });
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
}
