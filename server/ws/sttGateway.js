export function createSttGatewayConnectionHandler({
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
}) {
  function handleSttGatewayConnection(clientWs, request) {
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
      let connectAttempt = 0;    
      let connectRetryTimer = null;    
      let lastConnectError = null;    
      let clientClosed = false;    
      const configPromise = loadAppConfig().catch(() => null);    
        
      const clearConnectRetryTimer = () => {    
        if (!connectRetryTimer) {    
          return;    
        }    
        clearTimeout(connectRetryTimer);    
        connectRetryTimer = null;    
      };    
        
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
        
      const scheduleConnectRetry = (details = {}) => {    
        if (clientClosed || clientWs.readyState !== WebSocket.OPEN) {    
          return false;    
        }    
        if (!shouldRetryGeminiConnect({ attempt: connectAttempt, ...details })) {    
          return false;    
        }    
        
        const delayMs = getGeminiRetryDelayMs(connectAttempt);    
        logRuntime('stt.stream.retry.scheduled', {    
          conversationSessionId,    
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
        
      const connectGemini = () => {    
        try {    
          clearConnectRetryTimer();    
          connectAttempt += 1;    
          lastConnectError = null;    
          geminiReady = false;    
          setupSent = false;    
          const upstream = createGeminiUpstreamSocket({
            route: 'stt',
            attempt: connectAttempt,
            conversationSessionId,
          });
          geminiWs = upstream;    
          logRuntime('stt.stream.connect.attempt', {    
            conversationSessionId,    
            attempt: connectAttempt,    
          });    
        
          upstream.on('open', () => {    
            if (geminiWs !== upstream) {    
              upstream.close();    
              return;    
            }    
        
            geminiReady = true;    
            connectAttempt = 0;    
            lastConnectError = null;    
            void sendSttSetup();    
          });    
        
          upstream.on('message', async (raw) => {    
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
        
          upstream.on('error', (error) => {    
            if (geminiWs !== upstream) {    
              return;    
            }    
        
            lastConnectError = error;    
            logRuntime('stt.stream.error', {    
              conversationSessionId,    
              error,    
              attempt: connectAttempt,    
            }, 'error');    
            if (geminiReady) {    
              sendToClient({ type: 'error', error: error.message || 'STT upstream error' });    
              if (clientWs.readyState === WebSocket.OPEN) {    
                safeCloseSocket(clientWs, 1011, error.message || 'STT upstream error', 'stt-upstream-error');    
              }    
            }    
          });    
        
          upstream.on('close', (code, reason) => {    
            if (geminiWs !== upstream) {    
              return;    
            }    
        
            const closeReason = reason.toString();    
            if (!geminiReady && scheduleConnectRetry({ error: lastConnectError, code, reason: closeReason })) {    
              return;    
            }    
        
            finalizeBufferedTranscript('upstream-close');    
            logRuntime('stt.stream.closed', {    
              conversationSessionId,    
              code,    
              reason: closeReason,    
              attempt: connectAttempt,    
            });    
            if (clientWs.readyState === WebSocket.OPEN) {    
              safeCloseSocket(clientWs, code, closeReason, 'stt-upstream-close');    
            }    
          });    
        } catch (error) {    
          logRuntime('stt.stream.error', {    
            conversationSessionId,    
            error,    
          }, 'error');    
          safeCloseSocket(clientWs, 1011, 'STT proxy create failed', 'stt-proxy-create-failed');    
        }    
      };    
        
      connectGemini();    
        
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
                audio: {    
                  mimeType: 'audio/pcm;rate=16000',    
                  data: payload.data,    
                },    
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
        clientClosed = true;    
        clearConnectRetryTimer();    
        finalizeBufferedTranscript('client-close');    
        if (geminiWs && (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING)) {    
          geminiWs.close();    
        }    
      });    
        
      clientWs.on('error', (error) => {    
        clientClosed = true;    
        clearConnectRetryTimer();    
        logRuntime('stt.client.error', {    
          conversationSessionId,    
          error,    
        }, 'error');    
        if (geminiWs && (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING)) {    
          geminiWs.close();    
        }    
      });
  }

  return handleSttGatewayConnection;
}
