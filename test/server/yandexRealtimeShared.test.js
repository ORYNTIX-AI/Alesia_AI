import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  buildModelSafeToolPayload,
  buildRealtimeInstructions,
  buildSessionStartPayload,
  shouldForwardResponseCancel,
} from '../../server/ws/yandexRealtimeShared.js'

test('Yandex realtime forwards cancel only for the active open response', () => {
  const state = {
    activeResponseId: 'resp-active',
    closedResponseIds: new Set(),
  }

  assert.equal(shouldForwardResponseCancel(state, 'resp-active'), true)
  assert.equal(shouldForwardResponseCancel(state, 'resp-stale'), false)
  assert.equal(shouldForwardResponseCancel(state, ''), false)

  state.closedResponseIds.add('resp-active')
  assert.equal(shouldForwardResponseCancel(state, 'resp-active'), false)
})

test('Yandex realtime gateway has no forced browser or persona reply path', async () => {
  const source = await fs.readFile(new URL('../../server/ws/yandexRealtimeGateway.js', import.meta.url), 'utf8')

  assert.equal(source.includes('sendForcedAssistantReply'), false)
  assert.equal(source.includes('shouldForceBrowserOpenRu'), false)
  assert.equal(source.includes('buildForcedBrowserReplyRu'), false)
})

test('Yandex browser tool payload exposes verified browser snapshot state', () => {
  const payload = buildModelSafeToolPayload('open_site', {
    ok: true,
    browserSessionId: 'browser-1',
    title: 'Example',
    url: 'https://example.com/',
    verified: true,
    verification: { reason: 'verified' },
    summary: 'Visible text',
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.verified, true)
  assert.equal(payload.verificationReason, 'verified')
  assert.equal(payload.url, 'https://example.com/')
})

test('Yandex realtime uses native server VAD response creation', () => {
  const payload = buildSessionStartPayload({
    modelId: 'gpt://folder/speech-realtime-250923',
    voiceName: 'ermil',
    enabledTools: ['open_site'],
    voiceInteractionTuning: { pauseMs: 420 },
  })

  assert.equal(payload.session.audio.input.turn_detection.type, 'server_vad')
  assert.equal(payload.session.audio.input.turn_detection.create_response, true)
  assert.equal(payload.session.audio.input.turn_detection.interrupt_response, true)
  assert.equal(payload.session.audio.input.format.rate, 24000)
  assert.equal(payload.session.audio.input.format.channels, 1)
  assert.equal(payload.session.temperature, 0.2)
  assert.deepEqual(payload.session.tools, [])
})

test('Yandex realtime advertises tools only when explicitly requested', () => {
  const payload = buildSessionStartPayload({
    modelId: 'gpt://folder/speech-realtime-250923',
    enabledTools: ['open_site', 'view_page'],
    advertiseTools: true,
  })

  assert.deepEqual(payload.session.tools.map((tool) => tool.name), ['open_site', 'view_page'])
})

test('Yandex realtime instructions describe natural conversation and reject service formulas', () => {
  const instructions = buildRealtimeInstructions({
    systemPrompt: 'Ты Николай.',
  })

  assert.match(instructions, /живого голосового диалога/)
  assert.match(instructions, /не добавляй дежурное предложение помощи/)
  assert.match(instructions, /greeting answer must not contain a question mark/i)
  assert.match(instructions, /Never ask what you can do/i)
})

test('Yandex realtime default instructions use app-side browser context policy', () => {
  const instructions = buildRealtimeInstructions({
    systemPrompt: 'Test persona.',
  })

  assert.match(instructions, /Browser and website actions are handled by the application/i)
  assert.match(instructions, /WEB_CONTEXT_\*/i)
})
