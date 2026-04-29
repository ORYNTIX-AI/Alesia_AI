import { useCallback, useEffect, useRef } from 'react';

function calculateFloat32Rms(float32Array) {
  let sum = 0;
  for (let index = 0; index < float32Array.length; index += 1) {
    sum += float32Array[index] * float32Array[index];
  }
  return Math.sqrt(sum / Math.max(1, float32Array.length));
}

export function useSapphireGeminiAudioQueue({ audioContextRef, audioPlayer }) {
  const queueRef = useRef([]);
  const playingRef = useRef(false);
  const sourceRef = useRef(null);
  const bufferedUntilMsRef = useRef(0);
  const playNextRef = useRef(null);

  const getBufferedMs = useCallback(() => (
    Math.round(Math.max(0, bufferedUntilMsRef.current - performance.now()))
  ), []);

  const resetAudio = useCallback(() => {
    queueRef.current = [];
    playingRef.current = false;
    sourceRef.current = null;
    bufferedUntilMsRef.current = 0;
    audioPlayer?.setSyntheticVolume?.(0, 0);
  }, [audioPlayer]);

  const stopAudio = useCallback((reason = '') => {
    const queueDepth = queueRef.current.length;
    const activeSources = sourceRef.current ? 1 : 0;
    queueRef.current = [];
    playingRef.current = false;
    bufferedUntilMsRef.current = 0;
    audioPlayer?.setSyntheticVolume?.(0, 0);
    if (queueDepth > 0 || activeSources > 0) {
      audioPlayer?.emitPlaybackEvent?.('audio-playback-stop', {
        reason: String(reason || ''),
        outputMode: 'sapphire-direct',
        queueDepth,
        bufferedMs: 0,
        activeSources,
      });
    }

    const source = sourceRef.current;
    sourceRef.current = null;
    if (!source) {
      return;
    }
    try {
      source.onended = null;
      source.stop(0);
    } catch {
      // Ignore sources that already ended.
    }
  }, [audioPlayer]);

  const clearQueuedAudio = useCallback((reason = '') => {
    const queueDepth = queueRef.current.length;
    queueRef.current = [];
    playingRef.current = false;
    bufferedUntilMsRef.current = 0;
    audioPlayer?.setSyntheticVolume?.(0, 0);
    if (queueDepth > 0 || sourceRef.current) {
      audioPlayer?.emitPlaybackEvent?.('audio-playback-stop', {
        reason: String(reason || ''),
        outputMode: 'sapphire-direct',
        queueDepth,
        bufferedMs: 0,
        activeSources: sourceRef.current ? 1 : 0,
        softStop: true,
      });
    }
  }, [audioPlayer]);

  const playNext = useCallback(() => {
    if (queueRef.current.length === 0) {
      playingRef.current = false;
      sourceRef.current = null;
      bufferedUntilMsRef.current = 0;
      audioPlayer?.setSyntheticVolume?.(0, 0);
      return;
    }

    const audioContext = audioContextRef.current;
    if (!audioContext || audioContext.state === 'closed') {
      playingRef.current = false;
      audioPlayer?.emitPlaybackEvent?.('audio-playback-ended', {
        outputMode: 'sapphire-direct',
        reason: 'audio-context-missing',
        queueDepth: queueRef.current.length,
        bufferedMs: getBufferedMs(),
      });
      return;
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume()
        .then(() => playNextRef.current?.())
        .catch(() => {});
      return;
    }

    const chunk = queueRef.current.shift();
    if (!chunk?.length) {
      playNextRef.current?.();
      return;
    }

    const sampleRate = 24000;
    const buffer = audioContext.createBuffer(1, chunk.length, sampleRate);
    if (typeof buffer.copyToChannel === 'function') {
      buffer.copyToChannel(chunk, 0);
    } else {
      buffer.getChannelData(0).set(chunk);
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    playingRef.current = true;
    sourceRef.current = source;

    const durationMs = Math.round(buffer.duration * 1000);
    const rms = calculateFloat32Rms(chunk);
    const startedAtMs = performance.now();
    audioPlayer?.setSyntheticVolume?.(Math.min(1, Math.max(0.08, rms * 3.5)), durationMs);

    source.onended = () => {
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAtMs));
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
      playingRef.current = false;
      audioPlayer?.emitPlaybackEvent?.('audio-playback-ended', {
        outputMode: 'sapphire-direct',
        sampleRate,
        samples: buffer.length,
        durationMs,
        elapsedMs,
        earlyEnded: durationMs > 80 && elapsedMs < Math.round(durationMs * 0.6),
        queueDepth: queueRef.current.length,
        bufferedMs: getBufferedMs(),
      });
      playNextRef.current?.();
    };

    try {
      source.start();
      audioPlayer?.emitPlaybackEvent?.('audio-playback-start', {
        outputMode: 'sapphire-direct',
        sampleRate,
        samples: buffer.length,
        durationMs,
        queueDepth: queueRef.current.length,
        bufferedMs: getBufferedMs(),
      });
    } catch {
      playingRef.current = false;
      sourceRef.current = null;
      audioPlayer?.emitPlaybackEvent?.('audio-playback-ended', {
        outputMode: 'sapphire-direct',
        reason: 'source-start-failed',
        sampleRate,
        samples: buffer.length,
        durationMs,
        queueDepth: queueRef.current.length,
        bufferedMs: getBufferedMs(),
      });
      playNextRef.current?.();
    }
  }, [audioContextRef, audioPlayer, getBufferedMs]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  const enqueueAudioChunk = useCallback((float32Array, sampleRate = 24000) => {
    const samples = Number(float32Array?.length || 0);
    const effectiveRate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
    const buildResult = (ok, reason = '') => ({
      ok,
      reason,
      samples,
      sampleRate: effectiveRate,
      contextState: audioContextRef.current?.state || '',
      queuedMs: getBufferedMs(),
      queueDepth: queueRef.current.length,
      outputMode: 'sapphire-direct',
    });

    if (!samples) {
      return buildResult(false, 'empty-audio');
    }

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      try {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      } catch {
        return buildResult(false, 'audio-context-missing');
      }
    }

    const durationMs = Math.round((samples / effectiveRate) * 1000);
    queueRef.current.push(float32Array);
    bufferedUntilMsRef.current = Math.max(bufferedUntilMsRef.current, performance.now()) + durationMs;
    if (!playingRef.current) {
      playNext();
    }
    return buildResult(true);
  }, [audioContextRef, getBufferedMs, playNext]);

  return {
    clearQueuedAudio,
    enqueueAudioChunk,
    getBufferedMs,
    resetAudio,
    stopAudio,
  };
}
