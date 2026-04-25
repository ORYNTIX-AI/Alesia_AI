function rejectUnauthorizedUpgrade(socket) {
  try {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  } catch {
    // Ignore response write failures during rejected upgrade.
  }
  socket.destroy();
}

export function registerUpgradeHandlers({
  consumeVoiceSessionToken,
  geminiProxyWss,
  normalizeWhitespace,
  server,
  sttWss,
  voiceGatewayWss,
  yandexRealtimeGatewayWss,
}) {
  server.on('upgrade', (request, socket, head) => {
    try {
      const parsed = new URL(request.url || '/', 'http://localhost');
      if (parsed.pathname === '/gemini-proxy') {
        geminiProxyWss.handleUpgrade(request, socket, head, (ws) => {
          geminiProxyWss.emit('connection', ws, request);
        });
        return;
      }

      if (parsed.pathname === '/voice-proxy') {
        const sessionToken = normalizeWhitespace(parsed.searchParams.get('sessionToken') || '');
        const voiceSession = consumeVoiceSessionToken(sessionToken);
        if (!voiceSession) {
          rejectUnauthorizedUpgrade(socket);
          return;
        }

        voiceGatewayWss.handleUpgrade(request, socket, head, (ws) => {
          voiceGatewayWss.emit('connection', ws, request, voiceSession);
        });
        return;
      }

      if (parsed.pathname === '/yandex-realtime-proxy') {
        const sessionToken = normalizeWhitespace(parsed.searchParams.get('sessionToken') || '');
        const voiceSession = consumeVoiceSessionToken(sessionToken);
        if (!voiceSession) {
          rejectUnauthorizedUpgrade(socket);
          return;
        }

        yandexRealtimeGatewayWss.handleUpgrade(request, socket, head, (ws) => {
          yandexRealtimeGatewayWss.emit('connection', ws, request, voiceSession);
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
}
