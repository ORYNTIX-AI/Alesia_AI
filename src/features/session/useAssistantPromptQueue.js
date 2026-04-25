import React from 'react'
import { normalizeSpeechText } from './transcriptFlowModel.js'

const ASSISTANT_QUEUE_TURN_TIMEOUT_MS = 14000
const ASSISTANT_QUEUE_MAX_HARD_TIMEOUT_MS = 38000
const ASSISTANT_QUEUE_RETRY_DELAY_MS = 320

export function useAssistantPromptQueue({
  activeDialogRequestRef,
  assistantTurnStartedAtRef,
  initialized,
  manualStopRef,
  recordConversationAction,
}) {
  const sendTextTurnRef = React.useRef(null)
  const assistantPromptQueueRef = React.useRef([])
  const assistantPromptInFlightRef = React.useRef(false)
  const assistantInFlightRequestIdRef = React.useRef(0)
  const assistantAwaitingResponseRef = React.useRef(false)
  const assistantPromptTimerRef = React.useRef(null)
  const assistantPromptRetryTimerRef = React.useRef(null)
  const assistantPromptSeqRef = React.useRef(0)
  const assistantPromptMetaRef = React.useRef({ source: '', finalizeRequestOnCommit: true })

  const clearAssistantPromptTimer = React.useCallback(() => {
    if (assistantPromptTimerRef.current) {
      clearTimeout(assistantPromptTimerRef.current)
      assistantPromptTimerRef.current = null
    }
  }, [])

  const clearAssistantPromptRetryTimer = React.useCallback(() => {
    if (assistantPromptRetryTimerRef.current) {
      clearTimeout(assistantPromptRetryTimerRef.current)
      assistantPromptRetryTimerRef.current = null
    }
  }, [])

  const drainAssistantPromptQueue = React.useCallback(() => {
    if (assistantPromptInFlightRef.current) {
      return
    }

    clearAssistantPromptRetryTimer()

    let nextPrompt = null
    while (assistantPromptQueueRef.current.length > 0) {
      const candidate = assistantPromptQueueRef.current.shift()
      if (!candidate) {
        continue
      }
      if (
        Number.isInteger(candidate.requestId)
        && candidate.requestId > 0
        && candidate.requestId !== activeDialogRequestRef.current
      ) {
        recordConversationAction('assistant.queue.drop', {
          reason: 'stale-request',
          source: candidate.source || '',
          requestId: candidate.requestId,
          activeRequestId: activeDialogRequestRef.current,
        })
        continue
      }
      nextPrompt = candidate
      break
    }

    if (!nextPrompt) {
      return
    }

    assistantPromptInFlightRef.current = true
    assistantInFlightRequestIdRef.current = nextPrompt.requestId || activeDialogRequestRef.current
    assistantAwaitingResponseRef.current = true
    assistantPromptMetaRef.current = {
      source: nextPrompt.source || '',
      finalizeRequestOnCommit: nextPrompt.finalizeRequestOnCommit !== false,
    }

    const sent = sendTextTurnRef.current?.(nextPrompt.text, {
      interrupt: nextPrompt.interrupt,
      origin: nextPrompt.origin || 'assistant_prompt',
      allowForceHandlers: nextPrompt.allowForceHandlers === true,
    })
    if (!sent) {
      assistantPromptInFlightRef.current = false
      assistantInFlightRequestIdRef.current = 0
      assistantAwaitingResponseRef.current = false
      assistantPromptMetaRef.current = { source: '', finalizeRequestOnCommit: true }
      assistantPromptQueueRef.current.unshift(nextPrompt)
      recordConversationAction('assistant.queue.defer', {
        reason: 'send-failed',
        source: nextPrompt.source || '',
        requestId: nextPrompt.requestId || 0,
      })
      if (!assistantPromptRetryTimerRef.current && !manualStopRef.current && initialized) {
        assistantPromptRetryTimerRef.current = setTimeout(() => {
          assistantPromptRetryTimerRef.current = null
          recordConversationAction('assistant.queue.retry', { reason: 'send-failed' })
          drainAssistantPromptQueue()
        }, ASSISTANT_QUEUE_RETRY_DELAY_MS)
      }
      return
    }

    clearAssistantPromptTimer()
    const handleQueueTurnTimeout = () => {
      const assistantTurnStartedAt = assistantTurnStartedAtRef.current
      const assistantTurnAgeMs = assistantTurnStartedAt > 0 ? (Date.now() - assistantTurnStartedAt) : 0
      if (assistantTurnStartedAt > 0 && assistantTurnAgeMs < ASSISTANT_QUEUE_MAX_HARD_TIMEOUT_MS) {
        assistantPromptTimerRef.current = setTimeout(handleQueueTurnTimeout, ASSISTANT_QUEUE_TURN_TIMEOUT_MS)
        return
      }

      assistantPromptInFlightRef.current = false
      assistantInFlightRequestIdRef.current = 0
      assistantAwaitingResponseRef.current = false
      assistantPromptMetaRef.current = { source: '', finalizeRequestOnCommit: true }
      assistantPromptTimerRef.current = null
      recordConversationAction('assistant.queue.timeout-release', {
        source: nextPrompt.source || '',
        requestId: nextPrompt.requestId || 0,
      })
      drainAssistantPromptQueue()
    }
    assistantPromptTimerRef.current = setTimeout(handleQueueTurnTimeout, ASSISTANT_QUEUE_TURN_TIMEOUT_MS)

    recordConversationAction('assistant.queue.sent', {
      source: nextPrompt.source || '',
      textLength: nextPrompt.text.length,
      queueSize: assistantPromptQueueRef.current.length,
      requestId: nextPrompt.requestId || 0,
    })
  }, [
    activeDialogRequestRef,
    assistantTurnStartedAtRef,
    clearAssistantPromptRetryTimer,
    clearAssistantPromptTimer,
    initialized,
    manualStopRef,
    recordConversationAction,
  ])

  const enqueueAssistantPrompt = React.useCallback((text, {
    interrupt = true,
    priority = 'normal',
    source = 'runtime',
    dedupeKey = '',
    requestId = activeDialogRequestRef.current,
    origin = 'assistant_prompt',
    allowForceHandlers = false,
    finalizeRequestOnCommit = true,
  } = {}) => {
    const normalizedText = normalizeSpeechText(text)
    if (!normalizedText) {
      return false
    }

    const normalizedDedupeKey = normalizeSpeechText(dedupeKey || '').toLowerCase()
    if (normalizedDedupeKey) {
      const duplicateInQueue = assistantPromptQueueRef.current.some(
        (entry) => entry.dedupeKey === normalizedDedupeKey && entry.requestId === requestId,
      )
      if (duplicateInQueue) {
        return false
      }
    }

    const nextEntry = {
      id: `assistant-prompt-${Date.now().toString(36)}-${(assistantPromptSeqRef.current += 1).toString(36)}`,
      text: normalizedText,
      interrupt: Boolean(interrupt),
      source,
      dedupeKey: normalizedDedupeKey,
      requestId: Number.isInteger(requestId) ? requestId : activeDialogRequestRef.current,
      origin,
      allowForceHandlers: allowForceHandlers === true,
      finalizeRequestOnCommit: finalizeRequestOnCommit !== false,
    }

    if (priority === 'high') {
      assistantPromptQueueRef.current.unshift(nextEntry)
    } else {
      assistantPromptQueueRef.current.push(nextEntry)
    }

    recordConversationAction('assistant.queue.enqueue', {
      source,
      textLength: normalizedText.length,
      priority,
      queueSize: assistantPromptQueueRef.current.length,
      requestId: nextEntry.requestId || 0,
    })

    drainAssistantPromptQueue()
    return true
  }, [activeDialogRequestRef, drainAssistantPromptQueue, recordConversationAction])

  const releaseAssistantPromptLock = React.useCallback((reason = 'commit') => {
    assistantPromptInFlightRef.current = false
    assistantInFlightRequestIdRef.current = 0
    assistantAwaitingResponseRef.current = false
    assistantPromptMetaRef.current = { source: '', finalizeRequestOnCommit: true }
    clearAssistantPromptRetryTimer()
    clearAssistantPromptTimer()
    recordConversationAction('assistant.queue.release', { reason })
    drainAssistantPromptQueue()
  }, [clearAssistantPromptRetryTimer, clearAssistantPromptTimer, drainAssistantPromptQueue, recordConversationAction])

  const clearAssistantPromptQueue = React.useCallback((reason = 'reset') => {
    assistantPromptQueueRef.current = []
    assistantPromptInFlightRef.current = false
    assistantInFlightRequestIdRef.current = 0
    assistantAwaitingResponseRef.current = false
    assistantPromptMetaRef.current = { source: '', finalizeRequestOnCommit: true }
    clearAssistantPromptRetryTimer()
    clearAssistantPromptTimer()
    recordConversationAction('assistant.queue.clear', { reason })
  }, [clearAssistantPromptRetryTimer, clearAssistantPromptTimer, recordConversationAction])

  const resetAssistantPromptQueue = React.useCallback(() => {
    assistantPromptQueueRef.current = []
    assistantPromptInFlightRef.current = false
    assistantInFlightRequestIdRef.current = 0
    assistantAwaitingResponseRef.current = false
    assistantPromptMetaRef.current = { source: '', finalizeRequestOnCommit: true }
    assistantPromptSeqRef.current = 0
    clearAssistantPromptRetryTimer()
    clearAssistantPromptTimer()
  }, [clearAssistantPromptRetryTimer, clearAssistantPromptTimer])

  const setSendTextTurn = React.useCallback((sendTextTurn) => {
    sendTextTurnRef.current = sendTextTurn || null
  }, [])

  return {
    assistantAwaitingResponseRef,
    assistantInFlightRequestIdRef,
    assistantPromptInFlightRef,
    assistantPromptMetaRef,
    assistantPromptQueueRef,
    clearAssistantPromptQueue,
    clearAssistantPromptRetryTimer,
    clearAssistantPromptTimer,
    drainAssistantPromptQueue,
    enqueueAssistantPrompt,
    releaseAssistantPromptLock,
    resetAssistantPromptQueue,
    setSendTextTurn,
  }
}
