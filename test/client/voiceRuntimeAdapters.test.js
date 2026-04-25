import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveVoiceRuntimeState, selectVoiceRuntimeSession } from '../../src/features/voice/runtimeSelection.js'

test('resolveVoiceRuntimeState respects runtime override', () => {
  const state = resolveVoiceRuntimeState('gemini-live', 'yandex-realtime')

  assert.equal(state.effectiveRuntimeProvider, 'yandex-realtime')
  assert.equal(state.usesYandexRealtimeRuntime, true)
  assert.equal(state.usesYandexLegacyRuntime, false)
  assert.equal(state.usesYandexRuntime, true)
})

test('selectVoiceRuntimeSession returns the correct adapter session', () => {
  const sessions = {
    geminiSession: { id: 'gemini' },
    yandexSession: { id: 'legacy' },
    yandexRealtimeSession: { id: 'realtime' },
  }

  assert.equal(
    selectVoiceRuntimeSession(sessions, resolveVoiceRuntimeState('gemini-live')).id,
    'gemini',
  )
  assert.equal(
    selectVoiceRuntimeSession(sessions, resolveVoiceRuntimeState('yandex-full-legacy')).id,
    'legacy',
  )
  assert.equal(
    selectVoiceRuntimeSession(sessions, resolveVoiceRuntimeState('gemini-live', 'yandex-realtime')).id,
    'realtime',
  )
})
