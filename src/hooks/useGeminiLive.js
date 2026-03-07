import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, float32ToBase64, downsampleBuffer } from '../utils/audioConverter';

const DEFAULT_RUNTIME_CONFIG = {
  voiceModelId: 'models/gemini-2.5-flash-native-audio-preview-09-2025',
  voiceName: 'Aoede',
  systemPrompt: '',
  greetingText: 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.',
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

function buildSystemInstruction(runtimeConfig) {
  return `${runtimeConfig.systemPrompt || ''}

Системные возможности:
1. У тебя есть внешний browser-controller, который реально может открывать сайты и читать их содержимое.
2. Если пользователь просит открыть сайт, перейти на страницу, посмотреть страницу или найти информацию на сайте, никогда не говори, что ты не можешь открывать сайты.
3. До прихода служебного веб-контекста можно кратко сказать, что ты открываешь сайт или смотришь страницу.
4. Не утверждай, что сайт уже открыт или прочитан, пока не пришёл служебный веб-контекст.

Правила web-режима:
1. Если в чат приходит текст, начинающийся с "WEB_CONTEXT_PENDING:", ответь одной короткой фразой, что ты сейчас смотришь сайт.
2. Если приходит текст, начинающийся с "WEB_CONTEXT_RESULT:", это значит, что сайт уже успешно открыт системой. Не говори, что ты не можешь открывать сайты.
3. Если приходит текст, начинающийся с "WEB_CONTEXT_ERROR:", это значит, что в этот раз сайт не открылся. Не говори, что ты вообще не умеешь открывать сайты; скажи только, что именно сейчас не удалось открыть или распознать сайт.
4. Любой ответ по веб-контексту делай коротким, вслух, 1-3 предложения.`;
}

export function useGeminiLive(audioPlayer, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const userVolumeRef = useRef(0);
  const setupCompleteRef = useRef(false);
  const runtimeConfigRef = useRef({ ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig });

  useEffect(() => {
    runtimeConfigRef.current = {
      ...DEFAULT_RUNTIME_CONFIG,
      ...runtimeConfig,
    };
  }, [runtimeConfig]);

  const sendTextTurn = useCallback((text) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
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
  }, []);

  const connect = useCallback(async () => {
    if (status === 'connected' || status === 'connecting') return;
    setStatus('connecting');
    setError(null);
    setupCompleteRef.current = false;

    try {
      const activeRuntime = runtimeConfigRef.current;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const handleAudioBuffer = (buffer) => {
        let inputData = buffer;
        const GAIN = 3.0;
        for (let index = 0; index < inputData.length; index += 1) {
          inputData[index] *= GAIN;
        }

        let sum = 0;
        for (let index = 0; index < inputData.length; index += 1) {
          sum += inputData[index] * inputData[index];
        }
        const rms = Math.sqrt(sum / inputData.length);
        userVolumeRef.current = Math.min(1, rms * 5);

        if (setupCompleteRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
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

      let workletNode = null;
      try {
        await audioContext.audioWorklet.addModule('/mic-processor.js');
        workletNode = new AudioWorkletNode(audioContext, 'mic-processor');
        processorRef.current = workletNode;
      } catch (workletError) {
        console.warn('AudioWorklet failed, falling back to ScriptProcessorNode', workletError);
        const fallbackNode = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = fallbackNode;
        fallbackNode.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          handleAudioBuffer(inputData);
        };
      }

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
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
        ws.send(JSON.stringify(setupMessage));
      };

      ws.onmessage = async (event) => {
        try {
          const data = event.data instanceof Blob
            ? JSON.parse(await event.data.text())
            : JSON.parse(event.data);

          if (data.setupComplete) {
            setupCompleteRef.current = true;
            setStatus('connected');

            sendTextTurn(activeRuntime.greetingText || DEFAULT_RUNTIME_CONFIG.greetingText);
            return;
          }

          if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                const pcmData = base64ToFloat32Array(part.inlineData.data);
                audioPlayer.addChunk(pcmData);
              }
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
        setStatus('error');
        setError('Ошибка подключения к WebSocket');
      };

      ws.onclose = () => {
        if (status !== 'error') {
          setStatus('disconnected');
        }
      };

      if (workletNode) {
        workletNode.port.onmessage = (event) => {
          if (event.data.type === 'audio') {
            handleAudioBuffer(event.data.buffer);
          }
        };
        source.connect(workletNode);
      } else {
        source.connect(processorRef.current);
        processorRef.current.connect(audioContext.destination);
      }
    } catch (connectionError) {
      console.error('Connection failed:', connectionError);
      setError('Ошибка доступа к микрофону или подключения');
      setStatus('error');
    }
  }, [audioPlayer, sendTextTurn, status]);

  const disconnect = useCallback(() => {
    setupCompleteRef.current = false;

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

    setStatus('disconnected');
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  const getUserVolume = useCallback(() => userVolumeRef.current, []);

  return {
    status,
    connect,
    disconnect,
    error,
    getUserVolume,
    sendTextTurn,
  };
}
