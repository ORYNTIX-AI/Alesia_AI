import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STOP_SPEECH_PATTERN,
  classifyShortHumanTurn,
  extractBrowserTarget,
  isExplicitBrowserRequest,
  isGreetingOnlyTranscript,
  isPrayerRequest,
} from '../../src/features/session/transcriptDetection.js'
import {
  isBrowserActionFollowupRequest,
  parseBrowserActionRequest,
} from '../../src/features/session/transcriptNetworking.js'
import {
  buildBrowserOpeningAckPrompt,
  buildGreetingAckPrompt,
  buildPersonaDirectPrompt,
  buildRepeatRequestPrompt,
  buildRuntimeTurnPrompt,
  buildSessionHistorySummary,
} from '../../src/features/session/transcriptPromptBuilders.js'
import { resolveRealtimeInputConfig } from '../../src/hooks/geminiLiveShared.js'
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
    buildRepeatRequestPrompt('ага'),
  ]

  for (const prompt of prompts) {
    for (const marker of MOJIBAKE_MARKERS) {
      assert.equal(prompt.includes(marker), false, `Unexpected marker ${marker} in ${prompt}`)
    }
  }
})

test('Batyushka 2 Gemini realtime config allows barge-in', () => {
  const config = resolveRealtimeInputConfig({ characterId: 'batyushka-2' })

  assert.equal(config.activityHandling, 'START_OF_ACTIVITY_INTERRUPTS')
  assert.notEqual(config.activityHandling, 'NO_INTERRUPTION')
  assert.equal(config.automaticActivityDetection.startOfSpeechSensitivity, 'START_SENSITIVITY_HIGH')
  assert.ok(config.automaticActivityDetection.silenceDurationMs < 900)
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
