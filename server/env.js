function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

const DEFAULT_GEMINI_31_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview'

function parseNumber(value, fallback, { min = Number.NEGATIVE_INFINITY } = {}) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(min, numeric)
}

function normalizeGeminiModel(value, fallback = DEFAULT_GEMINI_31_LIVE_MODEL) {
  const normalized = normalizeWhitespace(value)
  const modelCode = normalized.replace(/^models\//, '')
  if (!normalized || (modelCode.startsWith('gemini-') && !modelCode.startsWith('gemini-3.1-'))) {
    return fallback
  }
  return normalized
}

export function loadServerEnv(env = process.env) {
  const proxyScheme = normalizeWhitespace(env.PROXY_SCHEME || 'socks5h').toLowerCase() || 'socks5h'
  const proxyHost = normalizeWhitespace(env.PROXY_HOST || '')
  const proxyPort = parseNumber(env.PROXY_PORT || 0, 0, { min: 0 })
  const proxyUser = normalizeWhitespace(env.PROXY_USER || '')
  const proxyPass = normalizeWhitespace(env.PROXY_PASS || '')
  const encodedProxyUser = encodeURIComponent(proxyUser)
  const encodedProxyPass = encodeURIComponent(proxyPass)
  const proxyAuth = proxyUser && proxyPass ? `${encodedProxyUser}:${encodedProxyPass}@` : ''
  const proxyUrl = normalizeWhitespace(env.PROXY_URL || '')
    || (proxyHost && proxyPort ? `${proxyScheme}://${proxyAuth}${proxyHost}:${proxyPort}` : '')

  return {
    port: parseNumber(env.PORT || 3000, 3000, { min: 1 }),
    proxy: {
      scheme: proxyScheme,
      host: proxyHost,
      port: proxyPort,
      user: proxyUser,
      pass: proxyPass,
      url: proxyUrl,
      connectTimeoutMs: parseNumber(env.PROXY_CONNECT_TIMEOUT_MS || 6000, 6000, { min: 3000 }),
    },
    gemini: {
      apiKey: normalizeWhitespace(env.GEMINI_API_KEY || ''),
      connectMaxAttempts: parseNumber(env.GEMINI_CONNECT_MAX_ATTEMPTS || 4, 4, { min: 1 }),
      connectRetryDelayMs: parseNumber(env.GEMINI_CONNECT_RETRY_DELAY_MS || 500, 500, { min: 250 }),
      sttModel: normalizeGeminiModel(env.STT_MODEL || ''),
    },
    yandex: {
      apiKey: normalizeWhitespace(env.YANDEX_API_KEY || ''),
      iamToken: normalizeWhitespace(env.YANDEX_IAM_TOKEN || ''),
      folderId: normalizeWhitespace(env.YANDEX_FOLDER_ID || ''),
      modelId: normalizeWhitespace(env.YANDEX_MODEL_ID || 'yandexgpt-lite/latest'),
      realtimeUrl: normalizeWhitespace(env.YANDEX_REALTIME_URL || 'wss://ai.api.cloud.yandex.net/v1/realtime/openai'),
      batyushkaVectorStoreId: normalizeWhitespace(env.YANDEX_BATYUSHKA_VECTOR_STORE_ID || ''),
    },
  }
}

export function getMissingLiveEnv(serverEnv, { providers = ['gemini-live', 'yandex-realtime', 'yandex-full-legacy'] } = {}) {
  const required = []
  const wantsGemini = providers.includes('gemini-live')
  const wantsYandex = providers.includes('yandex-realtime') || providers.includes('yandex-full-legacy')

  if (wantsGemini && !serverEnv.gemini.apiKey) {
    required.push('GEMINI_API_KEY')
  }

  if (wantsYandex) {
    if (!serverEnv.yandex.folderId) {
      required.push('YANDEX_FOLDER_ID')
    }
    if (!serverEnv.yandex.apiKey && !serverEnv.yandex.iamToken) {
      required.push('YANDEX_API_KEY|YANDEX_IAM_TOKEN')
    }
  }

  return required
}
