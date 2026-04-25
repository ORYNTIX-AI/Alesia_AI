/**
 * @typedef {object} VoiceRuntimeAdapter
 * @property {(config?: object) => Promise<void> | void} connect
 * @property {() => Promise<void> | void} disconnect
 * @property {(text: string, options?: object) => Promise<void> | void} sendTextTurn
 * @property {(audioChunk: Float32Array, sampleRateHertz?: number) => Promise<void> | void} sendAudioChunk
 * @property {() => Promise<void> | void} cancelAssistantOutput
 * @property {() => string} getStatus
 * @property {() => number} getUserVolume
 */

export const VOICE_RUNTIME_METHODS = Object.freeze([
  'connect',
  'disconnect',
  'sendTextTurn',
  'sendAudioChunk',
  'cancelAssistantOutput',
  'getStatus',
  'getUserVolume',
])

export function createVoiceRuntimeAdapter(adapter = {}) {
  return {
    connect: adapter.connect || (() => {}),
    disconnect: adapter.disconnect || (() => {}),
    sendTextTurn: adapter.sendTextTurn || (() => {}),
    sendAudioChunk: adapter.sendAudioChunk || (() => {}),
    cancelAssistantOutput: adapter.cancelAssistantOutput || (() => {}),
    getStatus: adapter.getStatus || (() => String(adapter.status || 'disconnected')),
    getUserVolume: adapter.getUserVolume || (() => 0),
    ...adapter,
  }
}
