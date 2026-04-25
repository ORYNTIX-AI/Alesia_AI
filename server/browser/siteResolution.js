import { logRuntime } from '../runtimeLogger.js';
import { DEFAULT_TIMEOUT_MS, GEMINI_REQUEST_TIMEOUT_MS, MIN_RESOLUTION_STEP_TIMEOUT_MS, SITE_RESOLUTION_CACHE_TTL_MS, SITE_RESOLUTION_MIN_SCORE, collectLookupStems, geminiAgent, geminiApiKey, geminiModel, normalizeWhitespace, scoreResolvedCandidate, simplifyLookup, siteResolutionCache } from './shared.js';
import { assertPublicUrl } from './browserRuntime.js';
import { buildSessionHistoryPromptBlock, extractSpokenDomain, normalizeSpokenDomainLabel, parseHistoryUrl, sanitizeSessionHistory } from './siteResolutionSupport.js';

export function buildGeminiModelPath() {
  return geminiModel.startsWith('models/') ? geminiModel : `models/${geminiModel}`;
}

export function extractResponseText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || '';
}

export function parseJsonText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('Gemini вернул пустой ответ');
  }

  try {
    return JSON.parse(normalized);
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('Gemini вернул невалидный JSON');
  }
}

export function requestText(url, { method = 'GET', headers = {}, body = null, agent, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const hardTimeoutId = setTimeout(() => {
      request.destroy(new Error(`Истек таймаут запроса к ${url}`));
    }, Math.max(1000, timeoutMs));
    const request = https.request(url, {
      method,
      headers,
      agent,
      timeout: timeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          clearTimeout(hardTimeoutId);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`HTTP ${response.statusCode}`));
          }
          return resolve(raw);
        } catch (error) {
          return reject(error);
        }
      });
    });

    request.on('timeout', () => {
      clearTimeout(hardTimeoutId);
      request.destroy(new Error(`Истек таймаут запроса к ${url}`));
    });
    request.on('error', (error) => {
      clearTimeout(hardTimeoutId);
      reject(error);
    });
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function requestGeminiJson(prompt, timeoutMs = GEMINI_REQUEST_TIMEOUT_MS) {
  if (!geminiApiKey) {
    throw new Error('Gemini API key не настроен');
  }

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/${buildGeminiModelPath()}:generateContent`;
  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-goog-api-key': geminiApiKey,
    },
    body,
    agent: geminiAgent,
    timeoutMs: Math.max(2500, timeoutMs),
  };

  const maxAttempts = 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const raw = await requestText(url, requestOptions);
      const payload = raw ? JSON.parse(raw) : {};
      return parseJsonText(extractResponseText(payload));
    } catch (error) {
      const isLastAttempt = attempt === (maxAttempts - 1);
      const isTimeout = /таймаут/i.test(String(error?.message || ''));
      if (isLastAttempt || !isTimeout) {
        throw error;
      }
    }
  }

  throw new Error('Gemini resolver failed without response');
}

export function normalizeResolvedUrl(domain, url) {
  const normalizedUrl = normalizeWhitespace(url).replace(/^["']|["']$/g, '');
  const normalizedDomain = normalizeWhitespace(domain).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');

  if (normalizedUrl) {
    if (/^https?:\/\//i.test(normalizedUrl)) {
      return normalizedUrl;
    }
    return `https://${normalizedUrl.replace(/^\/+/, '')}`;
  }

  if (normalizedDomain) {
    return `https://${normalizedDomain}`;
  }

  return '';
}

export function looksLikeStandaloneSiteMention(transcript) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized || normalized.length < 4) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 2) {
    return false;
  }

  if (hasKeywordFragment(normalized, ['погод', 'новост', 'курс', 'карт', 'википед', 'кто такой', 'что такое'])) {
    return false;
  }

  if (/^(можешь|моглабы|пожалуйста|ну|слушай)$/i.test(simplifyLookup(normalized))) {
    return false;
  }

  return /^[\p{L}\p{N}\s.-]+$/u.test(normalized);
}

