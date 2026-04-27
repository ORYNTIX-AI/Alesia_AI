import React, { useEffect, useRef, useState } from 'react'
import { DemoShell, LoadingShell } from './components/DemoShell.jsx'
import { SettingsDrawer } from './components/SettingsDrawer.jsx'
import { TesterDrawer } from './components/TesterDrawer.jsx'
import { useAppConfig } from './hooks/useAppConfig'
import { AudioStreamPlayer } from './utils/AudioStreamPlayer'
import { useBrowserRuntimeController } from './features/browser/useBrowserRuntimeController.js'
import { useDemoConfigActions } from './features/config/useDemoConfigActions.js'
import { loadTesterSettings, normalizeTesterSettings } from './features/tester/testerSettingsModel.js'
import { useConversationRuntimeController } from './features/session/useConversationRuntimeController.js'
import { useDemoSessionController } from './features/session/useDemoSessionController.js'
const AVATAR_QUICK_TAP_COUNT = 4, AVATAR_QUICK_TAP_WINDOW_MS = 900
function App() {
  const [audioPlayer] = useState(() => new AudioStreamPlayer())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState(null)
  const [testerOpen, setTesterOpen] = useState(false)
  const [testerSettings, setTesterSettings] = useState(() => loadTesterSettings())
  const [conversationSessionId, setConversationSessionId] = useState('')
  const [sessionBootstrapText, setSessionBootstrapText] = useState('')
  const [sessionShouldSendGreeting, setSessionShouldSendGreeting] = useState(true)
  const [appliedSessionSignature, setAppliedSessionSignature] = useState(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [runtimeProviderOverride, setRuntimeProviderOverride] = useState('')
  const {
    config,
    loading,
    error: configError,
    saving,
    persistConfig,
  } = useAppConfig()
  const avatarQuickTapTimestampsRef = useRef([])
  const activeDialogRequestRef = useRef(0)
  const recentTurnsForIntentRef = useRef([])
  const appendSessionWebHistoryRef = useRef(null)
  const cancelAssistantOutputRef = useRef(null)
  const clearAssistantPromptQueueBridgeRef = useRef(null)
  const enqueueAssistantPromptBridgeRef = useRef(null)
  const finalizeDialogRequestBridgeRef = useRef(null)
  const getSessionHistoryPayloadRef = useRef(null)
  const getSessionHistorySummaryRef = useRef(null)
  const markDialogRequestStateBridgeRef = useRef(null)
  const recordConversationActionRef = useRef(null)

  const sessionController = useDemoSessionController({
    config,
    settingsOpen,
    settingsDraft,
    runtimeProviderOverride,
    testerSettings,
    sessionBootstrapText,
    sessionShouldSendGreeting,
    conversationSessionId,
  })
  const {
    activeBackground,
    avatarModelUrl,
    avatarInstanceId,
    avatarFrame,
    avatarRenderKey,
    currentSignature,
    effectiveRuntimeProvider,
    isCompactCharacter,
    pageContextMode,
    realtimeFallbackProvider,
    runtimeConfig,
    runtimeProvider,
    selectedCharacter,
    themeMode,
    tunedSpeechConfig,
    uiCharacter,
    usesClientInlinePanel,
    usesLiveInput,
    usesYandexLegacyRuntime,
    usesYandexRealtimeRuntime,
    usesYandexRuntime,
    voiceOptions,
  } = sessionController

  const browserController = useBrowserRuntimeController({
    activeDialogRequestRef,
    conversationSessionId,
    pageContextMode,
    recentTurnsForIntentRef,
    selectedCharacter,
    sessionApiRefs: {
      appendSessionWebHistoryRef,
      cancelAssistantOutputRef,
      clearAssistantPromptQueueRef: clearAssistantPromptQueueBridgeRef,
      enqueueAssistantPromptRef: enqueueAssistantPromptBridgeRef,
      finalizeDialogRequestRef: finalizeDialogRequestBridgeRef,
      getSessionHistoryPayloadRef,
      getSessionHistorySummaryRef,
      markDialogRequestStateRef: markDialogRequestStateBridgeRef,
      recordConversationActionRef,
    },
    usesClientInlinePanel,
  })

  const runtimeController = useConversationRuntimeController({
    audioPlayer,
    appliedSessionSignature,
    browser: browserController,
    bridgeRefs: {
      appendSessionWebHistoryRef,
      cancelAssistantOutputRef,
      clearAssistantPromptQueueRef: clearAssistantPromptQueueBridgeRef,
      enqueueAssistantPromptRef: enqueueAssistantPromptBridgeRef,
      finalizeDialogRequestRef: finalizeDialogRequestBridgeRef,
      getSessionHistoryPayloadRef,
      getSessionHistorySummaryRef,
      markDialogRequestStateRef: markDialogRequestStateBridgeRef,
      recordConversationActionRef,
    },
    conversationSessionId,
    currentSignature,
    effectiveRuntimeProvider,
    isCompactCharacter,
    pageContextMode,
    realtimeFallbackProvider,
    runtimeConfig,
    runtimeProvider,
    runtimeProviderOverride,
    selectedCharacter,
    sessionShouldSendGreeting,
    setAppliedSessionSignature,
    setConversationSessionId,
    setRuntimeProviderOverride,
    setSessionBootstrapText,
    setSessionShouldSendGreeting,
    sharedRefs: {
      activeDialogRequestRef,
      recentTurnsForIntentRef,
    },
    testerSettings,
    tunedSpeechConfig,
    usesClientInlinePanel,
    usesLiveInput,
    usesYandexLegacyRuntime,
    usesYandexRealtimeRuntime,
    usesYandexRuntime,
  })
  const {
    assistantOutputState,
    clearTesterEvents,
    error,
    getLiveUserVolume,
    getServerSttUserVolume,
    handleStart,
    handleStop,
    initialized,
    lastAssistantTurnText,
    lastIssueText,
    lastRecognizedTurn,
    liveInputTranscript,
    reconnectAttempt,
    requestReconnectForSignature,
    status,
    testerEvents,
  } = runtimeController
  const {
    handleCharacterStep,
    handleOpenSettings,
    handleSaveSettings,
    handleThemeToggle,
    saveError,
  } = useDemoConfigActions({
    config,
    persistConfig,
    requestReconnectForSignature,
    selectedCharacter,
    setSettingsDraft,
    setSettingsOpen,
    testerSettings,
    themeMode,
  })
  const sessionNeedsReconnect = status === 'connected' && Boolean(appliedSessionSignature) && appliedSessionSignature !== currentSignature
  const isRecoveringConnection = initialized && reconnectAttempt > 0 && status !== 'connected'

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined
    }

    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }

    syncFullscreenState()
    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  const handleFullscreenToggle = React.useCallback(async () => {
    if (typeof document === 'undefined') {
      return
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      await document.documentElement.requestFullscreen()
    } catch (fullscreenError) {
      console.warn('Fullscreen toggle failed', fullscreenError)
    }
  }, [])

  const handleAvatarStageClick = React.useCallback(() => {
    const now = Date.now()
    const recent = avatarQuickTapTimestampsRef.current.filter((timestamp) => now - timestamp <= AVATAR_QUICK_TAP_WINDOW_MS)
    recent.push(now)
    avatarQuickTapTimestampsRef.current = recent

    if (recent.length < AVATAR_QUICK_TAP_COUNT) {
      return
    }

    avatarQuickTapTimestampsRef.current = []
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  if (loading || !config || !selectedCharacter) {
    return <LoadingShell />
  }

  return (
    <>
      <DemoShell
        activeBackground={activeBackground}
        audioPlayer={audioPlayer}
        avatarFrame={avatarFrame}
        avatarInstanceId={avatarInstanceId}
        avatarModelUrl={avatarModelUrl}
        avatarRenderKey={avatarRenderKey}
        browserPanel={browserController.browserPanel}
        configError={configError}
        error={error}
        getLiveUserVolume={getLiveUserVolume}
        getServerSttUserVolume={getServerSttUserVolume}
        initialized={initialized}
        isFullscreen={isFullscreen}
        isRecoveringConnection={isRecoveringConnection}
        liveInputTranscript={liveInputTranscript}
        onAvatarStageClick={handleAvatarStageClick}
        onBrowserPanelAction={browserController.handleBrowserPanelAction}
        onCharacterStep={handleCharacterStep}
        onFullscreenToggle={handleFullscreenToggle}
        onOpenSettings={handleOpenSettings}
        onStart={handleStart}
        onStop={handleStop}
        onThemeToggle={handleThemeToggle}
        reconnectAttempt={reconnectAttempt}
        saveError={saveError}
        sessionNeedsReconnect={sessionNeedsReconnect}
        status={status}
        themeMode={themeMode}
        uiCharacter={uiCharacter}
        usesLiveInput={usesLiveInput}
      />

      <SettingsDrawer
        isOpen={settingsOpen}
        draft={settingsDraft}
        voiceOptions={voiceOptions}
        onDraftChange={setSettingsDraft}
        onClose={() => setSettingsOpen(false)}
        onSave={() => handleSaveSettings(settingsDraft)}
        saving={saving}
      />
      <TesterDrawer
        isOpen={testerOpen}
        onToggle={() => setTesterOpen((current) => !current)}
        settings={testerSettings}
        onSettingsChange={(nextPatch) => {
          setTesterSettings((current) => normalizeTesterSettings({
            ...current,
            ...nextPatch,
          }))
        }}
        status={{
          connection: status,
          assistantState: assistantOutputState.state,
          bufferedAudioMs: Number(audioPlayer?.getBufferedMs?.() || 0),
          partialTranscript: testerSettings.showPartialTranscript ? liveInputTranscript : '',
          lastUserTurn: lastRecognizedTurn,
          lastAssistantTurn: assistantOutputState.lastText || lastAssistantTurnText,
          lastIssue: testerSettings.showDropReasons ? lastIssueText : '',
        }}
        events={testerEvents}
        onClearEvents={clearTesterEvents}
      />
      <div className="app-footer-version">v0.0.10</div>
    </>
  )
}

export default App
