export const GEMINI_RUNTIME_PROVIDER = 'gemini-live'
export const YANDEX_REALTIME_PROVIDER = 'yandex-realtime'
export const YANDEX_LEGACY_PROVIDERS = new Set(['yandex-full-legacy', 'yandex-full'])

export function resolveVoiceRuntimeState(runtimeProvider, runtimeProviderOverride = '') {
  const normalizedRuntimeProvider = String(runtimeProvider || GEMINI_RUNTIME_PROVIDER).trim() || GEMINI_RUNTIME_PROVIDER
  const normalizedOverride = String(runtimeProviderOverride || '').trim()
  const effectiveRuntimeProvider = normalizedOverride || normalizedRuntimeProvider
  const usesYandexRealtimeRuntime = effectiveRuntimeProvider === YANDEX_REALTIME_PROVIDER
  const usesYandexLegacyRuntime = YANDEX_LEGACY_PROVIDERS.has(effectiveRuntimeProvider)

  return {
    effectiveRuntimeProvider,
    usesYandexRealtimeRuntime,
    usesYandexLegacyRuntime,
    usesYandexRuntime: usesYandexRealtimeRuntime || usesYandexLegacyRuntime,
  }
}

export function selectVoiceRuntimeSession(sessions, runtimeState) {
  if (runtimeState.usesYandexRealtimeRuntime) {
    return sessions.yandexRealtimeSession
  }

  if (runtimeState.usesYandexLegacyRuntime) {
    return sessions.yandexSession
  }

  return sessions.geminiSession
}
