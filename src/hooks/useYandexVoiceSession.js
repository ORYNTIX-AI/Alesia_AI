import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFloat32Array, downsampleBuffer, float32ToBase64 } from '../utils/audioConverter';

const DEFAULT_RUNTIME_CONFIG = {
  runtimeProvider: 'yandex-full',
  modelId: 'yandexgpt-lite/latest',
  ttsVoiceName: 'ermil',
  systemPrompt: '',
  greetingText: '',
  sessionContextText: '',
  shouldSendGreeting: true,
  captureUserAudio: false,
  conversationSessionId: '',
  characterId: '',
  outputAudioTranscription: false,
};

const DEFAULT_CALLBACKS = {
  onInputTranscription: null,
  onInputTranscriptionCommit: null,
  onAssistantTurnStart: null,
  onAssistantTurnCommit: null,
  onAssistantTurnCancel: null,
  onAssistantInterrupted: null,
  onSessionReady: null,
};

const DEFAULT_BACKEND_HTTP_BASE =
  String(import.meta.env?.VITE_BACKEND_HTTP_BASE || '').trim().replace(/\/+$/, '');
const LOCAL_VAD_START_THRESHOLD = 0.02;
const LOCAL_VAD_CONTINUE_THRESHOLD = 0.012;
const LOCAL_VAD_END_SILENCE_MS = 880;
const LOCAL_VAD_MIN_UTTERANCE_MS = 320;
const LOCAL_VAD_MAX_UTTERANCE_MS = 12000;
const PCM_TARGET_RATE = 16000;
const YANDEX_TTS_RATE = 48000;

