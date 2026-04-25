export const TESTER_SETTINGS_STORAGE_KEY = 'alesia-tester-settings-v1'

export const DEFAULT_TESTER_SETTINGS = Object.freeze({
  pauseMs: 420,
  interruptHoldMs: 220,
  echoGuard: 62,
  firstReplySentences: 1,
  memoryTurnCount: 6,
  autoReconnect: true,
  showPartialTranscript: true,
  showDropReasons: true,
})

export function clampNumber(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, numeric))
}

export function normalizeTesterSettings(rawValue = {}) {
  const settings = rawValue && typeof rawValue === 'object' ? rawValue : {}
  return {
    pauseMs: clampNumber(settings.pauseMs, 260, 900, DEFAULT_TESTER_SETTINGS.pauseMs),
    interruptHoldMs: clampNumber(settings.interruptHoldMs, 120, 640, DEFAULT_TESTER_SETTINGS.interruptHoldMs),
    echoGuard: clampNumber(settings.echoGuard, 0, 100, DEFAULT_TESTER_SETTINGS.echoGuard),
    firstReplySentences: clampNumber(settings.firstReplySentences, 1, 3, DEFAULT_TESTER_SETTINGS.firstReplySentences),
    memoryTurnCount: clampNumber(settings.memoryTurnCount, 2, 12, DEFAULT_TESTER_SETTINGS.memoryTurnCount),
    autoReconnect: settings.autoReconnect !== false,
    showPartialTranscript: settings.showPartialTranscript !== false,
    showDropReasons: settings.showDropReasons !== false,
  }
}

export function loadTesterSettings() {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_TESTER_SETTINGS }
  }

  try {
    const raw = window.localStorage.getItem(TESTER_SETTINGS_STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_TESTER_SETTINGS }
    }
    return normalizeTesterSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_TESTER_SETTINGS }
  }
}

export function saveTesterSettings(nextSettings) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      TESTER_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeTesterSettings(nextSettings)),
    )
  } catch {
    // Ignore local persistence failures in demo mode.
  }
}
