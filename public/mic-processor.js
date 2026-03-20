// AudioWorklet Processor for capturing microphone audio
// This runs in a separate thread for better performance

class MicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 1024 samples at 48 kHz is about 21 ms, which keeps realtime latency low.
        this.bufferSize = 1024;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    process(inputs, OUTPUTS, PARAMETERS) {
        const input = inputs[0];
        if (input.length > 0) {
            const channelData = input[0];

            for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.bufferIndex++] = channelData[i];

                if (this.bufferIndex >= this.bufferSize) {
                    // Send buffer to main thread
                    this.port.postMessage({
                        type: 'audio',
                        buffer: this.buffer.slice()
                    });
                    this.bufferIndex = 0;
                }
            }
        }
        return true; // Keep processor alive
    }
}

registerProcessor('mic-processor', MicProcessor);
