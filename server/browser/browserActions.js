import { logRuntime } from '../runtimeLogger.js';
import { DEFAULT_TIMEOUT_MS, DOMCONTENTLOADED_TIMEOUT_MS, MAX_READER_TEXT_LENGTH, PAGE_SETTLE_MS, SESSION_CONTEXT_TEXT_LENGTH, SESSION_QUERY_TEXT_LENGTH, VIEWPORT_HEIGHT, VIEWPORT_WIDTH, WEATHER_RESULT_URL_PATTERN, normalizeWhitespace, simplifyLookup, BROWSER_VIEW_REFRESH_MS } from './shared.js';
import { assertPublicUrl, clamp, getBrowser, getConfiguredProxy, isEmbeddable, probeOriginReachability, safeHostnameFromUrl, shouldRetryWithHttpFallback, toHttpFallbackUrl, isSameSiteUrl } from './browserRuntime.js';
import { buildBrowserSessionId, bumpActiveRequestId, closeActivePage, closeBrowserImpl, getActiveBrowserSession, getActiveRequestId, requireActiveBrowserSession, scheduleBrowserShutdown, scheduleSessionCleanup, setActiveBrowserSession, touchBrowserSession } from './sessionStore.js';
import {
  assertVerifiedBrowserSessionSnapshot,
  buildSessionQueryAnswer,
  findBestActionableElement,
  refreshBrowserSessionSnapshot,
  serializeSession,
} from './sessionSnapshot.js';

async function closeActivePageWithScheduler(reason = 'unknown') {
  await closeActivePage(reason, () => scheduleBrowserShutdown(closeBrowser));
}

export async function closeBrowser() {
  return closeBrowserImpl(() => scheduleBrowserShutdown(closeBrowser));
}

export async function resolveInternalProviderPage(page, intent) {
  const currentUrl = page.url();

  if (intent.providerKey === 'weather' && currentUrl.includes('gismeteo.by/search/')) {
    const queryStem = simplifyLookup(intent.query || '');
    const weatherHref = await page.evaluate((queryValue) => {
      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/gi, '')
        .replace(/[еёуюаяыиоьй]$/i, '');
      const links = Array.from(document.querySelectorAll('a[href*="/weather-"]'))
        .map((link) => ({
          href: link.href,
          text: (link.textContent || '').trim(),
          className: link.className || '',
        }))
        .filter((link) => link.href);
      const exactMatches = links.filter((link) => {
        const textStem = normalize(link.text);
        return textStem && queryValue && (textStem.includes(queryValue) || queryValue.includes(textStem));
      });
      const preferred = links.filter((link) => /catalog-group-link|city-link/.test(link.className || ''));
      return exactMatches.at(-1)?.href || preferred.at(-1)?.href || links[0]?.href || null;
    }, queryStem);

    if (weatherHref && WEATHER_RESULT_URL_PATTERN.test(weatherHref)) {
      await page.goto(weatherHref, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      });
      await page.waitForTimeout(PAGE_SETTLE_MS);
    }
  }
}

