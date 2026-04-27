import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { getMissingLiveEnv, loadServerEnv } from '../../server/env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')
const port = Number(process.env.LIVE_SMOKE_PORT || 3300)
const runtimeLogPath = path.join(projectRoot, 'runtime-data', 'live-smoke-runtime.log')
const serverBaseUrl = `http://127.0.0.1:${port}`
const DEFAULT_LIVE_TARGETS = ['gemini-live', 'yandex-full-legacy', 'yandex-realtime', 'browser', 'knowledge']
const liveTargets = new Set(
  String(process.env.LIVE_SMOKE_TARGETS || DEFAULT_LIVE_TARGETS.join(','))
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean),
)

function shouldRunTarget(target) {
  return liveTargets.has('all') || liveTargets.has(target)
}

function requiredProvidersForTargets() {
  const providers = []
  if (shouldRunTarget('gemini-live')) {
    providers.push('gemini-live')
  }
  if (shouldRunTarget('yandex-full-legacy')) {
    providers.push('yandex-full-legacy')
  }
  if (shouldRunTarget('yandex-realtime')) {
    providers.push('yandex-realtime')
  }
  return providers
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServer(url, timeoutMs = 90_000) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return response.json()
      }
    } catch {
      // Server is still starting.
    }
    await sleep(750)
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return payload
}

function buildGeminiSetupMessage(character) {
  const modelId = String(character?.voiceModelId || character?.modelId || '').trim()
  const voiceName = String(character?.voiceName || 'Aoede').trim() || 'Aoede'
  const instructions = String(character?.systemPrompt || 'Answer briefly in Russian.').trim() || 'Answer briefly in Russian.'
  return {
    setup: {
      model: modelId,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
        thinkingConfig: modelId === 'models/gemini-3.1-flash-live-preview'
          ? { thinkingLevel: 'minimal' }
          : { thinkingBudget: 0 },
      },
      systemInstruction: {
        parts: [{ text: instructions }],
      },
      outputAudioTranscription: {},
    },
  }
}

async function runGeminiLiveSmoke(appConfig) {
  const geminiCharacter = appConfig.characters.find((character) => character.runtimeProvider === 'gemini-live')
  assert.ok(geminiCharacter, 'Gemini live character is missing in app config')

  const session = await jsonRequest(`${serverBaseUrl}/api/voice/session`, {
    method: 'POST',
    body: JSON.stringify({
      conversationSessionId: `live-gemini-${Date.now().toString(36)}`,
      characterId: geminiCharacter.id,
      requestedGatewayUrl: '/voice-proxy',
    }),
  })

  const gatewayUrl = `${session.voiceGatewayUrl}?sessionToken=${encodeURIComponent(session.sessionToken)}`
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl)
    let assistantText = ''
    let audioChunkCount = 0
    let settled = false
    const timerId = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('Gemini live smoke timed out'))
      }
    }, 90_000)

    ws.on('open', () => {
      ws.send(JSON.stringify(buildGeminiSetupMessage(geminiCharacter)))
    })

    ws.on('message', (rawData) => {
      let payload = null
      try {
        payload = JSON.parse(String(rawData))
      } catch {
        return
      }

      if (payload?.setupComplete) {
        const promptText = 'Скажи одно короткое приветствие по-русски.'
        const textTurnPayload = geminiCharacter.voiceModelId === 'models/gemini-3.1-flash-live-preview'
          ? { realtimeInput: { text: promptText } }
          : {
            client_content: {
              turns: [{
                role: 'user',
                parts: [{ text: promptText }],
              }],
              turn_complete: true,
            },
          }
        ws.send(JSON.stringify(textTurnPayload))
        return
      }

      if (payload?.serverContent?.modelTurn?.parts) {
        for (const part of payload.serverContent.modelTurn.parts) {
          if (part?.text && !part?.thought) {
            assistantText = `${assistantText} ${part.text}`.trim()
          }
          if (part?.inlineData?.mimeType?.startsWith('audio/pcm')) {
            audioChunkCount += 1
          }
        }
      }

      if (payload?.serverContent?.outputTranscription?.text) {
        assistantText = `${assistantText} ${payload.serverContent.outputTranscription.text}`.trim()
      }

      if (payload?.serverContent?.turnComplete) {
        if (!assistantText || audioChunkCount < 1) {
          settled = true
          clearTimeout(timerId)
          ws.close()
          reject(new Error('Gemini live smoke did not produce both text and audio'))
          return
        }
        settled = true
        clearTimeout(timerId)
        ws.close()
        resolve()
      }

      if (payload?.error?.message) {
        settled = true
        clearTimeout(timerId)
        ws.close()
        reject(new Error(payload.error.message))
      }
    })

    ws.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timerId)
        reject(error)
      }
    })

    ws.on('close', (code, reason) => {
      if (!settled) {
        settled = true
        clearTimeout(timerId)
        reject(new Error(`Gemini socket closed unexpectedly (${code}): ${String(reason || '')}`))
      }
    })
  })
}

