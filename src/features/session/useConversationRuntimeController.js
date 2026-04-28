import React from 'react';
import { useServerStt } from '../../hooks/useServerStt';
import { useVoiceRuntimeAdapters } from '../voice/useVoiceRuntimeAdapters.js';
import {
  VOICE_CONVERSATION_EVENTS,
  createVoiceConversationState,
  isMeaningfulYandexUserTurn,
  reduceVoiceConversationState,
} from '../voice/voiceConversationStateMachine.js';
import { base64ToFloat32Array } from '../../utils/audioConverter.js';
import { buildClientPanelState } from '../browser/browserPanelModel.js';
import { saveTesterSettings } from '../tester/testerSettingsModel.js';
import { buildRuntimeConfig, isGemini31FlashLiveModel } from './sessionModels.js';
import { useAssistantPromptQueue } from './useAssistantPromptQueue.js';
import { useConversationTelemetry } from './useConversationTelemetry.js';
import {
  SERVER_STT_FRAGMENT_HOLD_MS,
  SERVER_STT_FRAGMENT_MERGE_WINDOW_MS,
  STOP_SPEECH_PATTERN,
  buildConversationSessionId,
  buildExactPrayerReadingPrompt,
  buildGreetingAckPrompt,
  buildPersonaDirectPrompt,
  buildPrayerSourceRequiredPrompt,
  buildRepeatRequestPrompt,
  buildRuntimeTurnPrompt,
  buildSessionBootstrapText,
  canMergeServerTranscriptFragments,
  classifyShortHumanTurn,
  classifyTranscriptIntent,
  getServerFinalHoldDelay,
  isAssistantBrowserNarration,
  isGreetingOnlyTranscript,
  isLikelyAssistantEchoFinal,
  isLikelyUnclearStandaloneTranscript,
  isPersonaDirectQuestion,
  isPrayerRequest,
  jsonRequest,
  looksLikeIncompleteTranscriptFragment,
  mergeServerTranscriptFragments,
  normalizeSpeechText,
  normalizeTranscriptKey,
  parseImplicitBrowserActionRequest,
  resolveExactPrayerReading,
  splitSpeechPlaybackChunks,
  truncatePromptValue,
} from './transcriptFlowModel.js';

const BROWSER_CONTEXT_TIMEOUT_MS = 5000;
const BROWSER_ACTION_TIMEOUT_MS = 12000;
const AUTO_RECONNECT_BASE_DELAY_MS = 1200;
const AUTO_RECONNECT_MAX_DELAY_MS = 10000;
const AUTO_RECONNECT_MAX_ATTEMPTS = 8;
const GOAWAY_RECONNECT_MIN_DELAY_MS = 250;
const GOAWAY_RECONNECT_FALLBACK_DELAY_MS = 1500;
const GOAWAY_RECONNECT_BUFFER_MS = 1500;
const CONNECTING_WATCHDOG_TIMEOUT_MS = 20000;
const RELOAD_WATCHDOG_TIMEOUT_MS = 12000;
const MAX_RECENT_INTENT_TURNS = 10;
const BARGE_IN_MIN_GAP_MS = 1200;
const ASSISTANT_BARGE_IN_WARMUP_MS = 320;
const SILENT_TURN_FALLBACK_SAMPLE_RATE = 48000;
const SILENT_TURN_FALLBACK_FIRST_CHUNK_TIMEOUT_MS = 12000;
const SILENT_TURN_FALLBACK_NEXT_CHUNK_TIMEOUT_MS = 12000;
const SILENT_TURN_FALLBACK_CHUNK_MAX_CHARS = 90;
const USER_FINAL_DEDUP_WINDOW_MS = 4200;
const YANDEX_REALTIME_EXTRA_FINAL_SUPPRESS_MS = 900;
const LIVE_INPUT_FINAL_DEDUP_SOURCES = new Set([
  'gemini-input',
  'yandex-realtime-input',
  'yandex-input',
]);
const LIVE_INPUT_COMMIT_EXTRA_MS = 120;

function parseTimeLeftMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1000 ? value : value * 1000;
  }

  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 1000 ? numeric : numeric * 1000;
  }

  const numeric = Number.parseFloat(text.replace(',', '.'));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (text.endsWith('ms')) {
    return numeric;
  }
  if (text.endsWith('m') || text.includes('min')) {
    return numeric * 60000;
  }
  if (text.endsWith('s') || text.includes('sec')) {
    return numeric * 1000;
  }
  return numeric > 1000 ? numeric : numeric * 1000;
}