function defaultBackendHttpUrl(pathname) {
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

function mergeFloat32Chunks(chunks = []) {
  const totalLength = chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    if (!chunk?.length) {
      return;
    }
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

export function useYandexVoiceSession(audioPlayer, runtimeConfig = DEFAULT_RUNTIME_CONFIG, callbacks = DEFAULT_CALLBACKS) {
  const [status, setStatus] = useState('disconnected');
  const [error, setError] = useState(null);
  const runtimeConfigRef = useRef({ ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig });
  const callbacksRef = useRef({ ...DEFAULT_CALLBACKS, ...callbacks });
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const userVolumeRef = useRef(0);
  const speechStateRef = useRef({
    active: false,
    chunks: [],
    startedAt: 0,
    lastSpeechAt: 0,
    finalizedAt: 0,
  });
  const lifecycleTokenRef = useRef(0);
  const currentTurnAbortRef = useRef(null);

  useEffect(() => {
    runtimeConfigRef.current = { ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfig };
  }, [runtimeConfig]);

  useEffect(() => {
    callbacksRef.current = { ...DEFAULT_CALLBACKS, ...callbacks };
  }, [callbacks]);

  const releaseAudioResources = useCallback(() => {
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

  const resetSpeechState = useCallback(() => {
    speechStateRef.current = {
      active: false,
      chunks: [],
      startedAt: 0,
      lastSpeechAt: 0,
      finalizedAt: 0,
    };
  }, []);

  const cancelAssistantOutput = useCallback(() => {
    currentTurnAbortRef.current?.abort?.();
    audioPlayer.stop?.();
    callbacksRef.current.onAssistantInterrupted?.();
    callbacksRef.current.onAssistantTurnCancel?.({ text: '', interrupted: true });
  }, [audioPlayer]);

  const finalizeSpeechCapture = useCallback(async (sampleRate) => {
    const speechState = speechStateRef.current;
    if (!speechState.active || !speechState.chunks.length) {
      return;
    }

    const utteranceDurationMs = speechState.startedAt ? Date.now() - speechState.startedAt : 0;
    const merged = mergeFloat32Chunks(speechState.chunks);
    resetSpeechState();
    if (!merged.length || utteranceDurationMs < LOCAL_VAD_MIN_UTTERANCE_MS) {
      return;
    }

    let payloadBuffer = merged;
    if (sampleRate !== PCM_TARGET_RATE) {
      payloadBuffer = downsampleBuffer(merged, sampleRate, PCM_TARGET_RATE);
    }

    try {
      const response = await fetch(defaultBackendHttpUrl('/api/yandex/stt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationSessionId: runtimeConfigRef.current.conversationSessionId,
          characterId: runtimeConfigRef.current.characterId,
          sampleRateHertz: PCM_TARGET_RATE,
          audioBase64: float32ToBase64(payloadBuffer),
          language: 'ru-RU',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Yandex STT failed (${response.status})`);
      }
      const finalText = normalizeText(payload?.text || '');
      if (finalText) {
        callbacksRef.current.onInputTranscriptionCommit?.({ text: finalText });
      }
    } catch (requestError) {
      setError(requestError?.message || 'Ошибка Yandex STT');
      setStatus('error');
    }
  }, [resetSpeechState]);

  const connect = useCallback(async (runtimeOverride = null) => {
    lifecycleTokenRef.current += 1;
    const lifecycleToken = lifecycleTokenRef.current;
    setError(null);
    setStatus('connecting');
    if (runtimeOverride && typeof runtimeOverride === 'object') {
      runtimeConfigRef.current = { ...DEFAULT_RUNTIME_CONFIG, ...runtimeConfigRef.current, ...runtimeOverride };
    }
    const activeRuntime = runtimeConfigRef.current;
    const isStale = () => lifecycleTokenRef.current != lifecycleToken;

    try {
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

        const handleAudioBuffer = (buffer) => {
          const now = Date.now();
          let sum = 0;
          for (let index = 0; index < buffer.length; index += 1) {
            sum += buffer[index] * buffer[index];
          }
          const rms = Math.sqrt(sum / Math.max(1, buffer.length));
          userVolumeRef.current = Math.min(1, rms * 5.5);

          const speechState = speechStateRef.current;
          const threshold = speechState.active ? LOCAL_VAD_CONTINUE_THRESHOLD : LOCAL_VAD_START_THRESHOLD;
          const hasSpeech = rms >= threshold;

          if (hasSpeech) {
            if (!speechState.active) {
              speechState.active = true;
              speechState.startedAt = now;
              speechState.chunks = [];
            }
            speechState.lastSpeechAt = now;
            speechState.chunks.push(new Float32Array(buffer));
            return;
          }

          if (!speechState.active) {
            return;
          }

          speechState.chunks.push(new Float32Array(buffer));
          if ((now - speechState.lastSpeechAt) >= LOCAL_VAD_END_SILENCE_MS || (now - speechState.startedAt) >= LOCAL_VAD_MAX_UTTERANCE_MS) {
            void finalizeSpeechCapture(audioContext.sampleRate);
          }
        };

        try {
          await audioContext.audioWorklet.addModule('/mic-processor.js');
          if (isStale()) {
            releaseAudioResources();
            return;
          }
          const workletNode = new AudioWorkletNode(audioContext, 'mic-processor');
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
      }

      setStatus('connected');
      callbacksRef.current.onSessionReady?.({ resumed: false, shouldSendGreeting: activeRuntime.shouldSendGreeting !== false });
    } catch (connectionError) {
      if (isStale()) {
        return;
      }
      releaseAudioResources();
      setError(connectionError?.message || 'Не удалось подключить Yandex voice session');
      setStatus('error');
    }
  }, [audioPlayer, finalizeSpeechCapture, releaseAudioResources]);

  const disconnect = useCallback(() => {
    lifecycleTokenRef.current += 1;
    currentTurnAbortRef.current?.abort?.();
    resetSpeechState();
    releaseAudioResources();
    audioPlayer.stop?.();
    setStatus('disconnected');
  }, [audioPlayer, releaseAudioResources, resetSpeechState]);

  useEffect(() => () => disconnect(), [disconnect]);

  const sendTextTurn = useCallback(async (text, options = {}) => {
    const prompt = normalizeText(text);
    if (!prompt) {
      return false;
    }

    if (options.interrupt !== false) {
      currentTurnAbortRef.current?.abort?.();
      audioPlayer.stop?.();
    }

    const accepted = callbacksRef.current.onAssistantTurnStart?.() !== false;
    if (!accepted) {
      return false;
    }

    const abortController = new AbortController();
    currentTurnAbortRef.current = abortController;

    try {
      const response = await fetch(defaultBackendHttpUrl('/api/yandex/turn'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: prompt,
          characterId: runtimeConfigRef.current.characterId,
          conversationSessionId: runtimeConfigRef.current.conversationSessionId,
          systemPrompt: runtimeConfigRef.current.systemPrompt,
          voiceName: runtimeConfigRef.current.ttsVoiceName || runtimeConfigRef.current.voiceName || 'ermil',
          modelId: runtimeConfigRef.current.modelId,
          sampleRateHertz: YANDEX_TTS_RATE,
        }),
        signal: abortController.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Yandex turn failed (${response.status})`);
      }
      const assistantText = normalizeText(payload?.text || '');
      if (payload?.audioBase64) {
        const pcm = base64ToFloat32Array(payload.audioBase64);
        audioPlayer.addChunk?.(pcm, Number(payload.sampleRateHertz || YANDEX_TTS_RATE));
      }
      callbacksRef.current.onAssistantTurnCommit?.({
        text: assistantText,
        textChunks: assistantText ? 1 : 0,
        audioChunks: payload?.audioBase64 ? 1 : 0,
        durationMs: 0,
      });
      return true;
    } catch (requestError) {
      if (requestError?.name === 'AbortError') {
        callbacksRef.current.onAssistantTurnCancel?.({ text: '', interrupted: true });
        return false;
      }
      setError(requestError?.message || 'Ошибка Yandex voice session');
      setStatus('error');
      callbacksRef.current.onAssistantTurnCancel?.({ text: '', interrupted: false });
      return false;
    } finally {
      if (currentTurnAbortRef.current === abortController) {
        currentTurnAbortRef.current = null;
      }
    }
  }, [audioPlayer]);

  const clearSessionResumption = useCallback(() => {}, []);
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
