/**
 * Converts a Float32Array of audio data to an Int16Array (PCM 16-bit).
 * @param {Float32Array} float32Array 
 * @returns {Int16Array}
 */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Int16Array(buffer);
}

/**
 * Converts a base64 string to a Float32Array (16-bit PCM source).
 * @param {string} base64 
 * @returns {Float32Array}
 */
export function base64ToFloat32Array(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Encodes a Float32Array of audio data to a base64 string (16-bit PCM).
 * @param {Float32Array} array 
 * @returns {string}
 */
export function float32ToBase64(array) {
  const int16Array = floatTo16BitPCM(array);
  let binary = '';
  const bytes = new Uint8Array(int16Array.buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/**
 * Downsamples audio buffer to target sample rate.
 * @param {Float32Array} buffer 
 * @param {number} currentRate 
 * @param {number} targetRate 
 * @returns {Float32Array}
 */
export function downsampleBuffer(buffer, currentRate, targetRate) {
  if (currentRate === targetRate) {
    return buffer;
  }
  if (currentRate < targetRate) {
    throw new Error("Upsampling is not supported");
  }
  const sampleRateRatio = currentRate / targetRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}
