import React from 'react';
import { DEFAULT_PANEL_STATE } from './browserPanelModel.js';
import {
  buildWebActionPrompt,
  buildWebClientPendingPrompt,
  buildWebClientResultPrompt,
  buildWebFailurePrompt,
  buildWebResultPrompt,
  normalizeSpeechText,
  normalizeTranscriptKey,
} from '../session/transcriptFlowModel.js';

const CLIENT_INLINE_LOAD_TIMEOUT_MS = 12000;
const CLIENT_INLINE_CONTEXT_QUESTION = 'Что сейчас находится на открытой странице';
const CLIENT_INLINE_LOAD_FAILED_TEXT = 'Не удалось вовремя показать сайт внутри панели.';
const CLIENT_INLINE_EMBED_BLOCKED_TEXT = 'Этот сайт запрещает показывать себя внутри панели.';
const CLIENT_INLINE_CONTEXT_FAILED_TEXT = 'Не удалось быстро прочитать страницу.';
const CLIENT_INLINE_CONTEXT_PENDING_NOTE = 'Сайт уже открыт внизу. Дочитываю текст страницы.';
const CLIENT_INLINE_CONTEXT_ERROR_NOTE = 'Сайт открыт внизу. Текст страницы прочитать не удалось.';
const CLIENT_INLINE_FRAME_PENDING_NOTE = 'Сайт уже открыт внизу. Дочитываю текст страницы.';
const CLIENT_INLINE_FRAME_ERROR_TEXT = 'Не удалось показать сайт внутри панели.';

export function useClientInlinePanelController({
  activeDialogRequestRef,
  appendSessionWebHistoryRef,
  browserPanelRef,
  enqueueAssistantPromptRef,
  finalizeDialogRequestRef,
  getSessionHistorySummaryRef,
  markDialogRequestStateRef,
  requestClientInlineContext,
  sendBrowserClientEvent,
  setBrowserFlowPhase,
  setBrowserPanel,
}) {
  const pendingClientPanelLoadRef = React.useRef({
    requestId: 0,
    transcript: '',
    actionType: '',
    targetUrl: '',
    timerId: null,
    frameLoaded: false,
    contextReady: false,
  });

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
      enqueueAssistantPromptRef.current?.(buildWebFailurePrompt(
        transcript,
        errorText,
        getSessionHistorySummaryRef.current?.() || '',
      ), {
        source: 'browser.inline.error',
        dedupeKey: `browser-inline-error:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(panelState.url || panelState.clientUrl || '')}`,
        requestId,
      });
    }

    if (requestId > 0) {
      finalizeDialogRequestRef.current?.(requestId, 'browser-inline-error');
    }
  }, [
    appendSessionWebHistoryRef,
    browserPanelRef,
    clearPendingClientPanelLoad,
    enqueueAssistantPromptRef,
    finalizeDialogRequestRef,
    getSessionHistorySummaryRef,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    setBrowserPanel,
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
      pending.actionType === 'action' ? 'browser.action.ready' : 'browser.open.ready',
      {
        requestId,
        transcript,
        url: panelState.url || panelState.clientUrl || '',
        clientContextStatus: panelState.clientContextStatus || 'idle',
      },
    );

    if (transcript && requestId > 0) {
      markDialogRequestStateRef.current?.(requestId, 'browser-panel-ready', {
        browserPanelMode: 'client-inline',
        contextReady,
      });

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
    browserPanelRef,
    clearPendingClientPanelLoad,
    enqueueAssistantPromptRef,
    finalizeDialogRequestRef,
    getSessionHistorySummaryRef,
    markDialogRequestStateRef,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    setBrowserPanel,
  ]);

  const armPendingClientPanelLoad = React.useCallback(({
    requestId,
    transcript,
    actionType = 'open',
    targetUrl,
  }) => {
    clearPendingClientPanelLoad();
    const timerId = window.setTimeout(() => {
      failPendingClientPanelLoad(CLIENT_INLINE_LOAD_FAILED_TEXT, requestId);
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

  const loadClientInlineContext = React.useCallback((targetUrl, requestId) => {
    void requestClientInlineContext(targetUrl, CLIENT_INLINE_CONTEXT_QUESTION, { requestId })
      .then((contextResult) => {
        if (requestId !== activeDialogRequestRef.current) {
          return;
        }
        if (contextResult?.embeddable === false) {
          failPendingClientPanelLoad(CLIENT_INLINE_EMBED_BLOCKED_TEXT, requestId);
          return;
        }
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
        if (pendingClientPanelLoadRef.current?.requestId === requestId) {
          pendingClientPanelLoadRef.current.contextReady = true;
          if (pendingClientPanelLoadRef.current.frameLoaded) {
            finalizePendingClientPanelLoad();
          }
        }
      })
      .catch((contextError) => {
        if (requestId !== activeDialogRequestRef.current) {
          return;
        }
        setBrowserPanel((current) => ({
          ...current,
          clientContextStatus: 'error',
          clientContextError: contextError.message || CLIENT_INLINE_CONTEXT_FAILED_TEXT,
          note: current.clientFrameLoaded
            ? CLIENT_INLINE_CONTEXT_ERROR_NOTE
            : current.note,
        }));
        if (pendingClientPanelLoadRef.current?.requestId === requestId && pendingClientPanelLoadRef.current.frameLoaded) {
          finalizePendingClientPanelLoad();
        }
      });
  }, [
    activeDialogRequestRef,
    failPendingClientPanelLoad,
    finalizePendingClientPanelLoad,
    requestClientInlineContext,
    setBrowserPanel,
  ]);

  const handleClientPanelAction = React.useCallback((action) => {
    if (!action?.type) {
      return false;
    }

    if (action.type === 'client-frame-load') {
      const hasPendingLoad = Boolean(
        pendingClientPanelLoadRef.current?.targetUrl
        || pendingClientPanelLoadRef.current?.timerId,
      );
      if (!hasPendingLoad && browserPanelRef.current?.status === 'error') {
        return true;
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
            note: CLIENT_INLINE_FRAME_PENDING_NOTE,
          }));
        }
      }
      return true;
    }

    if (action.type === 'client-frame-error') {
      if (pendingClientPanelLoadRef.current?.targetUrl || pendingClientPanelLoadRef.current?.timerId) {
        failPendingClientPanelLoad(CLIENT_INLINE_FRAME_ERROR_TEXT, pendingClientPanelLoadRef.current.requestId);
        return true;
      }
      setBrowserFlowPhase('error');
      setBrowserPanel((current) => ({
        ...current,
        status: 'error',
        clientFrameLoaded: false,
        error: CLIENT_INLINE_FRAME_ERROR_TEXT,
      }));
      return true;
    }

    return false;
  }, [
    browserPanelRef,
    failPendingClientPanelLoad,
    finalizePendingClientPanelLoad,
    setBrowserFlowPhase,
    setBrowserPanel,
  ]);

  return {
    armPendingClientPanelLoad,
    clearPendingClientPanelLoad,
    failPendingClientPanelLoad,
    handleClientPanelAction,
    loadClientInlineContext,
  };
}
