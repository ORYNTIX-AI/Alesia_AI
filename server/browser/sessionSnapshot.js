import { logRuntime } from '../runtimeLogger.js';
import { DEFAULT_TIMEOUT_MS, DIRECT_PAGE_CONTEXT_TIMEOUT_MS, MAX_ACTIONABLE_ELEMENTS, MAX_ACTION_LABEL_LENGTH, MAX_READER_TEXT_LENGTH, SCREENSHOT_CAPTURE_TIMEOUT_MS, SCREENSHOT_SETTLE_MS, VIEWPORT_HEIGHT, VIEWPORT_WIDTH, computeStemSimilarity, normalizeWhitespace, simplifyLookup } from './shared.js';
import { decodeHtmlEntities } from './siteResolutionSupport.js';
import { assertPublicUrl, isEmbeddable, safeHostnameFromUrl } from './browserRuntime.js';

export function truncateText(value, maxLength = 360) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export async function readPageText(page) {
  return normalizeWhitespace(
    await page.evaluate(() => document.body?.innerText || '')
  );
}

export async function extractActionableElements(page) {
  const elements = await page.evaluate(({ maxItems, maxLabelLength }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLabelLength);
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (!style || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.right > 0;
    };

    const hrefLabel = (element) => {
      try {
        const url = new URL(element.href, window.location.href);
        const pathname = decodeURIComponent(url.pathname || '').split('/').filter(Boolean).pop() || '';
        return normalize(pathname.replace(/[-_]+/g, ' '));
      } catch {
        return '';
      }
    };

    const items = [];
    const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"], summary, input[type="button"], input[type="submit"]'));
    for (const element of candidates) {
      if (!isVisible(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const label = normalize(
        element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.textContent
        || element.getAttribute('value')
        || element.getAttribute('alt')
        || hrefLabel(element)
        || ''
      );
      if (!label) {
        continue;
      }

      items.push({
        label,
        role: normalize(element.getAttribute('role') || element.tagName || '').toLowerCase(),
        href: normalize(element.href || ''),
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });

      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }, {
    maxItems: MAX_ACTIONABLE_ELEMENTS,
    maxLabelLength: MAX_ACTION_LABEL_LENGTH,
  }).catch(() => []);

  return Array.isArray(elements) ? elements : [];
}

export async function refreshBrowserSessionSnapshot(session, {
  includeScreenshot = false,
  readerTextLimit = MAX_READER_TEXT_LENGTH,
  queryTextLimit = SESSION_QUERY_TEXT_LENGTH,
} = {}) {
  if (!session?.page || session.page.isClosed()) {
    throw new Error('Веб-сессия недоступна');
  }

  const page = session.page;
  const [titleRaw, textRaw] = await Promise.all([
    page.title().catch(() => ''),
    readPageText(page).catch(() => ''),
  ]);

  session.url = page.url();
  session.title = normalizeWhitespace(titleRaw) || session.title || safeHostnameFromUrl(session.url, 'Сайт');
  session.readerText = textRaw.slice(0, readerTextLimit);
  session.queryText = textRaw.slice(0, queryTextLimit);
  session.actionableElements = await extractActionableElements(page);
  session.lastUpdatedAt = Date.now();

  if (includeScreenshot) {
    await page.waitForTimeout(SCREENSHOT_SETTLE_MS).catch(() => {});
    const screenshotResult = await new Promise((resolve) => {
      let finished = false;
      const timerId = setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve({ ok: false, reason: 'timeout' });
        }
      }, SCREENSHOT_CAPTURE_TIMEOUT_MS);

      page.screenshot({
        type: 'jpeg',
        quality: 78,
      })
        .then((buffer) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timerId);
          resolve({ ok: true, buffer });
        })
        .catch((error) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timerId);
          resolve({ ok: false, reason: String(error?.message || 'screenshot-failed') });
        });
    });

    if (screenshotResult?.ok && screenshotResult.buffer) {
      session.screenshotUrl = `data:image/jpeg;base64,${screenshotResult.buffer.toString('base64')}`;
      session.lastScreenshotAt = Date.now();
    } else {
      logRuntime('browser.session.screenshot.skipped', {
        browserSessionId: session.id,
        url: session.url,
        reason: screenshotResult?.reason || 'unknown',
      });
    }
  }

  session.revision = Number(session.revision || 0) + 1;

  return session;
}

