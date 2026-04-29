import { useEffect, useMemo, useRef } from 'react'
import { useGeminiLive } from '../../hooks/useGeminiLive.js'
import { useYandexRealtimeSession } from '../../hooks/useYandexRealtimeSession.js'
import { useYandexVoiceSession } from '../../hooks/useYandexVoiceSession.js'
import {
  YANDEX_REALTIME_PROVIDER,
  resolveVoiceRuntimeState,
  selectVoiceRuntimeSession,
} from './runtimeSelection.js'

export function shouldUseRealtimeFallback({
  runtimeProvider,
  realtimeFallbackProvider,
  runtimeProviderOverride,
  realtimeStatus,
  realtimeError,
} = {}) {
  const normalizedRealtimeError = String(realtimeError || '').trim().toLowerCase()
  return runtimeProvider === YANDEX_REALTIME_PROVIDER
    && Boolean(realtimeFallbackProvider)
    && !runtimeProviderOverride
    && realtimeStatus === 'error'
    && (
      normalizedRealtimeError.includes('permission denied')
      || normalizedRealtimeError.includes('view model')
      || normalizedRealtimeError.includes('not configured')
      || normalizedRealtimeError.includes('runtime error')
    )
}

export function useVoiceRuntimeAdapters({
  audioPlayer,
  runtimeConfig,
  callbacks,
  runtimeProvider,
  runtimeProviderOverride,
  realtimeFallbackProvider,
  selectedCharacterId,
  onRealtimeFallback,
}) {
  const geminiSession = useGeminiLive(audioPlayer, runtimeConfig, callbacks)
  const yandexSession = useYandexVoiceSession(audioPlayer, runtimeConfig, callbacks)
  const yandexRealtimeSession = useYandexRealtimeSession(audioPlayer, runtimeConfig, callbacks)
  const runtimeState = resolveVoiceRuntimeState(runtimeProvider, runtimeProviderOverride)
  const geminiDisconnectRef = useRef(geminiSession.disconnect)
  const yandexDisconnectRef = useRef(yandexSession.disconnect)
  const yandexRealtimeDisconnectRef = useRef(yandexRealtimeSession.disconnect)

  useEffect(() => {
    geminiDisconnectRef.current = geminiSession.disconnect
  }, [geminiSession.disconnect])

  useEffect(() => {
    yandexDisconnectRef.current = yandexSession.disconnect
  }, [yandexSession.disconnect])

  useEffect(() => {
    yandexRealtimeDisconnectRef.current = yandexRealtimeSession.disconnect
  }, [yandexRealtimeSession.disconnect])

  const sessions = useMemo(() => ({
    geminiSession,
    yandexSession,
    yandexRealtimeSession,
  }), [geminiSession, yandexRealtimeSession, yandexSession])
  const activeSession = useMemo(
    () => selectVoiceRuntimeSession(sessions, runtimeState),
    [runtimeState, sessions],
  )

  useEffect(() => {
    const shouldFallback = shouldUseRealtimeFallback({
      runtimeProvider,
      realtimeFallbackProvider,
      runtimeProviderOverride,
      realtimeStatus: yandexRealtimeSession.status,
      realtimeError: yandexRealtimeSession.error,
    })

    if (!shouldFallback) {
      return
    }

    onRealtimeFallback?.({
      from: runtimeProvider,
      to: realtimeFallbackProvider,
      reason: String(yandexRealtimeSession.error || '').trim(),
      characterId: selectedCharacterId || '',
    })
  }, [
    onRealtimeFallback,
    realtimeFallbackProvider,
    runtimeProvider,
    runtimeProviderOverride,
    selectedCharacterId,
    yandexRealtimeSession.error,
    yandexRealtimeSession.status,
  ])

  useEffect(() => {
    if (runtimeState.usesYandexRealtimeRuntime) {
      geminiDisconnectRef.current?.()
      yandexDisconnectRef.current?.()
      return
    }

    if (runtimeState.usesYandexLegacyRuntime) {
      geminiDisconnectRef.current?.()
      yandexRealtimeDisconnectRef.current?.()
      return
    }

    yandexDisconnectRef.current?.()
    yandexRealtimeDisconnectRef.current?.()
  }, [
    runtimeState.usesYandexLegacyRuntime,
    runtimeState.usesYandexRealtimeRuntime,
  ])

  return {
    ...runtimeState,
    geminiSession,
    yandexSession,
    yandexRealtimeSession,
    activeSession,
  }
}
