import { useEffect, useMemo } from 'react'
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
      geminiSession.disconnect?.()
      yandexSession.disconnect?.()
      return
    }

    if (runtimeState.usesYandexLegacyRuntime) {
      geminiSession.disconnect?.()
      yandexRealtimeSession.disconnect?.()
      return
    }

    yandexSession.disconnect?.()
    yandexRealtimeSession.disconnect?.()
  }, [
    geminiSession,
    runtimeState.usesYandexLegacyRuntime,
    runtimeState.usesYandexRealtimeRuntime,
    yandexRealtimeSession,
    yandexSession,
  ])

  return {
    ...runtimeState,
    geminiSession,
    yandexSession,
    yandexRealtimeSession,
    activeSession,
  }
}