export function useConversationRuntimeController({
  audioPlayer,
  appliedSessionSignature,
  browser,
  bridgeRefs,
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
  sharedRefs,
  testerSettings,
  tunedSpeechConfig,
  usesClientInlinePanel,
  usesLiveInput,
  usesYandexLegacyRuntime,
  usesYandexRealtimeRuntime,
  usesYandexRuntime,
}) {
  const [initialized, setInitialized] = React.useState(false);
  const [lastRecognizedTurn, setLastRecognizedTurn] = React.useState('');
  const [assistantOutputState, setAssistantOutputState] = React.useState({
    responseId: '',
    state: 'idle',
    lastText: '',
    audioStarted: false,
  });
  const [liveInputTranscript, setLiveInputTranscript] = React.useState('');
  const [reconnectAttempt, setReconnectAttempt] = React.useState(0);

  const {
    activeBrowserSessionIdRef,
    browserFlowStateRef,
    browserIntentInFlightRef,
    browserPanelRef,
    cancelPendingBrowserWork,
    getRuntimePageContextForTurn,
    handleBrowserTranscriptRef,
    refreshBrowserView,
    resetBrowserRuntimeState,
    setActiveBrowserSessionId,
    setBrowserFlowPhase,
    setBrowserPanel,
  } = browser;

  const {
    appendSessionWebHistoryRef,
    cancelAssistantOutputRef,
    clearAssistantPromptQueueRef,
    enqueueAssistantPromptRef,
    finalizeDialogRequestRef,
    getSessionHistoryPayloadRef,
    getSessionHistorySummaryRef,
    markDialogRequestStateRef,
    recordConversationActionRef,
  } = bridgeRefs;
  const {
    activeDialogRequestRef,
    recentTurnsForIntentRef,
  } = sharedRefs;

  const conversationSessionIdRef = React.useRef('');
  const pendingReconnectSignatureRef = React.useRef(null);
  const reconnectTimerRef = React.useRef(null);
  const goAwayReconnectTimerRef = React.useRef(null);
  const reconnectAttemptRef = React.useRef(0);
  const reloadWatchdogTimerRef = React.useRef(null);
  const manualStopRef = React.useRef(false);
  const lastLiveFinalRef = React.useRef({ key: '', timestamp: 0, requestId: 0, source: '' });
  const normalTurnInFlightRef = React.useRef(false);
  const pendingOrchestratedTurnRef = React.useRef(null);
  const assistantTurnCountRef = React.useRef(0);
  const silentAssistantFallbackRef = React.useRef(new Set());
  const handleOrchestratedTurnRef = React.useRef(null);
  const bargeInCandidateRef = React.useRef({ startedAt: 0, textKey: '' });
  const lastBargeInAtRef = React.useRef(0);
  const assistantTurnStartedAtRef = React.useRef(0);
  const preferServerSttRef = React.useRef(false);
  const lastAssistantTurnRef = React.useRef({ text: '', timestamp: 0 });
  const sessionGreetingQueuedRef = React.useRef(false);
  const pendingServerFinalRef = React.useRef({ text: '', timerId: null, capturedAt: 0 });
  const pendingLiveFinalRef = React.useRef({ text: '', timerId: null, capturedAt: 0 });
  const pendingYandexRealtimeFinalRef = React.useRef({ text: '', timerId: null, capturedAt: 0 });
  const activeVoiceStatusRef = React.useRef('disconnected');
  const activeVoiceDisconnectRef = React.useRef(() => {});
  const voiceConversationStateRef = React.useRef(createVoiceConversationState());

  const {
    appendSessionWebHistory,
    clearTesterEvents,
    dialogRequestStatesRef,
    finalizeDialogRequest,
    getSessionHistoryPayload,
    getSessionHistorySummary,
    lastIssueText,
    markDialogRequestState,
    recordConversationAction,
    resetConversationTelemetry,
    setLastIssueText,
    testerEvents,
  } = useConversationTelemetry({
    conversationSessionIdRef,
    recordConversationActionRef,
    selectedCharacterId: selectedCharacter?.id,
    showDropReasons: testerSettings.showDropReasons,
  });

  const {
    assistantAwaitingResponseRef,
    assistantInFlightRequestIdRef,
    assistantPromptInFlightRef,
    assistantPromptMetaRef,
    assistantPromptQueueRef,
    clearAssistantPromptQueue,
    drainAssistantPromptQueue,
    enqueueAssistantPrompt,
    releaseAssistantPromptLock,
    resetAssistantPromptQueue,
    setSendTextTurn,
  } = useAssistantPromptQueue({
    activeDialogRequestRef,
    assistantTurnStartedAtRef,
    initialized,
    manualStopRef,
    recordConversationAction,
  });

  const transitionVoiceConversationState = React.useCallback((event, details = {}) => {
    if (!usesYandexRealtimeRuntime) {
      return voiceConversationStateRef.current;
    }
    const previous = voiceConversationStateRef.current;
    const next = reduceVoiceConversationState(previous, event, details);
    voiceConversationStateRef.current = next;
    if (next !== previous) {
      recordConversationAction('voice.agent.state', {
        conversationSessionId: conversationSessionIdRef.current || '',
        from: previous?.state || '',
        to: next.state,
        event,
        reason: details.reason || '',
        requestId: details.requestId || activeDialogRequestRef.current || 0,
        toolName: details.toolName || '',
      });
    }
    return next;
  }, [activeDialogRequestRef, recordConversationAction, usesYandexRealtimeRuntime]);

  React.useEffect(() => {
    saveTesterSettings(testerSettings);
  }, [testerSettings]);

  React.useEffect(() => {
    appendSessionWebHistoryRef.current = appendSessionWebHistory;
    clearAssistantPromptQueueRef.current = clearAssistantPromptQueue;
    enqueueAssistantPromptRef.current = enqueueAssistantPrompt;
    finalizeDialogRequestRef.current = finalizeDialogRequest;
    getSessionHistoryPayloadRef.current = getSessionHistoryPayload;
    getSessionHistorySummaryRef.current = getSessionHistorySummary;
    markDialogRequestStateRef.current = markDialogRequestState;
  }, [
    appendSessionWebHistory,
    appendSessionWebHistoryRef,
    clearAssistantPromptQueue,
    clearAssistantPromptQueueRef,
    enqueueAssistantPrompt,
    enqueueAssistantPromptRef,
    finalizeDialogRequest,
    finalizeDialogRequestRef,
    getSessionHistoryPayload,
    getSessionHistoryPayloadRef,
    getSessionHistorySummary,
    getSessionHistorySummaryRef,
    markDialogRequestState,
    markDialogRequestStateRef,
  ]);

  const beginUserRequest = React.useCallback((source = 'stt-final') => {
    const previousRequestId = activeDialogRequestRef.current;
    if (previousRequestId > 0) {
      finalizeDialogRequest(previousRequestId, 'superseded', { source });
    }
    const nextRequestId = activeDialogRequestRef.current + 1;
    activeDialogRequestRef.current = nextRequestId;
    pendingOrchestratedTurnRef.current = null;
    const shouldKeepPendingBrowserWork = usesYandexRealtimeRuntime
      && (source === 'yandex-realtime-native-audio' || source === 'yandex-realtime-browser-audio')
      && (
        browserIntentInFlightRef.current
        || browserFlowStateRef.current === 'intent_pending'
        || browserFlowStateRef.current === 'opening'
      );
    if (!shouldKeepPendingBrowserWork) {
      cancelPendingBrowserWork(`superseded:${source}`);
      clearAssistantPromptQueue(`new-user-request:${source}`);
    } else {
      recordConversationAction('browser.work.preserved', {
        requestId: nextRequestId,
        previousRequestId,
        source,
        browserFlowState: browserFlowStateRef.current,
        browserIntentInFlight: Boolean(browserIntentInFlightRef.current),
      });
    }
    cancelAssistantOutputRef.current?.();
    recordConversationAction('runtime.request.activate', {
      requestId: nextRequestId,
      source,
    });
    markDialogRequestState(nextRequestId, 'active', { source });
    return nextRequestId;
  }, [activeDialogRequestRef, browserFlowStateRef, browserIntentInFlightRef, cancelAssistantOutputRef, cancelPendingBrowserWork, clearAssistantPromptQueue, finalizeDialogRequest, markDialogRequestState, recordConversationAction, usesYandexRealtimeRuntime]);

  const beginAssistantInitiatedRequest = React.useCallback((source = 'assistant-initiated') => {
    const previousRequestId = activeDialogRequestRef.current;
    if (previousRequestId > 0) {
      finalizeDialogRequest(previousRequestId, 'superseded', { source });
    }
    const nextRequestId = activeDialogRequestRef.current + 1;
    activeDialogRequestRef.current = nextRequestId;
    pendingOrchestratedTurnRef.current = null;
    clearAssistantPromptQueue(`assistant-request:${source}`);
    recordConversationAction('runtime.request.activate', {
      requestId: nextRequestId,
      source,
      actor: 'assistant',
    });
    markDialogRequestState(nextRequestId, 'assistant-active', { source });
    return nextRequestId;
  }, [activeDialogRequestRef, clearAssistantPromptQueue, finalizeDialogRequest, markDialogRequestState, recordConversationAction]);

  const triggerBargeIn = React.useCallback((reason = 'speech-overlap') => {
    const now = Date.now();
    if ((now - lastBargeInAtRef.current) < BARGE_IN_MIN_GAP_MS) {
      return false;
    }
    lastBargeInAtRef.current = now;
    cancelPendingBrowserWork(reason);
    clearAssistantPromptQueue(reason);
    cancelAssistantOutputRef.current?.();
    transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.BARGE_IN, { reason });
    if (activeDialogRequestRef.current > 0) {
      markDialogRequestState(activeDialogRequestRef.current, 'interrupted', { reason });
    }
    recordConversationActionRef.current?.('assistant.turn.bargein', {
      conversationSessionId: conversationSessionIdRef.current || '',
      reason,
    });
    return true;
  }, [activeDialogRequestRef, cancelAssistantOutputRef, cancelPendingBrowserWork, clearAssistantPromptQueue, markDialogRequestState, recordConversationActionRef, transitionVoiceConversationState]);

  const recordConversationTurn = React.useCallback((role, text, source = 'live') => {
    const sessionId = conversationSessionIdRef.current;
    const normalizedText = normalizeSpeechText(text);
    const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
    if (normalizedText) {
      recentTurnsForIntentRef.current = [
        ...recentTurnsForIntentRef.current,
        {
          role: normalizedRole,
          text: truncatePromptValue(normalizedText, 260),
          source: normalizeSpeechText(source || 'live') || 'live',
        },
      ].slice(-MAX_RECENT_INTENT_TURNS);
    }
    if (!sessionId || !normalizedText) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: normalizedRole,
        text: normalizedText,
        source,
        characterId: selectedCharacter?.id || '',
      }),
    }).catch(() => {});
  }, [recentTurnsForIntentRef, selectedCharacter?.id]);

  const updateConversationSessionState = React.useCallback((nextState = {}) => {
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...nextState,
        characterId: selectedCharacter?.id || '',
      }),
    }).catch(() => {});
  }, [selectedCharacter?.id]);

  const clearPendingServerFinal = React.useCallback(() => {
    const timerId = pendingServerFinalRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingServerFinalRef.current = {
      text: '',
      timerId: null,
      capturedAt: 0,
    };
  }, []);

  const clearPendingLiveFinal = React.useCallback(() => {
    const timerId = pendingLiveFinalRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingLiveFinalRef.current = {
      text: '',
      timerId: null,
      capturedAt: 0,
    };
  }, []);

  const clearPendingYandexRealtimeFinal = React.useCallback(() => {
    const timerId = pendingYandexRealtimeFinalRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingYandexRealtimeFinalRef.current = {
      text: '',
      timerId: null,
      capturedAt: 0,
    };
  }, []);

  const resetSessionRuntimeState = React.useCallback(() => {
    resetConversationTelemetry();
    normalTurnInFlightRef.current = false;
    pendingOrchestratedTurnRef.current = null;
    activeDialogRequestRef.current = 0;
    lastLiveFinalRef.current = { key: '', timestamp: 0, requestId: 0, source: '' };
    lastAssistantTurnRef.current = { text: '', timestamp: 0 };
    voiceConversationStateRef.current = createVoiceConversationState();
    assistantTurnCountRef.current = 0;
    sessionGreetingQueuedRef.current = false;
    resetAssistantPromptQueue();
    silentAssistantFallbackRef.current = new Set();
    recentTurnsForIntentRef.current = [];
    bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
    lastBargeInAtRef.current = 0;
    setAssistantOutputState({
      responseId: '',
      state: 'idle',
      lastText: '',
      audioStarted: false,
    });
    setLastRecognizedTurn('');
    setLastIssueText('');
    clearPendingServerFinal();
    clearPendingLiveFinal();
    clearPendingYandexRealtimeFinal();
    resetBrowserRuntimeState();
    setSessionBootstrapText('');
    setSessionShouldSendGreeting(true);
  }, [
    activeDialogRequestRef,
    clearPendingLiveFinal,
    clearPendingYandexRealtimeFinal,
    clearPendingServerFinal,
    recentTurnsForIntentRef,
    resetAssistantPromptQueue,
    resetBrowserRuntimeState,
    resetConversationTelemetry,
    setLastIssueText,
    setSessionBootstrapText,
    setSessionShouldSendGreeting,
  ]);

  const commitRecognizedUserTranscript = React.useCallback((transcript, {
    source = 'server-stt',
    requestSource = 'server-stt-final',
    sttSessionPrefix = 'server-stt',
    turnSource = 'server-stt',
  } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return false;
    }

    const botVolume = audioPlayer?.getVolume?.() || 0;
    const botBufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
    const lastAssistantTs = Number(lastAssistantTurnRef.current?.timestamp || 0);
    const timeSinceAssistantMs = lastAssistantTs > 0 ? Date.now() - lastAssistantTs : Number.POSITIVE_INFINITY;
    const shortTurnType = classifyShortHumanTurn(normalized);
    const recentAssistantSpeech = usesYandexRuntime && (botBufferedMs > 0 || timeSinceAssistantMs < 400);

    if (recentAssistantSpeech && shortTurnType === 'backchannel') {
      recordConversationAction('stt.stream.backchannel', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        textLength: normalized.length,
      });
      return false;
    }

    if (isLikelyAssistantEchoFinal(normalized, lastAssistantTurnRef.current, botVolume, tunedSpeechConfig)) {
      recordConversationAction('stt.stream.echo-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        textLength: normalized.length,
        reason: recentAssistantSpeech ? 'assistant-overlap' : 'assistant-echo',
      });
      return false;
    }

    const transcriptKey = normalizeTranscriptKey(normalized);
    const now = Date.now();
    const previousLiveFinal = lastLiveFinalRef.current;
    const previousRequestState = previousLiveFinal.requestId > 0
      ? dialogRequestStatesRef.current.get(previousLiveFinal.requestId)
      : null;
    const duplicateLiveFinalInFlight = LIVE_INPUT_FINAL_DEDUP_SOURCES.has(source)
      && transcriptKey
      && previousLiveFinal.key === transcriptKey
      && previousLiveFinal.source === source
      && previousLiveFinal.requestId > 0
      && !previousRequestState?.finalized;

    if (duplicateLiveFinalInFlight) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        reason: 'duplicate-live-final-in-flight',
        textLength: normalized.length,
      });
      return false;
    }

    if (
      transcriptKey
      && previousLiveFinal.key === transcriptKey
      && (now - previousLiveFinal.timestamp) < USER_FINAL_DEDUP_WINDOW_MS
    ) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        reason: 'dedupe-window',
        textLength: normalized.length,
      });
      return false;
    }
    if (botVolume > tunedSpeechConfig.botVolumeGuard && shortTurnType !== 'backchannel') {
      triggerBargeIn(`bargein-final-${source}`);
    }

    const requestId = beginUserRequest(requestSource);
    transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.INPUT_FINAL_COMMIT, {
      reason: source,
      requestId,
    });
    setLastRecognizedTurn(normalized);
    setLastIssueText('');
    lastLiveFinalRef.current = {
      key: transcriptKey,
      timestamp: now,
      requestId,
      source,
    };
    updateConversationSessionState({
      lastFinalTranscriptHash: transcriptKey,
      activeSttSessionId: conversationSessionIdRef.current
        ? `${sttSessionPrefix}:${conversationSessionIdRef.current}`
        : '',
    });
    recordConversationAction('stt.stream.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source,
      textLength: normalized.length,
    });
    recordConversationAction('user.turn.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source,
      textLength: normalized.length,
    });
    recordConversationTurn('user', normalized, turnSource);

    const hasActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current)
      || Boolean(usesClientInlinePanel && browserPanelRef.current?.clientUrl);
    const intentType = classifyTranscriptIntent(normalized, { hasActiveBrowserSession });
    const implicitBrowserAction = Boolean(activeBrowserSessionIdRef.current)
      && Boolean(parseImplicitBrowserActionRequest(normalized));
    if (
      !usesYandexRealtimeRuntime
      && (intentType === 'browser_action' || intentType === 'page_query' || intentType === 'site_open' || implicitBrowserAction)
    ) {
      handleBrowserTranscriptRef.current?.(normalized, { requestId });
      return true;
    }

    handleOrchestratedTurnRef.current?.(normalized, { requestId });
    return true;
  }, [
    activeBrowserSessionIdRef,
    audioPlayer,
    beginUserRequest,
    browserPanelRef,
    dialogRequestStatesRef,
    handleBrowserTranscriptRef,
    recordConversationAction,
    recordConversationTurn,
    setLastIssueText,
    tunedSpeechConfig,
    triggerBargeIn,
    transitionVoiceConversationState,
    updateConversationSessionState,
    usesClientInlinePanel,
    usesYandexRealtimeRuntime,
    usesYandexRuntime,
  ]);

  const commitNativeYandexRealtimeUserTranscript = React.useCallback((transcript) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return false;
    }

    const botVolume = audioPlayer?.getVolume?.() || 0;
    const botBufferedMs = Number(audioPlayer?.getBufferedMs?.() || 0);
    const lastAssistantTs = Number(lastAssistantTurnRef.current?.timestamp || 0);
    const timeSinceAssistantMs = lastAssistantTs > 0 ? Date.now() - lastAssistantTs : Number.POSITIVE_INFINITY;
    const shortTurnType = classifyShortHumanTurn(normalized);
    const recentAssistantSpeech = botBufferedMs > 0 || timeSinceAssistantMs < 400;

    if (recentAssistantSpeech && shortTurnType === 'backchannel') {
      recordConversationAction('stt.stream.backchannel', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source: 'yandex-realtime-input',
        textLength: normalized.length,
      });
      return false;
    }

    if (isLikelyAssistantEchoFinal(normalized, lastAssistantTurnRef.current, botVolume, tunedSpeechConfig)) {
      recordConversationAction('stt.stream.echo-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source: 'yandex-realtime-input',
        textLength: normalized.length,
        reason: recentAssistantSpeech ? 'assistant-overlap' : 'assistant-echo',
      });
      return false;
    }

    const transcriptKey = normalizeTranscriptKey(normalized);
    const now = Date.now();
    const previousLiveFinal = lastLiveFinalRef.current;
    if (
      transcriptKey
      && previousLiveFinal.key === transcriptKey
      && previousLiveFinal.source === 'yandex-realtime-input'
      && (now - previousLiveFinal.timestamp) < USER_FINAL_DEDUP_WINDOW_MS
    ) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source: 'yandex-realtime-input',
        reason: 'dedupe-window',
        textLength: normalized.length,
      });
      return false;
    }

    if (botVolume > tunedSpeechConfig.botVolumeGuard && shortTurnType !== 'backchannel') {
      triggerBargeIn('bargein-final-yandex-realtime-input');
    }

    const hasActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current)
      || Boolean(usesClientInlinePanel && browserPanelRef.current?.clientUrl);
    const intentType = classifyTranscriptIntent(normalized, { hasActiveBrowserSession });
    const implicitBrowserAction = Boolean(activeBrowserSessionIdRef.current)
      && Boolean(parseImplicitBrowserActionRequest(normalized));
    const shouldRouteToBrowser = intentType === 'site_open'
      || (hasActiveBrowserSession && (intentType === 'browser_action' || intentType === 'page_query' || implicitBrowserAction));
    const canRouteToBrowserRuntime = shouldRouteToBrowser && Boolean(handleBrowserTranscriptRef.current);

    const requestId = beginUserRequest(
      canRouteToBrowserRuntime ? 'yandex-realtime-browser-audio' : 'yandex-realtime-native-audio',
    );
    if (!canRouteToBrowserRuntime) {
      assistantPromptInFlightRef.current = true;
      assistantInFlightRequestIdRef.current = requestId;
      assistantAwaitingResponseRef.current = true;
      assistantPromptMetaRef.current = {
        source: 'yandex-realtime-native-audio',
        finalizeRequestOnCommit: true,
      };
    }

    transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.INPUT_FINAL_COMMIT, {
      reason: 'yandex-realtime-native-audio',
      requestId,
    });
    setLastRecognizedTurn(normalized);
    setLastIssueText('');
    lastLiveFinalRef.current = {
      key: transcriptKey,
      timestamp: now,
      requestId,
      source: 'yandex-realtime-input',
    };
    updateConversationSessionState({
      lastFinalTranscriptHash: transcriptKey,
      activeSttSessionId: conversationSessionIdRef.current
        ? `yandex-realtime:${conversationSessionIdRef.current}`
        : '',
    });
    recordConversationAction('stt.stream.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source: 'yandex-realtime-input',
      textLength: normalized.length,
      nativeResponse: true,
      browserRouted: canRouteToBrowserRuntime,
    });
    recordConversationAction('user.turn.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source: 'yandex-realtime-input',
      textLength: normalized.length,
      nativeResponse: true,
      browserRouted: canRouteToBrowserRuntime,
    });
    recordConversationTurn('user', normalized, 'yandex-realtime-transcription');
    if (canRouteToBrowserRuntime) {
      transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.TOOL_CALL, {
        reason: 'browser-runtime',
        requestId,
      });
      markDialogRequestState(requestId, 'browser-routing', {
        source: 'yandex-realtime-browser-audio',
        intentType,
      });
      handleBrowserTranscriptRef.current?.(normalized, {
        requestId,
        suppressOpeningAck: false,
      });
      return true;
    }
    markDialogRequestState(requestId, 'awaiting-native-response', {
      source: 'yandex-realtime-native-audio',
    });
    return true;
  }, [
    activeBrowserSessionIdRef,
    assistantAwaitingResponseRef,
    assistantInFlightRequestIdRef,
    assistantPromptInFlightRef,
    assistantPromptMetaRef,
    audioPlayer,
    beginUserRequest,
    browserPanelRef,
    handleBrowserTranscriptRef,
    markDialogRequestState,
    recordConversationAction,
    recordConversationTurn,
    setLastIssueText,
    tunedSpeechConfig,
    transitionVoiceConversationState,
    triggerBargeIn,
    updateConversationSessionState,
    usesClientInlinePanel,
  ]);

  const schedulePendingServerFinal = React.useCallback((delayMs = SERVER_STT_FRAGMENT_HOLD_MS) => {
    const bufferedText = normalizeSpeechText(pendingServerFinalRef.current.text);
    if (!bufferedText) {
      clearPendingServerFinal();
      return;
    }

    if (pendingServerFinalRef.current.timerId) {
      clearTimeout(pendingServerFinalRef.current.timerId);
    }

    pendingServerFinalRef.current.timerId = window.setTimeout(() => {
      const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
      clearPendingServerFinal();
      if (!pendingText) {
        return;
      }
      commitRecognizedUserTranscript(pendingText, {
        source: 'server-stt',
        requestSource: 'server-stt-final',
        sttSessionPrefix: 'server-stt',
        turnSource: 'server-stt',
      });
    }, Math.max(180, delayMs));
  }, [clearPendingServerFinal, commitRecognizedUserTranscript]);

  const flushPendingServerFinal = React.useCallback((mode = 'commit') => {
    const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
    clearPendingServerFinal();
    if (mode !== 'commit' || !pendingText) {
      return false;
    }
    return commitRecognizedUserTranscript(pendingText, {
      source: 'server-stt',
      requestSource: 'server-stt-final',
      sttSessionPrefix: 'server-stt',
      turnSource: 'server-stt',
    });
  }, [clearPendingServerFinal, commitRecognizedUserTranscript]);

  const handleServerFinalTranscript = React.useCallback((transcript) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return;
    }

    const now = Date.now();
    const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
    const pendingCapturedAt = Number(pendingServerFinalRef.current.capturedAt || 0);
    if (pendingText) {
      const withinMergeWindow = pendingCapturedAt > 0
        && (now - pendingCapturedAt) <= SERVER_STT_FRAGMENT_MERGE_WINDOW_MS;
      if (withinMergeWindow && canMergeServerTranscriptFragments(pendingText, normalized)) {
        const mergedText = mergeServerTranscriptFragments(pendingText, normalized);
        pendingServerFinalRef.current.text = mergedText;
        pendingServerFinalRef.current.capturedAt = now;
        recordConversationAction('stt.stream.final.merge', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: mergedText.length,
        });
        schedulePendingServerFinal(
          looksLikeIncompleteTranscriptFragment(mergedText)
            ? getServerFinalHoldDelay(mergedText)
            : 260,
        );
        return;
      }

      flushPendingServerFinal('commit');
    }

    if (looksLikeIncompleteTranscriptFragment(normalized)) {
      pendingServerFinalRef.current = {
        text: normalized,
        timerId: null,
        capturedAt: now,
      };
      recordConversationAction('stt.stream.final.hold', {
        conversationSessionId: conversationSessionIdRef.current || '',
        textLength: normalized.length,
      });
      schedulePendingServerFinal(getServerFinalHoldDelay(normalized));
      return;
    }

    commitRecognizedUserTranscript(normalized, {
      source: 'server-stt',
      requestSource: 'server-stt-final',
      sttSessionPrefix: 'server-stt',
      turnSource: 'server-stt',
    });
  }, [
    commitRecognizedUserTranscript,
    flushPendingServerFinal,
    recordConversationAction,
    schedulePendingServerFinal,
  ]);

  const handleYandexRealtimeFinalTranscript = React.useCallback((transcript) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return;
    }

    const isGreetingOnly = isGreetingOnlyTranscript(normalized);
    if (
      (!isGreetingOnly && !isMeaningfulYandexUserTurn(normalized))
      || (!isGreetingOnly && isLikelyUnclearStandaloneTranscript(normalized))
    ) {
      clearPendingYandexRealtimeFinal();
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source: 'yandex-realtime-input',
        reason: 'low-value-yandex-final',
        textLength: normalized.length,
      });
      transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.INPUT_IGNORED, {
        reason: 'low-value-yandex-final',
      });
      return;
    }

    const now = Date.now();
    const previousFinal = lastLiveFinalRef.current;
    const transcriptKey = normalizeTranscriptKey(normalized);
    if (
      previousFinal?.source === 'yandex-realtime-input'
      && (now - Number(previousFinal.timestamp || 0)) < YANDEX_REALTIME_EXTRA_FINAL_SUPPRESS_MS
      && transcriptKey
      && previousFinal.key === transcriptKey
      && activeDialogRequestRef.current > 0
      && assistantAwaitingResponseRef.current
    ) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source: 'yandex-realtime-input',
        reason: 'extra-final-during-response',
        textLength: normalized.length,
      });
      return;
    }

    clearPendingYandexRealtimeFinal();
    commitNativeYandexRealtimeUserTranscript(normalized);
  }, [
    activeDialogRequestRef,
    assistantAwaitingResponseRef,
    clearPendingYandexRealtimeFinal,
    commitNativeYandexRealtimeUserTranscript,
    recordConversationAction,
    transitionVoiceConversationState,
  ]);

  const handleLiveInputTranscription = React.useCallback((transcript) => {
    const normalized = String(transcript || '').trim();
    const now = Date.now();
    setLiveInputTranscript(normalized);
    if (!normalized) {
      clearPendingLiveFinal();
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      return;
    }

    if (isAssistantBrowserNarration(normalized)) {
      clearPendingLiveFinal();
      return;
    }

    if (usesYandexRealtimeRuntime && isMeaningfulYandexUserTurn(normalized)) {
      transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.INPUT_PARTIAL, {
        reason: 'partial-transcript',
      });
    }

    const botVolume = audioPlayer?.getVolume?.() || 0;
    if (botVolume <= tunedSpeechConfig.botVolumeGuard) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      return;
    }

    if (STOP_SPEECH_PATTERN.test(normalized)) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      triggerBargeIn('bargein-stop-word');
      return;
    }

    if (classifyShortHumanTurn(normalized) === 'backchannel') {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      return;
    }

    if ((now - assistantTurnStartedAtRef.current) < ASSISTANT_BARGE_IN_WARMUP_MS) {
      return;
    }

    if (normalized.length < tunedSpeechConfig.minTranscriptLength) {
      return;
    }

    const textKey = normalizeTranscriptKey(normalized);
    if (bargeInCandidateRef.current.textKey !== textKey) {
      bargeInCandidateRef.current = { startedAt: now, textKey };
      return;
    }

    if ((now - bargeInCandidateRef.current.startedAt) >= tunedSpeechConfig.bargeInHoldMs) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      triggerBargeIn('bargein-input-hold');
    }
  }, [audioPlayer, clearPendingLiveFinal, transitionVoiceConversationState, tunedSpeechConfig, triggerBargeIn, usesYandexRealtimeRuntime]);

  const bootstrapConversationContext = React.useCallback(async (sessionId, { shouldSendGreeting = false } = {}) => {
    const restorePayload = await jsonRequest(
      `/api/conversation/session/${encodeURIComponent(sessionId)}/restore?characterId=${encodeURIComponent(selectedCharacter?.id || '')}`,
      { method: 'GET' },
      10000,
    );
    const restoredCharacterId = String(restorePayload?.restore?.lastCharacterId || '').trim();
    const characterMismatch = Boolean(restoredCharacterId && selectedCharacter?.id && restoredCharacterId !== selectedCharacter.id);
    const effectiveRestorePayload = characterMismatch
      ? { ...restorePayload, restore: null }
      : restorePayload;
    const nextBootstrapText = buildSessionBootstrapText(effectiveRestorePayload, restorePayload?.knowledgeContext || '');
    setSessionBootstrapText(nextBootstrapText);
    setSessionShouldSendGreeting(Boolean(shouldSendGreeting && !effectiveRestorePayload?.restore?.greetingSent));
    assistantTurnCountRef.current = Array.isArray(effectiveRestorePayload?.restore?.recentTurns)
      ? effectiveRestorePayload.restore.recentTurns.filter((turn) => turn?.role === 'assistant' && normalizeSpeechText(turn?.text || '')).length
      : 0;
    lastLiveFinalRef.current = {
      key: normalizeTranscriptKey(effectiveRestorePayload?.restore?.lastFinalTranscriptHash || ''),
      timestamp: 0,
      requestId: 0,
      source: '',
    };
    const restoredBrowserSessionId = String(effectiveRestorePayload?.restore?.browserSessionId || '').trim();
    if (restoredBrowserSessionId) {
      setActiveBrowserSessionId(restoredBrowserSessionId);
      activeBrowserSessionIdRef.current = restoredBrowserSessionId;
      setBrowserPanel((current) => ({
        ...current,
        status: current.status === 'idle' ? 'ready' : current.status,
        title: effectiveRestorePayload?.restore?.browserContext?.title || current.title,
        url: effectiveRestorePayload?.restore?.browserContext?.url || current.url,
      }));
      void jsonRequest(
        `/api/browser/session/${encodeURIComponent(restoredBrowserSessionId)}/view?refresh=1`,
        { method: 'GET' },
        BROWSER_ACTION_TIMEOUT_MS,
      ).then((view) => {
        setBrowserPanel((current) => ({
          ...current,
          status: 'ready',
          title: view.title || current.title,
          url: view.url || current.url,
          screenshotUrl: view.imageUrl || current.screenshotUrl,
          view: {
            imageUrl: view.imageUrl || '',
            width: view.width || 0,
            height: view.height || 0,
            revision: view.revision || 0,
            actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
          },
          revision: view.revision || current.revision || 0,
          actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : current.actionableElements,
        }));
      }).catch((error) => {
        if (/нет активного открытого сайта/i.test(String(error?.message || ''))) {
          activeBrowserSessionIdRef.current = '';
          setActiveBrowserSessionId('');
          setBrowserFlowPhase('error');
          setBrowserPanel((current) => ({
            ...current,
            status: 'error',
            error: 'Связь с открытым сайтом потеряна. Откройте сайт снова.',
          }));
        }
      });
    } else if (pageContextMode === 'url-fetch' && effectiveRestorePayload?.restore?.browserContext?.url) {
      const restoredUrl = String(effectiveRestorePayload.restore.browserContext.url || '').trim();
      const restoredTitle = String(effectiveRestorePayload.restore.browserContext.title || '').trim();
      if (restoredUrl) {
        setBrowserFlowPhase('ready');
        setBrowserPanel((current) => ({
          ...buildClientPanelState({
            url: restoredUrl,
            titleHint: restoredTitle || restoredUrl,
            sourceType: 'restored-site',
          }, current, {
            status: 'ready',
            note: '',
            browserPanelMode: 'client-inline',
          }),
          title: restoredTitle || current.title || restoredUrl,
          url: restoredUrl,
          clientUrl: restoredUrl,
          clientContextStatus: 'loading',
          clientContextError: '',
        }));
        void jsonRequest('/api/browser/url-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: restoredUrl,
            question: 'что сейчас находится на открытой странице',
            requestId: 0,
            conversationSessionId: sessionId,
            characterId: selectedCharacter?.id || '',
          }),
        }, BROWSER_CONTEXT_TIMEOUT_MS + 3000)
          .then((contextResult) => {
            setBrowserPanel((current) => ({
              ...current,
              title: contextResult?.title || current.title,
              url: contextResult?.url || current.url,
              embeddable: contextResult?.embeddable !== false,
              readerText: contextResult?.readerText || current.readerText,
              lastUpdated: contextResult?.lastUpdated || current.lastUpdated,
              clientContextStatus: 'ready',
              clientContextError: '',
              error: null,
            }));
          })
          .catch((contextError) => {
            setBrowserPanel((current) => ({
              ...current,
              clientContextStatus: 'error',
              clientContextError: contextError.message || 'Не удалось быстро прочитать страницу.',
            }));
          });
      }
    }
    return nextBootstrapText;
  }, [activeBrowserSessionIdRef, pageContextMode, selectedCharacter?.id, setActiveBrowserSessionId, setBrowserFlowPhase, setBrowserPanel, setSessionBootstrapText, setSessionShouldSendGreeting]);

  const queryKnowledgeForTurn = React.useCallback(async (question) => {
    const normalizedQuestion = normalizeSpeechText(question);
    if (!normalizedQuestion) {
      return { hits: [] };
    }

    return jsonRequest('/api/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: normalizedQuestion,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
      }),
    }, 10000);
  }, [selectedCharacter?.id]);

  const synthesizeSilentAssistantTurn = React.useCallback(async ({
    text,
    responseId = '',
    requestId = 0,
    source = '',
  } = {}) => {
    const normalizedText = normalizeSpeechText(text);
    const fallbackKey = `${responseId || requestId}:${normalizeTranscriptKey(normalizedText)}`;
    if (!normalizedText || !fallbackKey || silentAssistantFallbackRef.current.has(fallbackKey)) {
      return false;
    }

    silentAssistantFallbackRef.current.add(fallbackKey);
    setAssistantOutputState((current) => ({
      ...current,
      responseId: responseId || current.responseId || '',
      state: 'восстанавливаю звук',
      lastText: normalizedText,
    }));
    recordConversationAction('assistant.turn.silent', {
      conversationSessionId: conversationSessionIdRef.current || '',
      requestId,
      responseId,
      textLength: normalizedText.length,
      source,
    });

    const isStaleFallback = () => (
      manualStopRef.current
      || !conversationSessionIdRef.current
      || (requestId > 0 && requestId !== activeDialogRequestRef.current)
    );

    const shouldUseGeminiTts = String(selectedCharacter?.id || '').trim() === 'batyushka-2'
      && String(selectedCharacter?.runtimeProvider || '').trim() === 'gemini-live'
      && String(selectedCharacter?.ttsModelId || '').trim();
    const requestTtsChunk = async (chunkText, timeoutMs) => {
      if (shouldUseGeminiTts) {
        return jsonRequest('/api/gemini/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: chunkText,
            modelId: selectedCharacter?.ttsModelId,
            voiceName: selectedCharacter?.ttsVoiceName || selectedCharacter?.voiceName || 'Schedar',
            stylePrompt: 'Read naturally in Russian with a calm, warm, human voice. Keep the pace conversational and use natural short pauses.',
          }),
        }, timeoutMs);
      }

      return jsonRequest('/api/yandex/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: chunkText,
          voiceName: selectedCharacter?.ttsVoiceName || selectedCharacter?.voiceName || 'ermil',
          sampleRateHertz: SILENT_TURN_FALLBACK_SAMPLE_RATE,
        }),
      }, timeoutMs);
    };

    try {
      const chunks = splitSpeechPlaybackChunks(normalizedText, SILENT_TURN_FALLBACK_CHUNK_MAX_CHARS);
      let hasPlayableAudio = false;
      let finalizedAnswered = false;

      for (let index = 0; index < chunks.length; index += 1) {
        if (isStaleFallback()) {
          return false;
        }

        const chunkText = chunks[index];
        const timeoutMs = index === 0
          ? SILENT_TURN_FALLBACK_FIRST_CHUNK_TIMEOUT_MS
          : SILENT_TURN_FALLBACK_NEXT_CHUNK_TIMEOUT_MS;
        let payload = null;
        let lastChunkError = null;
        const maxAttempts = index === 0 ? 2 : 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            payload = await requestTtsChunk(chunkText, timeoutMs);
            if (!String(payload?.audioBase64 || '').trim()) {
              throw new Error('empty-audio');
            }
            lastChunkError = null;
            break;
          } catch (error) {
            lastChunkError = error;
          }
        }

        if (!payload) {
          if (hasPlayableAudio) {
            recordConversationAction('assistant.turn.audio-fallback.partial', {
              conversationSessionId: conversationSessionIdRef.current || '',
              requestId,
              responseId,
              chunkIndex: index + 1,
              chunkCount: chunks.length,
              error: lastChunkError?.message || 'partial-fallback-failed',
            });
            return true;
          }
          throw lastChunkError || new Error('silent-turn-repair-failed');
        }

        if (isStaleFallback()) {
          return false;
        }

        const pcm = base64ToFloat32Array(String(payload?.audioBase64 || ''));
        const sampleRateHertz = Math.max(
          8000,
          Number(payload?.sampleRateHertz || SILENT_TURN_FALLBACK_SAMPLE_RATE) || SILENT_TURN_FALLBACK_SAMPLE_RATE,
        );
        if (!pcm.length) {
          if (hasPlayableAudio) {
            recordConversationAction('assistant.turn.audio-fallback.partial', {
              conversationSessionId: conversationSessionIdRef.current || '',
              requestId,
              responseId,
              chunkIndex: index + 1,
              chunkCount: chunks.length,
              error: 'empty-audio',
            });
            return true;
          }
          throw new Error('empty-audio');
        }

        const playbackResult = audioPlayer.addChunk?.(pcm, sampleRateHertz);
        if (playbackResult?.ok === false) {
          throw new Error(playbackResult.reason || 'audio-playback-rejected');
        }
        if (hasPlayableAudio) {
          continue;
        }

        hasPlayableAudio = true;
        setAssistantOutputState({
          responseId,
          state: 'говорит',
          lastText: normalizedText,
          audioStarted: true,
        });
        recordConversationAction('assistant.turn.audio-fallback.ok', {
          conversationSessionId: conversationSessionIdRef.current || '',
          requestId,
          responseId,
          sampleRateHertz,
          chunkCount: chunks.length,
        });
        recordConversationAction('assistant.turn.audio-start', {
          conversationSessionId: conversationSessionIdRef.current || '',
          requestId,
          responseId,
          fallback: true,
        });
        recordConversationAction('assistant.turn.lips-started', {
          conversationSessionId: conversationSessionIdRef.current || '',
          requestId,
          responseId,
          fallback: true,
        });

        assistantTurnCountRef.current += 1;
        lastAssistantTurnRef.current = {
          text: normalizedText,
          timestamp: Date.now(),
        };
        if (assistantTurnCountRef.current === 1 && sessionShouldSendGreeting) {
          updateConversationSessionState({ greetingSent: true });
          setSessionShouldSendGreeting(false);
        }
        recordConversationTurn(
          'assistant',
          normalizedText,
          shouldUseGeminiTts
            ? 'gemini-3.1-tts-audio-fallback'
            : (usesYandexRealtimeRuntime ? 'yandex-realtime-audio-fallback' : 'yandex-legacy-audio-fallback'),
        );
        if (requestId > 0 && !finalizedAnswered) {
          finalizedAnswered = true;
          finalizeDialogRequest(requestId, 'answered', {
            textLength: normalizedText.length,
            repairedAudio: true,
          });
        }
      }

      return hasPlayableAudio;
    } catch (error) {
      const message = error?.message || 'silent-turn-repair-failed';
      setAssistantOutputState((current) => ({
        ...current,
        responseId: responseId || current.responseId || '',
        state: 'ошибка звука',
        lastText: normalizedText,
      }));
      setLastIssueText(message);
      recordConversationAction('assistant.turn.audio-fallback.error', {
        conversationSessionId: conversationSessionIdRef.current || '',
        requestId,
        responseId,
        error: message,
      });
      if (requestId > 0) {
        finalizeDialogRequest(requestId, 'answer-audio-missed', {
          textLength: normalizedText.length,
        });
      }
      return false;
    }

  }, [
    activeDialogRequestRef,
    audioPlayer,
    finalizeDialogRequest,
    recordConversationAction,
    recordConversationTurn,
    selectedCharacter?.id,
    selectedCharacter?.runtimeProvider,
    selectedCharacter?.ttsModelId,
    selectedCharacter?.ttsVoiceName,
    selectedCharacter?.voiceName,
    sessionShouldSendGreeting,
    setLastIssueText,
    setSessionShouldSendGreeting,
    updateConversationSessionState,
    usesYandexRealtimeRuntime,
  ]);

  const voiceSessionCallbacks = {
      onSessionReady: ({ resumed = false, shouldSendGreeting = false }) => {
        const shouldAutoGreet = shouldSendGreeting;
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.SESSION_READY, {
          reason: resumed ? 'resumed' : 'ready',
        });
        recordConversationAction('model.session.ready', {
          conversationSessionId: conversationSessionIdRef.current || '',
          resumed,
          shouldSendGreeting,
        });
        if (resumed || !shouldAutoGreet || sessionGreetingQueuedRef.current) {
          return;
        }
        const greetingRequestId = beginAssistantInitiatedRequest('session-greeting');
        sessionGreetingQueuedRef.current = true;
        enqueueAssistantPrompt(selectedCharacter?.greetingText || 'Поздоровайся коротко с пользователем.', {
          interrupt: false,
          priority: 'high',
          source: 'session.greeting',
          dedupeKey: `session-greeting:${selectedCharacter?.id || 'default'}`,
          requestId: greetingRequestId,
        });
      },
      onInputTranscription: (text) => {
        if (preferServerSttRef.current) {
          return;
        }
        handleLiveInputTranscription(text);
      },
      onInputTranscriptionCommit: ({ text }) => {
        if (runtimeConfig?.captureUserAudio === false) {
          return;
        }
        if (preferServerSttRef.current) {
          return;
        }
        if (usesYandexRealtimeRuntime) {
          handleYandexRealtimeFinalTranscript(text);
          return;
        }
        clearPendingLiveFinal();
        commitRecognizedUserTranscript(text, {
          source: usesYandexRealtimeRuntime
            ? 'yandex-realtime-input'
            : (usesYandexLegacyRuntime ? 'yandex-input' : 'gemini-input'),
          requestSource: usesYandexRealtimeRuntime
            ? 'yandex-realtime-input-final'
            : (usesYandexLegacyRuntime ? 'yandex-input-final' : 'gemini-input-final'),
          sttSessionPrefix: usesYandexRealtimeRuntime
            ? 'yandex-realtime'
            : (usesYandexLegacyRuntime ? 'yandex-local-vad' : 'gemini-live-input'),
          turnSource: usesYandexRealtimeRuntime
            ? 'yandex-realtime-transcription'
            : (usesYandexLegacyRuntime ? 'yandex-input-transcription' : 'gemini-input-transcription'),
        });
      },
      onAssistantTurnStart: ({ responseId = '' } = {}) => {
        const hasInFlightRequest = assistantPromptInFlightRef.current || assistantInFlightRequestIdRef.current > 0;
        if (!assistantAwaitingResponseRef.current && hasInFlightRequest) {
          assistantAwaitingResponseRef.current = true;
          recordConversationAction('assistant.turn.recover', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'late-start-after-state-race',
            requestId: assistantInFlightRequestIdRef.current || activeDialogRequestRef.current || 0,
            responseId,
          });
        }
        if (!assistantAwaitingResponseRef.current) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: browserIntentInFlightRef.current ? 'browser-runtime-native-response-suppressed' : 'unexpected-start',
            browserIntentInFlight: browserIntentInFlightRef.current,
            browserFlowState: browserFlowStateRef.current,
            responseId,
          });
          return false;
        }
        assistantTurnStartedAtRef.current = Date.now();
        assistantPromptInFlightRef.current = true;
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_START, {
          reason: 'turn-start',
          responseId,
        });
        setAssistantOutputState({
          responseId,
          state: 'готовит ответ',
          lastText: '',
          audioStarted: false,
        });
        recordConversationAction('assistant.turn.start', {
          conversationSessionId: conversationSessionIdRef.current || '',
          responseId,
        });
        return true;
      },
      onAssistantAudioStart: ({
        responseId = '',
        sampleRate = 0,
        samples = 0,
        contextState = '',
        queuedMs = 0,
      } = {}) => {
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_AUDIO_START, {
          reason: 'audio-start',
          responseId,
        });
        setAssistantOutputState((current) => ({
          responseId: responseId || current.responseId || '',
          state: 'говорит',
          lastText: current.lastText || '',
          audioStarted: true,
        }));
        recordConversationAction('assistant.turn.audio-start', {
          conversationSessionId: conversationSessionIdRef.current || '',
          responseId,
          sampleRate,
          samples,
          contextState,
          queuedMs,
        });
        recordConversationAction('assistant.turn.lips-started', {
          conversationSessionId: conversationSessionIdRef.current || '',
          responseId,
        });
      },
      onAssistantAudioDrop: ({
        responseId = '',
        reason = 'audio-playback-rejected',
        sampleRate = 0,
        samples = 0,
        contextState = '',
        queuedMs = 0,
      } = {}) => {
        setLastIssueText(reason);
        recordConversationAction('assistant.turn.audio-drop', {
          conversationSessionId: conversationSessionIdRef.current || '',
          responseId,
          reason,
          sampleRate,
          samples,
          contextState,
          queuedMs,
        });
      },
      onAssistantTurnCommit: ({ responseId = '', text, textChunks = 0, audioChunks = 0, durationMs = 0 }) => {
        const inFlightRequestId = assistantInFlightRequestIdRef.current;
        const awaitingResponse = assistantAwaitingResponseRef.current;
        const promptMeta = assistantPromptMetaRef.current;
        assistantTurnStartedAtRef.current = 0;
        releaseAssistantPromptLock('commit');
        if (!awaitingResponse || inFlightRequestId <= 0) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'unexpected-commit',
            textLength: String(text || '').length,
            responseId,
          });
          return;
        }
        if (inFlightRequestId > 0 && inFlightRequestId !== activeDialogRequestRef.current) {
          recordConversationAction('assistant.turn.drop', {
            reason: 'stale-request',
            requestId: inFlightRequestId,
            activeRequestId: activeDialogRequestRef.current,
            textLength: String(text || '').length,
            responseId,
          });
          return;
        }
        const normalizedAssistantText = normalizeSpeechText(text);
        if (!normalizedAssistantText) {
          if (audioChunks > 0) {
            assistantTurnCountRef.current += 1;
            if (assistantTurnCountRef.current === 1 && sessionShouldSendGreeting) {
              updateConversationSessionState({ greetingSent: true });
              setSessionShouldSendGreeting(false);
            }
            setAssistantOutputState({
              responseId,
              state: 'ответ отправлен',
              lastText: '',
              audioStarted: true,
            });
            recordConversationAction('assistant.turn.commit', {
              conversationSessionId: conversationSessionIdRef.current || '',
              textLength: 0,
              textChunks,
              audioChunks,
              durationMs,
              responseId,
              source: promptMeta?.source || '',
              audioOnly: true,
            });
            if (promptMeta?.finalizeRequestOnCommit !== false) {
              finalizeDialogRequest(inFlightRequestId || activeDialogRequestRef.current, 'answered', {
                textLength: 0,
                audioOnly: true,
              });
            }
            transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_DONE, {
              reason: 'audio-only',
              requestId: inFlightRequestId || activeDialogRequestRef.current,
            });
            return;
          }
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'empty-commit',
            textChunks,
            audioChunks,
            responseId,
          });
          transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_CANCELLED, {
            reason: 'empty-commit',
            requestId: inFlightRequestId || activeDialogRequestRef.current,
          });
          return;
        }
        if (usesYandexRuntime && audioChunks <= 0) {
          void synthesizeSilentAssistantTurn({
            text: normalizedAssistantText,
            responseId,
            requestId: inFlightRequestId || activeDialogRequestRef.current,
            source: promptMeta?.source || '',
          });
          return;
        }
        if (normalizedAssistantText) {
          assistantTurnCountRef.current += 1;
          lastAssistantTurnRef.current = {
            text: normalizedAssistantText,
            timestamp: Date.now(),
          };
          if (assistantTurnCountRef.current === 1 && sessionShouldSendGreeting) {
            updateConversationSessionState({ greetingSent: true });
            setSessionShouldSendGreeting(false);
          }
        }
        setAssistantOutputState({
          responseId,
          state: 'ответ отправлен',
          lastText: normalizedAssistantText,
          audioStarted: audioChunks > 0,
        });
        recordConversationAction('assistant.turn.commit', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: String(text || '').length,
          textChunks,
          audioChunks,
          durationMs,
          responseId,
          source: promptMeta?.source || '',
        });
        if (promptMeta?.finalizeRequestOnCommit !== false) {
          finalizeDialogRequest(inFlightRequestId || activeDialogRequestRef.current, 'answered', {
            textLength: normalizedAssistantText.length,
          });
        }
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_DONE, {
          reason: 'commit',
          requestId: inFlightRequestId || activeDialogRequestRef.current,
        });
        recordConversationTurn(
          'assistant',
          text,
          usesYandexRealtimeRuntime ? 'yandex-realtime' : (usesYandexLegacyRuntime ? 'yandex-full-legacy' : 'gemini-live'),
        );
      },
      onAssistantTurnCancel: ({ responseId = '', text, interrupted = false }) => {
        const inFlightRequestId = assistantInFlightRequestIdRef.current;
        const awaitingResponse = assistantAwaitingResponseRef.current;
        assistantTurnStartedAtRef.current = 0;
        releaseAssistantPromptLock('cancel');
        if (!awaitingResponse && !interrupted) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'unexpected-cancel',
            textLength: String(text || '').length,
            responseId,
          });
          return;
        }
        setAssistantOutputState((current) => ({
          responseId: responseId || current.responseId || '',
          state: interrupted ? 'прерван' : 'отменен',
          lastText: normalizeSpeechText(text) || current.lastText || '',
          audioStarted: false,
        }));
        recordConversationAction('assistant.turn.cancel', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: String(text || '').length,
          requestId: inFlightRequestId || 0,
          interrupted,
          responseId,
        });
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.ASSISTANT_CANCELLED, {
          reason: interrupted ? 'interrupted' : 'cancel',
          requestId: inFlightRequestId || activeDialogRequestRef.current,
        });
      },
      onAssistantInterrupted: () => {
        setAssistantOutputState((current) => ({
          ...current,
          state: 'прерван',
          audioStarted: false,
        }));
        recordConversationAction('assistant.turn.interrupted', {
          conversationSessionId: conversationSessionIdRef.current || '',
        });
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.BARGE_IN, {
          reason: 'assistant-interrupted',
        });
      },
      onToolCall: (toolEvent) => {
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.TOOL_CALL, {
          reason: 'tool-call',
          toolName: toolEvent?.name || '',
          requestId: activeDialogRequestRef.current || 0,
        });
        recordConversationAction('runtime.tool.call', {
          conversationSessionId: conversationSessionIdRef.current || '',
          toolName: toolEvent?.name || '',
          callId: toolEvent?.callId || '',
        });
        if (toolEvent?.name === 'open_site') {
          setBrowserFlowPhase('opening');
        setBrowserPanel((current) => ({
          ...current,
          status: 'loading',
          browserPanelMode: 'remote',
          title: current.title || 'Открываю сайт',
          error: null,
          sourceType: 'tool-open-site',
          note: 'Сайт загружается.',
        }));
      }
      },
      onToolResult: (toolEvent) => {
        const result = toolEvent?.result || {};
        const browserSessionId = String(result?.browserSessionId || '').trim();
        transitionVoiceConversationState(
          result?.ok === false ? VOICE_CONVERSATION_EVENTS.ERROR : VOICE_CONVERSATION_EVENTS.TOOL_RESULT,
          {
            reason: result?.ok === false ? 'tool-error' : 'tool-result',
            toolName: toolEvent?.name || '',
            requestId: activeDialogRequestRef.current || 0,
          },
        );
        recordConversationAction('runtime.tool.result', {
          conversationSessionId: conversationSessionIdRef.current || '',
          toolName: toolEvent?.name || '',
          callId: toolEvent?.callId || '',
          ok: result?.ok !== false,
          browserSessionId,
        });
        if (!browserSessionId) {
          return;
        }

        setBrowserFlowPhase('ready');
        setActiveBrowserSessionId(browserSessionId);
        activeBrowserSessionIdRef.current = browserSessionId;
        setBrowserPanel((current) => ({
          ...current,
          status: 'ready',
          browserPanelMode: 'remote',
          title: result?.title || current.title,
          url: result?.url || current.url,
          error: null,
          screenshotUrl: result?.view?.imageUrl || current.screenshotUrl,
          view: result?.view
            ? {
              imageUrl: result.view.imageUrl || '',
              width: result.view.width || 0,
              height: result.view.height || 0,
              revision: result.view.revision || 0,
              actionableElements: Array.isArray(result.view.actionableElements) ? result.view.actionableElements : [],
            }
            : current.view,
          actionableElements: Array.isArray(result?.view?.actionableElements)
            ? result.view.actionableElements
            : current.actionableElements,
        }));
        setTimeout(() => {
          void refreshBrowserView(true).catch(() => {});
        }, 0);
      },
      onSessionGoAway: (goAway) => {
        const timeLeftRaw = goAway?.timeLeft ?? goAway?.time_left ?? '';
        const timeLeftMs = parseTimeLeftMs(timeLeftRaw);
        const nextSignature = currentSignature || appliedSessionSignature || null;
        const reconnectDelayMs = timeLeftMs == null
          ? GOAWAY_RECONNECT_FALLBACK_DELAY_MS
          : Math.max(
            GOAWAY_RECONNECT_MIN_DELAY_MS,
            Math.min(GOAWAY_RECONNECT_FALLBACK_DELAY_MS, timeLeftMs - GOAWAY_RECONNECT_BUFFER_MS),
          );
        recordConversationAction('model.session.goaway', {
          conversationSessionId: conversationSessionIdRef.current || '',
          timeLeft: timeLeftRaw,
          timeLeftMs: timeLeftMs ?? '',
          reconnectDelayMs,
        });
        if (!initialized || manualStopRef.current || activeVoiceStatusRef.current !== 'connected' || !nextSignature) {
          return;
        }
        if (pendingReconnectSignatureRef.current) {
          return;
        }
        pendingReconnectSignatureRef.current = nextSignature;
        setSessionShouldSendGreeting(false);
        clearAssistantPromptQueue('session-goaway');
        cancelAssistantOutputRef.current?.();
        clearGoAwayReconnectTimer();
        goAwayReconnectTimerRef.current = setTimeout(() => {
          goAwayReconnectTimerRef.current = null;
          if (manualStopRef.current) {
            pendingReconnectSignatureRef.current = null;
            return;
          }
          activeVoiceDisconnectRef.current?.();
        }, reconnectDelayMs);
      },
  };

  const {
    geminiSession,
    yandexSession,
    yandexRealtimeSession,
    activeSession: activeVoiceSession,
  } = useVoiceRuntimeAdapters({
    audioPlayer,
    runtimeConfig,
    callbacks: voiceSessionCallbacks,
    runtimeProvider,
    runtimeProviderOverride,
    realtimeFallbackProvider,
    selectedCharacterId: selectedCharacter?.id,
    onRealtimeFallback: React.useCallback(({ from, to, reason, characterId }) => {
      transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.RECOVERING, {
        reason,
      });
      recordConversationAction('voice.runtime.fallback', {
        conversationSessionId: conversationSessionIdRef.current,
        from,
        to,
        reason,
        characterId,
      });
      setRuntimeProviderOverride(to);
    }, [recordConversationAction, setRuntimeProviderOverride, transitionVoiceConversationState]),
  });

  React.useEffect(() => {
    setRuntimeProviderOverride('');
  }, [runtimeProvider, selectedCharacter?.id, setRuntimeProviderOverride]);
  const {
    status,
    connect,
    disconnect,
    error,
    getUserVolume: getLiveUserVolume,
    sendTextTurn,
    cancelAssistantOutput,
    clearSessionResumption,
  } = activeVoiceSession;
  activeVoiceStatusRef.current = status;
  activeVoiceDisconnectRef.current = disconnect;

  React.useEffect(() => {
    setSendTextTurn(sendTextTurn);
    drainAssistantPromptQueue();
  }, [drainAssistantPromptQueue, sendTextTurn, setSendTextTurn]);

  React.useEffect(() => {
    cancelAssistantOutputRef.current = cancelAssistantOutput;
  }, [cancelAssistantOutput, cancelAssistantOutputRef]);

  React.useEffect(() => {
    if (status !== 'connected' || assistantPromptInFlightRef.current || assistantPromptQueueRef.current.length === 0) {
      return;
    }

    drainAssistantPromptQueue();
  }, [drainAssistantPromptQueue, status, assistantPromptInFlightRef, assistantPromptQueueRef]);

  React.useEffect(() => {
    if (status === 'connected') {
      drainAssistantPromptQueue();
      return;
    }

    if (status === 'error') {
      clearAssistantPromptQueue('model-status-change:error');
    }
  }, [clearAssistantPromptQueue, drainAssistantPromptQueue, status]);

  const {
    status: sttStatus,
    error: sttError,
    disconnect: disconnectServerStt,
    getUserVolume: getServerSttUserVolume,
  } = useServerStt({
    enabled: initialized && status === 'connected' && Boolean(conversationSessionId) && !usesLiveInput && !usesYandexRuntime,
    conversationSessionId,
    language: 'ru-RU',
    onSpeechStart: () => {
      if (!tunedSpeechConfig.immediateOnSpeechStart) {
        return;
      }
      if ((audioPlayer?.getVolume?.() || 0) > tunedSpeechConfig.botVolumeGuard) {
        triggerBargeIn('bargein-stt');
      }
    },
    onPartialTranscript: handleLiveInputTranscription,
    onFinalTranscript: handleServerFinalTranscript,
  });

  React.useEffect(() => {
    if (!conversationSessionIdRef.current) {
      return;
    }

    if (sttStatus === 'connected') {
      recordConversationAction('stt.stream.ready', {
        conversationSessionId: conversationSessionIdRef.current,
        sttSessionId: `server-stt:${conversationSessionIdRef.current}`,
      });
      return;
    }

    if (sttStatus === 'error' && sttError) {
      recordConversationAction('stt.stream.error', {
        conversationSessionId: conversationSessionIdRef.current,
        error: sttError,
      });
    }
  }, [recordConversationAction, sttError, sttStatus]);

  React.useEffect(() => {
    preferServerSttRef.current = !usesLiveInput && sttStatus === 'connected';
  }, [sttStatus, usesLiveInput]);

  React.useEffect(() => () => {
    clearPendingServerFinal();
    clearPendingLiveFinal();
    clearPendingYandexRealtimeFinal();
  }, [clearPendingLiveFinal, clearPendingServerFinal, clearPendingYandexRealtimeFinal]);

  React.useEffect(() => {
    if (sttStatus !== 'connected') {
      clearPendingServerFinal();
    }
  }, [clearPendingServerFinal, sttStatus]);

  React.useEffect(() => {
    if (!usesLiveInput) {
      clearPendingLiveFinal();
      clearPendingYandexRealtimeFinal();
    }
  }, [clearPendingLiveFinal, clearPendingYandexRealtimeFinal, usesLiveInput]);

  const handleOrchestratedUserTurn = React.useCallback(async (transcript, { requestId = 0 } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
      ? requestId
      : activeDialogRequestRef.current;
    if (!normalized || !conversationSessionIdRef.current) {
      return;
    }
    if (effectiveRequestId !== activeDialogRequestRef.current) {
      return;
    }

    if (normalTurnInFlightRef.current) {
      pendingOrchestratedTurnRef.current = { text: normalized, requestId: effectiveRequestId };
      return;
    }

    normalTurnInFlightRef.current = true;
    markDialogRequestState(effectiveRequestId, 'runtime-turn-started', {
      textLength: normalized.length,
    });
    recordConversationAction('runtime.turn.orchestrated.start', {
      conversationSessionId: conversationSessionIdRef.current,
      textLength: normalized.length,
      hasActiveBrowserSession: Boolean(activeBrowserSessionIdRef.current),
    });

    try {
      if (!usesYandexRealtimeRuntime && assistantTurnCountRef.current > 0 && isGreetingOnlyTranscript(normalized)) {
        const sent = enqueueAssistantPrompt(buildGreetingAckPrompt(normalized), {
          source: 'runtime.greeting-ack',
          dedupeKey: `runtime-greeting-ack:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        if (!sent) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: 'greeting-ack',
          });
        }
        return;
      }

      if (usesYandexRealtimeRuntime && isLikelyUnclearStandaloneTranscript(normalized)) {
        recordConversationAction('runtime.turn.ignored', {
          conversationSessionId: conversationSessionIdRef.current,
          reason: 'unclear-yandex-realtime-fragment',
          textLength: normalized.length,
          requestId: effectiveRequestId,
        });
        transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.INPUT_IGNORED, {
          reason: 'unclear-yandex-realtime-fragment',
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'ignored-unclear-transcript', {
          textLength: normalized.length,
        });
        return;
      }

      if (usesYandexRealtimeRuntime) {
        const sentYandexTurn = enqueueAssistantPrompt(normalized, {
          source: 'runtime.user-turn.yandex-realtime',
          origin: 'user_text',
          allowForceHandlers: false,
          dedupeKey: `runtime-yandex-user:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        if (!sentYandexTurn) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: 'yandex-user-turn',
          });
        }
        return;
      }

      if (isPersonaDirectQuestion(normalized)) {
        const sentPersonaPrompt = enqueueAssistantPrompt(buildPersonaDirectPrompt(normalized), {
          source: 'runtime.persona-direct',
          dedupeKey: `runtime-persona-direct:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
          priority: 'high',
        });
        if (!sentPersonaPrompt) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: 'persona-direct',
          });
        }
        return;
      }

      if (isLikelyUnclearStandaloneTranscript(normalized)) {
        if (usesYandexRealtimeRuntime) {
          recordConversationAction('runtime.turn.ignored', {
            conversationSessionId: conversationSessionIdRef.current,
            reason: 'unclear-yandex-realtime-fragment',
            textLength: normalized.length,
            requestId: effectiveRequestId,
          });
          finalizeDialogRequest(effectiveRequestId, 'ignored-unclear-transcript', {
            textLength: normalized.length,
          });
          return;
        }
        const sentClarifyPrompt = enqueueAssistantPrompt(buildRepeatRequestPrompt(normalized), {
          source: 'runtime.repeat-request',
          dedupeKey: `runtime-repeat-request:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
          priority: 'high',
        });
        if (!sentClarifyPrompt) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: 'repeat-request',
          });
        }
        return;
      }

      const [knowledgeResult, activePageContext] = await Promise.all([
        queryKnowledgeForTurn(normalized).catch(() => ({ hits: [] })),
        getRuntimePageContextForTurn(normalized),
      ]);

      const knowledgeHits = Array.isArray(knowledgeResult?.hits) ? knowledgeResult.hits : [];
      recordConversationAction('runtime.turn.orchestrated.context', {
        conversationSessionId: conversationSessionIdRef.current,
        knowledgeHitCount: knowledgeHits.length,
        hasActivePageContext: Boolean(activePageContext?.url),
      });
      markDialogRequestState(effectiveRequestId, 'runtime-turn-context-ready', {
        knowledgeHitCount: knowledgeHits.length,
        hasActivePageContext: Boolean(activePageContext?.url),
      });
      if (effectiveRequestId !== activeDialogRequestRef.current) {
        return;
      }

      const exactPrayerReading = resolveExactPrayerReading(normalized, {
        knowledgeHits,
        activePageContext,
      });
      if (isPrayerRequest(normalized)) {
        const prayerPrompt = exactPrayerReading
          ? buildExactPrayerReadingPrompt(normalized, exactPrayerReading)
          : buildPrayerSourceRequiredPrompt(normalized, {
            knowledgeHits,
            activePageContext,
          });
        const sentPrayerPrompt = enqueueAssistantPrompt(prayerPrompt, {
          source: exactPrayerReading ? 'runtime.prayer.exact' : 'runtime.prayer.source-required',
          dedupeKey: exactPrayerReading
            ? `runtime-prayer-read:${normalizeTranscriptKey(normalized)}`
            : `runtime-prayer-source:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
          priority: 'high',
        });
        if (!sentPrayerPrompt) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: exactPrayerReading ? 'prayer-exact' : 'prayer-source',
          });
        }
        return;
      }

      const sent = enqueueAssistantPrompt(buildRuntimeTurnPrompt(normalized, {
        knowledgeHits,
        activePageContext,
        characterId: selectedCharacter?.id || '',
        recentTurns: recentTurnsForIntentRef.current,
        compactMode: isCompactCharacter
          || isGemini31FlashLiveModel(selectedCharacter?.modelId || selectedCharacter?.voiceModelId),
      }), {
        source: 'runtime.turn',
        dedupeKey: `runtime-turn:${normalizeTranscriptKey(normalized)}`,
        requestId: effectiveRequestId,
      });

      if (!sent) {
        recordConversationAction('runtime.turn.orchestrated.fail', {
          conversationSessionId: conversationSessionIdRef.current,
          error: 'live-session-unavailable',
        });
      }
    } finally {
      normalTurnInFlightRef.current = false;
      if (pendingOrchestratedTurnRef.current?.text) {
        const pendingTurn = pendingOrchestratedTurnRef.current;
        pendingOrchestratedTurnRef.current = null;
        if (
          pendingTurn.requestId === activeDialogRequestRef.current
          && normalizeTranscriptKey(pendingTurn.text) !== normalizeTranscriptKey(normalized)
        ) {
          handleOrchestratedTurnRef.current?.(pendingTurn.text, { requestId: pendingTurn.requestId });
        }
      }
    }
  }, [
    activeBrowserSessionIdRef,
    activeDialogRequestRef,
    enqueueAssistantPrompt,
    finalizeDialogRequest,
    getRuntimePageContextForTurn,
    isCompactCharacter,
    markDialogRequestState,
    recentTurnsForIntentRef,
    selectedCharacter?.id,
    selectedCharacter?.modelId,
    selectedCharacter?.voiceModelId,
    queryKnowledgeForTurn,
    recordConversationAction,
    transitionVoiceConversationState,
    usesYandexRealtimeRuntime,
  ]);

  React.useEffect(() => {
    handleOrchestratedTurnRef.current = (transcript, options = {}) => {
      void handleOrchestratedUserTurn(transcript, options);
    };
  }, [handleOrchestratedUserTurn]);

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearReloadWatchdog = React.useCallback(() => {
    if (reloadWatchdogTimerRef.current) {
      clearTimeout(reloadWatchdogTimerRef.current);
      reloadWatchdogTimerRef.current = null;
    }
  }, []);

  const clearGoAwayReconnectTimer = React.useCallback(() => {
    if (goAwayReconnectTimerRef.current) {
      clearTimeout(goAwayReconnectTimerRef.current);
      goAwayReconnectTimerRef.current = null;
    }
  }, []);

  const resetReconnectState = React.useCallback(() => {
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    clearReconnectTimer();
    clearReloadWatchdog();
    clearGoAwayReconnectTimer();
  }, [clearGoAwayReconnectTimer, clearReconnectTimer, clearReloadWatchdog]);

  const buildSessionConnectConfig = React.useCallback(({
    conversationSessionId: nextConversationSessionId,
    sessionContextText = '',
    shouldSendGreeting = true,
  }) => buildRuntimeConfig({
    character: selectedCharacter,
    runtimeProvider: effectiveRuntimeProvider,
    usesLiveInput,
    sessionContextText,
      shouldSendGreeting,
      conversationSessionId: nextConversationSessionId,
      testerSettings,
      fallbackRuntimeProvider: realtimeFallbackProvider,
    }), [
      effectiveRuntimeProvider,
      realtimeFallbackProvider,
      selectedCharacter,
      testerSettings,
      usesLiveInput,
    ]);

  React.useEffect(() => {
    if (status === 'connected') {
      resetReconnectState();
      return;
    }

    if (status === 'connecting') {
      clearReconnectTimer();
    }
  }, [clearReconnectTimer, resetReconnectState, status]);

  React.useEffect(() => {
    if (status !== 'disconnected' || !pendingReconnectSignatureRef.current) {
      return;
    }

    const nextSignature = pendingReconnectSignatureRef.current;
    pendingReconnectSignatureRef.current = null;
    setAppliedSessionSignature(nextSignature);
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      connect();
      return;
    }

    void bootstrapConversationContext(sessionId, { shouldSendGreeting: false })
      .then((bootstrapText) => {
        connect(buildSessionConnectConfig({
          conversationSessionId: sessionId,
          sessionContextText: bootstrapText,
          shouldSendGreeting: false,
        }));
      })
      .catch(() => {
        connect();
      });
  }, [
    bootstrapConversationContext,
    buildSessionConnectConfig,
    connect,
    setAppliedSessionSignature,
    status,
  ]);

  React.useEffect(() => {
    if (!initialized || manualStopRef.current || pendingReconnectSignatureRef.current || !testerSettings.autoReconnect) {
      return;
    }

    if (status !== 'error' && status !== 'disconnected') {
      return;
    }

    if (reconnectTimerRef.current) {
      return;
    }

    const nextAttempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = nextAttempt;
    setReconnectAttempt(nextAttempt);

    const delay = Math.min(
      AUTO_RECONNECT_MAX_DELAY_MS,
      AUTO_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(nextAttempt - 1, 4)),
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const sessionId = conversationSessionIdRef.current;
      if (!sessionId) {
        connect();
        return;
      }

      void bootstrapConversationContext(sessionId, { shouldSendGreeting: false })
        .then((bootstrapText) => {
          recordConversationAction('model.reconnect.restore', {
            attempt: nextAttempt,
            conversationSessionId: sessionId,
          });
          connect(buildSessionConnectConfig({
            conversationSessionId: sessionId,
            sessionContextText: bootstrapText,
            shouldSendGreeting: false,
          }));
        })
        .catch(() => {
          connect();
        });
    }, delay);

    if (nextAttempt >= AUTO_RECONNECT_MAX_ATTEMPTS && !reloadWatchdogTimerRef.current) {
      reloadWatchdogTimerRef.current = setTimeout(() => {
        reloadWatchdogTimerRef.current = null;
        recordConversationAction('model.reconnect.watchdog', {
          conversationSessionId: conversationSessionIdRef.current || '',
          attempt: nextAttempt,
          action: 'reload-suppressed',
        });
      }, RELOAD_WATCHDOG_TIMEOUT_MS);
    }
  }, [
    bootstrapConversationContext,
    buildSessionConnectConfig,
    connect,
    initialized,
    recordConversationAction,
    status,
    testerSettings.autoReconnect,
  ]);

  React.useEffect(() => {
    if (!initialized || manualStopRef.current || status !== 'connecting') {
      return undefined;
    }

    const watchdogId = setTimeout(() => {
      disconnect();
    }, CONNECTING_WATCHDOG_TIMEOUT_MS);

    return () => clearTimeout(watchdogId);
  }, [disconnect, initialized, status]);

  React.useEffect(() => () => {
    clearReconnectTimer();
    clearReloadWatchdog();
    cancelPendingBrowserWork('component-unmount');
    clearAssistantPromptQueue('component-unmount');
  }, [cancelPendingBrowserWork, clearAssistantPromptQueue, clearReconnectTimer, clearReloadWatchdog]);
  const handleStart = async () => {
    await audioPlayer.initialize();
    manualStopRef.current = false;
    resetReconnectState();
    clearSessionResumption();
    geminiSession.disconnect?.();
    yandexSession.disconnect?.();
    yandexRealtimeSession.disconnect?.();
    setInitialized(true);
    setLiveInputTranscript('');
    clearTesterEvents();
    resetSessionRuntimeState();
    const nextConversationSessionId = buildConversationSessionId();
    await jsonRequest('/api/conversation/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationSessionId: nextConversationSessionId,
        characterId: selectedCharacter?.id || '',
      }),
    }, 10000);
    setConversationSessionId(nextConversationSessionId);
    conversationSessionIdRef.current = nextConversationSessionId;
    const inputSessionId = usesYandexRealtimeRuntime
      ? `yandex-realtime:${nextConversationSessionId}`
      : (usesYandexLegacyRuntime
        ? `yandex-local-vad:${nextConversationSessionId}`
        : (usesLiveInput
          ? `gemini-live-input:${nextConversationSessionId}`
          : `server-stt:${nextConversationSessionId}`));
    recordConversationAction('voice.input.start', {
      conversationSessionId: nextConversationSessionId,
      inputSessionId,
      mode: usesYandexRealtimeRuntime
        ? 'yandex-realtime'
        : (usesYandexLegacyRuntime ? 'yandex-local-vad' : (usesLiveInput ? 'gemini-live-input' : 'server-stt')),
    });
    transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.SESSION_READY, {
      reason: 'input-start',
    });
    updateConversationSessionState({
      activeSttSessionId: inputSessionId,
    });
    const shouldSendSessionGreeting = true;
    const bootstrapText = await bootstrapConversationContext(nextConversationSessionId, { shouldSendGreeting: shouldSendSessionGreeting });
    setAppliedSessionSignature(currentSignature);
    connect(buildSessionConnectConfig({
      conversationSessionId: nextConversationSessionId,
      sessionContextText: bootstrapText,
      shouldSendGreeting: shouldSendSessionGreeting,
    }));
  };

  const handleStop = () => {
    const currentConversationSessionId = conversationSessionIdRef.current || '';
    if (activeDialogRequestRef.current > 0) {
      finalizeDialogRequest(activeDialogRequestRef.current, 'session-stopped');
    }
    recordConversationAction('session.stop.request', {
      conversationSessionId: currentConversationSessionId,
    });
    recordConversationAction('voice.input.closed', {
      conversationSessionId: currentConversationSessionId,
      inputSessionId: currentConversationSessionId
        ? `${usesYandexRealtimeRuntime
          ? 'yandex-realtime'
          : (usesYandexLegacyRuntime ? 'yandex-local-vad' : (usesLiveInput ? 'gemini-live-input' : 'server-stt'))}:${currentConversationSessionId}`
        : '',
      mode: usesYandexRealtimeRuntime
        ? 'yandex-realtime'
        : (usesYandexLegacyRuntime ? 'yandex-local-vad' : (usesLiveInput ? 'gemini-live-input' : 'server-stt')),
    });
    transitionVoiceConversationState(VOICE_CONVERSATION_EVENTS.SESSION_STOP, {
      reason: 'manual-stop',
    });
    manualStopRef.current = true;
    cancelPendingBrowserWork('manual-stop');
    clearAssistantPromptQueue('manual-stop');
    cancelAssistantOutputRef.current?.();
    resetReconnectState();
    pendingReconnectSignatureRef.current = null;
    clearSessionResumption();
    updateConversationSessionState({
      activeSttSessionId: '',
    });
    if (currentConversationSessionId) {
      void fetch(`/api/conversation/session/${encodeURIComponent(currentConversationSessionId)}/close`, {
        method: 'POST',
      }).catch(() => {});
    }
    disconnectServerStt();
    geminiSession.disconnect?.();
    yandexSession.disconnect?.();
    yandexRealtimeSession.disconnect?.();
    disconnect();
    setInitialized(false);
    setLiveInputTranscript('');
    resetSessionRuntimeState();
    recordConversationAction('session.teardown.complete', {
      conversationSessionId: currentConversationSessionId,
    });
    setAppliedSessionSignature(null);
    setConversationSessionId('');
    conversationSessionIdRef.current = '';
    audioPlayer.close();
  };

  const requestReconnectForSignature = React.useCallback((nextSignature) => {
    if (status === 'connected' && nextSignature && nextSignature !== appliedSessionSignature) {
      pendingReconnectSignatureRef.current = nextSignature;
      setLiveInputTranscript('');
      resetSessionRuntimeState();
      disconnect();
    }
  }, [appliedSessionSignature, disconnect, resetSessionRuntimeState, status]);

  return {
    activeDialogRequestRef,
    assistantOutputState,
    clearTesterEvents,
    clearSessionResumption,
    error,
    getLiveUserVolume,
    getServerSttUserVolume,
    handleStart,
    handleStop,
    initialized,
    lastAssistantTurnText: lastAssistantTurnRef.current?.text || '',
    lastIssueText,
    lastRecognizedTurn,
    liveInputTranscript,
    reconnectAttempt,
    requestReconnectForSignature,
    status,
    sttError,
    sttStatus,
    testerEvents,
  };
}




