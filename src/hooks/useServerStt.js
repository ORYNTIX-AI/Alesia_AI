import { useCallback, useEffect, useRef, useState } from 'react';
import { downsampleBuffer, float32ToBase64 } from '../utils/audioConverter';

const LOCAL_STT_VOICE_RMS_THRESHOLD = 0.015;
const LOCAL_STT_FINAL_DEDUP_MS = 3200;

function defaultBackendUrl(conversationSessionId = '') {
  if (typeof window === 'undefined') return `ws://localhost:3001/api/stt/session/${conversationSessionId}/stream`;

  const isLocal =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (isLocal) return `ws://localhost:3001/api/stt/session/${conversationSessionId}/stream`;

  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${window.location.host}/api/stt/session/${conversationSessionId}/stream`;
}

export function useServerStt({
  enabled,
  conversationSessionId,
  language = 'ru-RU',
  onPartialTranscript,
  onFinalTranscript,
  onSpeechStart,
}) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [partialTranscript, setPartialTranscript] = useState('');
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const userVolumeRef = useRef(0);
  const partialRef = useRef('');
  const speakingRef = useRef(false);
  const lastFinalEmitRef = useRef({ key: '', timestamp: 0 });
  const onPartialRef = useRef(onPartialTranscript);
  const onFinalRef = useRef(onFinalTranscript);
  const onSpeechStartRef = useRef(onSpeechStart);

  useEffect(() => {
    onPartialRef.current = onPartialTranscript;
    onFinalRef.current = onFinalTranscript;
    onSpeechStartRef.current = onSpeechStart;
  }, [onFinalTranscript, onPartialTranscript, onSpeechStart]);

  const clearPartial = useCallback(() => {
    partialRef.current = '';
    setPartialTranscript('');
    onPartialRef.current?.('');
  }, []);

  const disconnect = useCallback(() => {
    speakingRef.current = false;
    clearPartial();

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore close failures during teardown.
      }
      wsRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect?.();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    userVolumeRef.current = 0;
    setStatus('idle');
  }, [clearPartial]);

  useEffect(() => {
    if (!enabled || !conversationSessionId) {
      return undefined;
    }

    let cancelled = false;
    let workletNode = null;

    const connect = async () => {
      setStatus('connecting');
      setError(null);
      lastFinalEmitRef.current = { key: '', timestamp: 0 };

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const ws = new WebSocket(defaultBackendUrl(encodeURIComponent(conversationSessionId)));
        wsRef.current = ws;

        const handleAudioBuffer = (buffer) => {
          let inputData = buffer;
          let sum = 0;
          for (let index = 0; index < inputData.length; index += 1) {
            sum += inputData[index] * inputData[index];
          }
          const rms = Math.sqrt(sum / inputData.length);
          userVolumeRef.current = Math.min(1, rms * 5);

          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }

          if (audioContext.sampleRate !== 16000) {
            inputData = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
          }

          ws.send(JSON.stringify({
            type: 'audio',
            data: float32ToBase64(inputData),
          }));
        };

        try {
          await audioContext.audioWorklet.addModule('/mic-processor.js');
          workletNode = new AudioWorkletNode(audioContext, 'mic-processor');
          processorRef.current = workletNode;
          workletNode.port.onmessage = (event) => {
            if (event.data?.type === 'audio') {
              handleAudioBuffer(event.data.buffer);
            }
          };
          source.connect(workletNode);
        } catch {
          const fallbackNode = audioContext.createScriptProcessor(1024, 1, 1);
          fallbackNode.onaudioprocess = (event) => {
            handleAudioBuffer(event.inputBuffer.getChannelData(0));
          };
          processorRef.current = fallbackNode;
          source.connect(fallbackNode);
          fallbackNode.connect(audioContext.destination);
        }

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'start',
            language,
          }));
        };

        ws.onmessage = async (event) => {
          try {
            const payload = event.data instanceof Blob
              ? JSON.parse(await event.data.text())
              : JSON.parse(event.data);

            if (payload.type === 'ready') {
              setStatus('connected');
              return;
            }

            if (payload.type === 'partial') {
              const nextPartial = String(payload.text || '').trim();
              partialRef.current = nextPartial;
              setPartialTranscript(nextPartial);
              if (nextPartial && !speakingRef.current) {
                speakingRef.current = true;
                onSpeechStartRef.current?.();
              }
              onPartialRef.current?.(nextPartial);
              return;
            }

            if (payload.type === 'final') {
              const finalText = String(payload.text || '').trim();
              const dedupeKey = finalText.toLowerCase();
              const now = Date.now();
              clearPartial();
              speakingRef.current = false;
              if (
                finalText
                && (
                  !dedupeKey
                  || dedupeKey !== lastFinalEmitRef.current.key
                  || (now - lastFinalEmitRef.current.timestamp) >= LOCAL_STT_FINAL_DEDUP_MS
                )
              ) {
                lastFinalEmitRef.current = { key: dedupeKey, timestamp: now };
                onFinalRef.current?.(finalText);
              }
              return;
            }

            if (payload.type === 'error') {
              setError(payload.error || 'Ошибка STT');
              return;
            }
          } catch (messageError) {
            console.error('STT websocket message error', messageError);
          }
        };

        ws.onerror = () => {
          setStatus('error');
          setError('Ошибка подключения к STT');
        };

        ws.onclose = () => {
          speakingRef.current = false;
          clearPartial();
          if (!cancelled) {
            setStatus('idle');
          }
        };
      } catch (connectError) {
        console.error('STT connect failed', connectError);
        setStatus('error');
        setError(connectError?.message || 'Не удалось подключить STT');
      }
    };

    void connect();

    return () => {
      cancelled = true;
      disconnect();
    };
  }, [clearPartial, conversationSessionId, disconnect, enabled, language]);

  const getUserVolume = useCallback(() => userVolumeRef.current, []);

  return {
    status,
    error,
    partialTranscript,
    disconnect,
    getUserVolume,
  };
}
