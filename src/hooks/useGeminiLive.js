import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, float32ToBase64, downsampleBuffer } from '../utils/audioConverter.js';
import {
  DEFAULT_CALLBACKS,
  DEFAULT_RUNTIME_CONFIG,
  TRANSIENT_CLOSE_CODES,
  buildSystemInstruction,
  buildThinkingConfig,
  isBatyushka2StableRuntime,
  isGemini31FlashLiveModel,
  mergeAssistantText,
  normalizeAssistantText,
  requestVoiceGatewaySession,
  resolveAssistantTurnIdleFlushMs,
  resolveBackendUrl,
  resolveRealtimeInputConfig,
  shouldCommitGeminiAssistantTurn,
} from './geminiLiveShared.js';

const BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD = 0.18;
const BATYUSHKA_2_BARGE_IN_HOLD_MS = 900;
const BATYUSHKA_2_MIC_TAIL_GATE_MS = 220;

export function useGeminiLive(audioPlayer, runtimeConfig = DEFAULT_RUNTIME_CONFIG, callbacks = DEFAULT_CALLBACKS) {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const statusRef = useRef('disconnected');
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const userVolumeRef = useRef(0);
  const setupCompleteRef = useRef(false);
  const runtimeConfigRef = useRef({ ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig });
  const callbacksRef = useRef({ ...DEFAULT_CALLBACKS, ...callbacks });
  const assistantTurnRef = useRef({
    active: false,
    rejected: false,
    text: '',
    timerId: null,
    interrupted: false,
    textChunks: 0,
    audioChunks: 0,
    startedAt: 0,
    lastChunkAt: 0,
  });
  const inputTranscriptionRef = useRef('');
  const suppressAudioRef = useRef(false);
  const sessionResumptionHandleRef = useRef('');
  const pendingGoAwayRef = useRef(null);
  const lifecycleTokenRef = useRef(0);
  const strongUserSpeechUntilRef = useRef(0);
  const lastAssistantPlaybackActiveAtRef = useRef(0);

  const releaseSuppressedAudio = useCallback(() => {
    suppressAudioRef.current = false;
  }, []);

  useEffect(() => {
    runtimeConfigRef.current = {
      ...DEFAULT_RUNTIME_CONFIG,
      ...runtimeConfig,
    };
  }, [runtimeConfig]);

  useEffect(() => {
    callbacksRef.current = {
      ...DEFAULT_CALLBACKS,
      ...callbacks,
    };
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

  const resetAssistantTurnState = useCallback(() => {
    assistantTurnRef.current = {
      active: false,
      rejected: false,
      text: '',
      timerId: null,
      interrupted: false,
      textChunks: 0,
      audioChunks: 0,
      startedAt: 0,
      lastChunkAt: 0,
    };
  }, []);

  const flushAssistantTurn = useCallback((mode = 'commit') => {
    clearAssistantTurnTimer();
    const currentTurn = assistantTurnRef.current;
    const text = normalizeAssistantText(currentTurn.text);
    const hadContent = currentTurn.active || Boolean(text);
    const rejected = Boolean(currentTurn.rejected);

    resetAssistantTurnState();

    if (!hadContent || rejected) {
      return;
    }

    if (mode === 'cancel' || currentTurn.interrupted) {
      callbacksRef.current.onAssistantTurnCancel?.({ text, interrupted: Boolean(currentTurn.interrupted) });
      return;
    }

    callbacksRef.current.onAssistantTurnCommit?.({
      text,
      textChunks: currentTurn.textChunks,
      audioChunks: currentTurn.audioChunks,
      durationMs: currentTurn.startedAt ? Math.max(0, Date.now() - currentTurn.startedAt) : 0,
    });
  }, [clearAssistantTurnTimer, resetAssistantTurnState]);

  const scheduleAssistantTurnFlush = useCallback(() => {
    clearAssistantTurnTimer();
    const debounceMs = resolveAssistantTurnIdleFlushMs(runtimeConfigRef.current);
    const armTimer = (delayMs) => {
      assistantTurnRef.current.timerId = window.setTimeout(() => {
        if (!assistantTurnRef.current.interrupted) {
          const bufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
          if (isBatyushka2StableRuntime(runtimeConfigRef.current) && bufferedMs > 250) {
            armTimer(500);
            return;
          }
          flushAssistantTurn('commit');
        }
      }, delayMs);
    };
    armTimer(debounceMs);
  }, [audioPlayer, clearAssistantTurnTimer, flushAssistantTurn]);

  const ensureAssistantTurnStarted = useCallback(() => {
    if (assistantTurnRef.current.active) {
      return !assistantTurnRef.current.rejected;
    }

    const accepted = callbacksRef.current.onAssistantTurnStart?.() !== false;
    assistantTurnRef.current.active = true;
    assistantTurnRef.current.rejected = !accepted;
    assistantTurnRef.current.text = '';
    assistantTurnRef.current.interrupted = false;
    assistantTurnRef.current.textChunks = 0;
    assistantTurnRef.current.audioChunks = 0;
    assistantTurnRef.current.startedAt = Date.now();
    assistantTurnRef.current.lastChunkAt = Date.now();
    if (!accepted) {
      suppressAudioRef.current = true;
    }
    return accepted;
  }, []);

  const noteAssistantTurnChunk = useCallback(({ kind }) => {
    if (!assistantTurnRef.current.active || assistantTurnRef.current.rejected) {
      return;
    }

    assistantTurnRef.current.lastChunkAt = Date.now();
    if (kind === 'text') {
      assistantTurnRef.current.textChunks += 1;
    }
    if (kind === 'audio') {
      assistantTurnRef.current.audioChunks += 1;
    }
    scheduleAssistantTurnFlush();
  }, [scheduleAssistantTurnFlush]);

  const cancelAssistantOutput = useCallback(() => {
    suppressAudioRef.current = true;
    audioPlayer.stop?.();
    flushAssistantTurn('cancel');
  }, [audioPlayer, flushAssistantTurn]);

  const sendTextTurn = useCallback((text, options = {}) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (options.interrupt !== false) {
      audioPlayer.stop?.();
      releaseSuppressedAudio();
      flushAssistantTurn('cancel');
    }

    const payload = isGemini31FlashLiveModel(runtimeConfigRef.current?.voiceModelId)
      ? {
        realtimeInput: {
          text,
        },
      }
      : {
        client_content: {
          turns: [
            {
              role: 'user',
              parts: [{ text }],
            },
          ],
          turn_complete: true,
        },
      };

    wsRef.current.send(JSON.stringify(payload));
    return true;
  }, [audioPlayer, flushAssistantTurn, releaseSuppressedAudio]);

  const clearInputTranscription = useCallback(() => {
    inputTranscriptionRef.current = '';
    callbacksRef.current.onInputTranscription?.('');
  }, []);

  const clearSessionResumption = useCallback(() => {
    sessionResumptionHandleRef.current = '';
    pendingGoAwayRef.current = null;
  }, []);

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

  const connect = useCallback(async (runtimeOverride = null) => {
    const currentStatus = statusRef.current;
    if (currentStatus === 'connected' || currentStatus === 'connecting') return;
    const lifecycleToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = lifecycleToken;
    statusRef.current = 'connecting';
    setStatus('connecting');
    setError(null);
    setupCompleteRef.current = false;
    suppressAudioRef.current = false;
    lastAssistantPlaybackActiveAtRef.current = 0;

    try {
      if (runtimeOverride && typeof runtimeOverride === 'object') {
        runtimeConfigRef.current = {
          ...DEFAULT_RUNTIME_CONFIG,
          ...runtimeConfigRef.current,
          ...runtimeOverride,
        };
      }
      const activeRuntime = runtimeConfigRef.current;
      let audioContext = null;
      let source = null;
      let workletNode = null;
      let handleAudioBuffer = null;
      const isStale = () => lifecycleTokenRef.current !== lifecycleToken;

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

        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          audioContext.close().catch(() => {});
          return;
        }
        audioContextRef.current = audioContext;
        source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;
        handleAudioBuffer = (buffer) => {
          let inputData = buffer;
          const GAIN = isBatyushka2StableRuntime(activeRuntime) ? 1.45 : 2.4;
          for (let index = 0; index < inputData.length; index += 1) {
            inputData[index] *= GAIN;
          }

          let sum = 0;
          for (let index = 0; index < inputData.length; index += 1) {
            sum += inputData[index] * inputData[index];
          }
          const rms = Math.sqrt(sum / inputData.length);
          userVolumeRef.current = Math.min(1, rms * 5);
          const stableBatyushkaRuntime = isBatyushka2StableRuntime(activeRuntime);
          const nowMs = Date.now();
          if (stableBatyushkaRuntime && rms >= BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD) {
            strongUserSpeechUntilRef.current = nowMs + BATYUSHKA_2_BARGE_IN_HOLD_MS;
          }

          if (
            setupCompleteRef.current
            && wsRef.current
            && wsRef.current.readyState === WebSocket.OPEN
          ) {
            if (stableBatyushkaRuntime) {
              const assistantBufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
              if (assistantBufferedMs > 0) {
                lastAssistantPlaybackActiveAtRef.current = nowMs;
              } else if (
                lastAssistantPlaybackActiveAtRef.current > 0
                && (nowMs - lastAssistantPlaybackActiveAtRef.current) < BATYUSHKA_2_MIC_TAIL_GATE_MS
                && rms < BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD
              ) {
                return;
              }
            }
            if (audioContext.sampleRate !== 16000) {
              inputData = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
            }
            const base64Audio = float32ToBase64(inputData);
            const message = {
              realtimeInput: {
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: base64Audio,
                },
              },
            };
            wsRef.current.send(JSON.stringify(message));
          }
        };

        try {
          await audioContext.audioWorklet.addModule('/mic-processor.js');
          if (isStale()) {
            releaseInputResources();
            return;
          }
          workletNode = new AudioWorkletNode(audioContext, 'mic-processor');
          processorRef.current = workletNode;
        } catch (workletError) {
          console.warn('AudioWorklet failed, falling back to ScriptProcessorNode', workletError);
          const fallbackNode = audioContext.createScriptProcessor(1024, 1, 1);
          processorRef.current = fallbackNode;
          fallbackNode.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            handleAudioBuffer(inputData);
          };
        }

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
          if (isStale()) {
            releaseInputResources();
            return;
          }
        }
      }

      let backendUrl = resolveBackendUrl(activeRuntime);
      if (activeRuntime.captureUserAudio !== false) {
        const voiceSession = await requestVoiceGatewaySession(activeRuntime);
        if (voiceSession?.gatewayUrl) {
          backendUrl = voiceSession.gatewayUrl;
          if (voiceSession.sessionToken) {
            const delimiter = backendUrl.includes('?') ? '&' : '?';
            backendUrl = `${backendUrl}${delimiter}sessionToken=${encodeURIComponent(voiceSession.sessionToken)}`;
          }
        }
      }

      const ws = new WebSocket(backendUrl);
      if (isStale()) {
        try {
          ws.close();
        } catch {
          // Ignore stale websocket close failures.
        }
        releaseInputResources();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (isStale()) {
          return;
        }
        const setupAlreadyCompleted = setupCompleteRef.current;
        const setupMessage = {
          setup: {
            model: activeRuntime.voiceModelId,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: activeRuntime.voiceName,
                  },
                },
              },
              thinkingConfig: buildThinkingConfig(activeRuntime),
            },
            systemInstruction: {
              parts: [
                {
                  text: buildSystemInstruction(activeRuntime),
                },
              ],
            },
          },
        };
        if (activeRuntime.captureUserAudio !== false) {
          setupMessage.setup.realtimeInputConfig = resolveRealtimeInputConfig(activeRuntime);
        }
        if (isGemini31FlashLiveModel(activeRuntime.voiceModelId)) {
          setupMessage.setup.contextWindowCompression = {
            slidingWindow: {},
          };
          setupMessage.setup.sessionResumption = {
            handle: sessionResumptionHandleRef.current || undefined,
          };
        }
        if (activeRuntime.captureUserAudio !== false) {
          setupMessage.setup.inputAudioTranscription = {};
        }
        if (activeRuntime.outputAudioTranscription !== false) {
          setupMessage.setup.outputAudioTranscription = {};
        }
        ws.send(JSON.stringify(setupMessage));
        if (setupAlreadyCompleted) {
          setStatus('connected');
        }
      };

      ws.onmessage = async (event) => {
        if (isStale()) {
          return;
        }
        try {
          const data = event.data instanceof Blob
            ? JSON.parse(await event.data.text())
            : JSON.parse(event.data);

          if (data.setupComplete) {
            const wasSetupComplete = setupCompleteRef.current;
            setupCompleteRef.current = true;
            statusRef.current = 'connected';
            setStatus('connected');
            callbacksRef.current.onSessionReady?.({
              resumed: wasSetupComplete,
              shouldSendGreeting: activeRuntime.shouldSendGreeting !== false,
            });
            return;
          }

          if (data.sessionResumptionUpdate) {
            const resumable = Boolean(data.sessionResumptionUpdate.resumable);
            const nextHandle = String(data.sessionResumptionUpdate.newHandle || '').trim();
            sessionResumptionHandleRef.current = resumable ? nextHandle : '';
          }

          if (data.goAway) {
            pendingGoAwayRef.current = data.goAway;
            callbacksRef.current.onSessionGoAway?.(data.goAway);
          }

          if (data.serverContent?.inputTranscription?.text) {
            inputTranscriptionRef.current += data.serverContent.inputTranscription.text;
            callbacksRef.current.onInputTranscription?.(normalizeAssistantText(inputTranscriptionRef.current));
          }

          if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
              if (part.text && !part.thought) {
                const accepted = ensureAssistantTurnStarted();
                if (!accepted) {
                  continue;
                }
                releaseSuppressedAudio();
                const nextText = mergeAssistantText(assistantTurnRef.current.text, part.text);
                assistantTurnRef.current.text = nextText;
                noteAssistantTurnChunk({ kind: 'text' });
              }

              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                const accepted = ensureAssistantTurnStarted();
                if (!accepted) {
                  continue;
                }
                if (assistantTurnRef.current.active && assistantTurnRef.current.text) {
                  releaseSuppressedAudio();
                }
                noteAssistantTurnChunk({ kind: 'audio' });
                if (!suppressAudioRef.current) {
                  const pcmData = base64ToFloat32Array(part.inlineData.data);
                  audioPlayer.addChunk(pcmData);
                }
              }
            }
          }

          if (data.serverContent?.outputTranscription?.text) {
            const accepted = ensureAssistantTurnStarted();
            if (accepted) {
              releaseSuppressedAudio();
            }
            assistantTurnRef.current.text = mergeAssistantText(
              assistantTurnRef.current.text,
              data.serverContent.outputTranscription.text,
            );
            if (accepted) {
              noteAssistantTurnChunk({ kind: 'text' });
            }
          }

          if (data.serverContent?.interrupted) {
            if (
              isBatyushka2StableRuntime(runtimeConfigRef.current)
              && Date.now() >= strongUserSpeechUntilRef.current
            ) {
              suppressAudioRef.current = false;
              return;
            }
            audioPlayer.stop?.();
            suppressAudioRef.current = true;
            assistantTurnRef.current.interrupted = true;
            callbacksRef.current.onAssistantInterrupted?.();
            flushAssistantTurn('cancel');
          }

          if (shouldCommitGeminiAssistantTurn(data.serverContent)) {
            const finalInputTranscription = normalizeAssistantText(inputTranscriptionRef.current);
            if (finalInputTranscription) {
              callbacksRef.current.onInputTranscriptionCommit?.({ text: finalInputTranscription });
              clearInputTranscription();
            }
            if (assistantTurnRef.current.rejected) {
              suppressAudioRef.current = true;
              flushAssistantTurn('cancel');
            } else if (!assistantTurnRef.current.interrupted) {
              releaseSuppressedAudio();
              flushAssistantTurn('commit');
            }
          }

          if (data.error) {
            setError(data.error.message || 'Ошибка сервера');
          }
        } catch (messageError) {
          console.error('WebSocket Message Error', messageError);
        }
      };

      ws.onerror = () => {
        if (isStale()) {
          return;
        }
        releaseInputResources();
        clearInputTranscription();
        statusRef.current = 'error';
        setStatus('error');
        setError('Ошибка подключения к WebSocket');
      };

      ws.onclose = (event) => {
        if (isStale()) {
          return;
        }
        releaseInputResources();
        clearInputTranscription();
        flushAssistantTurn(statusRef.current === 'error' ? 'cancel' : 'commit');
        const closeCode = Number(event?.code || 0);
        const closeReason = String(event?.reason || '').trim();
        const isTransientClose = TRANSIENT_CLOSE_CODES.has(closeCode);

        if (!setupCompleteRef.current && closeCode && closeCode !== 1000 && !isTransientClose) {
          statusRef.current = 'error';
          setStatus('error');
          setError(closeReason || `Gemini Live закрыл соединение (код ${closeCode})`);
          return;
        }

        if (isTransientClose && closeReason) {
          console.warn(`Gemini Live transient close (${closeCode}): ${closeReason}`);
        }

        if (statusRef.current !== 'error') {
          statusRef.current = 'disconnected';
          setStatus('disconnected');
        }
      };

      if (source && workletNode) {
        workletNode.port.onmessage = (event) => {
          if (event.data.type === 'audio') {
            handleAudioBuffer(event.data.buffer);
          }
        };
        source.connect(workletNode);
      } else if (source && processorRef.current && audioContext) {
        source.connect(processorRef.current);
        processorRef.current.connect(audioContext.destination);
      }
    } catch (connectionError) {
      if (!isNaN(lifecycleToken) && lifecycleTokenRef.current === lifecycleToken) {
        console.error('Connection failed:', connectionError);
        releaseInputResources();
        const connectionMessage = normalizeAssistantText(connectionError?.message || '');
        setError(connectionMessage || 'Ошибка доступа к микрофону или подключения');
        statusRef.current = 'error';
        setStatus('error');
      }
    }
  }, [audioPlayer, clearInputTranscription, ensureAssistantTurnStarted, flushAssistantTurn, noteAssistantTurnChunk, releaseInputResources, releaseSuppressedAudio]);

  const disconnect = useCallback(() => {
    lifecycleTokenRef.current += 1;
    setupCompleteRef.current = false;
    clearInputTranscription();
    releaseSuppressedAudio();
    flushAssistantTurn('cancel');
    audioPlayer.stop?.();
    pendingGoAwayRef.current = null;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    releaseInputResources();

    statusRef.current = 'disconnected';
    setStatus('disconnected');
  }, [audioPlayer, clearInputTranscription, flushAssistantTurn, releaseInputResources, releaseSuppressedAudio]);

  useEffect(() => () => disconnect(), [disconnect]);

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
