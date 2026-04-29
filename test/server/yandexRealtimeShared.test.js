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

test('Yandex realtime session keeps the documented native server VAD shape with tools', () => {
  const payload = buildSessionStartPayload({
    modelId: 'gpt://folder/speech-realtime-250923',
    voiceName: 'ermil',
    enabledTools: ['open_site'],
    voiceInteractionTuning: { pauseMs: 420 },
  })

  assert.equal(payload.session.audio.input.turn_detection.type, 'server_vad')
  assert.equal(payload.session.audio.input.turn_detection.threshold, 0.5)
  assert.equal(payload.session.audio.input.turn_detection.silence_duration_ms, 400)
  assert.equal('create_response' in payload.session.audio.input.turn_detection, false)
  assert.equal('interrupt_response' in payload.session.audio.input.turn_detection, false)
  assert.equal('prefix_padding_ms' in payload.session.audio.input.turn_detection, false)
  assert.equal(payload.session.audio.input.format.rate, 24000)
  assert.equal(payload.session.audio.input.format.channels, 1)
  assert.equal(payload.session.temperature, 0.2)
  assert.deepEqual(payload.session.tools.map((tool) => tool.name), ['open_site'])
})

test('Yandex realtime can explicitly disable tools', () => {
  const payload = buildSessionStartPayload({
    modelId: 'gpt://folder/speech-realtime-250923',
    enabledTools: ['open_site'],
    advertiseTools: false,
  })

  assert.deepEqual(payload.session.tools, [])
})

test('Yandex realtime advertises configured browser tools', () => {
  const payload = buildSessionStartPayload({
    modelId: 'gpt://folder/speech-realtime-250923',
    enabledTools: ['open_site', 'get_browser_state', 'get_visible_page_summary', 'query_knowledge'],
  })

  assert.deepEqual(payload.session.tools.map((tool) => tool.name), [
    'query_knowledge',
    'open_site',
    'get_browser_state',
    'get_visible_page_summary',
  ])
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

test('Yandex realtime default instructions do not claim browser tools are available', () => {
  const instructions = buildRealtimeInstructions({
    systemPrompt: 'Test persona.',
  })

  assert.match(instructions, /Browser and website actions are not available/i)
})

test('Yandex realtime tool instructions describe the lower browser panel', () => {
  const instructions = buildRealtimeInstructions({
    systemPrompt: 'Test persona.',
    enabledTools: ['open_site', 'get_browser_state'],
  })

  assert.match(instructions, /browser panel below the avatar/i)
  assert.match(instructions, /call get_browser_state/i)
})
