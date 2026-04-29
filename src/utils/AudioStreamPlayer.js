export class AudioStreamPlayer {
    constructor(sampleRate = 24000) {
        this.audioContext = null;
        this.queue = [];
        this.htmlQueue = [];
        this.sampleRate = sampleRate;
        this.nextStartTime = 0;
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
        this.htmlAudio = null;
        this.htmlAudioPlaying = false;
        this.htmlAudioCurrentItem = null;
        this.htmlPendingChunks = [];
        this.htmlPendingSamples = 0;
        this.htmlPendingSampleRate = 0;
        this.htmlFlushTimer = null;
        this.activeSources = new Set();
        this.playbackGeneration = 0;
        this.bufferedUntil = 0;
        this.htmlBufferedUntilMs = 0;
        this.syntheticVolume = 0;
        this.syntheticVolumeUntilMs = 0;
        this.lastChunkAt = 0;
        this.initialBufferMs = 80;
        this.fadeDurationSec = 0.004;
        this.restartCooldownMs = 40;
        this.blockedUntilMs = 0;
        this.resumeTimer = null;
        this.htmlChunkTargetMs = 360;
        this.htmlChunkFlushDelayMs = 90;
        this.preferHtmlAudioOutput = false;
        this.sequentialPlaybackMode = false;
        this.sequentialQueue = [];
        this.sequentialPlaying = false;
        this.sequentialSource = null;
        this.sequentialBufferedUntilMs = 0;
        this.playbackEventCallback = null;
    }

    setSequentialPlaybackMode(enabled) {
        this.sequentialPlaybackMode = Boolean(enabled);
        if (!this.sequentialPlaybackMode) {
            this.sequentialQueue = [];
            this.sequentialPlaying = false;
            this.sequentialSource = null;
            this.sequentialBufferedUntilMs = 0;
        }
    }

    setPreferHtmlAudioOutput(preferHtmlAudioOutput) {
        this.preferHtmlAudioOutput = Boolean(preferHtmlAudioOutput);
        if (this.preferHtmlAudioOutput && !this.htmlAudio && typeof Audio !== 'undefined') {
            this.htmlAudio = new Audio();
            this.htmlAudio.preload = 'auto';
            this.htmlAudio.playsInline = true;
        }
    }

    setPlaybackEventCallback(callback) {
        this.playbackEventCallback = typeof callback === 'function' ? callback : null;
    }

    emitPlaybackEvent(event, details = {}) {
        try {
            this.playbackEventCallback?.(event, details);
        } catch {
            // Playback telemetry must never break audio.
        }
    }

    setSyntheticVolume(volume = 0, durationMs = 0) {
        this.syntheticVolume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.syntheticVolumeUntilMs = this.syntheticVolume > 0 && Number(durationMs) > 0
            ? Date.now() + Number(durationMs)
            : 0;
    }

    async initialize() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            this.gainNode = this.audioContext.createGain();
            this.gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        if (this.preferHtmlAudioOutput && !this.htmlAudio) {
            this.htmlAudio = new Audio();
            this.htmlAudio.preload = 'auto';
            this.htmlAudio.playsInline = true;
        }
    }

    addChunk(float32Array, sampleRate = this.sampleRate) {
        const samples = Number(float32Array?.length || 0);
        const effectiveRate = Number(sampleRate) > 0 ? Number(sampleRate) : this.sampleRate;
        const buildResult = (ok, reason = '') => ({
            ok,
            reason,
            samples,
            sampleRate: effectiveRate,
            contextState: this.audioContext?.state || '',
            queuedMs: this.getBufferedMs(),
            queueDepth: this.queue.length + this.sequentialQueue.length + this.htmlQueue.length,
            outputMode: this.preferHtmlAudioOutput
                ? 'html'
                : (this.sequentialPlaybackMode ? 'webaudio-sequential' : 'webaudio'),
        });

        if (!this.audioContext) {
            return buildResult(false, 'audio-context-missing');
        }
        if (!samples) {
            return buildResult(false, 'empty-audio');
        }
        if (this.preferHtmlAudioOutput) {
            this.enqueueHtmlAudioChunk(float32Array, effectiveRate);
            return buildResult(true);
        }

        if (this.audioContext.state === 'closed') {
            return buildResult(false, 'audio-context-closed');
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume()
                .then(() => {
                    if (this.sequentialPlaybackMode) {
                        this.playNextSequentialChunk();
                    } else {
                        this.scheduleQueue();
                    }
                })
                .catch(() => {});
        }

        const buffer = this.audioContext.createBuffer(1, float32Array.length, effectiveRate);
        buffer.getChannelData(0).set(float32Array);
        const generation = this.playbackGeneration;
        if (this.sequentialPlaybackMode) {
            const durationMs = Math.round(buffer.duration * 1000);
            this.sequentialQueue.push({ buffer, generation, durationMs });
            this.sequentialBufferedUntilMs = Math.max(this.sequentialBufferedUntilMs, performance.now()) + durationMs;
            this.lastChunkAt = performance.now();
            this.playNextSequentialChunk();
            return buildResult(true);
        }
        this.queue.push({ buffer, generation });
        this.lastChunkAt = performance.now();
        this.scheduleQueue();
        return buildResult(true);
    }

    playNextSequentialChunk() {
        if (!this.audioContext || this.sequentialPlaying || this.sequentialQueue.length === 0) {
            return;
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume()
                .then(() => this.playNextSequentialChunk())
                .catch(() => {});
            return;
        }

        const queued = this.sequentialQueue.shift();
        if (!queued) {
            return;
        }
        const { buffer, generation, durationMs } = queued;
        if (generation !== this.playbackGeneration) {
            this.playNextSequentialChunk();
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        this.sequentialPlaying = true;
        this.sequentialSource = source;
        const startedAtMs = performance.now();
        this.activeSources.add(source);
        source.onended = () => {
            const elapsedMs = Math.max(0, Math.round(performance.now() - startedAtMs));
            this.activeSources.delete(source);
            if (generation !== this.playbackGeneration) {
                return;
            }
            if (this.sequentialSource === source) {
                this.sequentialSource = null;
            }
            this.sequentialPlaying = false;
            this.emitPlaybackEvent('audio-playback-ended', {
                outputMode: 'webaudio-sequential',
                sampleRate: buffer.sampleRate,
                samples: buffer.length,
                durationMs,
                elapsedMs,
                earlyEnded: durationMs > 80 && elapsedMs < Math.round(durationMs * 0.6),
                queueDepth: this.sequentialQueue.length,
                bufferedMs: this.getBufferedMs(),
            });
            this.playNextSequentialChunk();
        };
        source.start();
        this.emitPlaybackEvent('audio-playback-start', {
            outputMode: 'webaudio-sequential',
            sampleRate: buffer.sampleRate,
            samples: buffer.length,
            durationMs,
            queueDepth: this.sequentialQueue.length,
            bufferedMs: this.getBufferedMs(),
        });
    }

    scheduleQueue() {
        if (!this.audioContext || this.queue.length === 0) return;

        const nowMs = performance.now();
        if (this.blockedUntilMs > nowMs) {
            if (!this.resumeTimer) {
                this.resumeTimer = window.setTimeout(() => {
                    this.resumeTimer = null;
                    this.scheduleQueue();
                }, Math.max(0, this.blockedUntilMs - nowMs));
            }
            return;
        }

        const currentTime = this.audioContext.currentTime;
        if (this.nextStartTime < currentTime + 0.01) {
            const initialBufferSec = this.initialBufferMs / 1000;
            const idleSince = currentTime - this.bufferedUntil;
            this.nextStartTime = currentTime + (idleSince > initialBufferSec ? initialBufferSec : 0.02);
        }

        while (this.queue.length > 0) {
            const queued = this.queue.shift();
            if (!queued) {
                continue;
            }
            const { buffer, generation } = queued;
            if (generation !== this.playbackGeneration) {
                continue;
            }
            const source = this.audioContext.createBufferSource();
            const startAt = this.nextStartTime;
            const endAt = startAt + buffer.duration;
            const durationMs = Math.round(buffer.duration * 1000);
            const scheduledDelayMs = Math.max(0, Math.round((startAt - currentTime) * 1000));

            source.buffer = buffer;
            source.connect(this.gainNode);
            const scheduledAtMs = performance.now();
            source.onended = () => {
                const elapsedMs = Math.max(0, Math.round(performance.now() - scheduledAtMs));
                this.activeSources.delete(source);
                this.emitPlaybackEvent('audio-playback-ended', {
                    outputMode: 'webaudio',
                    sampleRate: buffer.sampleRate,
                    samples: buffer.length,
                    durationMs,
                    elapsedMs,
                    scheduledDelayMs,
                    earlyEnded: durationMs > 80 && elapsedMs < Math.round(durationMs * 0.6),
                    queueDepth: this.queue.length,
                    bufferedMs: this.getBufferedMs(),
                });
            };
            this.activeSources.add(source);
            source.start(startAt);
            this.emitPlaybackEvent('audio-playback-start', {
                outputMode: 'webaudio',
                sampleRate: buffer.sampleRate,
                samples: buffer.length,
                durationMs,
                scheduledDelayMs,
                queueDepth: this.queue.length,
                bufferedMs: this.getBufferedMs(),
            });
            this.nextStartTime = endAt;
            this.bufferedUntil = Math.max(this.bufferedUntil, endAt);
        }
    }

    enqueueHtmlAudioChunk(float32Array, sampleRate) {
        if (!float32Array?.length) {
            return;
        }
        if (this.htmlPendingSampleRate && this.htmlPendingSampleRate !== sampleRate) {
            this.flushPendingHtmlAudioChunk();
        }

        this.htmlPendingChunks.push(float32Array);
        this.htmlPendingSamples += float32Array.length;
        this.htmlPendingSampleRate = sampleRate;

        const pendingDurationMs = Math.round((this.htmlPendingSamples / sampleRate) * 1000);
        if (pendingDurationMs >= this.htmlChunkTargetMs || !this.htmlAudioPlaying) {
            this.flushPendingHtmlAudioChunk();
            return;
        }

        if (!this.htmlFlushTimer) {
            this.htmlFlushTimer = window.setTimeout(() => {
                this.htmlFlushTimer = null;
                this.flushPendingHtmlAudioChunk();
            }, this.htmlChunkFlushDelayMs);
        }
    }

    flushPendingHtmlAudioChunk() {
        if (this.htmlFlushTimer) {
            clearTimeout(this.htmlFlushTimer);
            this.htmlFlushTimer = null;
        }
        if (!this.htmlPendingSamples || this.htmlPendingChunks.length === 0) {
            return;
        }

        const sampleRate = this.htmlPendingSampleRate || this.sampleRate;
        const merged = new Float32Array(this.htmlPendingSamples);
        let offset = 0;
        for (const chunk of this.htmlPendingChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        this.htmlPendingChunks = [];
        this.htmlPendingSamples = 0;
        this.htmlPendingSampleRate = 0;

        const durationMs = Math.round((merged.length / sampleRate) * 1000);
        const rms = this.calculateRms(merged);
        const bytes = this.encodeWav(merged, sampleRate);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        const item = {
            blobUrl,
            durationMs,
            rms,
            float32Array: merged,
            sampleRate,
            generation: this.playbackGeneration,
        };
        this.htmlQueue.push(item);
        this.htmlBufferedUntilMs = Math.max(this.htmlBufferedUntilMs, performance.now()) + durationMs;
        this.playNextHtmlAudioChunk();
    }

    playNextHtmlAudioChunk() {
        if (!this.htmlAudioPlaying && this.htmlQueue.length === 0 && this.htmlPendingSamples > 0) {
            this.flushPendingHtmlAudioChunk();
        }
        if (!this.htmlAudio || this.htmlAudioPlaying || this.htmlQueue.length === 0) {
            return;
        }
        const item = this.htmlQueue.shift();
        if (!item || item.generation !== this.playbackGeneration) {
            if (item?.blobUrl) {
                URL.revokeObjectURL(item.blobUrl);
            }
            this.playNextHtmlAudioChunk();
            return;
        }
        this.htmlAudioPlaying = true;
        this.htmlAudioCurrentItem = item;
        this.syntheticVolume = Math.min(1, Math.max(0.08, item.rms * 3.5));
        this.syntheticVolumeUntilMs = Date.now() + item.durationMs;
        this.htmlAudio.src = item.blobUrl;
        this.htmlAudio.onended = () => {
            this.finishHtmlAudioItem(item);
            this.playNextHtmlAudioChunk();
        };
        this.htmlAudio.onerror = () => {
            this.finishHtmlAudioItem(item);
            this.playWebAudioFallback(item);
            this.playNextHtmlAudioChunk();
        };
        this.emitPlaybackEvent('audio-playback-start', {
            outputMode: 'html',
            sampleRate: item.sampleRate,
            samples: item.float32Array?.length || 0,
            durationMs: item.durationMs,
            queueDepth: this.htmlQueue.length,
            bufferedMs: this.getBufferedMs(),
        });
        const playPromise = this.htmlAudio.play();
        if (playPromise?.catch) {
            playPromise.catch(() => {
                this.finishHtmlAudioItem(item);
                this.playWebAudioFallback(item);
                this.playNextHtmlAudioChunk();
            });
        }
    }

    finishHtmlAudioItem(item) {
        this.htmlAudioPlaying = false;
        this.htmlAudioCurrentItem = null;
        this.emitPlaybackEvent('audio-playback-ended', {
            outputMode: 'html',
            sampleRate: item?.sampleRate || this.sampleRate,
            samples: item?.float32Array?.length || 0,
            durationMs: item?.durationMs || 0,
            queueDepth: this.htmlQueue.length,
            bufferedMs: this.getBufferedMs(),
        });
        if (item?.blobUrl) {
            URL.revokeObjectURL(item.blobUrl);
        }
    }

    playWebAudioFallback(item) {
        if (!this.audioContext || this.audioContext.state === 'closed' || !item?.float32Array?.length) {
            return;
        }
        const buffer = this.audioContext.createBuffer(1, item.float32Array.length, item.sampleRate || this.sampleRate);
        buffer.getChannelData(0).set(item.float32Array);
        this.queue.push({ buffer, generation: this.playbackGeneration });
        this.scheduleQueue();
    }

    calculateRms(float32Array) {
        let sum = 0;
        for (let index = 0; index < float32Array.length; index += 1) {
            sum += float32Array[index] * float32Array[index];
        }
        return Math.sqrt(sum / Math.max(1, float32Array.length));
    }

    encodeWav(float32Array, sampleRate) {
        const bytesPerSample = 2;
        const dataSize = float32Array.length * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const writeString = (offset, value) => {
            for (let index = 0; index < value.length; index += 1) {
                view.setUint8(offset + index, value.charCodeAt(index));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * bytesPerSample, true);
        view.setUint16(32, bytesPerSample, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let index = 0; index < float32Array.length; index += 1, offset += 2) {
            const sample = Math.max(-1, Math.min(1, float32Array[index]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }
        return buffer;
    }

    stop(reason = '') {
        const outputMode = this.preferHtmlAudioOutput
            ? 'html'
            : (this.sequentialPlaybackMode ? 'webaudio-sequential' : 'webaudio');
        this.emitPlaybackEvent('audio-playback-stop', {
            reason: String(reason || ''),
            outputMode,
            activeSources: this.activeSources.size,
            queueDepth: this.queue.length + this.sequentialQueue.length + this.htmlQueue.length,
            bufferedMs: this.getBufferedMs(),
            htmlPendingSamples: this.htmlPendingSamples,
        });
        this.playbackGeneration += 1;
        this.queue = [];
        this.sequentialQueue = [];
        this.sequentialPlaying = false;
        this.sequentialSource = null;
        this.sequentialBufferedUntilMs = 0;
        this.htmlQueue.forEach((item) => {
            if (item?.blobUrl) {
                URL.revokeObjectURL(item.blobUrl);
            }
        });
        this.htmlQueue = [];
        this.htmlPendingChunks = [];
        this.htmlPendingSamples = 0;
        this.htmlPendingSampleRate = 0;
        if (this.htmlFlushTimer) {
            clearTimeout(this.htmlFlushTimer);
            this.htmlFlushTimer = null;
        }
        this.blockedUntilMs = performance.now() + this.restartCooldownMs;
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
        this.nextStartTime = this.audioContext ? this.audioContext.currentTime : 0;
        this.bufferedUntil = this.nextStartTime;
        this.htmlBufferedUntilMs = 0;
        this.syntheticVolume = 0;
        this.syntheticVolumeUntilMs = 0;
        if (this.htmlAudio) {
            try {
                this.htmlAudio.pause();
                this.htmlAudio.removeAttribute('src');
                this.htmlAudio.load();
            } catch {
                // Ignore HTML audio teardown failures.
            }
        }
        if (this.htmlAudioCurrentItem?.blobUrl) {
            URL.revokeObjectURL(this.htmlAudioCurrentItem.blobUrl);
        }
        this.htmlAudioCurrentItem = null;
        this.htmlAudioPlaying = false;
        this.activeSources.forEach((source) => {
            try {
                source.stop(0);
            } catch {
                // Ignore sources that already ended.
            }
        });
        this.activeSources.clear();
    }

    getBufferedMs() {
        const webAudioRemaining = this.audioContext
            ? Math.max(0, this.bufferedUntil - this.audioContext.currentTime) * 1000
            : 0;
        const htmlRemaining = Math.max(0, this.htmlBufferedUntilMs - performance.now());
        const sequentialRemaining = Math.max(0, this.sequentialBufferedUntilMs - performance.now());
        return Math.round(Math.max(webAudioRemaining, htmlRemaining, sequentialRemaining));
    }

    getVolume() {
        const syntheticVolume = Date.now() < this.syntheticVolumeUntilMs ? this.syntheticVolume : 0;
        if (!this.analyser || !this.dataArray) return syntheticVolume;
        this.analyser.getByteFrequencyData(this.dataArray);
        let sum = 0;
        const len = this.dataArray.length;
        for (let i = 0; i < len; i++) {
            sum += this.dataArray[i];
        }
        const average = sum / len;
        return Math.max(average / 255, syntheticVolume);
    }

    async close() {
        this.stop();
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
        if (this.htmlFlushTimer) {
            clearTimeout(this.htmlFlushTimer);
            this.htmlFlushTimer = null;
        }
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
        this.htmlAudio = null;
    }
}
