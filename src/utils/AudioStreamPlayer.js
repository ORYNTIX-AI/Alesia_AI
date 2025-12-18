export class AudioStreamPlayer {
    constructor(sampleRate = 24000) {
        this.audioContext = null;
        this.queue = [];
        this.isPlaying = false;
        this.sampleRate = sampleRate; // Gemini default usually 24kHz or determined by handshake
        this.nextStartTime = 0;
        this.analyser = null;
        this.gainNode = null;
        this.dataArray = null;
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

        this.queue.push(buffer);
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
            const buffer = this.queue.shift();
            const source = this.audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(this.gainNode);
            source.start(this.nextStartTime);
            this.nextStartTime += buffer.duration;
        }
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
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
    }
}
