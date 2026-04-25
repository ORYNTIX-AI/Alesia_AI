import React from 'react';
import { DEFAULT_PANEL_STATE } from './browserPanelModel.js';
import { useBrowserActionRuntime } from './useBrowserActionRuntime.js';
import { useBrowserTranscriptHandler } from './useBrowserTranscriptHandler.js';
import {
  buildWebActionPrompt,
  buildWebClientPendingPrompt,
  buildWebClientResultPrompt,
  buildWebFailurePrompt,
  buildWebResultPrompt,
  isTransientIntentError,
  jsonRequest,
  normalizeSpeechText,
  normalizeTranscriptKey,
} from '../session/transcriptFlowModel.js';

const BROWSER_INTENT_TIMEOUT_MS = 9000;
const BROWSER_INTENT_PENDING_SLA_MS = 8500;
const BROWSER_OPEN_TIMEOUT_MS = 75000;
const BROWSER_CONTEXT_TIMEOUT_MS = 5000;
const BROWSER_ACTION_TIMEOUT_MS = 12000;
const BROWSER_VIEW_POLL_MS = 2500;
const BROWSER_INTENT_RETRY_LIMIT = 1;
const BROWSER_INTENT_RETRY_BACKOFF_MS = 180;
const CLIENT_INLINE_LOAD_TIMEOUT_MS = 12000;
const MAX_RECENT_INTENT_TURNS = 10;

