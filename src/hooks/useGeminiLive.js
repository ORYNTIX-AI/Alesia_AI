import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, float32ToBase64, downsampleBuffer } from '../utils/audioConverter.js';
import {
  DEFAULT_CALLBACKS,
  DEFAULT_RUNTIME_CONFIG,
  buildGeminiLiveToolDefinitions,
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
  shouldUseSapphireGeminiAudio,
} from './geminiLiveShared.js';
import { buildGeminiLiveToolResponses } from './geminiLiveToolCalls.js';
import { useSapphireGeminiAudioQueue } from './useSapphireGeminiAudioQueue.js';

const BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD = 0.18;
const BATYUSHKA_2_BARGE_IN_HOLD_MS = 900;
const BATYUSHKA_2_LOCAL_BARGE_IN_HOLD_MS = 150;
const BATYUSHKA_2_LOCAL_BARGE_IN_COOLDOWN_MS = 900;
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
  const localBargeInCandidateRef = useRef({ startedAt: 0 });
  const lastLocalBargeInAtRef = useRef(0);
  const {
    clearQueuedAudio: clearQueuedSapphireAudio,
    enqueueAudioChunk: enqueueSapphireAudioChunk,
    resetAudio: resetSapphireAudio,
    stopAudio: stopSapphireAudio,
  } = useSapphireGeminiAudioQueue({ audioContextRef, audioPlayer });

  const recordGeminiClientEvent = useCallback((event, details = {}) => {
    const activeRuntime = runtimeConfigRef.current || {};
    fetch('/api/browser/client-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        details: {
          conversationSessionId: String(activeRuntime.conversationSessionId || ''),
          characterId: String(activeRuntime.characterId || ''),
          ...details,
        },
      }),
    }).catch(() => {});
  }, []);

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
    if (shouldUseSapphireGeminiAudio(runtimeConfigRef.current)) {
      return;
    }
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

  const ensureAssistantTurnStarted = useCallback((details = {}) => {
    if (assistantTurnRef.current.active) {
      return !assistantTurnRef.current.rejected;
    }

    const accepted = callbacksRef.current.onAssistantTurnStart?.(details) !== false;
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
    if (shouldUseSapphireGeminiAudio(runtimeConfigRef.current)) {
      stopSapphireAudio('gemini-cancel');
    } else {
      audioPlayer.stop?.('gemini-cancel');
    }
    if (assistantTurnRef.current.active) {
      assistantTurnRef.current.interrupted = true;
    }
    flushAssistantTurn('cancel');
  }, [audioPlayer, flushAssistantTurn, stopSapphireAudio]);

  const triggerLocalBargeIn = useCallback((reason = 'local-rms-barge-in') => {
    const nowMs = Date.now();
    if ((nowMs - lastLocalBargeInAtRef.current) < BATYUSHKA_2_LOCAL_BARGE_IN_COOLDOWN_MS) {
      return false;
    }
    const bufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
    const hasAssistantOutput = assistantTurnRef.current.active || bufferedMs > 0;
    if (!hasAssistantOutput) {
      return false;
    }
    lastLocalBargeInAtRef.current = nowMs;
    suppressAudioRef.current = true;
    audioPlayer.stop?.();
    if (assistantTurnRef.current.active) {
      assistantTurnRef.current.interrupted = true;
    }
    callbacksRef.current.onAssistantInterrupted?.({ reason });
    flushAssistantTurn('cancel');
    return true;
  }, [audioPlayer, flushAssistantTurn]);

  const sendTextTurn = useCallback((text, options = {}) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (options.interrupt !== false) {
      if (shouldUseSapphireGeminiAudio(runtimeConfigRef.current)) {
        stopSapphireAudio('gemini-text-turn');
      } else {
        audioPlayer.stop?.('gemini-text-turn');
      }
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
  }, [audioPlayer, flushAssistantTurn, releaseSuppressedAudio, stopSapphireAudio]);

  const clearInputTranscription = useCallback(() => {
    inputTranscriptionRef.current = '';
    callbacksRef.current.onInputTranscription?.('');
  }, []);

  const clearSessionResumption = useCallback(() => {
    sessionResumptionHandleRef.current = '';
    pendingGoAwayRef.current = null;
  }, []);

  const releaseInputResources = useCallback(() => {
    resetSapphireAudio();
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
  }, [resetSapphireAudio]);

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
    localBargeInCandidateRef.current = { startedAt: 0 };
    lastLocalBargeInAtRef.current = 0;

    try {
      if (runtimeOverride && typeof runtimeOverride === 'object') {
        runtimeConfigRef.current = {
          ...DEFAULT_RUNTIME_CONFIG,
          ...runtimeConfigRef.current,
          ...runtimeOverride,
        };
      }
      const activeRuntime = runtimeConfigRef.current;
      const useSapphireAudio = shouldUseSapphireGeminiAudio(activeRuntime);
      recordGeminiClientEvent('voice.gemini.profile', {
        useSapphireAudio,
        runtimeProvider: String(activeRuntime.runtimeProvider || ''),
        characterId: String(activeRuntime.characterId || ''),
        voiceModelId: String(activeRuntime.voiceModelId || ''),
        modelId: String(activeRuntime.modelId || ''),
        voiceName: String(activeRuntime.voiceName || ''),
        captureUserAudio: activeRuntime.captureUserAudio !== false,
      });
      audioPlayer.setPreferHtmlAudioOutput?.(false);
      audioPlayer.setSequentialPlaybackMode?.(false);
      let audioContext = null;
      let source = null;
      let workletNode = null;
      let handleAudioBuffer = null;
      const isStale = () => lifecycleTokenRef.current !== lifecycleToken;

      if (activeRuntime.captureUserAudio !== false) {
        const stream = await navigator.mediaDevices.getUserMedia(useSapphireAudio
          ? { audio: true }
          : {
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

        audioContext = new (window.AudioContext || window.webkitAudioContext)(
          useSapphireAudio ? { sampleRate: 16000 } : { latencyHint: 'interactive' },
        );
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
          const stableBatyushkaRuntime = isBatyushka2StableRuntime(activeRuntime);
          if (!useSapphireAudio) {
            const GAIN = stableBatyushkaRuntime ? 1.45 : 2.4;
            for (let index = 0; index < inputData.length; index += 1) {
              inputData[index] *= GAIN;
            }
          }

          let sum = 0;
          for (let index = 0; index < inputData.length; index += 1) {
            sum += inputData[index] * inputData[index];
          }
          const rms = Math.sqrt(sum / inputData.length);
          userVolumeRef.current = Math.min(1, rms * 5);
          const nowMs = Date.now();
          if (!useSapphireAudio && stableBatyushkaRuntime && rms >= BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD) {
            strongUserSpeechUntilRef.current = nowMs + BATYUSHKA_2_BARGE_IN_HOLD_MS;
          }

          if (
            setupCompleteRef.current
            && wsRef.current
            && wsRef.current.readyState === WebSocket.OPEN
          ) {
            if (!useSapphireAudio && stableBatyushkaRuntime) {
              const assistantBufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
              if (
                assistantBufferedMs > 80
                && rms >= BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD
                && !assistantTurnRef.current.interrupted
              ) {
                if (!localBargeInCandidateRef.current.startedAt) {
                  localBargeInCandidateRef.current = { startedAt: nowMs };
                } else if ((nowMs - localBargeInCandidateRef.current.startedAt) >= BATYUSHKA_2_LOCAL_BARGE_IN_HOLD_MS) {
                  localBargeInCandidateRef.current = { startedAt: 0 };
                  triggerLocalBargeIn('local-rms-barge-in');
                }
              } else if (rms < BATYUSHKA_2_BARGE_IN_RMS_THRESHOLD) {
                localBargeInCandidateRef.current = { startedAt: 0 };
              }
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

        if (useSapphireAudio) {
          const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
          processorRef.current = processorNode;
          processorNode.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            handleAudioBuffer(inputData);
          };
        } else {
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
        if (!useSapphireAudio) {
          setupMessage.setup.generationConfig.thinkingConfig = buildThinkingConfig(activeRuntime);
        }
        if (activeRuntime.captureUserAudio !== false) {
          const realtimeInputConfig = resolveRealtimeInputConfig(activeRuntime);
          if (realtimeInputConfig) {
            setupMessage.setup.realtimeInputConfig = realtimeInputConfig;
          }
        }
        if (!useSapphireAudio && isGemini31FlashLiveModel(activeRuntime.voiceModelId)) {
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
        if (useSapphireAudio || activeRuntime.outputAudioTranscription !== false) {
          setupMessage.setup.outputAudioTranscription = {};
        }
        const toolDefinitions = buildGeminiLiveToolDefinitions(activeRuntime);
        if (toolDefinitions.length) {
          setupMessage.setup.tools = toolDefinitions;
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

          const functionCalls = Array.isArray(data.toolCall?.functionCalls)
            ? data.toolCall.functionCalls
            : [];
          if (functionCalls.length) {
            const functionResponses = await buildGeminiLiveToolResponses({
              functionCalls,
              activeRuntime,
              callbacks: callbacksRef.current,
            });
            if (functionResponses.length && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                toolResponse: {
                  functionResponses,
                },
              }));
            }
            return;
          }

          if (data.serverContent?.inputTranscription?.text) {
            inputTranscriptionRef.current += data.serverContent.inputTranscription.text;
            callbacksRef.current.onInputTranscription?.(normalizeAssistantText(inputTranscriptionRef.current));
          }

          if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
              if (part.text && !part.thought) {
                const accepted = ensureAssistantTurnStarted({ nativeDirect: useSapphireAudio });
                if (!accepted) {
                  continue;
                }
                if (!assistantTurnRef.current.interrupted) {
                  releaseSuppressedAudio();
                }
                const nextText = mergeAssistantText(assistantTurnRef.current.text, part.text);
                assistantTurnRef.current.text = nextText;
                noteAssistantTurnChunk({ kind: 'text' });
              }

              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                const accepted = ensureAssistantTurnStarted({ nativeDirect: useSapphireAudio });
                if (!accepted) {
                  continue;
                }
                if (assistantTurnRef.current.active && assistantTurnRef.current.text && !assistantTurnRef.current.interrupted) {
                  releaseSuppressedAudio();
                }
                noteAssistantTurnChunk({ kind: 'audio' });
                if (!suppressAudioRef.current) {
                  const pcmData = base64ToFloat32Array(part.inlineData.data);
                  const playbackResult = useSapphireAudio
                    ? enqueueSapphireAudioChunk(pcmData, 24000)
                    : audioPlayer.addChunk(pcmData, 24000);
                  if (playbackResult?.ok === false) {
                    callbacksRef.current.onAssistantAudioDrop?.({
                      responseId: '',
                      reason: playbackResult.reason || 'audio-playback-rejected',
                      sampleRate: 24000,
                      samples: pcmData.length,
                      contextState: playbackResult.contextState || '',
                      queuedMs: Number(playbackResult.queuedMs || 0),
                      outputMode: playbackResult.outputMode || '',
                    });
                  } else if (assistantTurnRef.current.audioChunks === 1) {
                    callbacksRef.current.onAssistantAudioStart?.({
                      responseId: '',
                      sampleRate: 24000,
                      samples: pcmData.length,
                      contextState: playbackResult?.contextState || '',
                      queuedMs: Number(playbackResult?.queuedMs || 0),
                      outputMode: playbackResult?.outputMode || '',
                    });
                  }
                }
              }
            }
          }

          if (data.serverContent?.outputTranscription?.text) {
            const accepted = ensureAssistantTurnStarted({ nativeDirect: useSapphireAudio });
            if (accepted && !assistantTurnRef.current.interrupted) {
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
            if (useSapphireAudio) {
              clearQueuedSapphireAudio('gemini-interrupted');
              suppressAudioRef.current = true;
              assistantTurnRef.current.interrupted = true;
              callbacksRef.current.onAssistantInterrupted?.();
              flushAssistantTurn('cancel');
              return;
            }
            if (
              !useSapphireAudio
              &&
              isBatyushka2StableRuntime(runtimeConfigRef.current)
              && Date.now() >= strongUserSpeechUntilRef.current
            ) {
              suppressAudioRef.current = false;
              return;
            }
            audioPlayer.stop?.('gemini-interrupted');
            suppressAudioRef.current = true;
            assistantTurnRef.current.interrupted = true;
            callbacksRef.current.onAssistantInterrupted?.();
            flushAssistantTurn('cancel');
          }

          if (shouldCommitGeminiAssistantTurn(data.serverContent)) {
            const finalInputTranscription = normalizeAssistantText(inputTranscriptionRef.current);
            if (finalInputTranscription) {
              callbacksRef.current.onInputTranscriptionCommit?.({
                text: finalInputTranscription,
                nativeDirect: useSapphireAudio,
              });
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
  }, [audioPlayer, clearInputTranscription, clearQueuedSapphireAudio, enqueueSapphireAudioChunk, ensureAssistantTurnStarted, flushAssistantTurn, noteAssistantTurnChunk, recordGeminiClientEvent, releaseInputResources, releaseSuppressedAudio, triggerLocalBargeIn]);

  const disconnect = useCallback(() => {
    const wasConnected = Boolean(wsRef.current)
      || setupCompleteRef.current
      || statusRef.current !== 'disconnected'
      || assistantTurnRef.current.active;
    lifecycleTokenRef.current += 1;
    setupCompleteRef.current = false;
    clearInputTranscription();
    releaseSuppressedAudio();
    flushAssistantTurn('cancel');
    if (wasConnected) {
      stopSapphireAudio('gemini-disconnect');
      audioPlayer.stop?.('gemini-disconnect');
      audioPlayer.setSequentialPlaybackMode?.(false);
    }
    pendingGoAwayRef.current = null;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    releaseInputResources();

    if (statusRef.current !== 'disconnected') {
      statusRef.current = 'disconnected';
      setStatus('disconnected');
    }
  }, [audioPlayer, clearInputTranscription, flushAssistantTurn, releaseInputResources, releaseSuppressedAudio, stopSapphireAudio]);

  const disconnectRef = useRef(disconnect);

  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  useEffect(() => () => disconnectRef.current?.(), []);

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
