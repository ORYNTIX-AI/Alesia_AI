import { isClientInlinePanelMode } from '../browser/browserPanelModel.js'

export const SIDECAR_BOT_VOLUME_GUARD = 0.08
export const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3'])
export const GEMINI_31_FLASH_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview'
export const GEMINI_31_FLASH_TTS_MODEL = 'gemini-3.1-flash-tts-preview'
export const DEMO_SPEECH_CONFIG = Object.freeze({
  profile: 'balanced',
  bargeInHoldMs: 180,
  minTranscriptLength: 4,
  botVolumeGuard: SIDECAR_BOT_VOLUME_GUARD,
  immediateOnSpeechStart: true,
})

export function isGemini31FlashLiveModel(modelId) {
  return String(modelId || '').trim() === GEMINI_31_FLASH_LIVE_MODEL
}

export function getSelectedCharacter(config) {
  return config?.characters?.find((character) => character.id === config.activeCharacterId)
    || config?.characters?.[0]
    || null
}

export function getVoiceOptions(config) {
  if (Array.isArray(config?.supportedVoices) && config.supportedVoices.length > 0) {
    return config.supportedVoices.map((voice) => ({
      value: voice.name,
      label: `${voice.name} (${voice.gender === 'male' ? 'male' : 'female'})`,
    }))
  }

  const supportedVoiceNames = config?.supportedVoiceNames?.length
    ? config.supportedVoiceNames
    : ['Aoede', 'Kore', 'Puck']

  return supportedVoiceNames.map((voiceName) => ({
    value: voiceName,
    label: voiceName,
  }))
}

export function resolveUiCharacter(selectedCharacter, settingsOpen, settingsDraft) {
  if (!settingsOpen || !settingsDraft || !selectedCharacter || settingsDraft.id !== selectedCharacter.id) {
    return selectedCharacter
  }

  return {
    ...selectedCharacter,
    backgroundPreset: settingsDraft.backgroundPreset,
    displayName: settingsDraft.displayName,
  }
}

export function resolveSpeechConfig() {
  return { ...DEMO_SPEECH_CONFIG }
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, numeric))
}

export function buildTunedSpeechConfig(baseConfig, testerSettings = {}) {
  return {
    ...baseConfig,
    bargeInHoldMs: clampNumber(
      testerSettings.interruptHoldMs,
      120,
      640,
      baseConfig.bargeInHoldMs,
    ),
    botVolumeGuard: clampNumber(
      0.035 + (Number(testerSettings.echoGuard || 0) / 100) * 0.16,
      0.035,
      0.195,
      baseConfig.botVolumeGuard,
    ),
  }
}

export function resolvePageContextMode(character) {
  return String(character?.pageContextMode || 'browser-session').trim() === 'url-fetch'
    ? 'url-fetch'
    : 'browser-session'
}

export function buildRuntimeConfig({
  character,
  runtimeProvider = '',
  usesLiveInput = false,
  sessionContextText = '',
  shouldSendGreeting = true,
  conversationSessionId = '',
  testerSettings = {},
  fallbackRuntimeProvider = '',
} = {}) {
  if (!character) {
    return undefined
  }

  return {
    runtimeProvider: String(runtimeProvider || character.runtimeProvider || 'gemini-live').trim() || 'gemini-live',
    modelId: character.modelId || character.voiceModelId,
    voiceModelId: character.voiceModelId || character.modelId,
    ttsModelId: character.ttsModelId || GEMINI_31_FLASH_TTS_MODEL,
    voiceName: character.voiceName,
    ttsVoiceName: character.ttsVoiceName || character.voiceName,
    systemPrompt: character.systemPrompt,
    greetingText: character.greetingText,
    sessionContextText,
    shouldSendGreeting,
    captureUserAudio: usesLiveInput,
    voiceGatewayUrl: character.voiceGatewayUrl || '',
    conversationSessionId,
    characterId: character.id,
    outputAudioTranscription: character.outputAudioTranscription !== false,
    vectorStoreId: character.vectorStoreId || '',
    enabledTools: Array.isArray(character.enabledTools) ? character.enabledTools : [],
    webSearchEnabled: character.webSearchEnabled === true,
    maxToolResults: character.maxToolResults || 4,
    voiceInteractionTuning: {
      pauseMs: testerSettings.pauseMs,
      firstReplySentences: testerSettings.firstReplySentences,
      memoryTurnCount: testerSettings.memoryTurnCount,
    },
    fallbackRuntimeProvider: String(fallbackRuntimeProvider || character.fallbackRuntimeProvider || '').trim(),
  }
}

export function buildSignature(character, globalRuntimeConfig = {}) {
  if (!character) {
    return ''
  }

  return [
    String(character.runtimeProvider || 'gemini-live').trim(),
    String(character.modelId || character.voiceModelId || '').trim(),
    character.voiceModelId,
    character.ttsModelId,
    character.voiceName,
    character.systemPrompt,
    character.greetingText,
    character.liveInputEnabled ? 'live-input-on' : 'live-input-off',
    String(character.voiceGatewayUrl || '').trim(),
    isClientInlinePanelMode(character.browserPanelMode) ? 'client-inline' : 'remote',
    String(character.pageContextMode || 'browser-session').trim(),
    String(globalRuntimeConfig.pauseMs || '').trim(),
    String(globalRuntimeConfig.firstReplySentences || '').trim(),
    String(globalRuntimeConfig.memoryTurnCount || '').trim(),
  ].join('|')
}