export function buildLookupVariants(siteQuery, _contextHint = '', transcript = '') {
  const variants = new Set();
  const normalizedSiteQuery = normalizeWhitespace(siteQuery);
  const normalizedTranscript = normalizeWhitespace(transcript);

  if (normalizedSiteQuery) {
    variants.add(normalizedSiteQuery);
  }

  const spokenDomain = extractSpokenDomain(`${normalizedSiteQuery} ${normalizedTranscript}`);
  if (spokenDomain) {
    try {
      variants.add(new URL(spokenDomain).hostname.replace(/^www\./i, ''));
    } catch {
      // ignore spoken-domain parse failures
    }
  }

  const collapsedSpokenQuery = normalizeSpokenDomainLabel(normalizedSiteQuery);
  if (collapsedSpokenQuery.length >= 3) {
    variants.add(collapsedSpokenQuery);
  }

  collectLookupStems(normalizedSiteQuery).forEach((stem) => {
    if (stem.length >= 2) {
      variants.add(stem);
    }
  });

  if (!variants.size && normalizedTranscript) {
    variants.add(normalizedTranscript);
  }

  return Array.from(variants).filter(Boolean).slice(0, 6);
}

export function buildBigrams(stem) {
  const result = new Set();
  for (let index = 0; index < stem.length - 1; index += 1) {
    result.add(stem.slice(index, index + 2));
  }
  return result;
}

export function computeStemSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  if (left.length < 2 || right.length < 2) return 0;

  const leftBigrams = buildBigrams(left);
  const rightBigrams = buildBigrams(right);
  let intersection = 0;
  leftBigrams.forEach((value) => {
    if (rightBigrams.has(value)) {
      intersection += 1;
    }
  });
  const union = leftBigrams.size + rightBigrams.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function buildSiteResolverPrompt(transcript, siteQuery, contextHint, sessionHistory = [], checkedFailures = []) {
  const previousFailuresBlock = checkedFailures.length > 0
    ? `\nУже проверенные и неподходящие варианты:
${checkedFailures.map((failure, index) => `${index + 1}. ${failure.url} -> ${failure.reason}`).join('\n')}

Не повторяй эти варианты. Предложи другой реальный домен, если знаешь его уверенно.`
    : '';
  const sessionHistoryBlock = buildSessionHistoryPromptBlock(sessionHistory);

  return `Ты системный резолвер доменов для голосового аватара.

Нужно определить реальный публичный домен сайта, который пользователь хочет открыть.

Правила:
1. Используй только свои знания о реально существующих популярных публичных сайтах.
2. Никакого поиска и никаких предположений "наверное". Если не уверен, верни canResolve=false.
3. Разрешены только домены .by и .ru.
4. Верни JSON без markdown и без пояснений.
5. Если пользователь назвал именно раздел или бренд сайта, можешь вернуть конкретный URL раздела, но только если уверен.
6. Название сайта может быть в косвенном падеже, разговорной форме, сокращении или неполным.
7. Не подставляй бренд из контекста персонажа, если пользователь явно не назвал этот бренд в запросе.
8. Если знаешь несколько реальных вариантов, верни лучший вариант в url, а остальные в candidateUrls.

Формат ответа JSON:
{
  "canResolve": true,
  "title": "Короткое название сайта",
  "domain": "example.by",
  "url": "https://example.by/",
  "candidateUrls": ["https://example.by/"],
  "reason": "коротко"
}

Если не уверен, верни:
{
  "canResolve": false,
  "title": "",
  "domain": "",
  "url": "",
  "candidateUrls": [],
  "reason": "почему не удалось уверенно определить"
}

Фраза пользователя: "${transcript}"
Название сайта или цель открытия: "${siteQuery}"
Контекст активного персонажа: "${normalizeWhitespace(contextHint || '')}"
${sessionHistoryBlock}${previousFailuresBlock}`;
}