function requireActiveBrowserSession(sessionId = '') {
  if (!activeBrowserSession) {
    throw new Error('Нет активного открытого сайта');
  }

  if (sessionId && activeBrowserSession.id !== sessionId) {
    throw new Error('Открытый сайт устарел. Откройте сайт заново.');
  }

  if (!activeBrowserSession.page || activeBrowserSession.page.isClosed()) {
    void closeActivePage('page-closed-check');
    throw new Error('Сессия сайта завершена');
  }

  return activeBrowserSession;
}

const QUERY_STOP_WORDS = new Set([
  'что',
  'это',
  'этот',
  'эта',
  'этом',
  'на',
  'в',
  'во',
  'по',
  'для',
  'про',
  'сайт',
  'страница',
  'странице',
  'страницу',
  'сейчас',
  'там',
  'тут',
  'здесь',
  'низу',
  'который',
  'которая',
  'которые',
  'какой',
  'какая',
  'какие',
]);

export function tokenizeQuestion(question) {
  return normalizeWhitespace(String(question || '').toLowerCase())
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
    .map((token) => simplifyLookup(token))
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
}

export function splitContextSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((chunk) => normalizeWhitespace(chunk))
    .filter((chunk) => chunk.length >= 20);
}

export function scoreSentenceAgainstTokens(sentence, tokens) {
  if (!sentence || !tokens.length) {
    return 0;
  }

  const sentenceStem = simplifyLookup(sentence);
  if (!sentenceStem) {
    return 0;
  }

  return tokens.reduce((score, token) => {
    if (sentenceStem.includes(token)) {
      return score + 1;
    }
    return score;
  }, 0);
}

