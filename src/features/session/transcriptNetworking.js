import {
  hasExplicitMainPageSiteTarget,
  isMainPagePhrase,
  normalizeSpeechText,
} from './transcriptDetection.js'

export function parseBrowserActionRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (isMainPagePhrase(normalized) && hasExplicitMainPageSiteTarget(normalized)) {
    return null;
  }

  if (
    /(перейди|перейти|открой|открыть|вернись|вернуться|иди|зайди|зайти|переход|навигац)/i.test(normalized)
    && isMainPagePhrase(normalized)
  ) {
    return { type: 'home' };
  }

  if (isMainPagePhrase(normalized)) {
    return { type: 'home' };
  }

  if (/(^|\s)(назад|вернись назад|вернуться назад)(?=\s|$)/i.test(normalized)) {
    return { type: 'back' };
  }

  if (/(^|\s)(вперед|впер[её]д|далее)(?=\s|$)/i.test(normalized)) {
    return { type: 'forward' };
  }

  if (/(^|\s)(обнови|перезагрузи|обновить страницу)(?=\s|$)/i.test(normalized)) {
    return { type: 'reload' };
  }

  if (/(прокрути|листни|пролистай|скролл)/i.test(normalized)) {
    return { type: 'wheel', deltaY: /(вверх|наверх)/i.test(normalized) ? -960 : 960 };
  }

  const clickMatch = normalized.match(/(?:нажми|кликни|перейди в раздел|открой раздел)\s+(.+)$/iu);
  if (clickMatch?.[1]) {
    const label = normalizeSpeechText(clickMatch[1]).replace(/[.?!]+$/g, '');
    if (label) {
      return { type: 'click-label', label };
    }
  }

  return null;
}

export function parseImplicitBrowserActionRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (isMainPagePhrase(normalized)) {
    return { type: 'home' };
  }
  if (/(^|\s)(назад|вернись назад|вернуться назад)(?=\s|$)/i.test(normalized)) {
    return { type: 'back' };
  }
  if (/(^|\s)(вперед|впер[её]д|далее)(?=\s|$)/i.test(normalized)) {
    return { type: 'forward' };
  }
  if (/(^|\s)(обнови|перезагрузи|обновить страницу|перезагрузка)(?=\s|$)/i.test(normalized)) {
    return { type: 'reload' };
  }

  return null;
}

export function isBrowserActionFollowupRequest(transcript) {
  return Boolean(parseBrowserActionRequest(transcript));
}

export function isTransientIntentError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }
  return message.includes('таймаут')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('503')
    || message.includes('network');
}

export function classifyIntentErrorReason(error) {
  if (isTransientIntentError(error)) {
    return 'resolve_timeout';
  }
  return 'navigation_failed';
}

export function classifyBrowserOpenErrorReason(error) {
  const explicitCode = String(error?.code || '').trim();
  if (explicitCode) {
    return explicitCode;
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('таймаут') || message.includes('timeout')) {
    return 'network_timeout';
  }
  if (message.includes('запрещ') || message.includes('blocked') || message.includes('домен')) {
    return 'navigation_blocked';
  }
  return 'navigation_failed';
}

export async function jsonRequest(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });

  try {
    const { signal: _ignoredSignal, ...restOptions } = options;
    const response = await fetch(url, {
      ...restOptions,
      signal: controller.signal,
    });
    const rawPayload = await response.text().catch(() => '');
    let payload = {};
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const requestError = new Error(
          contentType.includes('text/html')
            ? 'Сервер вернул HTML вместо данных API. Проверьте адрес и прокси.'
            : 'Сервер вернул неверный формат ответа.',
        );
        requestError.code = 'invalid_response_format';
        throw requestError;
      }
    }
    if (!response.ok) {
      const requestError = new Error(payload.error || `Запрос не выполнен (HTTP ${response.status})`);
      if (payload?.errorReason) {
        requestError.code = String(payload.errorReason);
      }
      if (payload?.details && typeof payload.details === 'object') {
        requestError.details = payload.details;
      }
      throw requestError;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Истек таймаут ожидания ответа');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.('abort', abortFromExternal);
  }
}

export function waitForNextPaint() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 32);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
