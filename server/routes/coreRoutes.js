function withAppConfigMetadata(config, supportedVoiceNames, supportedVoices) {
  return {
    ...config,
    supportedVoiceNames,
    supportedVoices,
  };
}

const APP_VERSION = process.env.APP_VERSION || '0.0.15';
const APP_COMMIT = process.env.APP_COMMIT || 'unknown';
const APP_BUILD_TIME = process.env.APP_BUILD_TIME || '';

export function registerCoreRoutes(app, {
  getAppConfigPath,
  getRuntimeLogPath,
  getVoiceSessionStoreStats,
  issueVoiceSessionToken,
  loadAppConfig,
  logRuntime,
  normalizeWhitespace,
  proxyInfo,
  saveAppConfig,
  supportedVoiceNames,
  supportedVoices,
} = {}) {
  app.get('/health', async (_req, res) => {
    const config = await loadAppConfig();
    const voiceSessionStats = getVoiceSessionStoreStats();
    res.json({
      status: 'ok',
      version: APP_VERSION,
      commit: APP_COMMIT,
      buildTime: APP_BUILD_TIME,
      proxy: proxyInfo?.host || '',
      proxyScheme: proxyInfo?.scheme || '',
      configPath: getAppConfigPath(),
      logPath: getRuntimeLogPath(),
      characters: config.characters.length,
      knowledgeSources: Array.isArray(config.knowledgeSources) ? config.knowledgeSources.length : 0,
      voiceSessionTokens: voiceSessionStats.activeTokens,
    });
  });

  app.get('/api/app-config', async (_req, res) => {
    try {
      const config = await loadAppConfig();
      res.json(withAppConfigMetadata(config, supportedVoiceNames, supportedVoices));
    } catch (error) {
      console.error('Failed to load app config', error);
      res.status(500).json({ error: 'Не удалось загрузить конфиг приложения' });
    }
  });

  app.put('/api/app-config', async (req, res) => {
    try {
      const saved = await saveAppConfig(req.body);
      res.json(withAppConfigMetadata(saved, supportedVoiceNames, supportedVoices));
    } catch (error) {
      console.error('Failed to save app config', error);
      res.status(400).json({ error: 'Не удалось сохранить конфиг приложения' });
    }
  });

  app.post('/api/voice/session', async (req, res) => {
    try {
      const conversationSessionId = normalizeWhitespace(req.body?.conversationSessionId || '');
      const characterId = normalizeWhitespace(req.body?.characterId || '');
      if (!conversationSessionId) {
        return res.status(400).json({ error: 'Не передан идентификатор голосовой сессии' });
      }

      const requestedGatewayUrl = normalizeWhitespace(req.body?.requestedGatewayUrl || '');
      const isAbsoluteGatewayUrl = /^wss?:\/\//i.test(requestedGatewayUrl);
      const forwardedProto = normalizeWhitespace(req.get('x-forwarded-proto') || '').toLowerCase();
      const forwardedHost = normalizeWhitespace(req.get('x-forwarded-host') || '');
      const wsProtocol = (forwardedProto === 'https' || req.protocol === 'https') ? 'wss' : 'ws';
      const publicHost = forwardedHost || req.get('host') || '127.0.0.1:8200';
      const defaultGatewayUrl = `${wsProtocol}://${publicHost}/voice-proxy`;
      const voiceGatewayUrl = requestedGatewayUrl
        ? (isAbsoluteGatewayUrl ? requestedGatewayUrl : `${wsProtocol}://${publicHost}${requestedGatewayUrl.startsWith('/') ? requestedGatewayUrl : `/${requestedGatewayUrl}`}`)
        : defaultGatewayUrl;
      const session = issueVoiceSessionToken({
        conversationSessionId,
        characterId,
      });

      logRuntime('voice.session.issued', {
        conversationSessionId,
        characterId,
        expiresAt: session.expiresAt,
      });

      return res.json({
        conversationSessionId,
        voiceGatewayUrl,
        sessionToken: session.token,
        expiresAt: new Date(session.expiresAt).toISOString(),
        mode: 'proxy-ws',
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось подготовить голосовую сессию' });
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
}
