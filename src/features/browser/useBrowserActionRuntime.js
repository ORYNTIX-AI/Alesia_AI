import React from 'react';
import { DEFAULT_PANEL_STATE } from './browserPanelModel.js';
import {
  buildWebActionPrompt,
  jsonRequest,
  normalizeSpeechText,
  normalizeTranscriptKey,
} from '../session/transcriptFlowModel.js';

const CLIENT_INLINE_CONTEXT_QUESTION = 'Что сейчас находится на открытой странице';

export function useBrowserActionRuntime({
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
  selectedCharacterId,
  sendBrowserClientEvent,
  setBrowserFlowPhase,
  setBrowserPanel,
  usesClientInlinePanel,
  BROWSER_ACTION_TIMEOUT_MS,
}) {
  return React.useCallback(async (actionRequest, transcript = '', { requestId = 0 } = {}) => {
    if (usesClientInlinePanel && browserPanelRef.current?.clientUrl) {
      const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
        ? requestId
        : (normalizeSpeechText(transcript) ? activeDialogRequestRef.current : 0);
      const supportedClientActions = new Set(['back', 'forward', 'home', 'reload']);
      if (!supportedClientActions.has(String(actionRequest?.type || '').trim())) {
        throw new Error('Во встроенной панели сейчас доступны только назад, вперед, главная и обновить.');
      }

      const currentPanel = browserPanelRef.current || DEFAULT_PANEL_STATE;
      const history = Array.isArray(currentPanel.clientHistory) ? currentPanel.clientHistory : [];
      const currentIndex = Number.isInteger(currentPanel.clientHistoryIndex) ? currentPanel.clientHistoryIndex : -1;
      let nextUrl = String(currentPanel.clientUrl || currentPanel.url || '').trim();
      let nextHistory = [...history];
      let nextHistoryIndex = currentIndex;

      if (actionRequest.type === 'back') {
        if (currentIndex <= 0) {
          throw new Error('Назад переходить уже некуда.');
        }
        nextHistoryIndex = currentIndex - 1;
        nextUrl = nextHistory[nextHistoryIndex];
      } else if (actionRequest.type === 'forward') {
        if (currentIndex < 0 || currentIndex >= nextHistory.length - 1) {
          throw new Error('Вперед переходить уже некуда.');
        }
        nextHistoryIndex = currentIndex + 1;
        nextUrl = nextHistory[nextHistoryIndex];
      } else if (actionRequest.type === 'home') {
        nextUrl = String(currentPanel.clientHomeUrl || nextUrl).trim();
        if (!nextUrl) {
          throw new Error('Не знаю, какая страница здесь главная.');
        }
        nextHistory = nextHistory.slice(0, Math.max(0, currentIndex) + 1);
        if (nextHistory[nextHistory.length - 1] !== nextUrl) {
          nextHistory.push(nextUrl);
        }
        nextHistoryIndex = nextHistory.length - 1;
      }

      if (!nextUrl) {
        throw new Error('Не удалось определить адрес страницы для этого действия.');
      }

      setBrowserFlowPhase('opening');
      setBrowserPanel((current) => ({
        ...current,
        status: 'loading',
        browserPanelMode: 'client-inline',
        clientUrl: nextUrl,
        url: nextUrl,
        clientHistory: nextHistory,
        clientHistoryIndex: nextHistoryIndex,
        clientReloadKey: Date.now(),
        clientFrameLoaded: false,
        clientContextStatus: 'loading',
        clientContextError: '',
        error: null,
        note: 'Обновляю страницу внизу.',
      }));
      armPendingClientPanelLoad({
        requestId: effectiveRequestId,
        transcript,
        actionType: 'action',
        targetUrl: nextUrl,
      });
      sendBrowserClientEvent('browser.action.request', {
        browserPanelMode: 'client-inline',
        actionType: actionRequest?.type || '',
        transcript,
        requestId: effectiveRequestId,
        url: nextUrl,
      });
      recordConversationActionRef.current?.('browser.action.request', {
        browserPanelMode: 'client-inline',
        actionType: actionRequest?.type || '',
        transcript,
        requestId: effectiveRequestId,
        url: nextUrl,
      });

      void requestClientInlineContext(nextUrl, CLIENT_INLINE_CONTEXT_QUESTION, {
        requestId: effectiveRequestId,
      })
        .then((contextResult) => {
          if (effectiveRequestId !== activeDialogRequestRef.current) {
            return;
          }
          if (contextResult?.embeddable === false) {
            failPendingClientPanelLoad('Этот сайт запрещает показывать себя внутри панели.', effectiveRequestId);
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
          if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
            pendingClientPanelLoadRef.current.contextReady = true;
          }
          if (pendingClientPanelLoadRef.current?.frameLoaded) {
            finalizePendingClientPanelLoad();
          }
        })
        .catch((contextError) => {
          if (effectiveRequestId !== activeDialogRequestRef.current) {
            return;
          }
          setBrowserPanel((current) => ({
            ...current,
            clientContextStatus: 'error',
            clientContextError: contextError.message || 'Не удалось быстро прочитать страницу.',
            note: current.clientFrameLoaded
              ? 'Сайт открыт внизу. Текст страницы прочитать не удалось.'
              : current.note,
          }));
          if (pendingClientPanelLoadRef.current?.frameLoaded) {
            finalizePendingClientPanelLoad();
          }
        });

      return {
        status: 'ready',
        url: nextUrl,
      };
    }

    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      throw new Error('Нет активного сайта для действия');
    }
    const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
      ? requestId
      : activeDialogRequestRef.current;
    const isStaleRequest = () => effectiveRequestId > 0 && effectiveRequestId !== activeDialogRequestRef.current;
    if (isStaleRequest()) {
      return null;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: 'loading',
      sourceType: 'page-action',
    }));
    cancelAssistantOutputRef.current?.();
    setBrowserFlowPhase('opening');
    sendBrowserClientEvent('browser.action.request', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      transcript,
    });
    recordConversationActionRef.current?.('browser.action.request', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      transcript,
    });

    const actionResult = await jsonRequest(`/api/browser/session/${encodeURIComponent(sessionId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...actionRequest,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacterId || '',
        requestId: effectiveRequestId,
      }),
    }, BROWSER_ACTION_TIMEOUT_MS);
    if (isStaleRequest()) {
      return null;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: 'ready',
      title: actionResult.title || current.title,
      url: actionResult.url || current.url,
      screenshotUrl: actionResult.imageUrl || current.screenshotUrl,
      view: {
        imageUrl: actionResult.imageUrl || '',
        width: actionResult.width || 0,
        height: actionResult.height || 0,
        revision: actionResult.revision || 0,
        actionableElements: Array.isArray(actionResult.actionableElements) ? actionResult.actionableElements : [],
      },
      revision: actionResult.revision || current.revision || 0,
      actionableElements: Array.isArray(actionResult.actionableElements) ? actionResult.actionableElements : current.actionableElements,
      error: null,
    }));
    setBrowserFlowPhase('ready');

    const contextResult = await requestActiveBrowserContext(CLIENT_INLINE_CONTEXT_QUESTION, {
      requestId: effectiveRequestId,
    });
    if (isStaleRequest()) {
      return null;
    }
    sendBrowserClientEvent('browser.action.complete', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      url: contextResult?.url || actionResult?.url || '',
      title: contextResult?.title || actionResult?.title || '',
    });
    if (transcript) {
      enqueueAssistantPromptRef.current?.(
        buildWebActionPrompt(transcript, contextResult, getSessionHistorySummaryRef.current?.() || ''),
        {
          source: 'browser.action.result',
          dedupeKey: `action:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(actionRequest?.type || '')}`,
          requestId: effectiveRequestId,
        },
      );
    }
    return contextResult;
  }, [
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
    selectedCharacterId,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    setBrowserPanel,
    usesClientInlinePanel,
    BROWSER_ACTION_TIMEOUT_MS,
  ]);
}
