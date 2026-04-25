import { WebSocket } from 'ws';
import { getConversationRestoreContext } from '../conversationStore.js';
import { logRuntime } from '../runtimeLogger.js';
import {
  buildModelSafeToolPayload,
  buildResponseCreatePayload,
  buildSessionStartPayload,
  buildYandexAuthHeaders,
  buildYandexRealtimeSocketUrl,
  clearPendingResponseDone,
  closeBothSockets,
  extractResponseId,
  extractToolCall,
  isClosedResponseId,
  normalizeAssistantOutputEvent,
  normalizeTranscriptEvent,
  normalizeWhitespace,
  rememberClosedResponseId,
  safeJsonParse,
  scheduleAssistantTurnDone,
  sendJson,
  shouldForwardResponseCancel,
} from './yandexRealtimeShared.js';
import {
  executeToolCall,
} from './yandexRealtimeTools.js';

export function attachYandexRealtimeBridgeConnection(clientWs, { voiceSession = null, route = 'yandex-realtime-proxy' } = {}) {
  let upstreamWs = null;
  let upstreamConnectPromise = null;
  const YANDEX_RECONNECT_MAX_ATTEMPTS = 3;
  const YANDEX_RECONNECT_BASE_DELAY_MS = 800;
  let reconnectTimer = null;
  const connectionState = {
    route,
    conversationSessionId: normalizeWhitespace(voiceSession?.conversationSessionId || ''),
    characterId: normalizeWhitespace(voiceSession?.characterId || ''),
    runtimeConfig: {},
    restoreContext: null,
    upstreamReady: false,
    sessionConfigured: false,
    clientClosed: false,
    clientQueue: [],
    responseCreateTimer: null,
    awaitingToolResult: false,
    readySent: false,
    responseIdsWithTextDelta: new Set(),
    activeResponseId: '',
    pendingResponseDoneTimers: new Map(),
    closedResponseIds: new Set(),
    reconnectAttempt: 0,
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearResponseCreateTimer = () => {
    if (connectionState.responseCreateTimer) {
      clearTimeout(connectionState.responseCreateTimer);
      connectionState.responseCreateTimer = null;
    }
  };

  const scheduleResponseCreate = (delayMs = 260, instructions = '') => {
    if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
      return;
    }
    if (connectionState.awaitingToolResult) {
      return;
    }
    clearResponseCreateTimer();
    connectionState.responseCreateTimer = setTimeout(() => {
      connectionState.responseCreateTimer = null;
      if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
        return;
      }
      upstreamWs.send(JSON.stringify(buildResponseCreatePayload(instructions)));
    }, delayMs);
  };

  const flushQueuedClientMessages = async () => {
    if (!connectionState.upstreamReady || !connectionState.clientQueue.length) {
      return;
    }
    const queued = [...connectionState.clientQueue];
    connectionState.clientQueue = [];
    for (const message of queued) {
      await handleClientMessage(message);
    }
  };

  const attachUpstreamHandlers = () => {
    upstreamWs.on('open', async () => {
      connectionState.upstreamReady = true;
      logRuntime('yandex.realtime.connected', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
      });
      await flushQueuedClientMessages();
    });

    upstreamWs.on('message', async (rawData) => {
      const asText = rawData instanceof Buffer ? rawData.toString('utf8') : String(rawData || '');
      const eventPayload = safeJsonParse(asText, null);
      if (!eventPayload || typeof eventPayload !== 'object') {
        return;
      }

      const toolCall = extractToolCall(eventPayload);
      if (toolCall?.name && toolCall.callId) {
        clearResponseCreateTimer();
        connectionState.awaitingToolResult = true;
        await handleToolCall(toolCall);
        return;
      }

      if (eventPayload.type === 'session.updated') {
        if (!connectionState.readySent) {
          connectionState.readySent = true;
          sendJson(clientWs, {
            type: 'ready',
            resumed: false,
            shouldSendGreeting: connectionState.runtimeConfig.shouldSendGreeting !== false,
          });
        }
        return;
      }

      const transcriptEvent = normalizeTranscriptEvent(eventPayload);
      if (transcriptEvent) {
        sendJson(clientWs, transcriptEvent);
        return;
      }

      if (eventPayload.type === 'response.created') {
        connectionState.activeResponseId = extractResponseId(eventPayload) || connectionState.activeResponseId;
        return;
      }

      const assistantEvent = normalizeAssistantOutputEvent(eventPayload, connectionState);
      if (assistantEvent) {
        const responseId = normalizeWhitespace(assistantEvent.responseId || extractResponseId(eventPayload) || '');
        if (eventPayload.type === 'response.output_text.delta' && responseId) {
          connectionState.responseIdsWithTextDelta.add(responseId);
        }
        if (
          eventPayload.type === 'response.output_audio_transcript.done'
          && responseId
          && connectionState.responseIdsWithTextDelta.has(responseId)
        ) {
          return;
        }
        if (responseId && isClosedResponseId(connectionState, responseId)) {
          return;
        }
        if (
          responseId
          && (
            assistantEvent.type === 'assistant_text_delta'
            || assistantEvent.type === 'assistant_audio_delta'
          )
        ) {
          connectionState.activeResponseId = responseId;
          const hadPendingDone = clearPendingResponseDone(connectionState, responseId);
          if (hadPendingDone) {
            scheduleAssistantTurnDone(clientWs, connectionState, responseId);
          }
        }
        if (eventPayload.type === 'response.done' && responseId) {
          connectionState.responseIdsWithTextDelta.delete(responseId);
          if (connectionState.activeResponseId === responseId) {
            connectionState.activeResponseId = '';
          }
          scheduleAssistantTurnDone(clientWs, connectionState, responseId);
          return;
        }
        sendJson(clientWs, assistantEvent);
        return;
      }

      if (eventPayload.type === 'error') {
        const errorMessage = normalizeWhitespace(eventPayload?.error?.message || eventPayload?.message || 'Yandex realtime error');
        if (/no such response|unknown response/i.test(errorMessage)) {
          logRuntime('yandex.realtime.response-cancel.ignored', {
            route,
            conversationSessionId: connectionState.conversationSessionId,
            characterId: connectionState.characterId,
            message: errorMessage,
          });
          return;
        }
        sendJson(clientWs, {
          type: 'error',
          message: errorMessage,
          details: eventPayload,
        });
      }
    });

    upstreamWs.on('error', (error) => {
      logRuntime('yandex.realtime.error', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        error,
      }, 'error');
      sendJson(clientWs, {
        type: 'error',
        message: normalizeWhitespace(error?.message || 'Yandex realtime connection failed'),
      });
    });

    upstreamWs.on('close', (code, reason) => {
      connectionState.upstreamReady = false;
      connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
      connectionState.pendingResponseDoneTimers.clear();
      const closeReason = normalizeWhitespace(reason?.toString?.() || '');
      logRuntime('yandex.realtime.closed', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        code,
        reason: closeReason,
        reconnectAttempt: connectionState.reconnectAttempt,
      });
      if (connectionState.clientClosed) {
        return;
      }
      // Auto-reconnect upstream if client is still alive
      if (connectionState.sessionConfigured && connectionState.reconnectAttempt < YANDEX_RECONNECT_MAX_ATTEMPTS) {
        connectionState.reconnectAttempt += 1;
        const delayMs = YANDEX_RECONNECT_BASE_DELAY_MS * Math.pow(2, connectionState.reconnectAttempt - 1);
        logRuntime('yandex.realtime.reconnect.scheduled', {
          route,
          attempt: connectionState.reconnectAttempt,
          delayMs,
          conversationSessionId: connectionState.conversationSessionId,
        });
        sendJson(clientWs, {
          type: 'goaway',
          reason: 'upstream_reconnect',
          attempt: connectionState.reconnectAttempt,
        });
        clearReconnectTimer();
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;
          if (connectionState.clientClosed) {
            return;
          }
          try {
            upstreamConnectPromise = null;
            upstreamWs = null;
            await ensureUpstreamConnection(connectionState.runtimeConfig);
            await configureSession(connectionState.runtimeConfig);
            logRuntime('yandex.realtime.reconnect.ok', {
              route,
              attempt: connectionState.reconnectAttempt,
              conversationSessionId: connectionState.conversationSessionId,
            });
            connectionState.reconnectAttempt = 0;
          } catch (reconnectError) {
            logRuntime('yandex.realtime.reconnect.failed', {
              route,
              attempt: connectionState.reconnectAttempt,
              error: reconnectError,
            }, 'error');
            closeBothSockets(clientWs, upstreamWs, 1011, 'Yandex realtime reconnect failed');
          }
        }, delayMs);
        return;
      }
      closeBothSockets(clientWs, upstreamWs, Number(code) || 1011, closeReason || 'Yandex realtime closed');
    });
  };

  const ensureUpstreamConnection = async (runtimeConfig = {}) => {
    if (connectionState.upstreamReady && upstreamWs) {
      return upstreamWs;
    }
    if (upstreamConnectPromise) {
      await upstreamConnectPromise;
      return upstreamWs;
    }

    upstreamWs = new WebSocket(buildYandexRealtimeSocketUrl(runtimeConfig.modelId || 'speech-realtime-250923'), {
      headers: buildYandexAuthHeaders(),
    });
    attachUpstreamHandlers();

    upstreamConnectPromise = new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        upstreamWs?.off('open', handleOpen);
        upstreamWs?.off('error', handleError);
        upstreamConnectPromise = null;
      };
      upstreamWs.on('open', handleOpen);
      upstreamWs.on('error', handleError);
    });

    await upstreamConnectPromise;
    return upstreamWs;
  };

  const configureSession = async (runtimeConfig = {}) => {
    connectionState.runtimeConfig = {
      ...runtimeConfig,
    };
    connectionState.restoreContext = connectionState.conversationSessionId
      ? await getConversationRestoreContext(connectionState.conversationSessionId).catch(() => null)
      : null;

    upstreamWs.send(JSON.stringify(buildSessionStartPayload(connectionState.runtimeConfig, connectionState.restoreContext)));
    connectionState.sessionConfigured = true;
  };

  const sendToolOutputBackToModel = (callId, payload) => {
    connectionState.awaitingToolResult = false;
    upstreamWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(payload),
      },
    }));
    scheduleResponseCreate();
  };

  const handleToolCall = async (toolCall) => {
    const rawArgs = safeJsonParse(toolCall.argumentsText, {}) || {};
    sendJson(clientWs, {
      type: 'tool_call',
      name: toolCall.name,
      callId: toolCall.callId,
      arguments: rawArgs,
    });

    let payload;
    let modelPayload;
    try {
      const result = await executeToolCall(toolCall.name, rawArgs, connectionState);
      payload = result;
      modelPayload = buildModelSafeToolPayload(toolCall.name, result);
      sendJson(clientWs, {
        type: 'tool_result',
        name: toolCall.name,
        callId: toolCall.callId,
        result,
      });
      logRuntime('yandex.realtime.tool.ok', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        toolName: toolCall.name,
      });
    } catch (toolError) {
      payload = {
        ok: false,
        error: normalizeWhitespace(toolError?.message || 'Tool failed'),
      };
      modelPayload = payload;
      sendJson(clientWs, {
        type: 'tool_result',
        name: toolCall.name,
        callId: toolCall.callId,
        result: payload,
      });
      logRuntime('yandex.realtime.tool.error', {
        route,
        conversationSessionId: connectionState.conversationSessionId,
        characterId: connectionState.characterId,
        toolName: toolCall.name,
        error: toolError,
      }, 'error');
    }

    sendToolOutputBackToModel(toolCall.callId, modelPayload);
  };

  async function handleClientMessage(messageText) {
    const payload = safeJsonParse(messageText, null);
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'session.start' && !connectionState.upstreamReady) {
      connectionState.clientQueue.push(messageText);
      await ensureUpstreamConnection(payload.runtimeConfig || {});
      return;
    }

    if (!connectionState.upstreamReady) {
      connectionState.clientQueue.push(messageText);
      return;
    }

    switch (payload.type) {
      case 'session.start': {
        await configureSession(payload.runtimeConfig || {});
        break;
      }
      case 'audio.append': {
        if (!connectionState.sessionConfigured) {
          return;
        }
        upstreamWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: String(payload.audio || ''),
        }));
        break;
      }
      case 'input_text': {
        const text = normalizeWhitespace(payload.text || '');
        if (!text || !connectionState.sessionConfigured) {
          return;
        }
        upstreamWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text,
              },
            ],
          },
        }));
        upstreamWs.send(JSON.stringify(buildResponseCreatePayload()));
        break;
      }
      case 'interrupt': {
        const responseId = normalizeWhitespace(payload.responseId || connectionState.activeResponseId || '');
        if (responseId) {
          const shouldForwardCancel = shouldForwardResponseCancel(connectionState, responseId);
          clearPendingResponseDone(connectionState, responseId);
          rememberClosedResponseId(connectionState, responseId);
          if (shouldForwardCancel && upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
            try {
              upstreamWs.send(JSON.stringify({
                type: 'response.cancel',
                response_id: responseId,
              }));
            } catch (cancelError) {
              logRuntime('yandex.realtime.cancel.error', {
                route,
                responseId,
                error: cancelError,
              }, 'error');
            }
          }
          sendJson(clientWs, {
            type: 'assistant_turn_cancelled',
            responseId,
            reason: 'client_interrupt',
          });
        }
        if (connectionState.activeResponseId === responseId) {
          connectionState.activeResponseId = '';
        }
        break;
      }
      case 'session.stop': {
        closeBothSockets(clientWs, upstreamWs, 1000, 'Session stopped');
        break;
      }
      default:
        break;
    }
  }

  clientWs.on('message', (rawData) => {
    const asText = rawData instanceof Buffer ? rawData.toString('utf8') : String(rawData || '');
    void handleClientMessage(asText);
  });

  clientWs.on('close', (code, reason) => {
    connectionState.clientClosed = true;
    clearResponseCreateTimer();
    connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
    connectionState.pendingResponseDoneTimers.clear();
    logRuntime('yandex.realtime.client.closed', {
      route,
      conversationSessionId: connectionState.conversationSessionId,
      characterId: connectionState.characterId,
      code,
      reason: normalizeWhitespace(reason?.toString?.() || ''),
    });
    closeBothSockets(clientWs, upstreamWs, 1000, 'Client disconnected');
  });

  clientWs.on('error', (error) => {
    connectionState.clientClosed = true;
    clearResponseCreateTimer();
    connectionState.pendingResponseDoneTimers.forEach((timerId) => clearTimeout(timerId));
    connectionState.pendingResponseDoneTimers.clear();
    logRuntime('yandex.realtime.client.error', {
      route,
      conversationSessionId: connectionState.conversationSessionId,
      characterId: connectionState.characterId,
      message: normalizeWhitespace(error?.message || 'Client websocket error'),
    });
    closeBothSockets(clientWs, upstreamWs, 1011, 'Client error');
  });
}