export function selectRelevantContext(text, question) {
  const sentences = splitContextSentences(text);
  if (!sentences.length) {
    return '';
  }

  const tokens = tokenizeQuestion(question);
  if (!tokens.length) {
    return truncateText(sentences.slice(0, 3).join(' '), 420);
  }

  const ranked = sentences
    .map((sentence) => ({
      sentence,
      score: scoreSentenceAgainstTokens(sentence, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.sentence);

  if (!ranked.length) {
    return truncateText(sentences.slice(0, 2).join(' '), 420);
  }

  return truncateText(ranked.join(' '), 420);
}

export function buildSessionQueryAnswer(question, session) {
  const contextSnippet = selectRelevantContext(session.queryText || session.readerText, question);
  if (!contextSnippet) {
    return {
      answer: 'На текущей странице пока не вижу читаемого текста.',
      contextSnippet: '',
    };
  }

  return {
    answer: `На странице ${session.title ? `"${session.title}"` : 'сайта'}: ${contextSnippet}`,
    contextSnippet,
  };
}

export function htmlToPlainText(html) {
  return normalizeWhitespace(
    decodeHtmlEntities(
      String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/section|\/article|\/h[1-6])\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    ),
  );
}

export async function fetchBrowserUrlContext({ url, question = '' }) {
  const safeUrl = await assertPublicUrl(String(url || '').trim());
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIRECT_PAGE_CONTEXT_TIMEOUT_MS);

  try {
    const response = await fetch(safeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'user-agent': 'AlesiaAI/1.0 (+https://arfox.by/)',
      },
    });

    if (!response.ok) {
      throw new Error(`Страница ответила ошибкой ${response.status}`);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('Страница не вернула HTML-контент');
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = normalizeWhitespace(decodeHtmlEntities(titleMatch?.[1] || '')) || 'Сайт';
    const readerText = truncateText(htmlToPlainText(html), MAX_READER_TEXT_LENGTH);
    const normalizedUrl = String(response.url || safeUrl).trim();
    const answer = buildSessionQueryAnswer(question || 'что сейчас на этой странице', {
      title,
      url: normalizedUrl,
      readerText,
      queryText: readerText,
    });

    return {
      status: 'ready',
      title,
      url: normalizedUrl,
      embeddable: isEmbeddable({
        'x-frame-options': String(response.headers.get('x-frame-options') || ''),
        'content-security-policy': String(response.headers.get('content-security-policy') || ''),
      }),
      readerText,
      lastUpdated: Date.now(),
      answer: answer.answer,
      contextSnippet: answer.contextSnippet,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Не удалось быстро прочитать страницу');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function verifyBrowserSessionSnapshot(session, { responseStatus = 0 } = {}) {
  const url = normalizeWhitespace(session?.url || '');
  const title = normalizeWhitespace(session?.title || '');
  const readerText = normalizeWhitespace(session?.readerText || session?.queryText || '');
  const screenshotUrl = normalizeWhitespace(session?.screenshotUrl || '');
  const status = Number(responseStatus || session?.responseStatus || 0) || 0;

  if (!url || url === 'about:blank') {
    return { ok: false, reason: 'about-blank', status };
  }
  if (/^chrome-error:\/\//i.test(url) || /chrome-error/i.test(title)) {
    return { ok: false, reason: 'chrome-error', status };
  }
  if (status >= 400) {
    return { ok: false, reason: `http-status-${status}`, status };
  }
  if (!title && !readerText && !screenshotUrl) {
    return { ok: false, reason: 'empty-visible-state', status };
  }
  return {
    ok: true,
    reason: 'verified',
    status,
    hasTitle: Boolean(title),
    hasReaderText: Boolean(readerText),
    hasScreenshot: Boolean(screenshotUrl),
  };
}

export function assertVerifiedBrowserSessionSnapshot(session, options = {}) {
  const verification = verifyBrowserSessionSnapshot(session, options);
  if (!verification.ok) {
    const error = new Error(`Browser page verification failed: ${verification.reason}`);
    error.code = 'browser_snapshot_unverified';
    error.details = verification;
    throw error;
  }
  return verification;
}

export function serializeSession(session) {
  const view = {
    imageUrl: session.screenshotUrl || null,
    width: session.viewport?.width || VIEWPORT_WIDTH,
    height: session.viewport?.height || VIEWPORT_HEIGHT,
    revision: session.revision || 0,
    actionableElements: Array.isArray(session.actionableElements) ? session.actionableElements : [],
  };

  return {
    status: 'ready',
    browserSessionId: session.id,
    sourceType: session.sourceType,
    title: session.title,
    url: session.url,
    embeddable: Boolean(session.embeddable),
    readerText: session.readerText || '',
    screenshotUrl: session.screenshotUrl || null,
    verified: session.verified === true,
    verification: session.verification || null,
    error: null,
    query: session.query || '',
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    view,
  };
}

export function scoreActionableElement(target, element) {
  const normalizedTarget = simplifyLookup(target);
  const normalizedLabel = simplifyLookup(element?.label || '');
  if (!normalizedTarget || !normalizedLabel) {
    return 0;
  }

  const direct = computeStemSimilarity(normalizedTarget, normalizedLabel);
  if (normalizedLabel.includes(normalizedTarget) || normalizedTarget.includes(normalizedLabel)) {
    return Math.max(direct, 0.92);
  }
  return direct;
}

export function findBestActionableElement(session, label) {
  const elements = Array.isArray(session?.actionableElements) ? session.actionableElements : [];
  if (!elements.length) {
    return null;
  }

  const ranked = elements
    .map((element) => ({
      element,
      score: scoreActionableElement(label, element),
    }))
    .filter((entry) => entry.score >= 0.58)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.element || null;
}
