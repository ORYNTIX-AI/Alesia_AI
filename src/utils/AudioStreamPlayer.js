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
        this.activeSources = new Set();
        this.playbackGeneration = 0;
        this.bufferedUntil = 0;
        this.htmlBufferedUntilMs = 0;
        this.syntheticVolume = 0;
        this.syntheticVolumeUntilMs = 0;
        this.lastChunkAt = 0;
        this.initialBufferMs = 110;
        this.fadeDurationSec = 0.012;
        this.restartCooldownMs = 140;
        this.blockedUntilMs = 0;
        this.resumeTimer = null;
        this.preferHtmlAudioOutput = typeof navigator !== 'undefined'
            && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
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
            this.audioContext.resume().catch(() => {});
        }

        const buffer = this.audioContext.createBuffer(1, float32Array.length, effectiveRate);
        buffer.getChannelData(0).set(float32Array);
        const generation = this.playbackGeneration;
        this.queue.push({ buffer, generation });
        this.lastChunkAt = performance.now();
        this.scheduleQueue();
        return buildResult(true);
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
            this.nextStartTime = currentTime + (this.initialBufferMs / 1000);
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
            const envelope = this.audioContext.createGain();
            const startAt = this.nextStartTime;
            const fadeDuration = Math.min(this.fadeDurationSec, Math.max(0.004, buffer.duration / 3));
            const endAt = startAt + buffer.duration;

            source.buffer = buffer;
            source.connect(envelope);
            envelope.connect(this.gainNode);
            envelope.gain.setValueAtTime(0.0001, startAt);
            envelope.gain.linearRampToValueAtTime(1, startAt + fadeDuration);
            envelope.gain.setValueAtTime(1, Math.max(startAt + fadeDuration, endAt - fadeDuration));
            envelope.gain.linearRampToValueAtTime(0.0001, endAt);
            source.onended = () => {
                this.activeSources.delete(source);
            };
            this.activeSources.add(source);
            source.start(startAt);
            this.nextStartTime = endAt;
            this.bufferedUntil = Math.max(this.bufferedUntil, endAt);
        }
    }

    enqueueHtmlAudioChunk(float32Array, sampleRate) {
        const durationMs = Math.round((float32Array.length / sampleRate) * 1000);
        const rms = this.calculateRms(float32Array);
        const bytes = this.encodeWav(float32Array, sampleRate);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        const item = {
            blobUrl,
            durationMs,
            rms,
            float32Array,
            sampleRate,
            generation: this.playbackGeneration,
        };
        this.htmlQueue.push(item);
        this.htmlBufferedUntilMs = Math.max(this.htmlBufferedUntilMs, performance.now()) + durationMs;
        this.playNextHtmlAudioChunk();
    }

    playNextHtmlAudioChunk() {
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

    stop() {
        this.playbackGeneration += 1;
        this.queue = [];
        this.htmlQueue.forEach((item) => {
            if (item?.blobUrl) {
                URL.revokeObjectURL(item.blobUrl);
            }
        });
        this.htmlQueue = [];
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
        return Math.round(Math.max(webAudioRemaining, htmlRemaining));
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