export async function resolveSiteWithGemini(
  transcript,
  siteQuery,
  contextHint,
  sessionHistory = [],
  traceId = '',
  { totalBudgetMs = SITE_RESOLUTION_TIMEOUT_MS } = {},
) {
  const startedAt = Date.now();
  const getRemainingBudget = () => totalBudgetMs - (Date.now() - startedAt);
  const toGeminiTimeout = () => {
    const remainingBudget = getRemainingBudget();
    if (remainingBudget <= MIN_RESOLUTION_STEP_TIMEOUT_MS) {
      return 0;
    }
    return Math.min(
      GEMINI_REQUEST_TIMEOUT_MS,
      Math.max(MIN_RESOLUTION_STEP_TIMEOUT_MS, remainingBudget - 120),
    );
  };

  const lookupVariants = buildLookupVariants(siteQuery, contextHint, transcript);
  const cacheKeys = Array.from(new Set(
    [siteQuery, transcript]
      .map((value) => simplifyLookup(value))
      .filter(Boolean)
  ));

  for (const cacheKey of cacheKeys) {
    const cached = siteResolutionCache.get(cacheKey);
    if (cached && cached.value?.url && (Date.now() - cached.timestamp) < SITE_RESOLUTION_CACHE_TTL_MS) {
      logRuntime('browser.resolve.cache-hit', {
        traceId,
        cacheKey,
        url: cached.value.url,
      });
      return cached.value;
    }
  }

  const checkedFailures = [];

  for (const lookupVariant of (lookupVariants.length ? lookupVariants : [siteQuery || transcript])) {
    if (getRemainingBudget() <= 0) {
      return {
        canResolve: false,
        title: '',
        reason: 'Истек таймаут определения сайта',
        url: '',
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (getRemainingBudget() <= 0) {
        return {
          canResolve: false,
          title: '',
          reason: 'Истек таймаут определения сайта',
          url: '',
        };
      }

      const geminiTimeoutMs = toGeminiTimeout();
      if (geminiTimeoutMs <= 0) {
        return {
          canResolve: false,
          title: '',
          reason: 'Истек таймаут определения сайта',
          url: '',
        };
      }

      const resolved = await requestGeminiJson(buildSiteResolverPrompt(
        transcript,
        lookupVariant,
        contextHint,
        sessionHistory,
        checkedFailures,
      ), geminiTimeoutMs);
      const title = normalizeWhitespace(resolved?.title || '');
      const reason = normalizeWhitespace(resolved?.reason || '');
      const primaryUrl = normalizeResolvedUrl(resolved?.domain, resolved?.url);
      const alternateUrls = Array.isArray(resolved?.candidateUrls)
        ? resolved.candidateUrls.map((candidateUrl) => normalizeResolvedUrl('', candidateUrl))
        : [];
      const candidateUrls = Array.from(new Set([primaryUrl, ...alternateUrls].filter(Boolean)));

      if (!resolved?.canResolve && candidateUrls.length === 0) {
        if (reason) {
          checkedFailures.push({
            url: lookupVariant || '(пустой вариант)',
            reason,
          });
        }
        continue;
      }

      for (const candidateUrl of candidateUrls) {
        try {
          const safeUrl = await assertPublicUrl(candidateUrl);
          const relevanceScore = scoreResolvedCandidate(siteQuery, transcript, title, safeUrl);
          if (relevanceScore < SITE_RESOLUTION_MIN_SCORE) {
            checkedFailures.push({
              url: safeUrl,
              reason: `низкая релевантность (${relevanceScore})`,
            });
            continue;
          }

          const safeValue = {
            canResolve: true,
            title,
            reason,
            url: safeUrl,
            score: relevanceScore,
          };
          cacheKeys.forEach((cacheKey) => {
            siteResolutionCache.set(cacheKey, { value: safeValue, timestamp: Date.now() });
          });
          logRuntime('browser.resolve.gemini-match', {
            traceId,
            lookupVariant,
            url: safeUrl,
            score: relevanceScore,
            ms: Date.now() - startedAt,
          });
          return safeValue;
        } catch (error) {
          checkedFailures.push({
            url: candidateUrl,
            reason: error.message || 'не прошёл проверку',
          });
        }
      }

      if (reason) {
        checkedFailures.push({
          url: lookupVariant || '(пустой вариант)',
          reason,
        });
      }
    }
  }

  return {
    canResolve: false,
    title: '',
    reason: checkedFailures.at(-1)?.reason || 'Не удалось определить сайт',
    url: '',
  };
}
