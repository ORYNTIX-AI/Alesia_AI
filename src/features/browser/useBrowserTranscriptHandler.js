import React from 'react';
import {
  DEFAULT_PANEL_STATE,
  buildClientPanelState,
  shouldPreferRemoteBrowserTransport,
} from './browserPanelModel.js';
import {
  buildBrowserIntentKey,
  buildBrowserOpeningAckPrompt,
  buildEarlyBrowserLoadingTitle,
  buildWebActivePrompt,
  buildWebClientPendingPrompt,
  buildWebFailurePrompt,
  buildWebOpenPendingPrompt,
  buildWebResultPrompt,
  classifyBrowserOpenErrorReason,
  classifyIntentErrorReason,
  classifyTranscriptIntent,
  hasExplicitMainPageSiteTarget,
  isAssistantBrowserNarration,
  isSimilarIntentKey,
  jsonRequest,
  normalizeSpeechText,
  normalizeTranscriptKey,
  parseBrowserActionRequest,
  parseImplicitBrowserActionRequest,
  truncatePromptValue,
  waitForNextPaint,
} from '../session/transcriptFlowModel.js';

const CLIENT_INLINE_CONTEXT_QUESTION = 'Что сейчас находится на открытой странице';

export function useBrowserTranscriptHandler({
  activeBrowserSessionIdRef,
  activeDialogRequestRef,
  appendSessionWebHistoryRef,
  armPendingClientPanelLoad,
  conversationSessionIdRef,
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
}) {
  return React.useCallback(async (transcript, {
    requestId: dialogRequestId = 0,
    suppressOpeningAck = false,
  } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    const effectiveRequestId = Number.isInteger(dialogRequestId) && dialogRequestId > 0
      ? dialogRequestId
      : activeDialogRequestRef.current;
    if (!normalized) {
      return;
    }
    if (effectiveRequestId !== activeDialogRequestRef.current) {
      return;
    }

    markDialogRequestStateRef.current?.(effectiveRequestId, 'browser-routing', {
      transcript: truncatePromptValue(normalized, 180),
    });
    recordConversationActionRef.current?.('browser.intent.input', {
      requestId: effectiveRequestId,
      transcript: truncatePromptValue(normalized, 180),
    });

    if (isAssistantBrowserNarration(normalized)) {
      recordConversationActionRef.current?.('browser.intent.skipped', {
        requestId: effectiveRequestId,
        reason: 'assistant-browser-narration',
      });
      return;
    }

    const hasClientInlineSession = usesClientInlinePanel && Boolean(browserPanelRef.current?.clientUrl);
    const hasActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current);
    const hasAnyBrowserSession = hasActiveBrowserSession || hasClientInlineSession;
    let intentType = classifyTranscriptIntent(normalized, { hasActiveBrowserSession: hasAnyBrowserSession });

    if (hasAnyBrowserSession && parseImplicitBrowserActionRequest(normalized)) {
      intentType = 'browser_action';
    }
    recordConversationActionRef.current?.('browser.intent.classified', {
      requestId: effectiveRequestId,
      intentType,
      hasActiveBrowserSession: hasAnyBrowserSession,
    });

    if (intentType === 'browser_action') {
      let browserActionRequest = parseBrowserActionRequest(normalized);
      if (!browserActionRequest && hasActiveBrowserSession) {
        browserActionRequest = parseImplicitBrowserActionRequest(normalized);
      }
      if (!browserActionRequest || browserIntentInFlightRef.current) {
        return;
      }

      if (!activeBrowserSessionIdRef.current && !hasClientInlineSession) {
        const canFallbackToSiteOpen = browserActionRequest.type === 'home'
          && (
            hasExplicitMainPageSiteTarget(normalized)
            || /\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(normalized)
            || /\bhttps?:\/\/[^\s]+/i.test(normalized)
            || /\bточка\s*(?:by|ru)\b/i.test(normalized)
          );
        if (canFallbackToSiteOpen) {
          intentType = 'site_open';
        } else {
          const errorText = 'Сейчас сайт не открыт. Укажите, какой сайт открыть.';
          setBrowserFlowPhase('error');
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: errorText,
          });
          enqueueAssistantPromptRef.current?.(
            buildWebFailurePrompt(normalized, errorText, getSessionHistorySummaryRef.current?.() || ''),
            {
              source: 'browser.action.no-session',
              dedupeKey: `browser-action-no-session:${normalizeTranscriptKey(normalized)}`,
              requestId: effectiveRequestId,
            },
          );
          finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-no-session');
          return;
        }
      }

      if (activeBrowserSessionIdRef.current || hasClientInlineSession) {
        browserIntentInFlightRef.current = true;
        inFlightBrowserKeyRef.current = 'page-action';
        clearAssistantPromptQueueRef.current?.('browser-action');
        cancelAssistantOutputRef.current?.();
        try {
          await performBrowserAction(browserActionRequest, normalized, { requestId: effectiveRequestId });
        } catch (actionError) {
          setBrowserFlowPhase('error');
          setBrowserPanel((current) => ({
            ...current,
            status: 'error',
            error: actionError.message || 'Не удалось выполнить действие на странице',
          }));
          enqueueAssistantPromptRef.current?.(
            buildWebFailurePrompt(
              normalized,
              actionError.message || 'Не удалось выполнить действие на странице',
              getSessionHistorySummaryRef.current?.() || '',
            ),
            {
              source: 'browser.action.error',
              dedupeKey: `browser-action-error:${normalizeTranscriptKey(normalized)}`,
              requestId: effectiveRequestId,
            },
          );
        } finally {
          browserIntentInFlightRef.current = false;
          inFlightBrowserKeyRef.current = '';
        }
        return;
      }
    }

    if (intentType === 'page_query') {
      if ((!activeBrowserSessionIdRef.current && !hasClientInlineSession) || browserIntentInFlightRef.current) {
        const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;
        if (
          browserIntentInFlightRef.current
          || panelState.status === 'loading'
          || panelState.clientContextStatus === 'loading'
        ) {
          enqueueAssistantPromptRef.current?.(
            buildWebOpenPendingPrompt(normalized, panelState, getSessionHistorySummaryRef.current?.() || ''),
            {
              source: 'browser.followup.pending',
              dedupeKey: `browser-followup-pending:${normalizeTranscriptKey(normalized)}`,
              requestId: effectiveRequestId,
            },
          );
          markDialogRequestStateRef.current?.(effectiveRequestId, 'browser-followup-pending');
        }
        return;
      }

      browserIntentInFlightRef.current = true;
      inFlightBrowserKeyRef.current = 'context-followup';
      clearAssistantPromptQueueRef.current?.('browser-followup');
      cancelAssistantOutputRef.current?.();
      sendBrowserClientEvent('browser.followup.started', {
        browserSessionId: activeBrowserSessionIdRef.current,
        question: normalized,
      });

      try {
        if (hasClientInlineSession) {
          const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;
          if (panelState.status === 'loading' || panelState.clientContextStatus === 'loading') {
            enqueueAssistantPromptRef.current?.(
              buildWebClientPendingPrompt(normalized, panelState, getSessionHistorySummaryRef.current?.() || ''),
              {
                source: 'browser.followup.pending',
                dedupeKey: `browser-followup-pending:${normalizeTranscriptKey(normalized)}`,
                requestId: effectiveRequestId,
              },
            );
            markDialogRequestStateRef.current?.(effectiveRequestId, 'browser-followup-pending');
            return;
          }
        }

        const contextResult = hasClientInlineSession
          ? await requestClientInlineContext(browserPanelRef.current?.clientUrl, normalized, {
            requestId: effectiveRequestId,
          })
          : await requestActiveBrowserContext(normalized, {
            requestId: effectiveRequestId,
          });
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }
        sendBrowserClientEvent('browser.followup.ready', {
          browserSessionId: contextResult?.browserSessionId || activeBrowserSessionIdRef.current,
          url: contextResult?.url || '',
          title: contextResult?.title || '',
          browserPanelMode: hasClientInlineSession ? 'client-inline' : 'remote',
        });
        enqueueAssistantPromptRef.current?.(
          buildWebActivePrompt(normalized, contextResult, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.followup.ready',
            dedupeKey: `browser-followup:${normalizeTranscriptKey(normalized)}`,
            requestId: effectiveRequestId,
          },
        );
        markDialogRequestStateRef.current?.(effectiveRequestId, 'browser-followup-ready');
      } catch (contextError) {
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }
        const message = contextError.message || 'Не удалось прочитать текущую страницу';
        sendBrowserClientEvent('browser.followup.error', {
          browserSessionId: activeBrowserSessionIdRef.current,
          browserPanelMode: hasClientInlineSession ? 'client-inline' : 'remote',
          question: normalized,
          error: message,
        });
        enqueueAssistantPromptRef.current?.(
          buildWebFailurePrompt(normalized, message, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.followup.error',
            dedupeKey: `browser-followup-error:${normalizeTranscriptKey(normalized)}`,
            requestId: effectiveRequestId,
          },
        );
        finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-followup-error');
      } finally {
        browserIntentInFlightRef.current = false;
        inFlightBrowserKeyRef.current = '';
      }
      return;
    }

    if (intentType !== 'site_open') {
      recordConversationActionRef.current?.('browser.intent.skipped', {
        requestId: effectiveRequestId,
        reason: 'not-site-open',
        intentType,
      });
      return;
    }

    const dedupeKey = buildBrowserIntentKey(normalized);
    const now = Date.now();
    const lastBrowserCommand = lastBrowserCommandRef.current;
    const isEchoOfRecentBrowserAction = (
      now < browserSpeechGuardUntilRef.current
      && Boolean(lastBrowserCommand.key)
      && isSimilarIntentKey(dedupeKey, lastBrowserCommand.key)
    );

    const browserOpenAlreadyRunning = browserFlowStateRef.current === 'intent_pending'
      || browserFlowStateRef.current === 'opening'
      || browserPanelRef.current?.status === 'loading';
    if (isEchoOfRecentBrowserAction || browserIntentInFlightRef.current || browserOpenAlreadyRunning) {
      recordConversationActionRef.current?.('browser.intent.skipped', {
        requestId: effectiveRequestId,
        reason: browserOpenAlreadyRunning ? 'open-already-running' : (browserIntentInFlightRef.current ? 'intent-in-flight' : 'recent-echo'),
        intentType,
      });
      if (browserOpenAlreadyRunning) {
        recordConversationActionRef.current?.('browser.open.duplicate-ignored', {
          requestId: effectiveRequestId,
          transcript: truncatePromptValue(normalized, 160),
          browserFlowState: browserFlowStateRef.current,
        });
      }
      return;
    }

    handledTranscriptsRef.current = handledTranscriptsRef.current.filter((entry) => now - entry.timestamp < 15000);
    if (handledTranscriptsRef.current.some((entry) => isSimilarIntentKey(entry.key, dedupeKey))) {
      recordConversationActionRef.current?.('browser.intent.skipped', {
        requestId: effectiveRequestId,
        reason: 'dedupe-window',
        intentType,
      });
      return;
    }

    const hadActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current);
    browserIntentInFlightRef.current = true;
    inFlightBrowserKeyRef.current = dedupeKey;
    clearAssistantPromptQueueRef.current?.('browser-site-intent');
    cancelAssistantOutputRef.current?.();
    handledTranscriptsRef.current.push({ key: dedupeKey, timestamp: now });
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    browserFlowRequestIdRef.current = requestId;
    markDialogRequestStateRef.current?.(effectiveRequestId, 'browser-intent-started', { browserRequestId: requestId });
    setBrowserFlowPhase('intent_pending');
    setBrowserPanel((current) => ({
      ...current,
      status: 'loading',
      title: buildEarlyBrowserLoadingTitle(normalized),
      sourceType: 'intent-pending',
      error: null,
    }));
    browserTraceCounterRef.current += 1;
    const traceId = `browser-${Date.now().toString(36)}-${browserTraceCounterRef.current.toString(36)}`;
    sendBrowserClientEvent('browser.intent.started', {
      requestId,
      traceId,
      transcript: normalized,
      dedupeKey,
      activeCharacterId: selectedCharacter?.id || '',
      dialogRequestId: effectiveRequestId,
    });

    try {
      let intent;
      try {
        intent = await detectBrowserIntentWithRetry({
          requestId,
          traceId,
          transcript: normalized,
          dedupeKey,
        });
      } catch (requestError) {
        if (browserFlowRequestIdRef.current !== requestId) {
          return;
        }
        const liveDialogRequestId = activeDialogRequestRef.current || effectiveRequestId;
        browserFlowRequestIdRef.current = 0;
        browserSpeechGuardUntilRef.current = now + 2500;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({ ...current, status: 'ready', error: null }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
        }
        const errorReason = classifyIntentErrorReason(requestError);
        const errorMessage = errorReason === 'resolve_timeout'
          ? 'Не успела определить сайт вовремя. Повторите запрос точнее.'
          : (requestError.message || 'Не удалось определить browser intent');
        if (!(hadActiveBrowserSession && activeBrowserSessionIdRef.current)) {
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: errorMessage,
          });
        }
        sendBrowserClientEvent('browser.intent.error', {
          requestId,
          traceId,
          transcript: normalized,
          error: errorMessage,
          errorReason,
        });
        enqueueAssistantPromptRef.current?.(
          buildWebFailurePrompt(normalized, errorMessage, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.intent.error',
            dedupeKey: `browser-intent-error:${normalizeTranscriptKey(normalized)}`,
            requestId: liveDialogRequestId,
            finalizeRequestOnCommit: liveDialogRequestId === effectiveRequestId,
          },
        );
        finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-intent-error', { browserRequestId: requestId });
        return;
      }

      if (browserFlowRequestIdRef.current !== requestId) {
        return;
      }

      sendBrowserClientEvent('browser.intent.result', {
        requestId,
        traceId,
        intentType: intent?.intentType || intent?.type || 'none',
        url: intent?.url || '',
        confidence: intent?.confidence ?? 0,
        confidenceMargin: intent?.confidenceMargin ?? 0,
        resolutionSource: intent?.resolutionSource || '',
        candidateCount: intent?.candidateCount ?? 0,
      });
      recordConversationActionRef.current?.('browser.intent.classified', {
        requestId,
        traceId,
        intentType: intent?.intentType || intent?.type || 'none',
        url: intent?.url || '',
        confidence: intent?.confidence ?? 0,
        resolutionSource: intent?.resolutionSource || '',
      });

      if (!intent || intent.type === 'none') {
        browserFlowRequestIdRef.current = 0;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({ ...current, status: 'ready', error: null }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: 'Не получилось понять, какой сайт или страницу нужно открыть.',
          });
        }
        sendBrowserClientEvent('browser.intent.unresolved', {
          requestId,
          traceId,
          transcript: normalized,
        });
        enqueueAssistantPromptRef.current?.(
          buildWebFailurePrompt(
            normalized,
            'Не получилось понять, какой сайт или страницу нужно открыть.',
            getSessionHistorySummaryRef.current?.() || '',
          ),
          {
            source: 'browser.intent.none',
            dedupeKey: `browser-intent-none:${normalizeTranscriptKey(normalized)}`,
            requestId: activeDialogRequestRef.current || effectiveRequestId,
            finalizeRequestOnCommit: (activeDialogRequestRef.current || effectiveRequestId) === effectiveRequestId,
          },
        );
        finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-intent-unresolved', { browserRequestId: requestId });
        return;
      }

      if (intent.type === 'unresolved-site') {
        browserFlowRequestIdRef.current = 0;
        browserSpeechGuardUntilRef.current = now + 2500;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({ ...current, status: 'ready', error: null }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
        }
        appendSessionWebHistoryRef.current?.({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          note: intent.error || 'Не удалось определить сайт',
        });
        if (!(hadActiveBrowserSession && activeBrowserSessionIdRef.current)) {
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: intent.error || 'Не распознала сайт',
          });
        }
        sendBrowserClientEvent('browser.intent.unresolved', {
          requestId,
          traceId,
          transcript: normalized,
          error: intent.error || 'Не распознала сайт',
          errorReason: intent.errorReason || 'resolve_low_confidence',
        });
        enqueueAssistantPromptRef.current?.(
          buildWebFailurePrompt(normalized, intent.error, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.intent.unresolved',
            dedupeKey: `browser-intent-unresolved:${normalizeTranscriptKey(normalized)}`,
            requestId: activeDialogRequestRef.current || effectiveRequestId,
            finalizeRequestOnCommit: (activeDialogRequestRef.current || effectiveRequestId) === effectiveRequestId,
          },
        );
        finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-intent-unresolved', { browserRequestId: requestId });
        return;
      }

      const resolvedTraceId = intent.traceId || traceId;
      const useClientInlineTransport = usesClientInlinePanel
        && !shouldPreferRemoteBrowserTransport(intent.url || '', selectedCharacter?.browserPanelMode || 'remote');
      lastBrowserCommandRef.current = { key: dedupeKey, transcript: normalized, timestamp: now };
      browserSpeechGuardUntilRef.current = now + 6000;
      setBrowserFlowPhase('opening');
      setBrowserPanel((current) => ({
        ...buildClientPanelState(intent, current, {
          status: 'loading',
          note: useClientInlineTransport
            ? 'Открываю сайт внизу.'
            : 'Открываю сайт у пользователя.',
          browserPanelMode: useClientInlineTransport ? 'client-inline' : 'remote',
        }),
        error: null,
      }));
      if (!suppressOpeningAck) {
        enqueueAssistantPromptRef.current?.(buildBrowserOpeningAckPrompt(normalized), {
          source: 'browser.open.ack',
          dedupeKey: `browser-open-ack:${normalizeTranscriptKey(normalized)}:${normalizeTranscriptKey(intent.url || '')}`,
          requestId: effectiveRequestId,
          priority: 'high',
          finalizeRequestOnCommit: false,
        });
      }
      sendBrowserClientEvent('browser.opening', {
        requestId,
        traceId: resolvedTraceId,
        url: intent.url || '',
        sourceType: intent.sourceType || intent.type || '',
        browserPanelMode: useClientInlineTransport ? 'client-inline' : 'remote',
      });
      recordConversationActionRef.current?.('browser.open.started', {
        requestId,
        traceId: resolvedTraceId,
        url: intent.url || '',
        browserPanelMode: useClientInlineTransport ? 'client-inline' : 'remote',
      });

      if (useClientInlineTransport) {
        setActiveBrowserSessionId('');
        activeBrowserSessionIdRef.current = '';
        armPendingClientPanelLoad({
          requestId: effectiveRequestId,
          transcript: normalized,
          actionType: 'open',
          targetUrl: intent.url || '',
        });

        void requestClientInlineContext(intent.url || '', CLIENT_INLINE_CONTEXT_QUESTION, {
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
              if (pendingClientPanelLoadRef.current.frameLoaded) {
                finalizePendingClientPanelLoad();
              }
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
            if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
              if (pendingClientPanelLoadRef.current.frameLoaded) {
                finalizePendingClientPanelLoad();
              }
            }
          });
        return;
      }

      try {
        const opened = await jsonRequest('/api/browser/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...intent,
            traceId: resolvedTraceId,
            conversationSessionId: conversationSessionIdRef.current || '',
            characterId: selectedCharacter?.id || '',
            requestId: effectiveRequestId,
          }),
        }, BROWSER_OPEN_TIMEOUT_MS);

        if (browserRequestIdRef.current !== requestId) {
          return;
        }

        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        const nextSessionId = String(opened?.browserSessionId || '');
        if (!nextSessionId) {
          throw new Error('Сервер не передал данные открытого сайта. Проверьте подключение API.');
        }
        setBrowserFlowPhase('ready');
        setBrowserPanel((current) => ({
          ...current,
          ...opened,
          status: 'ready',
          view: opened.view || current.view || null,
          revision: opened.revision || current.revision || 0,
          actionableElements: Array.isArray(opened?.view?.actionableElements)
            ? opened.view.actionableElements
            : (current.actionableElements || []),
          error: null,
        }));
        setActiveBrowserSessionId(nextSessionId);
        activeBrowserSessionIdRef.current = nextSessionId;
        await waitForNextPaint();
        let confirmedOpen = { ...opened };
        let panelConfirmed = Boolean(opened?.view?.imageUrl || opened?.screenshotUrl || opened?.browserSessionId);
        try {
          const view = await jsonRequest(
            `/api/browser/session/${encodeURIComponent(nextSessionId)}/view?refresh=1`,
            { method: 'GET' },
            BROWSER_ACTION_TIMEOUT_MS,
          );
          if (browserRequestIdRef.current !== requestId) {
            return;
          }
          confirmedOpen = {
            ...confirmedOpen,
            ...view,
            browserSessionId: nextSessionId,
            screenshotUrl: view.imageUrl || confirmedOpen.screenshotUrl || null,
            view: {
              imageUrl: view.imageUrl || '',
              width: view.width || 0,
              height: view.height || 0,
              revision: view.revision || 0,
              actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
            },
          };
          panelConfirmed = true;
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
            error: null,
          }));
          await waitForNextPaint();
        } catch (viewError) {
          recordConversationActionRef.current?.('browser.open.view-warning', {
            requestId,
            browserSessionId: nextSessionId,
            error: viewError.message || 'browser view refresh failed',
          });
        }
        appendSessionWebHistoryRef.current?.({
          status: 'opened',
          transcript: normalized,
          title: confirmedOpen.title || intent.titleHint || 'Сайт',
          url: confirmedOpen.url || intent.url,
          note: confirmedOpen.query || '',
        });
        sendBrowserClientEvent('browser.open.ready', {
          requestId,
          traceId: resolvedTraceId,
          browserSessionId: nextSessionId,
          title: confirmedOpen?.title || '',
          url: confirmedOpen?.url || '',
          embeddable: Boolean(confirmedOpen?.embeddable),
          panelConfirmed,
        });
        recordConversationActionRef.current?.('browser.open.result', {
          requestId,
          traceId: resolvedTraceId,
          status: 'ready',
          browserSessionId: nextSessionId,
          title: truncatePromptValue(confirmedOpen?.title || '', 120),
          url: confirmedOpen?.url || '',
          panelConfirmed,
        });
        const liveDialogRequestId = activeDialogRequestRef.current || effectiveRequestId;
        const resultBelongsToOriginalRequest = liveDialogRequestId === effectiveRequestId;
        markDialogRequestStateRef.current?.(resultBelongsToOriginalRequest ? effectiveRequestId : liveDialogRequestId, 'browser-open-ready', {
          browserRequestId: requestId,
          browserSessionId: nextSessionId,
          panelConfirmed,
          originalRequestId: effectiveRequestId,
        });
        enqueueAssistantPromptRef.current?.(
          panelConfirmed
            ? buildWebResultPrompt(normalized, confirmedOpen, getSessionHistorySummaryRef.current?.() || '')
            : buildWebOpenPendingPrompt(normalized, confirmedOpen, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.open.ready',
            dedupeKey: `browser-open-ready:${normalizeTranscriptKey(normalized)}`,
            requestId: liveDialogRequestId,
            finalizeRequestOnCommit: resultBelongsToOriginalRequest,
          },
        );
      } catch (requestError) {
        if (browserRequestIdRef.current !== requestId) {
          return;
        }

        const liveDialogRequestId = activeDialogRequestRef.current || effectiveRequestId;
        const errorBelongsToOriginalRequest = liveDialogRequestId === effectiveRequestId;
        const errorReason = classifyBrowserOpenErrorReason(requestError);
        const errorText = requestError.message || 'Не удалось открыть страницу';
        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        setBrowserFlowPhase('ready');
        setActiveBrowserSessionId('');
        appendSessionWebHistoryRef.current?.({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          url: intent.url || '',
          note: errorText,
        });
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          browserPanelMode: 'remote',
          error: errorText,
        });
        sendBrowserClientEvent('browser.open.error', {
          requestId,
          traceId: resolvedTraceId,
          url: intent.url || '',
          error: errorText,
          errorReason,
        });
        recordConversationActionRef.current?.('browser.open.result', {
          requestId,
          traceId: resolvedTraceId,
          status: 'error',
          url: intent.url || '',
          error: truncatePromptValue(errorText, 180),
          errorReason,
        });
        enqueueAssistantPromptRef.current?.(
          buildWebFailurePrompt(normalized, errorText, getSessionHistorySummaryRef.current?.() || ''),
          {
            source: 'browser.open.error',
            dedupeKey: `browser-open-error:${normalizeTranscriptKey(normalized)}`,
            requestId: liveDialogRequestId,
            finalizeRequestOnCommit: errorBelongsToOriginalRequest,
          },
        );
        if (errorBelongsToOriginalRequest) {
          finalizeDialogRequestRef.current?.(effectiveRequestId, 'browser-open-error', {
            browserRequestId: requestId,
            errorReason,
          });
        }
      }
    } finally {
      browserIntentAbortRef.current?.abort?.();
      browserIntentAbortRef.current = null;
      if (browserFlowRequestIdRef.current === requestId) {
        browserFlowRequestIdRef.current = 0;
      }
      browserIntentInFlightRef.current = false;
      inFlightBrowserKeyRef.current = '';
    }
  }, [
    activeBrowserSessionIdRef,
    activeDialogRequestRef,
    appendSessionWebHistoryRef,
    armPendingClientPanelLoad,
    conversationSessionIdRef,
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
  ]);
}