async function runYandexLegacySmoke(appConfig) {
  const yandexCharacter = appConfig.characters.find((character) => character.runtimeProvider === 'yandex-full-legacy')
    || appConfig.characters.find((character) => character.fallbackRuntimeProvider === 'yandex-full-legacy')
  assert.ok(yandexCharacter, 'Yandex legacy character is missing in app config')

  const turnPayload = await jsonRequest(`${serverBaseUrl}/api/yandex/turn`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Скажи короткое приветствие по-русски.',
      systemPrompt: yandexCharacter.systemPrompt || '',
      modelId: yandexCharacter.voiceModelId || yandexCharacter.modelId,
      voiceName: yandexCharacter.ttsVoiceName || yandexCharacter.voiceName || 'ermil',
      sampleRateHertz: 48000,
    }),
  })

  assert.ok(String(turnPayload.text || '').trim(), 'Yandex turn did not return text')
  assert.ok(String(turnPayload.audioBase64 || '').trim(), 'Yandex turn did not return audio')

  const ttsPayload = await jsonRequest(`${serverBaseUrl}/api/yandex/tts`, {
    method: 'POST',
    body: JSON.stringify({
      text: turnPayload.text,
      voiceName: yandexCharacter.ttsVoiceName || yandexCharacter.voiceName || 'ermil',
      sampleRateHertz: 48000,
    }),
  })

  assert.ok(String(ttsPayload.audioBase64 || '').trim(), 'Yandex TTS did not return audio')

  const sttPayload = await jsonRequest(`${serverBaseUrl}/api/yandex/stt`, {
    method: 'POST',
    body: JSON.stringify({
      audioBase64: ttsPayload.audioBase64,
      sampleRateHertz: ttsPayload.sampleRateHertz || 48000,
      language: 'ru-RU',
    }),
  })

  assert.ok(String(sttPayload.text || '').trim(), 'Yandex STT did not return text')
}

async function runYandexRealtimeSmoke(appConfig) {
  const realtimeCharacter = appConfig.characters.find((character) => character.runtimeProvider === 'yandex-realtime')
  assert.ok(realtimeCharacter, 'Yandex realtime character is missing in app config')

  const session = await jsonRequest(`${serverBaseUrl}/api/voice/session`, {
    method: 'POST',
    body: JSON.stringify({
      conversationSessionId: `live-yandex-${Date.now().toString(36)}`,
      characterId: realtimeCharacter.id,
      requestedGatewayUrl: '/yandex-realtime-proxy',
    }),
  })

  const gatewayUrl = `${session.voiceGatewayUrl}?sessionToken=${encodeURIComponent(session.sessionToken)}`
  const browserSessionId = await new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl)
    let settled = false
    let foundBrowserSessionId = ''
    let assistantDone = false
    let assistantText = ''
    let audioChunkCount = 0
    const timerId = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('Yandex realtime smoke timed out'))
      }
    }, 90_000)

    const maybeResolve = () => {
      if (foundBrowserSessionId && assistantDone && audioChunkCount > 0 && !settled) {
        assert.equal(/чем\s+(?:ещ[её]\s+)?могу\s+помочь|как\s+могу\s+помочь|что\s+ещ[её]\s+подсказать/i.test(assistantText), false, 'Yandex realtime returned generic filler')
        settled = true
        clearTimeout(timerId)
        ws.close()
        resolve(foundBrowserSessionId)
      }
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.start',
        runtimeConfig: {
          runtimeProvider: 'yandex-realtime',
          modelId: realtimeCharacter.voiceModelId || realtimeCharacter.modelId,
          systemPrompt: realtimeCharacter.systemPrompt || '',
          voiceName: realtimeCharacter.voiceName || 'ermil',
          ttsVoiceName: realtimeCharacter.ttsVoiceName || realtimeCharacter.voiceName || 'ermil',
          conversationSessionId: `live-yandex-${Date.now().toString(36)}`,
          characterId: realtimeCharacter.id,
          enabledTools: ['open_site', 'view_page', 'extract_page_context', 'summarize_visible_page'],
          advertiseTools: true,
          outputAudioTranscription: false,
          captureUserAudio: false,
        },
      }))
    })

    ws.on('message', (rawData) => {
      let payload = null
      try {
        payload = JSON.parse(String(rawData))
      } catch {
        return
      }

      if (payload?.type === 'ready') {
        ws.send(JSON.stringify({
          type: 'input_text',
          text: 'открой сайт азбука',
          origin: 'user_text',
        }))
        return
      }

      if (payload?.type === 'tool_result' && payload?.name === 'open_site') {
        assert.notEqual(payload?.result?.ok, false, `Yandex realtime open_site failed: ${payload?.result?.error || ''}`)
        assert.equal(payload?.result?.verified, true, 'Yandex realtime open_site did not return verified snapshot')
        assert.ok(!/^about:blank$/i.test(String(payload?.result?.url || '')), 'Yandex realtime opened about:blank')
        assert.ok(!/^chrome-error:\/\//i.test(String(payload?.result?.url || '')), 'Yandex realtime opened a browser error page')
        assert.ok(String(payload?.result?.title || '').trim(), 'Yandex realtime open_site did not return page title')
        assert.ok(String(payload?.result?.view?.imageUrl || '').trim(), 'Yandex realtime open_site did not return screenshot view')
        foundBrowserSessionId = String(payload?.result?.browserSessionId || '').trim()
        maybeResolve()
        return
      }

      if (payload?.type === 'assistant_text_delta') {
        assistantText = `${assistantText} ${payload.text || ''}`.trim()
        return
      }

      if (payload?.type === 'assistant_audio_delta') {
        audioChunkCount += 1
        return
      }

      if (payload?.type === 'assistant_turn_done') {
        assistantDone = true
        if (audioChunkCount < 1) {
          settled = true
          clearTimeout(timerId)
          ws.close()
          reject(new Error('Yandex realtime assistant turn finished without audio'))
          return
        }
        maybeResolve()
        return
      }

      if (payload?.type === 'error') {
        settled = true
        clearTimeout(timerId)
        ws.close()
        reject(new Error(payload.message || 'Yandex realtime returned an error'))
      }
    })

    ws.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timerId)
        reject(error)
      }
    })

    ws.on('close', (code, reason) => {
      if (!settled) {
        settled = true
        clearTimeout(timerId)
        reject(new Error(`Yandex realtime socket closed unexpectedly (${code}): ${String(reason || '')}`))
      }
    })
  })

  assert.ok(browserSessionId, 'Yandex realtime tool flow did not open a browser session')
  return browserSessionId
}