export async function openBrowserIntent(intent) {
  const traceId = String(intent?.traceId || '');
  const startedAt = Date.now();
  const safeUrl = await assertPublicUrl(intent.url);
  const requestId = bumpActiveRequestId();
  logRuntime('browser.open.phase', {
    traceId,
    phase: 'validated-url',
    url: safeUrl,
    requestId,
    ms: Date.now() - startedAt,
  });

  if (!getConfiguredProxy()) {
    const reachability = await probeOriginReachability(safeUrl);
    if (!reachability.ok) {
      logRuntime('browser.open.phase', {
        traceId,
        phase: 'origin-unreachable',
        url: safeUrl,
        reason: reachability.reason,
        requestId,
        ms: Date.now() - startedAt,
      }, 'error');
      const reachabilityError = new Error('Сервер сейчас не может показать этот сайт внутри панели.');
      reachabilityError.code = 'origin_unreachable';
      reachabilityError.details = reachability;
      throw reachabilityError;
    }
  }

  const browser = await getBrowser();
  logRuntime('browser.open.phase', {
    traceId,
    phase: 'browser-ready',
    requestId,
    ms: Date.now() - startedAt,
  });

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const browserSession = {
    id: buildBrowserSessionId(),
    context,
    page,
    sourceType: intent.sourceType || intent.type || 'direct-site',
    query: normalizeWhitespace(intent.query || ''),
    title: '',
    url: safeUrl,
    embeddable: true,
    readerText: '',
    queryText: '',
    screenshotUrl: null,
    actionableElements: [],
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    revision: 0,
    lastScreenshotAt: 0,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
  browserSession.page.on('close', () => {
    if (getActiveBrowserSession()?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.page.closed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    setActiveBrowserSession(null);
    scheduleBrowserShutdown(closeBrowser);
  });
  browserSession.page.on('crash', () => {
    if (getActiveBrowserSession()?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.page.crashed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    setActiveBrowserSession(null);
    scheduleBrowserShutdown(closeBrowser);
  });
  browserSession.context.on('close', () => {
    if (getActiveBrowserSession()?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.context.closed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    setActiveBrowserSession(null);
    scheduleBrowserShutdown(closeBrowser);
  });
  logRuntime('browser.open.phase', {
    traceId,
    phase: 'page-created',
    browserSessionId: browserSession.id,
    requestId,
    ms: Date.now() - startedAt,
  });

  try {
    let targetUrl = safeUrl;
    let response = null;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: 'commit',
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      const fallbackUrl = toHttpFallbackUrl(targetUrl);
      if (fallbackUrl && shouldRetryWithHttpFallback(targetUrl, error)) {
        const validatedFallbackUrl = await assertPublicUrl(fallbackUrl).catch(() => '');
        if (validatedFallbackUrl) {
          logRuntime('browser.open.phase', {
            traceId,
            phase: 'goto-http-fallback',
            from: targetUrl,
            to: validatedFallbackUrl,
            requestId,
            ms: Date.now() - startedAt,
          });
          targetUrl = validatedFallbackUrl;
          await page.goto('about:blank', {
            waitUntil: 'commit',
            timeout: Math.min(DEFAULT_TIMEOUT_MS, 3000),
          }).catch(() => {});

          try {
            response = await page.goto(targetUrl, {
              waitUntil: 'commit',
              timeout: DEFAULT_TIMEOUT_MS,
            });
          } catch (fallbackError) {
            const interruptedByErrorPage = /interrupted by another navigation|chrome-error/i
              .test(String(fallbackError?.message || ''));
            if (!interruptedByErrorPage) {
              throw fallbackError;
            }
            try {
              response = await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: DEFAULT_TIMEOUT_MS,
              });
            } catch (retryFallbackError) {
              const retryMessage = String(retryFallbackError?.message || '');
              const interruptedBySameSite = /interrupted by another navigation/i.test(retryMessage)
                && isSameSiteUrl(page.url(), targetUrl)
                && !/chrome-error/i.test(page.url());
              if (!interruptedBySameSite) {
                throw retryFallbackError;
              }
              await page.waitForLoadState('domcontentloaded', {
                timeout: Math.min(DEFAULT_TIMEOUT_MS, DOMCONTENTLOADED_TIMEOUT_MS),
              }).catch(() => {});
              response = null;
            }
          }
        } else if (error?.name !== 'TimeoutError' || page.url() === 'about:blank') {
          throw error;
        }
      } else if (error?.name !== 'TimeoutError' || page.url() === 'about:blank') {
        throw error;
      }
    }
    logRuntime('browser.open.phase', {
      traceId,
      phase: 'goto-commit',
      browserSessionId: browserSession.id,
      currentUrl: page.url(),
      requestId,
      ms: Date.now() - startedAt,
    });

    await page.waitForLoadState('domcontentloaded', {
      timeout: Math.min(DEFAULT_TIMEOUT_MS, DOMCONTENTLOADED_TIMEOUT_MS),
    }).catch(() => {});

    await resolveInternalProviderPage(page, intent);
    await page.waitForTimeout(PAGE_SETTLE_MS);

    const headers = response?.headers() || {};
    browserSession.embeddable = isEmbeddable(headers);
    browserSession.url = page.url() || targetUrl;
    browserSession.title = normalizeWhitespace(await page.title()) || intent.titleHint || new URL(targetUrl).hostname;
    logRuntime('browser.open.phase', {
      traceId,
      phase: 'page-classified',
      browserSessionId: browserSession.id,
      embeddable: browserSession.embeddable,
      title: browserSession.title,
      currentUrl: page.url(),
      requestId,
      ms: Date.now() - startedAt,
    });
    await refreshBrowserSessionSnapshot(browserSession, {
      includeScreenshot: true,
      readerTextLimit: MAX_READER_TEXT_LENGTH,
      queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
    });
    browserSession.responseStatus = Number(response?.status?.() || 0) || 0;
    browserSession.verification = assertVerifiedBrowserSessionSnapshot(browserSession, {
      responseStatus: browserSession.responseStatus,
    });
    browserSession.verified = true;

    logRuntime('browser.open.phase', {
      traceId,
      phase: 'session-ready',
      browserSessionId: browserSession.id,
      readerTextLength: browserSession.readerText.length,
      screenshot: Boolean(browserSession.screenshotUrl),
      verified: browserSession.verified,
      verificationReason: browserSession.verification?.reason || '',
      requestId,
      ms: Date.now() - startedAt,
    });

    if (getActiveRequestId() !== requestId) {
      throw new Error('Открытие было прервано более новым запросом');
    }

    await closeActivePageWithScheduler('open-replace');

    if (getActiveRequestId() !== requestId) {
      throw new Error('Открытие было прервано более новым запросом');
    }

    setActiveBrowserSession(browserSession);
    touchBrowserSession(browserSession, () => scheduleBrowserShutdown(closeBrowser), () => scheduleSessionCleanup(() => scheduleBrowserShutdown(closeBrowser), closeActivePageWithScheduler));

    return serializeSession(browserSession);
  } catch (error) {
    if (getActiveBrowserSession()?.id === browserSession.id) {
      setActiveBrowserSession(null);
    }
    await context.close().catch(() => {});
    scheduleBrowserShutdown(closeBrowser);
    throw error;
  }
}

export async function getBrowserSessionContext(sessionId) {
  const session = requireActiveBrowserSession(String(sessionId || '').trim(), closeActivePageWithScheduler);
  await refreshBrowserSessionSnapshot(session, {
    includeScreenshot: false,
    readerTextLimit: SESSION_CONTEXT_TEXT_LENGTH,
    queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
  });
  touchBrowserSession(session, () => scheduleBrowserShutdown(closeBrowser), () => scheduleSessionCleanup(() => scheduleBrowserShutdown(closeBrowser), closeActivePageWithScheduler));

  logRuntime('browser.session.context', {
    browserSessionId: session.id,
    title: session.title,
    url: session.url,
    textLength: session.readerText.length,
  });

  return {
    browserSessionId: session.id,
    title: session.title,
    url: session.url,
    embeddable: Boolean(session.embeddable),
    readerText: session.readerText,
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    actionableElements: Array.isArray(session.actionableElements) ? session.actionableElements : [],
  };
}

export async function queryBrowserSession({ sessionId, question }) {
  const session = requireActiveBrowserSession(String(sessionId || '').trim(), closeActivePageWithScheduler);
  const normalizedQuestion = normalizeWhitespace(question);
  if (!normalizedQuestion) {
    throw new Error('Вопрос к странице не передан');
  }

  await refreshBrowserSessionSnapshot(session, {
    includeScreenshot: false,
    readerTextLimit: SESSION_CONTEXT_TEXT_LENGTH,
    queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
  });
  const answer = buildSessionQueryAnswer(normalizedQuestion, session);
  touchBrowserSession(session, () => scheduleBrowserShutdown(closeBrowser), () => scheduleSessionCleanup(() => scheduleBrowserShutdown(closeBrowser), closeActivePageWithScheduler));

  logRuntime('browser.session.query', {
    browserSessionId: session.id,
    question: normalizedQuestion,
    answerLength: answer.answer.length,
    contextLength: answer.contextSnippet.length,
  });

  return {
    browserSessionId: session.id,
    title: session.title,
    url: session.url,
    answer: answer.answer,
    contextSnippet: answer.contextSnippet,
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    actionableElements: Array.isArray(session.actionableElements) ? session.actionableElements : [],
  };
}

export async function getBrowserSessionView(sessionId, { refresh = false } = {}) {
  const session = requireActiveBrowserSession(String(sessionId || '').trim(), closeActivePageWithScheduler);
  const shouldRefresh = refresh
    || !session.screenshotUrl
    || (Date.now() - Number(session.lastScreenshotAt || 0)) >= BROWSER_VIEW_REFRESH_MS;

  if (shouldRefresh) {
    await refreshBrowserSessionSnapshot(session, {
      includeScreenshot: true,
      readerTextLimit: MAX_READER_TEXT_LENGTH,
      queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
    });
  } else {
    touchBrowserSession(session, () => scheduleBrowserShutdown(closeBrowser), () => scheduleSessionCleanup(() => scheduleBrowserShutdown(closeBrowser), closeActivePageWithScheduler));
  }

  logRuntime('browser.session.view', {
    browserSessionId: session.id,
    revision: session.revision || 0,
    refreshed: shouldRefresh,
  });

  return {
    browserSessionId: session.id,
    title: session.title,
    url: session.url,
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    imageUrl: session.screenshotUrl || null,
    width: session.viewport?.width || VIEWPORT_WIDTH,
    height: session.viewport?.height || VIEWPORT_HEIGHT,
    actionableElements: Array.isArray(session.actionableElements) ? session.actionableElements : [],
  };
}

export async function waitForNavigationAfterAction(page, previousUrl) {
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {}),
    page.waitForTimeout(500),
  ]);
  await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});

  const nextUrl = page.url();
  if (previousUrl && nextUrl && previousUrl !== nextUrl && !isSameSiteUrl(previousUrl, nextUrl)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
    throw new Error('Переход на другой сайт без явной команды запрещен');
  }
}

