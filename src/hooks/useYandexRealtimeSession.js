import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, downsampleBuffer, float32ToBase64 } from '../utils/audioConverter.js';

const DEFAULT_RUNTIME_CONFIG = {
  runtimeProvider: 'yandex-realtime',
  modelId: 'speech-realtime-250923',
  voiceName: 'ermil',
  ttsVoiceName: 'ermil',
  systemPrompt: '',
  greetingText: '',
  sessionContextText: '',
  shouldSendGreeting: true,
  captureUserAudio: true,
  voiceGatewayUrl: '/yandex-realtime-proxy',
  conversationSessionId: '',
  characterId: '',
  outputAudioTranscription: false,
  vectorStoreId: '',
  enabledTools: [],
  webSearchEnabled: false,
  maxToolResults: 4,
};

const DEFAULT_CALLBACKS = {
  onInputTranscription: null,
  onInputTranscriptionCommit: null,
  onAssistantTurnStart: null,
  onAssistantAudioStart: null,
  onAssistantAudioDrop: null,
  onAssistantTurnCommit: null,
  onAssistantTurnCancel: null,
  onAssistantInterrupted: null,
  onSessionReady: null,
  onToolCall: null,
  onToolResult: null,
};

const DEFAULT_BACKEND_WS_BASE =
  String(import.meta.env?.VITE_BACKEND_WS_BASE || '').trim().replace(/\/+$/, '');
const DEFAULT_BACKEND_HTTP_BASE =
  String(import.meta.env?.VITE_BACKEND_HTTP_BASE || '').trim().replace(/\/+$/, '');
const INPUT_SAMPLE_RATE = 24000;
const OUTPUT_SAMPLE_RATE = 24000;
const ASSISTANT_TURN_IDLE_FLUSH_MS = 2600;
const SPEECH_STARTED_INTERRUPT_COOLDOWN_MS = 350;
const SPEECH_STARTED_BUFFER_GUARD_MS = 120;
const SPEECH_STARTED_VOLUME_GUARD = 0.025;
const INPUT_ECHO_SUPPRESSION_BUFFER_MS = 180;
const INPUT_ECHO_SUPPRESSION_TAIL_MS = 650;
const INPUT_ECHO_SUPPRESSION_VOLUME_GUARD = 0.012;

function defaultBackendWsUrl(pathname = '/yandex-realtime-proxy') {
  if (DEFAULT_BACKEND_WS_BASE) {
    return `${DEFAULT_BACKEND_WS_BASE}${pathname}`;
  }
  if (typeof window === 'undefined') {
    return `ws://127.0.0.1:8200${pathname}`;
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${window.location.host}${pathname}`;
}

function defaultBackendHttpUrl(pathname = '/api/voice/session') {
  if (DEFAULT_BACKEND_HTTP_BASE) {
    return `${DEFAULT_BACKEND_HTTP_BASE}${pathname}`;
  }
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:8200${pathname}`;
  }
  return `${window.location.origin}${pathname}`;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeWsLikeUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }
  if (/^wss?:\/\//i.test(value)) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^http/i, 'ws');
  }
  if (value.startsWith('/')) {
    return defaultBackendWsUrl(value);
  }
  return value;
}

