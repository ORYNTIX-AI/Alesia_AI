export class AudioStreamPlayer {
    constructor(sampleRate = 24000) {
        this.audioContext = null;
        this.queue = [];
        this.sampleRate = sampleRate;
        this.nextStartTime = 0;
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
        this.activeSources = new Set();
        this.playbackGeneration = 0;
        this.bufferedUntil = 0;
        this.lastChunkAt = 0;
        this.initialBufferMs = 110;
        this.fadeDurationSec = 0.012;
        this.restartCooldownMs = 140;
        this.blockedUntilMs = 0;
        this.resumeTimer = null;
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
    }

    addChunk(float32Array, sampleRate = this.sampleRate) {
        if (!this.audioContext || !float32Array?.length) return;

        const effectiveRate = Number(sampleRate) > 0 ? Number(sampleRate) : this.sampleRate;
        const buffer = this.audioContext.createBuffer(1, float32Array.length, effectiveRate);
        buffer.getChannelData(0).set(float32Array);
        const generation = this.playbackGeneration;
        this.queue.push({ buffer, generation });
        this.lastChunkAt = performance.now();
        this.scheduleQueue();
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

    stop() {
        this.playbackGeneration += 1;
        this.queue = [];
        this.blockedUntilMs = performance.now() + this.restartCooldownMs;
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
        this.nextStartTime = this.audioContext ? this.audioContext.currentTime : 0;
        this.bufferedUntil = this.nextStartTime;
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
        if (!this.audioContext) return 0;
        const remaining = Math.max(0, this.bufferedUntil - this.audioContext.currentTime);
        return Math.round(remaining * 1000);
    }

    getVolume() {
        if (!this.analyser || !this.dataArray) return 0;
        this.analyser.getByteFrequencyData(this.dataArray);
        let sum = 0;
        const len = this.dataArray.length;
        for (let i = 0; i < len; i++) {
            sum += this.dataArray[i];
        }
        const average = sum / len;
        return average / 255;
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
    }
}