export function useBrowserRuntimeController({
  activeDialogRequestRef,
  conversationSessionId,
  pageContextMode,
  recentTurnsForIntentRef,
  selectedCharacter,
  sessionApiRefs,
  usesClientInlinePanel,
}) {
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
  } = sessionApiRefs;

  const [browserPanel, setBrowserPanel] = React.useState(DEFAULT_PANEL_STATE);
  const [browserFlowState, setBrowserFlowState] = React.useState('idle');
  const [activeBrowserSessionId, setActiveBrowserSessionId] = React.useState('');

  const browserRequestIdRef = React.useRef(0);
  const browserFlowRequestIdRef = React.useRef(0);
  const browserIntentAbortRef = React.useRef(null);
  const browserPanelRef = React.useRef(DEFAULT_PANEL_STATE);
  const browserFlowStateRef = React.useRef('idle');
  const activeBrowserSessionIdRef = React.useRef('');
  const conversationSessionIdRef = React.useRef('');
  const handledTranscriptsRef = React.useRef([]);
  const lastBrowserCommandRef = React.useRef({ key: '', transcript: '', timestamp: 0 });
  const browserSpeechGuardUntilRef = React.useRef(0);
  const browserIntentInFlightRef = React.useRef(false);
  const inFlightBrowserKeyRef = React.useRef('');
  const browserTraceCounterRef = React.useRef(0);
  const browserViewPollTimerRef = React.useRef(null);
  const pendingClientPanelLoadRef = React.useRef({
    requestId: 0,
    transcript: '',
    actionType: '',
    targetUrl: '',
    timerId: null,
    frameLoaded: false,
    contextReady: false,
  });
  const handleBrowserTranscriptRef = React.useRef(null);

  const sendBrowserClientEvent = React.useCallback((event, details = {}) => {
    void fetch('/api/browser/client-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, details }),
    }).catch(() => {});
  }, []);

  const setBrowserFlowPhase = React.useCallback((phase) => {
    browserFlowStateRef.current = phase;
    setBrowserFlowState(phase);
  }, []);

  const clearPendingClientPanelLoad = React.useCallback(() => {
    const timerId = pendingClientPanelLoadRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingClientPanelLoadRef.current = {
      requestId: 0,
      transcript: '',
      actionType: '',
      targetUrl: '',
      timerId: null,
      frameLoaded: false,
      contextReady: false,
    };
  }, []);

  const cancelPendingBrowserWork = React.useCallback((reason = 'new-user-request') => {
    browserIntentAbortRef.current?.abort?.();
    browserIntentAbortRef.current = null;
    browserIntentInFlightRef.current = false;
    browserFlowRequestIdRef.current = 0;
    inFlightBrowserKeyRef.current = '';
    clearPendingClientPanelLoad();
    void fetch('/api/browser/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).catch(() => {});
  }, [clearPendingClientPanelLoad]);

  const refreshBrowserView = React.useCallback(async (force = false) => {
    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      return null;
    }

    let view;
    try {
      view = await jsonRequest(
        `/api/browser/session/${encodeURIComponent(sessionId)}/view?refresh=${force ? '1' : '0'}`,
        { method: 'GET' },
        BROWSER_ACTION_TIMEOUT_MS,
      );
    } catch (error) {
      const message = String(error?.message || '');
      if (/нет активного сайта/i.test(message) || /no active/i.test(message)) {
        activeBrowserSessionIdRef.current = '';
        browserFlowStateRef.current = 'error';
        setActiveBrowserSessionId('');
        setBrowserFlowState('error');
        setBrowserPanel((current) => ({
          ...current,
          status: 'error',
          error: 'Связь с открытым сайтом потеряна. Откройте сайт снова.',
        }));
      }
      throw error;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: current.status === 'idle' ? 'ready' : current.status,
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

    return view;
  }, []);

  const detectBrowserIntentWithRetry = React.useCallback(async ({
    traceId,
    transcript,
    requestId,
    dedupeKey,
  }) => {
    let lastError = null;
    const maxAttempts = 1 + BROWSER_INTENT_RETRY_LIMIT;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      const attemptAbortController = new AbortController();
      browserIntentAbortRef.current = attemptAbortController;
      const abortTimerId = setTimeout(() => {
        attemptAbortController.abort();
      }, BROWSER_INTENT_PENDING_SLA_MS);

      try {
        const intent = await jsonRequest('/api/browser/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            traceId,
            transcript,
            sessionHistory: getSessionHistoryPayloadRef.current?.() || [],
            activeCharacterId: selectedCharacter?.id || null,
            conversationSessionId: conversationSessionIdRef.current || '',
            recentTurns: recentTurnsForIntentRef.current.slice(-MAX_RECENT_INTENT_TURNS),
          }),
          signal: attemptAbortController.signal,
        }, BROWSER_INTENT_TIMEOUT_MS);

        sendBrowserClientEvent('browser.intent.attempt.success', {
          requestId,
          traceId,
          attempt,
          dedupeKey,
          intentType: intent?.type || 'none',
        });
        return intent;
      } catch (error) {
        lastError = error;
        const transientError = isTransientIntentError(error);
        const canRetryTranscript = /\bhttps?:\/\/[^\s]+/i.test(transcript)
          || /\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(transcript)
          || /\bточка\s*(?:by|ru)\b/i.test(transcript);
        const shouldRetry = transientError && canRetryTranscript && attempt < maxAttempts;
        sendBrowserClientEvent('browser.intent.attempt.error', {
          requestId,
          traceId,
          attempt,
          dedupeKey,
          transient: transientError,
          retryPlanned: shouldRetry,
          error: error?.message || 'Не удалось определить сайт',
        });

        if (!shouldRetry) {
          throw error;
        }

        setBrowserPanel((current) => ({
          ...current,
          status: 'loading',
          title: 'Проверяю адрес еще раз...',
          sourceType: 'intent-pending',
        }));
        await new Promise((resolve) => {
          setTimeout(resolve, BROWSER_INTENT_RETRY_BACKOFF_MS);
        });
      } finally {
        clearTimeout(abortTimerId);
        if (browserIntentAbortRef.current === attemptAbortController) {
          browserIntentAbortRef.current = null;
        }
      }
    }

    throw lastError || new Error('Не удалось определить сайт');
  }, [getSessionHistoryPayloadRef, recentTurnsForIntentRef, selectedCharacter?.id, sendBrowserClientEvent]);

  const requestActiveBrowserContext = React.useCallback(async (question, { requestId = 0 } = {}) => {
    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      throw new Error('Нет активного сайта для уточнения контекста');
    }

    return jsonRequest(`/api/browser/session/${encodeURIComponent(sessionId)}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
        requestId: Number.isInteger(requestId) ? requestId : 0,
      }),
    }, BROWSER_CONTEXT_TIMEOUT_MS);
  }, [selectedCharacter?.id]);

  const requestClientInlineContext = React.useCallback(async (url, question, { requestId = 0 } = {}) => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
      throw new Error('Нет адреса страницы для чтения контекста');
    }

    return jsonRequest('/api/browser/url-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: normalizedUrl,
        question,
        requestId: Number.isInteger(requestId) ? requestId : 0,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
      }),
    }, BROWSER_CONTEXT_TIMEOUT_MS + 3000);
  }, [selectedCharacter?.id]);

  const getRuntimePageContextForTurn = React.useCallback(async (question) => {
    if (browserIntentInFlightRef.current) {
      return null;
    }

    if (pageContextMode === 'url-fetch' && browserPanelRef.current?.clientUrl && browserFlowStateRef.current === 'ready') {
      try {
        return await requestClientInlineContext(browserPanelRef.current.clientUrl, question, {
          requestId: activeDialogRequestRef.current,
        });
      } catch {
        return null;
      }
    }

    if (!activeBrowserSessionIdRef.current || browserFlowStateRef.current !== 'ready') {
      return null;
    }

    try {
      return await requestActiveBrowserContext(question, {
        requestId: activeDialogRequestRef.current,
      });
    } catch {
      return null;
    }
  }, [activeDialogRequestRef, pageContextMode, requestActiveBrowserContext, requestClientInlineContext]);

  React.useEffect(() => {
    browserFlowStateRef.current = browserFlowState;
  }, [browserFlowState]);

  React.useEffect(() => {
    browserPanelRef.current = browserPanel;
  }, [browserPanel]);

  React.useEffect(() => {
    activeBrowserSessionIdRef.current = activeBrowserSessionId;
  }, [activeBrowserSessionId]);

  React.useEffect(() => {
    conversationSessionIdRef.current = conversationSessionId;
  }, [conversationSessionId]);

  React.useEffect(() => {
    if (browserViewPollTimerRef.current) {
      clearInterval(browserViewPollTimerRef.current);
      browserViewPollTimerRef.current = null;
    }

    if (!activeBrowserSessionId || browserFlowState !== 'ready') {
      return undefined;
    }

    void refreshBrowserView(false).catch(() => {});
    browserViewPollTimerRef.current = setInterval(() => {
      void refreshBrowserView(false).catch(() => {});
    }, BROWSER_VIEW_POLL_MS);

    return () => {
      if (browserViewPollTimerRef.current) {
        clearInterval(browserViewPollTimerRef.current);
        browserViewPollTimerRef.current = null;
      }
    };
  }, [activeBrowserSessionId, browserFlowState, refreshBrowserView]);

  const resetBrowserRuntimeState = React.useCallback(() => {
    browserRequestIdRef.current = 0;
    browserFlowRequestIdRef.current = 0;
    browserIntentAbortRef.current?.abort?.();
    browserIntentAbortRef.current = null;
    handledTranscriptsRef.current = [];
    lastBrowserCommandRef.current = { key: '', transcript: '', timestamp: 0 };
    browserSpeechGuardUntilRef.current = 0;
    browserIntentInFlightRef.current = false;
    inFlightBrowserKeyRef.current = '';
    clearPendingClientPanelLoad();
    if (browserViewPollTimerRef.current) {
      clearInterval(browserViewPollTimerRef.current);
      browserViewPollTimerRef.current = null;
    }
    setBrowserFlowPhase('idle');
    setActiveBrowserSessionId('');
    setBrowserPanel(DEFAULT_PANEL_STATE);
  }, [clearPendingClientPanelLoad, setBrowserFlowPhase]);

  const failPendingClientPanelLoad = React.useCallback((errorText, fallbackRequestId = 0) => {
    const pending = pendingClientPanelLoadRef.current;
    const requestId = Number.isInteger(pending?.requestId) && pending.requestId > 0
      ? pending.requestId
      : fallbackRequestId;
    const transcript = normalizeSpeechText(pending?.transcript || '');
    const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;

    clearPendingClientPanelLoad();
    setBrowserFlowPhase('error');
    setBrowserPanel((current) => ({
      ...current,
      status: 'error',
      clientFrameLoaded: false,
      clientContextStatus: 'error',
      clientContextError: errorText,
      error: errorText,
      note: '',
    }));

    if (transcript) {
      appendSessionWebHistoryRef.current?.({
        status: 'failed',
        transcript,
        title: panelState.title || 'Сайт',
        url: panelState.url || panelState.clientUrl || '',
        note: errorText,
      });
    }

    sendBrowserClientEvent('browser.inline.error', {
      requestId,
      transcript,
      url: panelState.url || panelState.clientUrl || '',
      error: errorText,
    });

    if (transcript && requestId > 0) {
      enqueueAssistantPromptRef.current?.(
        buildWebFailurePrompt(transcript, errorText, getSessionHistorySummaryRef.current?.() || ''),
        {
          source: 'browser.inline.error',
          dedupeKey: `browser-inline-error:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(panelState.url || panelState.clientUrl || '')}`,
          requestId,
        },
      );
    }

    if (requestId > 0) {
      finalizeDialogRequestRef.current?.(requestId, 'browser-inline-error');
    }
  }, [
    appendSessionWebHistoryRef,
    clearPendingClientPanelLoad,
    enqueueAssistantPromptRef,
    finalizeDialogRequestRef,
    getSessionHistorySummaryRef,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
  ]);

  const finalizePendingClientPanelLoad = React.useCallback(() => {
    const pending = pendingClientPanelLoadRef.current;
    const requestId = Number(pending?.requestId || 0);
    if (requestId > 0 && requestId !== activeDialogRequestRef.current) {
      clearPendingClientPanelLoad();
      return false;
    }

    const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;
    const transcript = normalizeSpeechText(pending.transcript || '');
    const contextReady = panelState.clientContextStatus === 'ready';
    const prompt = pending.actionType === 'action'
      ? (
        contextReady
          ? buildWebActionPrompt(transcript, panelState, getSessionHistorySummaryRef.current?.() || '')
          : buildWebClientPendingPrompt(transcript, panelState, getSessionHistorySummaryRef.current?.() || '')
      )
      : (
        contextReady
          ? buildWebResultPrompt(transcript, panelState, getSessionHistorySummaryRef.current?.() || '')
          : buildWebClientResultPrompt(transcript, panelState, getSessionHistorySummaryRef.current?.() || '')
      );

    if (pending.actionType !== 'action') {
      appendSessionWebHistoryRef.current?.({
        status: 'opened',
        transcript,
        title: panelState.title || 'Сайт',
        url: panelState.url || panelState.clientUrl || '',
        note: contextReady ? '' : 'Страница показана, текст еще дочитывается.',
      });
    }

    setBrowserFlowPhase('ready');
    setBrowserPanel((current) => ({
      ...current,
      status: 'ready',
      clientFrameLoaded: true,
      error: null,
      note: contextReady ? '' : 'Сайт открыт внизу. Текст страницы ещё дочитывается.',
    }));

    sendBrowserClientEvent(
      pending.actionType === 'action' ? 'browser.action.complete' : 'browser.open.ready',
      {
        requestId,
        browserPanelMode: 'client-inline',
        title: panelState.title || '',
        url: panelState.url || panelState.clientUrl || '',
        panelConfirmed: true,
        contextReady,
      },
    );

    markDialogRequestStateRef.current?.(
      requestId,
      pending.actionType === 'action' ? 'browser-action-ready' : 'browser-open-ready',
      {
        browserPanelMode: 'client-inline',
        panelConfirmed: true,
        contextReady,
      },
    );

    if (transcript && requestId > 0) {
      enqueueAssistantPromptRef.current?.(prompt, {
        source: pending.actionType === 'action' ? 'browser.inline.action.ready' : 'browser.inline.open.ready',
        dedupeKey: `${pending.actionType || 'open'}:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(panelState.url || panelState.clientUrl || '')}`,
        requestId,
      });

      finalizeDialogRequestRef.current?.(
        requestId,
        pending.actionType === 'action' ? 'browser-action-ready' : 'browser-open-ready',
        {
          browserPanelMode: 'client-inline',
          contextReady,
        },
      );
    }
    clearPendingClientPanelLoad();
    return true;
  }, [
    activeDialogRequestRef,
    appendSessionWebHistoryRef,
    clearPendingClientPanelLoad,
    enqueueAssistantPromptRef,
    finalizeDialogRequestRef,
    getSessionHistorySummaryRef,
    markDialogRequestStateRef,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
  ]);

  const armPendingClientPanelLoad = React.useCallback(({
    requestId,
    transcript,
    actionType = 'open',
    targetUrl,
  }) => {
    clearPendingClientPanelLoad();
    const timerId = window.setTimeout(() => {
      failPendingClientPanelLoad('Не удалось вовремя показать сайт внутри панели.', requestId);
    }, CLIENT_INLINE_LOAD_TIMEOUT_MS);
    pendingClientPanelLoadRef.current = {
      requestId,
      transcript,
      actionType,
      targetUrl: String(targetUrl || '').trim(),
      timerId,
      frameLoaded: false,
      contextReady: false,
    };
  }, [clearPendingClientPanelLoad, failPendingClientPanelLoad]);

  const performBrowserAction = useBrowserActionRuntime({
    activeBrowserSessionIdRef,
    activeDialogRequestRef,
    armPendingClientPanelLoad,
    browserPanelRef,
    cancelAssistantOutputRef,
    conversationSessionIdRef,
    enqueueAssistantPromptRef,
    failPendingClientPanelLoad,
    finalizePendingClientPanelLoad,
    getSessionHistorySummaryRef,
    pendingClientPanelLoadRef,
    recordConversationActionRef,
    requestActiveBrowserContext,
    requestClientInlineContext,
    selectedCharacterId: selectedCharacter?.id,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    setBrowserPanel,
    usesClientInlinePanel,
    BROWSER_ACTION_TIMEOUT_MS,
  });

  const handleBrowserTranscript = useBrowserTranscriptHandler({
    activeBrowserSessionIdRef,
    activeDialogRequestRef,
    appendSessionWebHistoryRef,
    armPendingClientPanelLoad,
    browserFlowRequestIdRef,
    browserFlowStateRef,
    browserIntentAbortRef,
    browserIntentInFlightRef,
    browserPanelRef,
    browserRequestIdRef,
    browserSpeechGuardUntilRef,
    browserTraceCounterRef,
    cancelAssistantOutputRef,
    clearAssistantPromptQueueRef,
    conversationSessionIdRef,
    detectBrowserIntentWithRetry,
    enqueueAssistantPromptRef,
    failPendingClientPanelLoad,
    finalizeDialogRequestRef,
    finalizePendingClientPanelLoad,
    getSessionHistorySummaryRef,
    handledTranscriptsRef,
    inFlightBrowserKeyRef,
    lastBrowserCommandRef,
    markDialogRequestStateRef,
    pendingClientPanelLoadRef,
    performBrowserAction,
    recordConversationActionRef,
    refreshBrowserView,
    requestActiveBrowserContext,
    requestClientInlineContext,
    selectedCharacter,
    sendBrowserClientEvent,
    setActiveBrowserSessionId,
    setBrowserFlowPhase,
    setBrowserPanel,
    usesClientInlinePanel,
    BROWSER_ACTION_TIMEOUT_MS,
    BROWSER_OPEN_TIMEOUT_MS,
  });

  React.useEffect(() => {
    handleBrowserTranscriptRef.current = (transcript, options = {}) => {
      void handleBrowserTranscript(transcript, options);
    };
  }, [handleBrowserTranscript]);

  const handleBrowserPanelAction = React.useCallback(async (action) => {
    if (!action?.type) {
      return;
    }

    if (action.type === 'client-frame-load') {
      const hasPendingLoad = Boolean(
        pendingClientPanelLoadRef.current?.targetUrl
        || pendingClientPanelLoadRef.current?.timerId,
      );
      if (!hasPendingLoad && browserPanelRef.current?.status === 'error') {
        return;
      }
      setBrowserPanel((current) => ({
        ...current,
        clientFrameLoaded: true,
        error: hasPendingLoad ? null : current.error,
      }));
      if (hasPendingLoad) {
        pendingClientPanelLoadRef.current.frameLoaded = true;
        if ((browserPanelRef.current?.clientContextStatus || 'idle') !== 'loading') {
          finalizePendingClientPanelLoad();
        } else {
          setBrowserPanel((current) => ({
            ...current,
            note: 'Сайт уже открыт внизу. Дочитываю текст страницы.',
          }));
        }
      }
      return;
    }

    if (action.type === 'client-frame-error') {
      if (pendingClientPanelLoadRef.current?.targetUrl || pendingClientPanelLoadRef.current?.timerId) {
        failPendingClientPanelLoad(
          'Не удалось показать сайт внутри панели.',
          pendingClientPanelLoadRef.current.requestId,
        );
        return;
      }
      setBrowserFlowPhase('error');
      setBrowserPanel((current) => ({
        ...current,
        status: 'error',
        clientFrameLoaded: false,
        error: 'Не удалось показать сайт внутри панели.',
      }));
      return;
    }

    if (!activeBrowserSessionIdRef.current && browserPanelRef.current?.clientUrl) {
      try {
        await performBrowserAction(action);
      } catch (error) {
        setBrowserFlowPhase('error');
        setBrowserPanel((current) => ({
          ...current,
          status: 'error',
          error: error.message || 'Не удалось выполнить действие на странице',
        }));
      }
      return;
    }

    if (!activeBrowserSessionIdRef.current) {
      return;
    }

    try {
      await performBrowserAction(action);
    } catch (error) {
      setBrowserFlowPhase('error');
      setBrowserPanel((current) => ({
        ...current,
        status: 'error',
        error: error.message || 'Не удалось выполнить действие на странице',
      }));
    }
  }, [failPendingClientPanelLoad, finalizePendingClientPanelLoad, performBrowserAction, setBrowserFlowPhase]);

  React.useEffect(() => () => {
    browserIntentAbortRef.current?.abort?.();
    if (pendingClientPanelLoadRef.current?.timerId) {
      clearTimeout(pendingClientPanelLoadRef.current.timerId);
    }
    if (browserViewPollTimerRef.current) {
      clearInterval(browserViewPollTimerRef.current);
      browserViewPollTimerRef.current = null;
    }
  }, []);

  return {
    activeBrowserSessionId,
    activeBrowserSessionIdRef,
    browserFlowState,
    browserFlowStateRef,
    browserIntentInFlightRef,
    browserPanel,
    browserPanelRef,
    browserSpeechGuardUntilRef,
    cancelPendingBrowserWork,
    getRuntimePageContextForTurn,
    handleBrowserPanelAction,
    handleBrowserTranscriptRef,
    refreshBrowserView,
    resetBrowserRuntimeState,
    setActiveBrowserSessionId,
    setBrowserFlowPhase,
    setBrowserPanel,
  };
}