async function requestVoiceGatewaySession(runtimeConfig) {
  const response = await fetch(defaultBackendHttpUrl('/api/voice/session'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversationSessionId: String(runtimeConfig?.conversationSessionId || '').trim(),
      characterId: String(runtimeConfig?.characterId || '').trim(),
      requestedGatewayUrl: String(runtimeConfig?.voiceGatewayUrl || '/yandex-realtime-proxy').trim(),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Не удалось подготовить Yandex realtime сессию (HTTP ${response.status})`);
  }

  return {
    gatewayUrl: normalizeWsLikeUrl(payload?.voiceGatewayUrl || '/yandex-realtime-proxy'),
    sessionToken: String(payload?.sessionToken || '').trim(),
  };
}

export function useYandexRealtimeSession(audioPlayer, runtimeConfig = DEFAULT_RUNTIME_CONFIG, callbacks = DEFAULT_CALLBACKS) {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const statusRef = useRef('disconnected');
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const inputMonitorGainRef = useRef(null);
  const streamRef = useRef(null);
  const userVolumeRef = useRef(0);
  const runtimeConfigRef = useRef({ ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig });
  const callbacksRef = useRef({ ...DEFAULT_CALLBACKS, ...callbacks });
  const assistantTurnRef = useRef({
    active: false,
    responseId: '',
    text: '',
    interrupted: false,
    timerId: null,
    startedAt: 0,
    textChunks: 0,
    audioChunks: 0,
  });
  const closedResponseIdsRef = useRef(new Set());
  const lifecycleTokenRef = useRef(0);
  const lastSpeechStartedInterruptAtRef = useRef(0);
  const lastAssistantAudioOutputAtRef = useRef(0);
  const inputAudioStatsRef = useRef({ chunks: 0, lastLoggedAt: 0 });

  useEffect(() => {
    runtimeConfigRef.current = { ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig };
  }, [runtimeConfig]);

  useEffect(() => {
    callbacksRef.current = { ...DEFAULT_CALLBACKS, ...callbacks };
  }, [callbacks]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const clearAssistantTurnTimer = useCallback(() => {
    if (assistantTurnRef.current.timerId) {
      clearTimeout(assistantTurnRef.current.timerId);
      assistantTurnRef.current.timerId = null;
    }
  }, []);

  const resetAssistantTurn = useCallback(() => {
    assistantTurnRef.current = {
      active: false,
      responseId: '',
      text: '',
      interrupted: false,
      timerId: null,
      startedAt: 0,
      textChunks: 0,
      audioChunks: 0,
    };
  }, []);

  const rememberClosedResponseId = useCallback((responseId) => {
    const normalized = normalizeText(responseId);
    if (!normalized) {
      return;
    }
    closedResponseIdsRef.current.add(normalized);
    if (closedResponseIdsRef.current.size > 48) {
      const nextSet = new Set(Array.from(closedResponseIdsRef.current).slice(-24));
      closedResponseIdsRef.current = nextSet;
    }
  }, []);

  const clearClosedResponseIds = useCallback(() => {
    closedResponseIdsRef.current = new Set();
  }, []);

  const isClosedResponseId = useCallback((responseId) => {
    const normalized = normalizeText(responseId);
    if (!normalized) {
      return false;
    }
    return closedResponseIdsRef.current.has(normalized);
  }, []);

  const flushAssistantTurn = useCallback((mode = 'commit') => {
    clearAssistantTurnTimer();
    const currentTurn = assistantTurnRef.current;
    const responseId = normalizeText(currentTurn.responseId);
    const text = normalizeText(currentTurn.text);
    const hadContent = Boolean(responseId) && (currentTurn.active || Boolean(text) || currentTurn.audioChunks > 0);
    resetAssistantTurn();
    if (!hadContent) {
      return;
    }
    rememberClosedResponseId(responseId);
    if (mode === 'cancel' || currentTurn.interrupted) {
      callbacksRef.current.onAssistantTurnCancel?.({
        responseId,
        text,
        interrupted: Boolean(currentTurn.interrupted),
      });
      return;
    }
    callbacksRef.current.onAssistantTurnCommit?.({
      responseId,
      text,
      textChunks: currentTurn.textChunks,
      audioChunks: currentTurn.audioChunks,
      durationMs: currentTurn.startedAt ? Math.max(0, Date.now() - currentTurn.startedAt) : 0,
    });
  }, [clearAssistantTurnTimer, rememberClosedResponseId, resetAssistantTurn]);

  const scheduleAssistantTurnFlush = useCallback(() => {
    clearAssistantTurnTimer();
    assistantTurnRef.current.timerId = window.setTimeout(() => {
      flushAssistantTurn('commit');
    }, ASSISTANT_TURN_IDLE_FLUSH_MS);
  }, [clearAssistantTurnTimer, flushAssistantTurn]);

  const ensureAssistantTurnStarted = useCallback((responseId = '') => {
    const normalizedResponseId = normalizeText(responseId);
    if (!normalizedResponseId || isClosedResponseId(normalizedResponseId)) {
      return false;
    }

    if (assistantTurnRef.current.active && assistantTurnRef.current.responseId === normalizedResponseId) {
      return true;
    }

    if (assistantTurnRef.current.active && assistantTurnRef.current.responseId !== normalizedResponseId) {
      flushAssistantTurn(assistantTurnRef.current.interrupted ? 'cancel' : 'commit');
    }

    const accepted = callbacksRef.current.onAssistantTurnStart?.({ responseId: normalizedResponseId }) !== false;
    if (!accepted) {
      rememberClosedResponseId(normalizedResponseId);
      return false;
    }
    assistantTurnRef.current.active = true;
    assistantTurnRef.current.responseId = normalizedResponseId;
    assistantTurnRef.current.text = '';
    assistantTurnRef.current.interrupted = false;
    assistantTurnRef.current.startedAt = Date.now();
    assistantTurnRef.current.textChunks = 0;
    assistantTurnRef.current.audioChunks = 0;
    return true;
  }, [flushAssistantTurn, isClosedResponseId, rememberClosedResponseId]);

  const releaseInputResources = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.port?.onmessage && (processorRef.current.port.onmessage = null);
      processorRef.current.disconnect?.();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect?.();
      sourceRef.current = null;
    }
    if (inputMonitorGainRef.current) {
      inputMonitorGainRef.current.disconnect?.();
      inputMonitorGainRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.enabled = false;
          track.stop();
        } catch {
          // Ignore per-track teardown failures.
        }
      });
      streamRef.current = null;
    }
  }, []);

  const clearSessionResumption = useCallback(() => {}, []);

  const recordInputAudioSent = useCallback(({
    rms = 0,
    sampleRate = 0,
    samples = 0,
    source = 'worklet',
  } = {}) => {
    const stats = inputAudioStatsRef.current;
    stats.chunks += 1;
    const now = Date.now();
    if (stats.chunks !== 1 && (now - stats.lastLoggedAt) < 2500) {
      return;
    }
    stats.lastLoggedAt = now;
    const activeRuntime = runtimeConfigRef.current || {};
    fetch('/api/browser/client-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'voice.input.audio-sent',
        details: {
          conversationSessionId: String(activeRuntime.conversationSessionId || ''),
          characterId: String(activeRuntime.characterId || ''),
          source,
          chunks: stats.chunks,
          rms: Number(rms.toFixed(5)),
          sampleRate,
          samples,
        },
      }),
    }).catch(() => {});
  }, []);

  const requestAssistantInterrupt = useCallback((responseId = '') => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }

    const normalizedResponseId = normalizeText(responseId || assistantTurnRef.current.responseId || '');
    const payload = normalizedResponseId
      ? { type: 'interrupt', responseId: normalizedResponseId }
      : { type: 'interrupt' };

    try {
      wsRef.current.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const shouldSuppressUserAudioInput = useCallback(() => {
    const bufferedAudioMs = Number(audioPlayer?.getBufferedMs?.() || 0);
    const assistantVolume = Number(audioPlayer?.getVolume?.() || 0);
    const recentlyPlayedAssistantAudio =
      assistantTurnRef.current.audioChunks > 0
      && (Date.now() - lastAssistantAudioOutputAtRef.current) < INPUT_ECHO_SUPPRESSION_TAIL_MS;
    return bufferedAudioMs > INPUT_ECHO_SUPPRESSION_BUFFER_MS
      || assistantVolume > INPUT_ECHO_SUPPRESSION_VOLUME_GUARD
      || recentlyPlayedAssistantAudio;
  }, [audioPlayer]);

  const cancelAssistantOutput = useCallback((options = {}) => {
    const responseId = normalizeText(assistantTurnRef.current.responseId || '');
    const bufferedAudioMs = Number(audioPlayer?.getBufferedMs?.() || 0);
    const hasLocalOutput = assistantTurnRef.current.active || Boolean(responseId) || bufferedAudioMs > 80;
    const interruptRequested = options.notifyServer === false || !hasLocalOutput ? false : requestAssistantInterrupt(responseId);
    if (!hasLocalOutput && !interruptRequested) {
      return false;
    }
    audioPlayer.stop?.();
    if (hasLocalOutput && assistantTurnRef.current.active) {
      assistantTurnRef.current.interrupted = true;
    }
    if (hasLocalOutput) {
      callbacksRef.current.onAssistantInterrupted?.();
      flushAssistantTurn('cancel');
    }
    return true;
  }, [audioPlayer, flushAssistantTurn, requestAssistantInterrupt]);

  const sendTextTurn = useCallback((text, options = {}) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }
    if (options.interrupt !== false) {
      const responseId = normalizeText(assistantTurnRef.current.responseId || '');
      const bufferedAudioMs = Number(audioPlayer?.getBufferedMs?.() || 0);
      const hasLocalOutput = assistantTurnRef.current.active || Boolean(responseId) || bufferedAudioMs > 80;
      if (hasLocalOutput) {
        requestAssistantInterrupt(responseId);
        audioPlayer.stop?.();
        flushAssistantTurn('cancel');
      }
    }
    const origin = normalizeText(options.origin || 'assistant_prompt') || 'assistant_prompt';
    const allowForceHandlers = options.allowForceHandlers === true;
    wsRef.current.send(JSON.stringify({
      type: 'input_text',
      text: normalized,
      origin,
      allowForceHandlers,
    }));
    return true;
  }, [audioPlayer, flushAssistantTurn, requestAssistantInterrupt]);

  const connect = useCallback(async (runtimeOverride = null) => {
    if (statusRef.current === 'connected' || statusRef.current === 'connecting') {
      return;
    }
    const lifecycleToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = lifecycleToken;
    setError(null);
    statusRef.current = 'connecting';
    setStatus('connecting');

    try {
      if (runtimeOverride && typeof runtimeOverride === 'object') {
        runtimeConfigRef.current = {
          ...DEFAULT_RUNTIME_CONFIG,
          ...runtimeConfigRef.current,
          ...runtimeOverride,
        };
      }
      const activeRuntime = runtimeConfigRef.current;
      const isStale = () => lifecycleTokenRef.current !== lifecycleToken;
      inputAudioStatsRef.current = { chunks: 0, lastLoggedAt: 0 };

      await audioPlayer.initialize?.();

      if (activeRuntime.captureUserAudio !== false) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
          },
        });
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        try {
          await audioContext.audioWorklet.addModule('/mic-processor.js');
          if (isStale()) {
            releaseInputResources();
            return;
          }
          processorRef.current = new AudioWorkletNode(audioContext, 'mic-processor');
        } catch (workletError) {
          console.warn('AudioWorklet failed, falling back to ScriptProcessorNode', workletError);
          const fallbackNode = audioContext.createScriptProcessor(1024, 1, 1);
          fallbackNode.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            if (statusRef.current !== 'connected' || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              return;
            }
            let sum = 0;
            for (let index = 0; index < inputData.length; index += 1) {
              sum += inputData[index] * inputData[index];
            }
            const rms = Math.sqrt(sum / Math.max(1, inputData.length));
            userVolumeRef.current = Math.min(1, rms * 5.5);
            if (shouldSuppressUserAudioInput()) {
              return;
            }
            const payloadBuffer = audioContext.sampleRate === INPUT_SAMPLE_RATE
              ? inputData
              : downsampleBuffer(inputData, audioContext.sampleRate, INPUT_SAMPLE_RATE);
            wsRef.current.send(JSON.stringify({
              type: 'audio.append',
              audio: float32ToBase64(payloadBuffer),
            }));
            recordInputAudioSent({
              rms,
              sampleRate: INPUT_SAMPLE_RATE,
              samples: payloadBuffer.length,
              source: 'script-processor',
            });
          };
          processorRef.current = fallbackNode;
        }

        const silentInputGain = audioContext.createGain();
        silentInputGain.gain.value = 0;
        inputMonitorGainRef.current = silentInputGain;

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
          if (isStale()) {
            releaseInputResources();
            return;
          }
        }

        if (processorRef.current?.port) {
          processorRef.current.port.onmessage = (event) => {
            if (event.data.type !== 'audio') {
              return;
            }
            if (statusRef.current !== 'connected' || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              return;
            }
            const inputBuffer = event.data.buffer;
            let sum = 0;
            for (let index = 0; index < inputBuffer.length; index += 1) {
              sum += inputBuffer[index] * inputBuffer[index];
            }
            const rms = Math.sqrt(sum / Math.max(1, inputBuffer.length));
            userVolumeRef.current = Math.min(1, rms * 5.5);
            if (shouldSuppressUserAudioInput()) {
              return;
            }
            const payloadBuffer = audioContext.sampleRate === INPUT_SAMPLE_RATE
              ? inputBuffer
              : downsampleBuffer(inputBuffer, audioContext.sampleRate, INPUT_SAMPLE_RATE);
            wsRef.current.send(JSON.stringify({
              type: 'audio.append',
              audio: float32ToBase64(payloadBuffer),
            }));
            recordInputAudioSent({
              rms,
              sampleRate: INPUT_SAMPLE_RATE,
              samples: payloadBuffer.length,
              source: 'audio-worklet',
            });
          };
          source.connect(processorRef.current);
          processorRef.current.connect(silentInputGain);
          silentInputGain.connect(audioContext.destination);
        } else if (processorRef.current) {
          source.connect(processorRef.current);
          processorRef.current.connect(silentInputGain);
          silentInputGain.connect(audioContext.destination);
        }
      }

      const voiceSession = await requestVoiceGatewaySession(activeRuntime);
      if (isStale()) {
        return;
      }

      const backendUrl = voiceSession?.gatewayUrl
        ? `${voiceSession.gatewayUrl}${voiceSession.sessionToken ? `?sessionToken=${encodeURIComponent(voiceSession.sessionToken)}` : ''}`
        : defaultBackendWsUrl('/yandex-realtime-proxy');

      const ws = new WebSocket(backendUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isStale()) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({
          type: 'session.start',
          runtimeConfig: activeRuntime,
        }));
      };

      ws.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (payload?.type) {
          case 'ready':
            clearClosedResponseIds();
            resetAssistantTurn();
            statusRef.current = 'connected';
            setStatus('connected');
            callbacksRef.current.onSessionReady?.({
              resumed: payload?.resumed === true,
              shouldSendGreeting: payload?.shouldSendGreeting !== false,
            });
            break;
          case 'partial_transcript':
            callbacksRef.current.onInputTranscription?.(normalizeText(payload?.text || ''));
            break;
          case 'final_transcript': {
            const finalText = normalizeText(payload?.text || '');
            callbacksRef.current.onInputTranscription?.('');
            if (finalText) {
              callbacksRef.current.onInputTranscriptionCommit?.({ text: finalText });
            }
            break;
          }
          case 'speech_started':
            {
              const now = Date.now();
              if ((now - lastSpeechStartedInterruptAtRef.current) < SPEECH_STARTED_INTERRUPT_COOLDOWN_MS) {
                break;
              }
              const bufferedAudioMs = Number(audioPlayer?.getBufferedMs?.() || 0);
              const assistantVolume = Number(audioPlayer?.getVolume?.() || 0);
              const hasAssistantOutput = assistantTurnRef.current.active
                || assistantTurnRef.current.audioChunks > 0
                || bufferedAudioMs > SPEECH_STARTED_BUFFER_GUARD_MS
                || assistantVolume > SPEECH_STARTED_VOLUME_GUARD;
              if (hasAssistantOutput) {
                lastSpeechStartedInterruptAtRef.current = now;
                const responseId = normalizeText(assistantTurnRef.current.responseId || '');
                requestAssistantInterrupt(responseId);
                audioPlayer.stop?.();
                if (assistantTurnRef.current.active) {
                  assistantTurnRef.current.interrupted = true;
                  callbacksRef.current.onAssistantInterrupted?.();
                  flushAssistantTurn('cancel');
                } else {
                  callbacksRef.current.onAssistantInterrupted?.();
                }
              }
            }
            break;
          case 'assistant_text_delta': {
            const responseId = normalizeText(payload?.responseId || payload?.response_id || assistantTurnRef.current.responseId || '');
            if (ensureAssistantTurnStarted(responseId) === false) {
              break;
            }
            assistantTurnRef.current.text = `${assistantTurnRef.current.text}${String(payload?.text || '')}`;
            assistantTurnRef.current.textChunks += 1;
            scheduleAssistantTurnFlush();
            break;
          }
          case 'assistant_audio_delta': {
            const responseId = normalizeText(payload?.responseId || payload?.response_id || assistantTurnRef.current.responseId || '');
            if (ensureAssistantTurnStarted(responseId) === false) {
              break;
            }
            const pcm = base64ToFloat32Array(String(payload?.audio || ''));
            if (pcm.length) {
              const sampleRate = Number(payload?.sampleRate || OUTPUT_SAMPLE_RATE) || OUTPUT_SAMPLE_RATE;
              const playbackResult = audioPlayer.addChunk?.(pcm, sampleRate);
              if (playbackResult?.ok === false) {
                callbacksRef.current.onAssistantAudioDrop?.({
                  responseId,
                  reason: playbackResult.reason || 'audio-playback-rejected',
                  sampleRate,
                  samples: pcm.length,
                  contextState: playbackResult.contextState || '',
                  queuedMs: Number(playbackResult.queuedMs || 0),
                });
                scheduleAssistantTurnFlush();
                break;
              }
              if (assistantTurnRef.current.audioChunks === 0) {
                callbacksRef.current.onAssistantAudioStart?.({
                  responseId,
                  sampleRate,
                  samples: pcm.length,
                  contextState: playbackResult?.contextState || '',
                  queuedMs: Number(playbackResult?.queuedMs || 0),
                });
              }
              assistantTurnRef.current.audioChunks += 1;
              lastAssistantAudioOutputAtRef.current = Date.now();
            }
            scheduleAssistantTurnFlush();
            break;
          }
          case 'assistant_turn_done': {
            const responseId = normalizeText(payload?.responseId || payload?.response_id || '');
            if (!responseId || responseId !== normalizeText(assistantTurnRef.current.responseId)) {
              break;
            }
            flushAssistantTurn('commit');
            break;
          }
          case 'assistant_turn_cancelled': {
            const responseId = normalizeText(payload?.responseId || payload?.response_id || '');
            if (!responseId || responseId !== normalizeText(assistantTurnRef.current.responseId)) {
              break;
            }
            audioPlayer.stop?.();
            assistantTurnRef.current.interrupted = true;
            callbacksRef.current.onAssistantInterrupted?.();
            flushAssistantTurn('cancel');
            break;
          }
          case 'tool_call':
            callbacksRef.current.onToolCall?.(payload);
            break;
          case 'tool_result':
            callbacksRef.current.onToolResult?.(payload);
            break;
          case 'error': {
            const message = normalizeText(payload?.message || 'Ошибка Yandex Realtime');
            setError(message);
            if (statusRef.current !== 'connected') {
              statusRef.current = 'error';
              setStatus('error');
            }
            break;
          }
          case 'goaway':
            // Bridge is reconnecting upstream — stay connected, just signal recovery
            callbacksRef.current.onGoaway?.({
              reason: normalizeText(payload?.reason || 'upstream_reconnect'),
              attempt: Number(payload?.attempt || 0),
            });
            break;
          default:
            break;
        }
      };

      ws.onerror = () => {
        if (isStale()) {
          return;
        }
        setError('Ошибка подключения к Yandex Realtime');
      };

      ws.onclose = () => {
        if (isStale()) {
          return;
        }
        releaseInputResources();
        wsRef.current = null;
        clearAssistantTurnTimer();
        clearClosedResponseIds();
        if (statusRef.current !== 'error') {
          statusRef.current = 'disconnected';
          setStatus('disconnected');
        }
      };
    } catch (connectionError) {
      if (lifecycleTokenRef.current === lifecycleToken) {
        releaseInputResources();
        const message = normalizeText(connectionError?.message || '') || 'Ошибка Yandex Realtime';
        setError(message);
        statusRef.current = 'error';
        setStatus('error');
      }
    }
  }, [
    audioPlayer,
    clearAssistantTurnTimer,
    clearClosedResponseIds,
    ensureAssistantTurnStarted,
    flushAssistantTurn,
    recordInputAudioSent,
    releaseInputResources,
    requestAssistantInterrupt,
    resetAssistantTurn,
    scheduleAssistantTurnFlush,
    shouldSuppressUserAudioInput,
  ]);

  const disconnect = useCallback(() => {
    lifecycleTokenRef.current += 1;
    clearAssistantTurnTimer();
    clearClosedResponseIds();
    resetAssistantTurn();
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'session.stop' }));
      } catch {
        // Ignore.
      }
      try {
        wsRef.current.close();
      } catch {
        // Ignore.
      }
      wsRef.current = null;
    }
    releaseInputResources();
    audioPlayer.stop?.();
    userVolumeRef.current = 0;
    setError(null);
    statusRef.current = 'disconnected';
    setStatus('disconnected');
  }, [audioPlayer, clearAssistantTurnTimer, clearClosedResponseIds, releaseInputResources, resetAssistantTurn]);

  const getUserVolume = useCallback(() => userVolumeRef.current, []);

  return {
    status,
    connect,
    disconnect,
    error,
    getUserVolume,
    sendTextTurn,
    cancelAssistantOutput,
    clearSessionResumption,
  };
}
