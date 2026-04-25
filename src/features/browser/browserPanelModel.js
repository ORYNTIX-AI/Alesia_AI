export const DEFAULT_PANEL_STATE = {
  status: 'idle',
  browserPanelMode: 'remote',
  sourceType: null,
  title: '',
  url: '',
  clientUrl: '',
  clientHomeUrl: '',
  clientHistory: [],
  clientHistoryIndex: -1,
  clientReloadKey: 0,
  clientFrameLoaded: false,
  clientContextStatus: 'idle',
  clientContextError: '',
  clientFallback: false,
  clientExternalOpened: false,
  note: '',
  embeddable: false,
  readerText: '',
  screenshotUrl: null,
  revision: 0,
  actionableElements: [],
  view: null,
  error: null,
}

export function isClientInlinePanelMode(value) {
  return String(value || '').trim() === 'client-inline'
}

export function getClientHomeUrl(url) {
  try {
    const nextUrl = new URL(String(url || '').trim())
    return `${nextUrl.origin}/`
  } catch {
    return String(url || '').trim()
  }
}

export function buildClientPanelState(intent, currentPanel = null, { status = 'ready', note = '', browserPanelMode = 'client-inline' } = {}) {
  const nextUrl = String(intent?.url || '').trim()
  const nextHistory = Array.isArray(currentPanel?.clientHistory) ? [...currentPanel.clientHistory] : []
  const currentHistoryIndex = Number.isInteger(currentPanel?.clientHistoryIndex) ? currentPanel.clientHistoryIndex : -1
  const shouldAppend = Boolean(nextUrl) && nextHistory[currentHistoryIndex] !== nextUrl

  if (shouldAppend) {
    nextHistory.splice(currentHistoryIndex + 1)
    nextHistory.push(nextUrl)
  } else if (nextUrl && nextHistory.length === 0) {
    nextHistory.push(nextUrl)
  }

  return {
    ...DEFAULT_PANEL_STATE,
    ...currentPanel,
    status,
    browserPanelMode: isClientInlinePanelMode(browserPanelMode) ? 'client-inline' : 'remote',
    sourceType: intent?.sourceType || currentPanel?.sourceType || null,
    title: intent?.titleHint || currentPanel?.title || '',
    url: nextUrl || currentPanel?.url || '',
    clientUrl: nextUrl || currentPanel?.clientUrl || '',
    clientHomeUrl: currentPanel?.clientHomeUrl || getClientHomeUrl(nextUrl),
    clientHistory: nextHistory,
    clientHistoryIndex: nextHistory.length > 0 ? nextHistory.length - 1 : -1,
    clientReloadKey: currentPanel?.clientReloadKey || 0,
    clientFrameLoaded: false,
    clientContextStatus: status === 'loading' ? 'loading' : 'idle',
    clientContextError: '',
    note,
    error: null,
  }
}

export function shouldPreferRemoteBrowserTransport(url, browserPanelMode = 'remote') {
  if (!isClientInlinePanelMode(browserPanelMode)) {
    return true
  }

  try {
    const nextUrl = new URL(String(url || '').trim())
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      return true
    }
    if (/^http:\/\//i.test(nextUrl.href) && typeof window !== 'undefined' && window.location.protocol === 'https:') {
      return true
    }
    return false
  } catch {
    return true
  }
}
