import { logRuntime } from '../runtimeLogger.js';
import { BROWSER_IDLE_TIMEOUT_MS, BROWSER_SESSION_TTL_MS } from './shared.js';

let browserPromise = null;
let browserInstance = null;
let browserIdleTimer = null;
let activeBrowserSession = null;
let sessionCleanupTimer = null;
let activeRequestId = 0;

export function getBrowserPromise() { return browserPromise; }
export function setBrowserPromise(value) { browserPromise = value; }
export function getBrowserInstance() { return browserInstance; }
export function setBrowserInstance(value) { browserInstance = value; }
export function getActiveBrowserSession() { return activeBrowserSession; }
export function setActiveBrowserSession(value) { activeBrowserSession = value; }
export function getActiveRequestId() { return activeRequestId; }
export function bumpActiveRequestId() { activeRequestId += 1; return activeRequestId; }

export function clearBrowserIdleTimer() {
  if (browserIdleTimer) { clearTimeout(browserIdleTimer); browserIdleTimer = null; }
}

export function clearSessionCleanupTimer() {
  if (sessionCleanupTimer) { clearTimeout(sessionCleanupTimer); sessionCleanupTimer = null; }
}

export function buildBrowserSessionId() {
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function hasActiveSession() {
  return Boolean(activeBrowserSession?.page && !activeBrowserSession.page.isClosed());
}

export function resetBrowserState(reason = 'browser-disconnected') {
  if (activeBrowserSession?.id) {
    logRuntime('browser.session.reset', { reason, browserSessionId: activeBrowserSession.id, url: activeBrowserSession.url || '' }, 'error');
  }
  clearBrowserIdleTimer();
  clearSessionCleanupTimer();
  browserPromise = null;
  browserInstance = null;
  activeBrowserSession = null;
}

export async function closeActivePage(reason = 'unknown', scheduleBrowserShutdown) {
  clearSessionCleanupTimer();
  const session = activeBrowserSession;
  const context = session?.context || null;
  const page = session?.page || null;
  if (session?.id) {
    logRuntime('browser.session.close', { reason, browserSessionId: session.id, url: session.url || '' });
  }
  activeBrowserSession = null;

  if (context) {
    await context.close().catch(() => {});
    scheduleBrowserShutdown();
    return;
  }

  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }

  scheduleBrowserShutdown();
}

export async function closeBrowserImpl(scheduleBrowserShutdown) {
  clearBrowserIdleTimer();
  clearSessionCleanupTimer();
  await closeActivePage('close-browser', scheduleBrowserShutdown);
  const browser = browserInstance || await browserPromise?.catch(() => null);
  browserPromise = null;
  browserInstance = null;
  if (browser) { await browser.close().catch(() => {}); }
}

export function cancelPendingBrowserOperations(reason = 'manual-cancel') {
  activeRequestId += 1;
  logRuntime('browser.request.cancelled', { reason, activeRequestId, browserSessionId: activeBrowserSession?.id || '', url: activeBrowserSession?.url || '' });
}

export function scheduleBrowserShutdown(closeBrowser) {
  clearBrowserIdleTimer();
  if (!browserPromise || hasActiveSession()) { return; }
  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    if (hasActiveSession()) { return; }
    void closeBrowser();
  }, BROWSER_IDLE_TIMEOUT_MS);
  browserIdleTimer.unref?.();
}

export function scheduleSessionCleanup(scheduleBrowserShutdownFn, closeActivePageFn) {
  clearSessionCleanupTimer();
  if (!activeBrowserSession) { scheduleBrowserShutdownFn(); return; }
  const elapsedMs = Date.now() - activeBrowserSession.lastAccessAt;
  const remainingMs = Math.max(1000, BROWSER_SESSION_TTL_MS - elapsedMs);
  sessionCleanupTimer = setTimeout(() => {
    if (!activeBrowserSession) { scheduleBrowserShutdownFn(); return; }
    const idleMs = Date.now() - activeBrowserSession.lastAccessAt;
    if (idleMs >= BROWSER_SESSION_TTL_MS) {
      logRuntime('browser.session.expired', { browserSessionId: activeBrowserSession.id, idleMs });
      void closeActivePageFn('session-ttl-expired');
      return;
    }
    scheduleSessionCleanup(scheduleBrowserShutdownFn, closeActivePageFn);
  }, remainingMs);
  sessionCleanupTimer.unref?.();
}

export function touchBrowserSession(session, scheduleBrowserShutdownFn, scheduleSessionCleanupFn) {
  if (!session || activeBrowserSession?.id !== session.id) { return; }
  clearBrowserIdleTimer();
  session.lastAccessAt = Date.now();
  scheduleSessionCleanupFn();
}

export function requireActiveBrowserSession(sessionId = '', closeActivePageFn) {
  if (!activeBrowserSession) throw new Error('?????? ?????????????????? ?????????????????? ??????????');
  if (sessionId && activeBrowserSession.id !== sessionId) throw new Error('???????????????? ???????? ??????????????. ???????????????? ???????? ????????????.');
  if (!activeBrowserSession.page || activeBrowserSession.page.isClosed()) {
    void closeActivePageFn('page-closed-check');
    throw new Error('???????????? ?????????? ??????????????????');
  }
  return activeBrowserSession;
}