async function runBrowserSmoke(browserSessionId) {
  const view = await jsonRequest(`${serverBaseUrl}/api/browser/session/${encodeURIComponent(browserSessionId)}/view?refresh=1`, {
    method: 'GET',
  })
  assert.ok(String(view.url || '').trim(), 'Browser view did not return a URL')

  const context = await jsonRequest(`${serverBaseUrl}/api/browser/session/${encodeURIComponent(browserSessionId)}/context`, {
    method: 'GET',
  })
  assert.ok(String(context.url || '').trim(), 'Browser context did not return a URL')

  const answer = await jsonRequest(`${serverBaseUrl}/api/browser/session/${encodeURIComponent(browserSessionId)}/query`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'Что это за сайт?',
    }),
  })
  assert.ok(String(answer.answer || '').trim(), 'Browser query did not return an answer')

  const action = await jsonRequest(`${serverBaseUrl}/api/browser/session/${encodeURIComponent(browserSessionId)}/action`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'reload',
    }),
  })
  assert.ok(String(action.url || '').trim(), 'Browser action did not return the current URL')
}

async function runKnowledgeSmoke(appConfig) {
  const firstSource = appConfig.knowledgeSources?.[0]
  assert.ok(firstSource, 'Knowledge sources are missing in app config')
  const question = String(
    firstSource.aliases?.[0]
    || firstSource.tags?.[0]
    || firstSource.title
    || firstSource.id
    || '',
  ).trim()
  assert.ok(question, 'Knowledge source does not contain a usable query token')

  const result = await jsonRequest(`${serverBaseUrl}/api/knowledge/query`, {
    method: 'POST',
    body: JSON.stringify({
      question,
      characterId: appConfig.activeCharacterId,
    }),
  })
  assert.ok(Array.isArray(result.hits), 'Knowledge query did not return hits array')
  assert.ok(result.hits.length > 0, `Knowledge query returned no hits for "${question}"`)
}

async function assertRuntimeLogClean() {
  const content = await fs.readFile(runtimeLogPath, 'utf8').catch(() => '')
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const errors = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry?.level === 'error')

  assert.equal(errors.length, 0, `Runtime log contains error events:\n${errors.map((entry) => entry.event).join('\n')}`)
}

async function main() {
  await fs.rm(runtimeLogPath, { force: true }).catch(() => {})

  const env = {
    ...process.env,
    PORT: String(port),
    RUNTIME_LOG_PATH: runtimeLogPath,
  }
  const serverEnv = loadServerEnv(env)
  const missingEnv = getMissingLiveEnv(serverEnv, {
    providers: requiredProvidersForTargets(),
  })
  assert.equal(
    missingEnv.length,
    0,
    `Missing live environment variables: ${missingEnv.join(', ')}`,
  )

  const child = spawn(process.execPath, ['server/proxy.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  try {
    await waitForServer(`${serverBaseUrl}/health`)
    const appConfig = await jsonRequest(`${serverBaseUrl}/api/app-config`, { method: 'GET' })

    if (shouldRunTarget('gemini-live')) {
      await runGeminiLiveSmoke(appConfig)
    }
    if (shouldRunTarget('yandex-full-legacy')) {
      await runYandexLegacySmoke(appConfig)
    }
    let browserSessionId = ''
    if (shouldRunTarget('yandex-realtime')) {
      browserSessionId = await runYandexRealtimeSmoke(appConfig)
    }
    if (shouldRunTarget('browser')) {
      assert.ok(browserSessionId, 'Browser target requires yandex-realtime target in the same run')
      await runBrowserSmoke(browserSessionId)
    }
    if (shouldRunTarget('knowledge')) {
      await runKnowledgeSmoke(appConfig)
    }
    await assertRuntimeLogClean()

    console.log('Live smoke passed')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 10_000)
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
