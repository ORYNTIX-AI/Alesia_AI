export function createGeminiBridgeConnectionHandler({
  WebSocket,
  createGeminiUpstreamSocket,
  getGeminiRetryDelayMs,
  logRuntime,
  normalizeWhitespace,
  safeCloseSocket,
  sanitizeGeminiProxySetupMessage,
  shouldRetryGeminiConnect,
}) {
  function attachGeminiBridgeConnection(clientWs, { route = 'gemini-proxy', voiceSession = null } = {}) {  
    logRuntime('ws.client.connected', {  
      route,  
      conversationSessionId: voiceSession?.conversationSessionId || '',  
      characterId: voiceSession?.characterId || '',  
    });  
    
    let geminiWs = null;  
    let messageBuffer = [];  
    let isConnected = false;  
    let connectAttempt = 0;  
    let connectRetryTimer = null;  
    let lastConnectError = null;  
    let clientClosed = false;  
    let lastSetupMessage = null;  
    let lastSetupPayload = null;  
    let latestSessionResumptionHandle = '';  
    
    const buildSetupMessageForReconnect = () => {  
      if (!lastSetupPayload || typeof lastSetupPayload !== 'object') {  
        return lastSetupMessage;  
      }  
    
      const payload = structuredClone(lastSetupPayload);  
      if (payload?.setup && payload.setup.sessionResumption) {  
        if (latestSessionResumptionHandle) {  
          payload.setup.sessionResumption.handle = latestSessionResumptionHandle;  
        } else {  
          delete payload.setup.sessionResumption.handle;  
        }  
      }  
    
      return JSON.stringify(payload);  
    };  
    
    const clearConnectRetryTimer = () => {  
      if (!connectRetryTimer) {  
        return;  
      }  
      clearTimeout(connectRetryTimer);  
      connectRetryTimer = null;  
    };  
    
    const scheduleConnectRetry = (details = {}) => {  
      if (clientClosed || clientWs.readyState !== WebSocket.OPEN) {  
        return false;  
      }  
      if (!shouldRetryGeminiConnect({ attempt: connectAttempt, ...details })) {  
        return false;  
      }  
    
      const delayMs = getGeminiRetryDelayMs(connectAttempt);  
      logRuntime('ws.gemini.retry.scheduled', {  
        attempt: connectAttempt + 1,  
        delayMs,  
        reason: normalizeWhitespace(details.error?.message || details.reason || ''),  
        code: Number(details.code) || 0,  
      });  
      clearConnectRetryTimer();  
      connectRetryTimer = setTimeout(() => {  
        connectGemini();  
      }, delayMs);  
      return true;  
    };  
    
    const connectGemini = () => {  
      if (clientClosed || clientWs.readyState !== WebSocket.OPEN) {  
        return;  
      }  
    
      clearConnectRetryTimer();  
      isConnected = false;  
      connectAttempt += 1;  
      lastConnectError = null;  
      const upstream = createGeminiUpstreamSocket({
        route,
        attempt: connectAttempt,
        conversationSessionId: voiceSession?.conversationSessionId || '',
      });  
      geminiWs = upstream;  
      logRuntime('ws.gemini.connect.attempt', {  
        route,  
        attempt: connectAttempt,  
        conversationSessionId: voiceSession?.conversationSessionId || '',  
      });  
    
      upstream.on('open', () => {  
        if (geminiWs !== upstream) {  
          upstream.close();  
          return;  
        }  
    
        logRuntime('ws.gemini.connected', {  
          route,  
          conversationSessionId: voiceSession?.conversationSessionId || '',  
        });  
        isConnected = true;  
        connectAttempt = 0;  
        lastConnectError = null;  
    
        const setupMessage = buildSetupMessageForReconnect();  
        if (setupMessage) {  
          upstream.send(setupMessage);  
        }  
    
        if (messageBuffer.length > 0) {  
          logRuntime('ws.gemini.flush-buffer', {  
            route,  
            messageCount: messageBuffer.length,  
          });  
          messageBuffer.forEach((message) => upstream.send(message));  
          messageBuffer = [];  
        }  
      });  
    
      upstream.on('message', (data) => {  
        try {  
          const parsed = data instanceof Buffer ? JSON.parse(data.toString('utf8')) : JSON.parse(String(data));  
          if (parsed?.sessionResumptionUpdate) {  
            const nextHandle = normalizeWhitespace(parsed.sessionResumptionUpdate.newHandle || '');  
            latestSessionResumptionHandle = parsed.sessionResumptionUpdate.resumable && nextHandle ? nextHandle : '';  
          }  
        } catch {  
          // Ignore non-JSON upstream messages.  
        }  
    
        if (clientWs.readyState === WebSocket.OPEN) {  
          clientWs.send(data);  
        }  
      });  
    
      upstream.on('error', (error) => {  
        if (geminiWs !== upstream) {  
          return;  
        }  
    
        lastConnectError = error;  
        logRuntime('ws.gemini.error', {  
          route,  
          error,  
          attempt: connectAttempt,  
          conversationSessionId: voiceSession?.conversationSessionId || '',  
        }, 'error');  
      });  
    
      upstream.on('close', (code, reason) => {  
        if (geminiWs !== upstream) {  
          return;  
        }  
    
        const closeReason = reason.toString();  
        isConnected = false;  
        logRuntime('ws.gemini.closed', {  
          route,  
          code,  
          reason: closeReason,  
          attempt: connectAttempt,  
          conversationSessionId: voiceSession?.conversationSessionId || '',  
        });  
    
        if (lastSetupMessage && scheduleConnectRetry({ error: lastConnectError, code, reason: closeReason })) {  
          return;  
        }  
    
        if (clientWs.readyState === WebSocket.OPEN) {  
          safeCloseSocket(clientWs, code, closeReason, `${route}-upstream-close`);  
        }  
      });  
    };  
    
    try {  
      connectGemini();  
    
      clientWs.on('message', (data) => {  
        const outgoing = sanitizeGeminiProxySetupMessage(data);  
        const textPayload = typeof outgoing === 'string'  
          ? outgoing  
          : (Buffer.isBuffer(outgoing) ? outgoing.toString('utf8') : '');  
        const isSetupMessage = Boolean(textPayload && textPayload.includes('"setup"'));  
        if (isSetupMessage) {  
          try {  
            lastSetupPayload = JSON.parse(textPayload);  
            const requestedHandle = normalizeWhitespace(lastSetupPayload?.setup?.sessionResumption?.handle || '');  
            latestSessionResumptionHandle = requestedHandle || latestSessionResumptionHandle;  
            lastSetupMessage = buildSetupMessageForReconnect();  
          } catch {  
            lastSetupPayload = null;  
            lastSetupMessage = outgoing;  
          }  
        }  
    
        if (isConnected && geminiWs.readyState === WebSocket.OPEN) {  
          geminiWs.send(isSetupMessage ? (lastSetupMessage || outgoing) : outgoing);  
        } else if (!isSetupMessage) {  
          messageBuffer.push(outgoing);  
        }  
      });  
    
    } catch (error) {  
      logRuntime('ws.gemini.create-failed', { route, error }, 'error');  
      safeCloseSocket(clientWs, 1011, 'Proxy Error', `${route}-create-failed`);  
    }  
    
    clientWs.on('close', () => {  
      clientClosed = true;  
      clearConnectRetryTimer();  
      logRuntime('ws.client.disconnected', {  
        route,  
        conversationSessionId: voiceSession?.conversationSessionId || '',  
      });  
      if (geminiWs && (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING)) {  
        geminiWs.close();  
      }  
    });  
    
    clientWs.on('error', (error) => {  
      clientClosed = true;  
      clearConnectRetryTimer();  
      logRuntime('ws.client.error', {  
        route,  
        error,  
        conversationSessionId: voiceSession?.conversationSessionId || '',  
      }, 'error');  
      if (geminiWs && (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING)) {  
        geminiWs.close();  
      }  
    });  
  }

  return attachGeminiBridgeConnection;
}
