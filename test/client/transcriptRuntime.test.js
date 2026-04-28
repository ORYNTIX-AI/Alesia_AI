import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STOP_SPEECH_PATTERN,
  classifyTranscriptIntent,
  classifyShortHumanTurn,
  extractBrowserTarget,
  isExplicitBrowserRequest,
  isGreetingOnlyTranscript,
  isLikelyVoiceStopCommand,
  isPrayerRequest,
  shouldSkipKnowledgeForTranscript,
} from '../../src/features/session/transcriptDetection.js'
import {
  isBrowserActionFollowupRequest,
  parseBrowserActionRequest,
} from '../../src/features/session/transcriptNetworking.js'
import {
  buildBrowserOpeningAckPrompt,
  buildGreetingAckPrompt,
  buildPersonaDirectPrompt,
  buildPrayerReadingChunk,
  buildRepeatRequestPrompt,
  buildRuntimeStatusPrompt,
  buildRuntimeTurnPrompt,
  buildSessionHistorySummary,
} from '../../src/features/session/transcriptPromptBuilders.js'
import {
  resolveRealtimeInputConfig,
  shouldCommitGeminiAssistantTurn,
} from '../../src/hooks/geminiLiveShared.js'
import { shouldUseRealtimeFallback } from '../../src/features/voice/useVoiceRuntimeAdapters.js'

const MOJIBAKE_MARKERS = ['Рџ', 'Рќ', 'СЃ', 'вЂ', '�', '����']

test('Russian short transcript detection handles greetings, stop words, persona and prayers', () => {
  assert.equal(isGreetingOnlyTranscript('привет'), true)
  assert.equal(isGreetingOnlyTranscript('добрый день'), true)
  assert.equal(classifyShortHumanTurn('ага'), 'backchannel')
  assert.equal(classifyShortHumanTurn('кто ты'), 'question')
  assert.equal(STOP_SPEECH_PATTERN.test('стоп'), true)
  assert.equal(STOP_SPEECH_PATTERN.test('остановись'), true)
  assert.equal(STOP_SPEECH_PATTERN.test('замолчи'), true)
  assert.equal(isLikelyVoiceStopCommand('опыт', { allowFuzzy: true }), true)
  assert.equal(isPrayerRequest('прочти Отче наш'), true)
})

test('Russian browser intents and follow-up actions are recognized', () => {
  assert.equal(isExplicitBrowserRequest('открой сайт bpcmm.by'), true)
  assert.equal(extractBrowserTarget('открой сайт bpcmm.by'), 'bpcmm.by')
  assert.equal(isExplicitBrowserRequest('перейди на сайт Белорусской православной церкви'), true)
  assert.equal(extractBrowserTarget('перейди на сайт Белорусской православной церкви'), 'Белорусской православной церкви')

  assert.equal(parseBrowserActionRequest('назад')?.type, 'back')
  assert.equal(parseBrowserActionRequest('вперёд')?.type, 'forward')
  assert.equal(parseBrowserActionRequest('обнови')?.type, 'reload')
  assert.equal(parseBrowserActionRequest('прокрути')?.type, 'wheel')
  assert.deepEqual(parseBrowserActionRequest('нажми контакты'), {
    type: 'click-label',
    label: 'контакты',
  })
  assert.equal(isBrowserActionFollowupRequest('нажми контакты'), true)
})

test('Russian known site intents route before ordinary chat', () => {
  assert.equal(classifyTranscriptIntent('\u043e\u0442\u043a\u0440\u043e\u0439 \u0430\u0437\u0431\u0443\u043a\u0443 \u0432\u0435\u0440\u044b'), 'site_open')
  assert.equal(classifyTranscriptIntent('\u0430\u0437\u0431\u0443\u043a\u0443 \u0432\u0435\u0440\u044b \u043e\u0442\u043a\u0440\u043e\u0439'), 'site_open')
  assert.equal(classifyTranscriptIntent('\u0441\u0430\u0439\u0442 \u0430\u0437\u0431\u0443\u043a\u0430'), 'site_open')
})

test('prompt builders do not contain mojibake markers', () => {
  const prompts = [
    buildSessionHistorySummary([]),
    buildRuntimeTurnPrompt('кто ты', {
      activePageContext: {
        title: 'Открытая страница',
        url: 'https://example.com',
        readerText: 'Контекст страницы.',
      },
      recentTurns: [{ role: 'user', text: 'привет' }],
    }),
    buildGreetingAckPrompt('привет'),
    buildPersonaDirectPrompt('кто ты'),
    buildBrowserOpeningAckPrompt('открой сайт bpcmm.by'),
    buildRuntimeStatusPrompt('lookup'),
    buildRepeatRequestPrompt('ага'),
  ]

  for (const prompt of prompts) {
    for (const marker of MOJIBAKE_MARKERS) {
      assert.equal(prompt.includes(marker), false, `Unexpected marker ${marker} in ${prompt}`)
    }
  }
})

test('Batyushka 2 Gemini realtime config prevents server-side echo self-interrupts', () => {
  const config = resolveRealtimeInputConfig({ characterId: 'batyushka-2' })

  assert.equal(config.activityHandling, 'NO_INTERRUPTION')
  assert.equal(config.automaticActivityDetection.startOfSpeechSensitivity, 'START_SENSITIVITY_LOW')
  assert.equal(config.automaticActivityDetection.endOfSpeechSensitivity, 'END_SENSITIVITY_LOW')
  assert.ok(config.automaticActivityDetection.silenceDurationMs >= 550)
  assert.ok(config.automaticActivityDetection.silenceDurationMs <= 650)
  assert.ok(config.automaticActivityDetection.prefixPaddingMs >= 120)
  assert.ok(config.automaticActivityDetection.prefixPaddingMs <= 150)
})

test('knowledge lookup is skipped for simple voice turns and browser commands', () => {
  assert.equal(shouldSkipKnowledgeForTranscript('привет'), true)
  assert.equal(shouldSkipKnowledgeForTranscript('что ты умеешь'), true)
  assert.equal(shouldSkipKnowledgeForTranscript('открой сайт bpcmm.by'), true)
  assert.equal(shouldSkipKnowledgeForTranscript('расскажи кратко о молитве отче наш'), false)
})

test('prayer reading chunk is short and strips page chrome before known prayer text', () => {
  const chunk = buildPrayerReadingChunk('Азбука веры Молитвослов меню Отче наш, Иже еси на небесех! Да святится имя Твое. Да приидет Царствие Твое. Да будет воля Твоя, яко на небеси и на земли. Хлеб наш насущный даждь нам днесь. И остави нам долги наша, якоже и мы оставляем должником нашим. И не введи нас во искушение, но избави нас от лукаваго. Аминь. Толкование и комментарии дальше по странице.')
  assert.ok(chunk.length <= 340)
  assert.equal(chunk.includes('Азбука веры'), false)
  assert.equal(chunk.startsWith('Отче наш'), true)
})

test('Gemini Live assistant turn commits only on turnComplete', () => {
  assert.equal(shouldCommitGeminiAssistantTurn({ generationComplete: true }), false)
  assert.equal(shouldCommitGeminiAssistantTurn({ turnComplete: true }), true)
})

test('Batyushka 3 can fall back from Yandex realtime to legacy runtime', () => {
  assert.equal(shouldUseRealtimeFallback({
    runtimeProvider: 'yandex-realtime',
    realtimeFallbackProvider: 'yandex-full-legacy',
    runtimeProviderOverride: '',
    realtimeStatus: 'error',
    realtimeError: 'runtime error: upstream unavailable',
  }), true)
})
