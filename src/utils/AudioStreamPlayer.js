export class AudioStreamPlayer {
    constructor(sampleRate = 24000) {
        this.audioContext = null;
        this.queue = [];
        this.sampleRate = sampleRate; // Gemini default usually 24kHz or determined by handshake
        this.nextStartTime = 0;
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
        this.activeSources = new Set();
        this.playbackGeneration = 0;
        this.bufferedUntil = 0;
        this.lastChunkAt = 0;
    }

    async initialize() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048; // High resolution for LipSync
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            this.gainNode = this.audioContext.createGain();
            this.gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    addChunk(float32Array) {
        if (!this.audioContext) return;

        const buffer = this.audioContext.createBuffer(1, float32Array.length, this.sampleRate);
        buffer.getChannelData(0).set(float32Array);
        const generation = this.playbackGeneration;
        this.queue.push({ buffer, generation });
        this.lastChunkAt = performance.now();
        this.scheduleQueue();
    }

    scheduleQueue() {
        if (this.queue.length === 0) return;

        // If not playing or caught up, reset nextStartTime
        const currentTime = this.audioContext.currentTime;
        if (this.nextStartTime < currentTime) {
            this.nextStartTime = currentTime + 0.05; // Small buffering
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
            source.buffer = buffer;
            source.connect(this.gainNode);
            source.onended = () => {
                this.activeSources.delete(source);
            };
            this.activeSources.add(source);
            source.start(this.nextStartTime);
            this.nextStartTime += buffer.duration;
            this.bufferedUntil = Math.max(this.bufferedUntil, this.nextStartTime);
        }
    }

    stop() {
        this.playbackGeneration += 1;
        this.queue = [];
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

        // Calculate average volume
        let sum = 0;
        const len = this.dataArray.length;
        for (let i = 0; i < len; i++) {
            sum += this.dataArray[i];
        }
        const average = sum / len;
        return average / 255; // Normalize 0-1
    }

    async close() {
        this.stop();
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
    }
}
