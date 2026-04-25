import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PANEL_STATE,
  buildClientPanelState,
  isClientInlinePanelMode,
  shouldPreferRemoteBrowserTransport,
} from '../../src/features/browser/browserPanelModel.js'

test('buildClientPanelState appends navigation history for inline browser mode', () => {
  const initial = buildClientPanelState({
    url: 'https://example.com/',
    titleHint: 'Example',
  })
  const next = buildClientPanelState({
    url: 'https://example.com/about',
    titleHint: 'About',
  }, initial)

  assert.equal(initial.clientHistory.length, 1)
  assert.deepEqual(next.clientHistory, ['https://example.com/', 'https://example.com/about'])
  assert.equal(next.clientHistoryIndex, 1)
  assert.equal(next.clientUrl, 'https://example.com/about')
  assert.equal(next.clientFallback, false)
  assert.equal(next.browserPanelMode, 'client-inline')
})

test('browser panel helpers keep remote and inline modes distinct', () => {
  assert.equal(isClientInlinePanelMode('client-inline'), true)
  assert.equal(isClientInlinePanelMode('remote'), false)
  assert.equal(shouldPreferRemoteBrowserTransport('https://example.com/', 'client-inline'), false)
  assert.equal(shouldPreferRemoteBrowserTransport('mailto:test@example.com', 'client-inline'), true)
  assert.equal(shouldPreferRemoteBrowserTransport('https://example.com/', 'remote'), true)
  assert.equal(DEFAULT_PANEL_STATE.status, 'idle')
})
