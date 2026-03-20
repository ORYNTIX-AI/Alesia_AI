import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, float32ToBase64, downsampleBuffer } from '../utils/audioConverter';

const DEFAULT_RUNTIME_CONFIG = {
  voiceModelId: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
  voiceName: 'Aoede',
  systemPrompt: '',
  greetingText: 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.',
  sessionContextText: '',
  shouldSendGreeting: true,
  captureUserAudio: true,
  speechStabilityProfile: 'balanced',
  prayerReadMode: 'knowledge-only',
  safeSpeechFlowEnabled: true,
  characterId: '',
};

const DEFAULT_CALLBACKS = {
  onInputTranscription: null,
  onInputTranscriptionCommit: null,
  onAssistantTurnStart: null,
  onAssistantTurnCommit: null,
  onAssistantTurnCancel: null,
  onAssistantInterrupted: null,
  onSessionGoAway: null,
};

const defaultBackendUrl = () => {
  if (typeof window === 'undefined') return 'ws://localhost:3001/gemini-proxy';

  const isLocal =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (isLocal) return 'ws://localhost:3001/gemini-proxy';

  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${window.location.host}/gemini-proxy`;
};

const HOST = import.meta.env.VITE_BACKEND_URL || defaultBackendUrl();
const ASSISTANT_TURN_IDLE_FLUSH_MS = 7000;
const TRANSIENT_CLOSE_CODES = new Set([1005, 1006, 1012, 1013]);

function resolveAssistantTurnIdleFlushMs(runtimeConfig) {
  const safeSpeechFlowEnabled = runtimeConfig?.safeSpeechFlowEnabled !== false;
  const profile = String(runtimeConfig?.speechStabilityProfile || 'balanced').trim().toLowerCase();

  if (!safeSpeechFlowEnabled || profile === 'legacy') {
    return ASSISTANT_TURN_IDLE_FLUSH_MS;
  }

  if (profile === 'strict') {
    return 9000;
  }

  if (profile === 'presentation') {
    return 8500;
  }

  return ASSISTANT_TURN_IDLE_FLUSH_MS;
}

function resolveRealtimeInputConfig(runtimeConfig) {
  const safeSpeechFlowEnabled = runtimeConfig?.safeSpeechFlowEnabled !== false;
  const profile = String(runtimeConfig?.speechStabilityProfile || 'balanced').trim().toLowerCase();
  const strictProfile = safeSpeechFlowEnabled && (profile === 'strict' || profile === 'presentation');

  return {
    automaticActivityDetection: {
      startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: strictProfile ? 60 : 40,
      silenceDurationMs: strictProfile ? 1000 : 850,
    },
    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
  };
}

function buildPrayerInstruction(runtimeConfig) {
  const mode = String(runtimeConfig?.prayerReadMode || 'knowledge-only').trim().toLowerCase();

  if (mode === 'free') {
    return 'Правила по молитвам: при запросе на молитву отвечай уважительно и кратко, не выдумывай факты вне подтвержденного контекста.';
  }

  if (mode === 'hybrid') {
    return `Правила по молитвам:
1. Сначала опирайся на подтвержденные фрагменты из утвержденной базы знаний и актуального веб-контекста.
2. Если подтвержденного текста недостаточно, честно скажи об этом и предложи открыть источник.
3. Не выдавай непроверенный текст как точную официальную версию.`;
  }

  return `Правила по молитвам:
1. Читать молитвы можно только по подтвержденным фрагментам из утвержденной базы знаний или актуального веб-контекста.
2. Если подтвержденного текста нет, честно скажи, что нужен источник, и предложи открыть страницу с текстом молитвы.
3. Не придумывай текст молитвы по памяти и не выдавай непроверенный текст как точный.`;
}

function buildCharacterInstruction(runtimeConfig) {
  const characterId = String(runtimeConfig?.characterId || '').trim();
  if (characterId !== 'alesya-puck') {
    return '';
  }

  return `Роль Николая:
1. Ты Николай, помощник для прихожан и церковного туризма по Беларуси.
2. Религиозные и церковные темы разрешены: можно кратко объяснять про храмы, приходы, богослужения и митрополита Вениамина.
3. Говори уважительно, спокойно и коротко, без отказа от религиозной тематики.`;
}

function buildSystemInstruction(runtimeConfig) {
  const safeSpeechFlowEnabled = runtimeConfig?.safeSpeechFlowEnabled !== false;
  const prayerInstruction = safeSpeechFlowEnabled ? buildPrayerInstruction(runtimeConfig) : '';
  const characterInstruction = safeSpeechFlowEnabled ? buildCharacterInstruction(runtimeConfig) : '';
  const base = `${runtimeConfig.systemPrompt || ''}

Системные возможности:
1. Внешняя система реально умеет открывать сайты, читать страницы и выполнять действия на уже открытом сайте.
2. До подтвержденного служебного события не говори, что сайт уже открыт или действие уже выполнено.
3. Если ждёшь служебный результат, не заполняй паузу длинными фразами. Допустима одна короткая нейтральная реплика.

Правила web-режима:
1. "WEB_CONTEXT_RESULT:" означает, что сайт уже подтверждено открыт. Ответь по факту, коротко.
2. "WEB_CONTEXT_ACTIVE:" означает, что вопрос относится к уже открытой странице. Отвечай только по этому контексту.
3. "WEB_CONTEXT_ERROR:" означает, что именно сейчас сайт не открылся или не распознался. Не обобщай это как постоянное ограничение.
4. "WEB_ACTION_RESULT:" означает, что действие на странице уже выполнено. Коротко подтверди итог.
5. Не противоречь служебному контексту и не выдумывай состояние сайта.

Политическая безопасность:
1. Не вступай в политические обсуждения.
2. Не повторяй политические лозунги пользователя.
3. На провокации отвечай коротко и нейтрально.`;
  const withPrayerInstruction = prayerInstruction ? `${base}\n\n${prayerInstruction}` : base;
  const withCharacterInstruction = characterInstruction
    ? `${withPrayerInstruction}\n\n${characterInstruction}`
    : withPrayerInstruction;

  if (!runtimeConfig.sessionContextText) {
    return withCharacterInstruction;
  }

  return `${withCharacterInstruction}

SESSION_BOOTSTRAP:
${runtimeConfig.sessionContextText}`;
}

function normalizeAssistantText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mergeAssistantText(currentValue, nextValue) {
  const current = normalizeAssistantText(currentValue);
  const next = normalizeAssistantText(nextValue);

  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  if (current.startsWith(next)) {
    return current;
  }
  if (next.includes(current)) {
    return next;
  }
  if (current.includes(next)) {
    return current;
  }
  return normalizeAssistantText(`${current} ${next}`);
}

export function useGeminiLive(audioPlayer, runtimeConfig = DEFAULT_RUNTIME_CONFIG, callbacks = DEFAULT_CALLBACKS) {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const statusRef = useRef('disconnected');
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const userVolumeRef = useRef(0);
  const setupCompleteRef = useRef(false);
  const runtimeConfigRef = useRef({ ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig });
  const callbacksRef = useRef({ ...DEFAULT_CALLBACKS, ...callbacks });
  const assistantTurnRef = useRef({
    active: false,
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

    resetAssistantTurnState();

    if (!hadContent) {
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
    assistantTurnRef.current.timerId = window.setTimeout(() => {
      if (!assistantTurnRef.current.interrupted) {
        flushAssistantTurn('commit');
      }
    }, debounceMs);
  }, [clearAssistantTurnTimer, flushAssistantTurn]);

  const ensureAssistantTurnStarted = useCallback(() => {
    if (assistantTurnRef.current.active) {
      return;
    }

    assistantTurnRef.current.active = true;
    assistantTurnRef.current.text = '';
    assistantTurnRef.current.interrupted = false;
    assistantTurnRef.current.textChunks = 0;
    assistantTurnRef.current.audioChunks = 0;
    assistantTurnRef.current.startedAt = Date.now();
    assistantTurnRef.current.lastChunkAt = Date.now();
    callbacksRef.current.onAssistantTurnStart?.();
  }, []);

  const noteAssistantTurnChunk = useCallback(({ kind }) => {
    if (!assistantTurnRef.current.active) {
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

    const payload = {
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

  const connect = useCallback(async (runtimeOverride = null) => {
    const currentStatus = statusRef.current;
    if (currentStatus === 'connected' || currentStatus === 'connecting') return;
    statusRef.current = 'connecting';
    setStatus('connecting');
    setError(null);
    setupCompleteRef.current = false;
    suppressAudioRef.current = false;

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

      if (activeRuntime.captureUserAudio !== false) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
          },
        });
        streamRef.current = stream;

        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        audioContextRef.current = audioContext;
        source = audioContext.createMediaStreamSource(stream);
        handleAudioBuffer = (buffer) => {
          let inputData = buffer;
          const GAIN = 2.4;
          for (let index = 0; index < inputData.length; index += 1) {
            inputData[index] *= GAIN;
          }

          let sum = 0;
          for (let index = 0; index < inputData.length; index += 1) {
            sum += inputData[index] * inputData[index];
          }
          const rms = Math.sqrt(sum / inputData.length);
          userVolumeRef.current = Math.min(1, rms * 5);

          if (
            setupCompleteRef.current
            && wsRef.current
            && wsRef.current.readyState === WebSocket.OPEN
          ) {
            if (audioContext.sampleRate !== 16000) {
              inputData = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
            }
            const base64Audio = float32ToBase64(inputData);
            const message = {
              realtimeInput: {
                mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Audio }],
              },
            };
            wsRef.current.send(JSON.stringify(message));
          }
        };

        try {
          await audioContext.audioWorklet.addModule('/mic-processor.js');
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
        }
      }

      const ws = new WebSocket(HOST);
      wsRef.current = ws;

      ws.onopen = () => {
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
              // Native audio preview currently behaves more reliably with thinking disabled.
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
            realtimeInputConfig: resolveRealtimeInputConfig(activeRuntime),
            sessionResumption: {
              handle: sessionResumptionHandleRef.current || undefined,
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
          setupMessage.setup.inputAudioTranscription = {};
        }
        if (activeRuntime.outputAudioTranscription !== false) {
          setupMessage.setup.outputAudioTranscription = {};
        }
        ws.send(JSON.stringify(setupMessage));
      };

      ws.onmessage = async (event) => {
        try {
          const data = event.data instanceof Blob
            ? JSON.parse(await event.data.text())
            : JSON.parse(event.data);

          if (data.setupComplete) {
            setupCompleteRef.current = true;
            statusRef.current = 'connected';
            setStatus('connected');

            if (activeRuntime.shouldSendGreeting !== false) {
              sendTextTurn(activeRuntime.greetingText || DEFAULT_RUNTIME_CONFIG.greetingText, { interrupt: false });
            }
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
                releaseSuppressedAudio();
                ensureAssistantTurnStarted();
                const nextText = mergeAssistantText(assistantTurnRef.current.text, part.text);
                assistantTurnRef.current.text = nextText;
                noteAssistantTurnChunk({ kind: 'text' });
              }

              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                if (assistantTurnRef.current.active && assistantTurnRef.current.text) {
                  releaseSuppressedAudio();
                }
                ensureAssistantTurnStarted();
                noteAssistantTurnChunk({ kind: 'audio' });
                if (!suppressAudioRef.current) {
                  const pcmData = base64ToFloat32Array(part.inlineData.data);
                  audioPlayer.addChunk(pcmData);
                }
              }
            }
          }

          if (data.serverContent?.outputTranscription?.text) {
            releaseSuppressedAudio();
            ensureAssistantTurnStarted();
            assistantTurnRef.current.text = mergeAssistantText(
              assistantTurnRef.current.text,
              data.serverContent.outputTranscription.text,
            );
            noteAssistantTurnChunk({ kind: 'text' });
          }

          if (data.serverContent?.interrupted) {
            audioPlayer.stop?.();
            suppressAudioRef.current = true;
            assistantTurnRef.current.interrupted = true;
            callbacksRef.current.onAssistantInterrupted?.();
            flushAssistantTurn('cancel');
          }

          if (data.serverContent?.turnComplete || data.serverContent?.generationComplete) {
            const finalInputTranscription = normalizeAssistantText(inputTranscriptionRef.current);
            if (finalInputTranscription) {
              callbacksRef.current.onInputTranscriptionCommit?.({ text: finalInputTranscription });
              clearInputTranscription();
            }
            if (!assistantTurnRef.current.interrupted) {
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
        clearInputTranscription();
        statusRef.current = 'error';
        setStatus('error');
        setError('Ошибка подключения к WebSocket');
      };

      ws.onclose = (event) => {
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
      console.error('Connection failed:', connectionError);
      setError('Ошибка доступа к микрофону или подключения');
      statusRef.current = 'error';
      setStatus('error');
    }
  }, [audioPlayer, clearInputTranscription, ensureAssistantTurnStarted, flushAssistantTurn, noteAssistantTurnChunk, releaseSuppressedAudio, sendTextTurn]);

  const disconnect = useCallback(() => {
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
    if (processorRef.current) {
      processorRef.current.disconnect?.();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    statusRef.current = 'disconnected';
    setStatus('disconnected');
  }, [audioPlayer, clearInputTranscription, flushAssistantTurn, releaseSuppressedAudio]);

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
