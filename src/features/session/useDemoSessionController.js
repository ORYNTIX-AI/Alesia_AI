import { useMemo } from 'react'
import { getAvatarStageModel } from '../avatar/avatarStageModel.js'
import { isClientInlinePanelMode } from '../browser/browserPanelModel.js'
import { resolveVoiceRuntimeState } from '../voice/runtimeSelection.js'
import {
  BATYUSHKA_CHARACTER_IDS,
  buildRuntimeConfig,
  buildSignature,
  buildTunedSpeechConfig,
  getSelectedCharacter,
  getVoiceOptions,
  resolvePageContextMode,
  resolveSpeechConfig,
  resolveUiCharacter,
} from './sessionModels.js'

export function useDemoSessionController({
  config,
  settingsOpen,
  settingsDraft,
  runtimeProviderOverride,
  testerSettings,
  sessionBootstrapText,
  sessionShouldSendGreeting,
  conversationSessionId,
}) {
  return useMemo(() => {
    const selectedCharacter = getSelectedCharacter(config)
    const runtimeProvider = String(selectedCharacter?.runtimeProvider || 'gemini-live').trim() || 'gemini-live'
    const realtimeFallbackProvider = String(selectedCharacter?.fallbackRuntimeProvider || '').trim() || ''
    const runtimeState = resolveVoiceRuntimeState(runtimeProvider, runtimeProviderOverride)
    const speechConfig = selectedCharacter?.id === 'batyushka-2'
      ? {
        ...resolveSpeechConfig(),
        profile: 'batyushka-stable',
        bargeInHoldMs: 560,
        minTranscriptLength: 7,
        botVolumeGuard: 0.115,
        immediateOnSpeechStart: false,
      }
      : resolveSpeechConfig()
    const tunedSpeechConfig = buildTunedSpeechConfig(speechConfig, testerSettings)
    const usesLiveInput = Boolean(selectedCharacter?.liveInputEnabled || runtimeState.usesYandexRuntime)
    const usesClientInlinePanel = isClientInlinePanelMode(selectedCharacter?.browserPanelMode)
    const pageContextMode = resolvePageContextMode(selectedCharacter)
    const voiceOptions = getVoiceOptions(config)
    const uiCharacter = resolveUiCharacter(selectedCharacter, settingsOpen, settingsDraft)
    const avatarStageModel = getAvatarStageModel(uiCharacter)
    const runtimeConfig = buildRuntimeConfig({
      character: selectedCharacter,
      runtimeProvider: runtimeState.effectiveRuntimeProvider,
      usesLiveInput,
      sessionContextText: sessionBootstrapText,
      shouldSendGreeting: sessionShouldSendGreeting,
      conversationSessionId,
      testerSettings,
      fallbackRuntimeProvider: realtimeFallbackProvider,
    })
    const currentSignature = buildSignature(selectedCharacter, {
      pauseMs: testerSettings.pauseMs,
      firstReplySentences: testerSettings.firstReplySentences,
      memoryTurnCount: testerSettings.memoryTurnCount,
    })

    return {
      selectedCharacter,
      runtimeProvider,
      realtimeFallbackProvider,
      tunedSpeechConfig,
      usesLiveInput,
      usesClientInlinePanel,
      pageContextMode,
      voiceOptions,
      uiCharacter,
      themeMode: config?.themeMode === 'dark' ? 'dark' : 'light',
      runtimeConfig,
      currentSignature,
      isCompactCharacter: BATYUSHKA_CHARACTER_IDS.has(selectedCharacter?.id || ''),
      ...runtimeState,
      ...avatarStageModel,
    }
  }, [
    config,
    conversationSessionId,
    runtimeProviderOverride,
    sessionBootstrapText,
    sessionShouldSendGreeting,
    settingsDraft,
    settingsOpen,
    testerSettings,
  ])
}
