import React from 'react';
import {
  buildSessionHistorySummary,
  sanitizeTesterEventDetails,
  truncatePromptValue,
} from './transcriptFlowModel.js';

const MAX_SESSION_WEB_HISTORY_ENTRIES = 8;
const MAX_TESTER_EVENTS = 80;

export function useConversationTelemetry({
  conversationSessionIdRef,
  recordConversationActionRef,
  selectedCharacterId,
  showDropReasons,
}) {
  const [testerEvents, setTesterEvents] = React.useState([]);
  const [lastIssueText, setLastIssueText] = React.useState('');

  const sessionWebHistoryRef = React.useRef([]);
  const testerEventsRef = React.useRef([]);
  const dialogRequestStatesRef = React.useRef(new Map());

  const appendSessionWebHistory = React.useCallback((entry) => {
    const normalizedEntry = {
      status: entry?.status === 'failed' ? 'failed' : 'opened',
      transcript: truncatePromptValue(entry?.transcript || '', 220),
      title: truncatePromptValue(entry?.title || '', 180),
      url: truncatePromptValue(entry?.url || '', 240),
      note: truncatePromptValue(entry?.note || '', 220),
      timestamp: Date.now(),
    };

    sessionWebHistoryRef.current = [
      ...sessionWebHistoryRef.current,
      normalizedEntry,
    ].slice(-MAX_SESSION_WEB_HISTORY_ENTRIES);
  }, []);

  const getSessionHistorySummary = React.useCallback(
    () => buildSessionHistorySummary(sessionWebHistoryRef.current),
    [],
  );

  const getSessionHistoryPayload = React.useCallback(
    () => sessionWebHistoryRef.current.map((entry) => ({
      status: entry.status,
      transcript: entry.transcript,
      title: entry.title,
      url: entry.url,
      note: entry.note,
      timestamp: entry.timestamp,
    })),
    [],
  );

  const pushTesterEvent = React.useCallback((event, details = {}) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      event: String(event || '').trim() || 'runtime.event',
      details: sanitizeTesterEventDetails(details),
    };

    const nextEvents = [
      ...testerEventsRef.current,
      entry,
    ].slice(-MAX_TESTER_EVENTS);
    testerEventsRef.current = nextEvents;
    setTesterEvents(nextEvents);

    if (
      showDropReasons
      && (
        entry.event.includes('drop')
        || entry.event.includes('error')
        || entry.event.includes('closed')
        || entry.event.includes('silent')
      )
    ) {
      const reason = String(entry.details.reason || entry.details.error || entry.event).trim();
      setLastIssueText(reason || entry.event);
    }
  }, [showDropReasons]);

  const recordConversationAction = React.useCallback((event, details = {}) => {
    pushTesterEvent(event, details);
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        details,
        characterId: selectedCharacterId || '',
      }),
    }).catch(() => {});
  }, [conversationSessionIdRef, pushTesterEvent, selectedCharacterId]);

  React.useEffect(() => {
    recordConversationActionRef.current = recordConversationAction;
  }, [recordConversationAction, recordConversationActionRef]);

  const markDialogRequestState = React.useCallback((requestId, state, details = {}) => {
    const safeRequestId = Number(requestId);
    if (!Number.isInteger(safeRequestId) || safeRequestId <= 0) {
      return;
    }

    const nextState = {
      ...(dialogRequestStatesRef.current.get(safeRequestId) || {}),
      requestId: safeRequestId,
      state,
      updatedAt: Date.now(),
      ...details,
    };
    dialogRequestStatesRef.current.set(safeRequestId, nextState);
    recordConversationAction('runtime.request.state', {
      requestId: safeRequestId,
      state,
      ...details,
    });
  }, [recordConversationAction]);

  const finalizeDialogRequest = React.useCallback((requestId, outcome, details = {}) => {
    const safeRequestId = Number(requestId);
    if (!Number.isInteger(safeRequestId) || safeRequestId <= 0) {
      return;
    }

    const existing = dialogRequestStatesRef.current.get(safeRequestId) || null;
    if (existing?.finalized) {
      return;
    }

    const nextState = {
      ...(existing || {}),
      requestId: safeRequestId,
      finalized: true,
      outcome,
      finalizedAt: Date.now(),
      ...details,
    };
    dialogRequestStatesRef.current.set(safeRequestId, nextState);
    recordConversationAction('runtime.request.final', {
      requestId: safeRequestId,
      outcome,
      ...details,
    });
  }, [recordConversationAction]);

  const clearTesterEvents = React.useCallback(() => {
    testerEventsRef.current = [];
    setTesterEvents([]);
    setLastIssueText('');
  }, []);

  const resetConversationTelemetry = React.useCallback(() => {
    sessionWebHistoryRef.current = [];
    dialogRequestStatesRef.current = new Map();
  }, []);

  return {
    appendSessionWebHistory,
    clearTesterEvents,
    dialogRequestStatesRef,
    finalizeDialogRequest,
    getSessionHistoryPayload,
    getSessionHistorySummary,
    lastIssueText,
    markDialogRequestState,
    pushTesterEvent,
    recordConversationAction,
    resetConversationTelemetry,
    sessionWebHistoryRef,
    setLastIssueText,
    testerEvents,
    testerEventsRef,
  };
}