export async function performBrowserSessionAction({ sessionId, action }) {
  const session = requireActiveBrowserSession(String(sessionId || '').trim(), closeActivePageWithScheduler);
  const page = session.page;
  const actionType = normalizeWhitespace(action?.type || '').toLowerCase();

  if (!actionType) {
    throw new Error('Тип browser action не передан');
  }

  await refreshBrowserSessionSnapshot(session, {
    includeScreenshot: false,
    readerTextLimit: MAX_READER_TEXT_LENGTH,
    queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
  });

  const previousUrl = page.url();

  if (actionType === 'click') {
    const xRatio = Number(action?.xRatio);
    const yRatio = Number(action?.yRatio);
    if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) {
      throw new Error('Координаты клика не переданы');
    }

    const targetX = Math.round(clamp(xRatio, 0, 1) * (session.viewport?.width || VIEWPORT_WIDTH));
    const targetY = Math.round(clamp(yRatio, 0, 1) * (session.viewport?.height || VIEWPORT_HEIGHT));
    await page.mouse.click(targetX, targetY, { delay: 40 });
    await waitForNavigationAfterAction(page, previousUrl);
  } else if (actionType === 'wheel' || actionType === 'scroll') {
    const deltaY = clamp(Number(action?.deltaY) || 0, -2200, 2200);
    if (!deltaY) {
      throw new Error('Смещение scroll не передано');
    }
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(240);
  } else if (actionType === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  } else if (actionType === 'forward') {
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  } else if (actionType === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  } else if (actionType === 'home') {
    const currentUrl = page.url();
    let homeUrl = '';
    try {
      homeUrl = `${new URL(currentUrl).origin}/`;
    } catch {
      throw new Error('Не удалось определить главную страницу текущего сайта');
    }
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  } else if (actionType === 'open-url') {
    const safeUrl = await assertPublicUrl(String(action?.url || '').trim());
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS).catch(() => {});
  } else if (actionType === 'click-label') {
    const label = normalizeWhitespace(action?.label || '');
    if (!label) {
      throw new Error('Не передана подпись элемента');
    }
    const target = findBestActionableElement(session, label);
    if (!target) {
      throw new Error('Не нашла на текущей странице подходящую кнопку или ссылку');
    }
    const x = clamp(target.x + Math.round(target.width / 2), 1, session.viewport?.width || VIEWPORT_WIDTH);
    const y = clamp(target.y + Math.round(target.height / 2), 1, session.viewport?.height || VIEWPORT_HEIGHT);
    await page.mouse.click(x, y, { delay: 40 });
    await waitForNavigationAfterAction(page, previousUrl);
  } else {
    throw new Error('Неподдерживаемое действие на странице');
  }

  await refreshBrowserSessionSnapshot(session, {
    includeScreenshot: true,
    readerTextLimit: MAX_READER_TEXT_LENGTH,
    queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
  });
  touchBrowserSession(session, () => scheduleBrowserShutdown(closeBrowser), () => scheduleSessionCleanup(() => scheduleBrowserShutdown(closeBrowser), closeActivePageWithScheduler));

  logRuntime('browser.session.action', {
    browserSessionId: session.id,
    type: actionType,
    url: session.url,
    revision: session.revision || 0,
  });

  return {
    browserSessionId: session.id,
    title: session.title,
    url: session.url,
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    imageUrl: session.screenshotUrl || null,
    width: session.viewport?.width || VIEWPORT_WIDTH,
    height: session.viewport?.height || VIEWPORT_HEIGHT,
    actionableElements: Array.isArray(session.actionableElements) ? session.actionableElements : [],
  };
}
