import dns from 'dns/promises';
import https from 'https';
import net from 'net';
import { chromium } from 'playwright';

const MAX_READER_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const GEMINI_REQUEST_TIMEOUT_MS = 22000;
const SITE_RESOLUTION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE_SETTLE_MS = 400;
const SCREENSHOT_SETTLE_MS = 250;
const parsedBrowserIdleTimeoutMs = Number.parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || '', 10);
const BROWSER_IDLE_TIMEOUT_MS = Number.isFinite(parsedBrowserIdleTimeoutMs) && parsedBrowserIdleTimeoutMs >= 0
  ? parsedBrowserIdleTimeoutMs
  : 30000;
const DIRECT_URL_REGEX = /\bhttps?:\/\/[^\s]+/i;
const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const WEATHER_RESULT_URL_PATTERN = /https:\/\/www\.gismeteo\.by\/weather-[^/]+-\d+\/?/i;

const WEATHER_MEMORY = [
  { aliases: ['минск'], url: 'https://www.gismeteo.by/weather-minsk-4248/' },
  { aliases: ['брест'], url: 'https://www.gismeteo.by/weather-brest-4912/' },
  { aliases: ['гродно'], url: 'https://www.gismeteo.by/weather-grodno-4243/' },
  { aliases: ['гомель'], url: 'https://www.gismeteo.by/weather-gomel-4918/' },
  { aliases: ['витебск'], url: 'https://www.gismeteo.by/weather-vitebsk-4218/' },
  { aliases: ['могилев', 'могилёв'], url: 'https://www.gismeteo.by/weather-mogilev-4251/' },
];

let browserPromise = null;
let browserInstance = null;
let browserIdleTimer = null;
let activePage = null;
let activePageContext = null;
let activeRequestId = 0;
let geminiApiKey = '';
let geminiAgent = null;
let geminiModel = process.env.BROWSER_RESOLVER_MODEL || 'gemini-3-flash-preview';
const siteResolutionCache = new Map();

export function configureBrowserController({ apiKey, agent, model } = {}) {
  geminiApiKey = String(apiKey || '');
  geminiAgent = agent || null;
  geminiModel = String(model || process.env.BROWSER_RESOLVER_MODEL || 'gemini-3-flash-preview');
}

function normalizeWhitespace(input) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCommandWords(transcript) {
  return normalizeWhitespace(
    String(transcript || '')
      .replace(/^(ну|пожалуйста|слушай|смотри)\s+/i, '')
      .replace(/(^|\s)(можешь|могла бы|поищи|найди|посмотри|покажи|открой|открыть|зайди|зайти|перейди|перейти|скажи|узнай)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в интернете|на сайте|по сайту|для меня)(?=\s|$)/gi, ' ')
      .replace(/[?!.]/g, ' ')
  );
}

function extractSiteLookupQuery(transcript) {
  return normalizeWhitespace(
    String(transcript || '')
      .replace(/(^|\s)(можешь|могла бы|открой|открыть|зайди|зайти|перейди|перейти|покажи|посмотри|найди|скажи|узнай)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице|главную|главную страницу|официальный|официального|официальную|домашнюю|домашнюю страницу)(?=\s|$)/gi, ' ')
      .replace(/[?!.]/g, ' ')
  );
}

function hasKeyword(transcript, keywords) {
  const value = transcript.toLowerCase();
  return keywords.some((keyword) => value.includes(keyword));
}

function hasKeywordFragment(transcript, fragments) {
  const value = simplifyLookup(transcript);
  return fragments.some((fragment) => value.includes(simplifyLookup(fragment)));
}

function buildUrlFromTemplate(template, query) {
  return template.replace('{query}', encodeURIComponent(query));
}

function isExplicitSiteOpenRequest(lower) {
  return hasKeyword(lower, [
    'открой',
    'открыть',
    'зайди',
    'зайти',
    'перейди',
    'перейти',
    'открой сайт',
    'открыть сайт',
    'открой страницу',
    'зайди на сайт',
    'можешь открыть',
    'можешь зайти',
    'можешь перейти',
  ]);
}

function normalizeQueryValue(input) {
  return normalizeWhitespace(
    String(input || '')
      .replace(/(^|\s)(какая|какой|какие|каково|можешь|мне|пожалуйста|сейчас|будет|будут|есть|ли)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(погод[а-яё]*|прогноз[а-яё]*)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в|во|на|по|с|со)(?=\s|$)/gi, ' ')
  );
}

function extractWikiQuery(transcript) {
  return normalizeWhitespace(
    String(transcript || '')
      .replace(/(^|\s)(что такое|кто такой|кто такая|кто такие|расскажи про|информация о|википедия|найди|покажи|открой)(?=\s|$)/gi, ' ')
      .replace(/[?!.]/g, ' ')
  );
}

function buildWikipediaArticleUrl(query) {
  const normalized = normalizeWhitespace(query).replace(/\s+/g, '_');
  return `https://ru.wikipedia.org/wiki/${encodeURIComponent(normalized)}`;
}

function getProviderHomeUrl(template) {
  try {
    const url = new URL(template);
    return `${url.origin}/`;
  } catch {
    return template;
  }
}

function resolveNewsUrl(transcript, webProviders) {
  const lower = transcript.toLowerCase();
  if (hasKeyword(lower, ['технолог', 'ии', 'ai', 'гаджет', 'смартфон', 'ноутбук'])) {
    return 'https://hi-tech.mail.ru/';
  }
  if (hasKeyword(lower, ['спорт', 'матч', 'футбол', 'хоккей', 'теннис'])) {
    return 'https://sportmail.ru/';
  }
  if (hasKeyword(lower, ['экономик', 'финанс', 'бирж', 'акци'])) {
    return 'https://finance.mail.ru/';
  }
  return webProviders.news.urlTemplate;
}

function simplifyLookup(input) {
  return normalizeWhitespace(String(input || ''))
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '')
    .replace(/[еёуюаяыиоьй]$/i, '');
}

function sanitizeSessionHistory(sessionHistory) {
  if (!Array.isArray(sessionHistory)) {
    return [];
  }

  return sessionHistory
    .slice(-8)
    .map((entry) => ({
      status: normalizeWhitespace(entry?.status || '').toLowerCase(),
      transcript: normalizeWhitespace(entry?.transcript || '').slice(0, 220),
      title: normalizeWhitespace(entry?.title || '').slice(0, 180),
      url: normalizeWhitespace(entry?.url || '').slice(0, 240),
      note: normalizeWhitespace(entry?.note || '').slice(0, 220),
    }))
    .filter((entry) => entry.transcript || entry.title || entry.url);
}

function buildSessionHistoryPromptBlock(sessionHistory) {
  const normalizedHistory = sanitizeSessionHistory(sessionHistory);
  if (!normalizedHistory.length) {
    return 'Недавняя веб-история этой сессии: нет.';
  }

  return `Недавняя веб-история этой сессии:
${normalizedHistory.map((entry, index) => {
  const title = entry.title || entry.url || entry.transcript || 'Сайт';
  if (entry.status === 'failed') {
    return `${index + 1}. Ошибка открытия: ${title}. Запрос: "${entry.transcript || 'без уточнения'}". Причина: ${entry.note || 'не указана'}.`;
  }

  return `${index + 1}. Открыт: ${title}${entry.url ? ` (${entry.url})` : ''}. Запрос: "${entry.transcript || 'без уточнения'}".`;
}).join('\n')}`;
}

function parseHistoryUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function resolveFromSessionHistory(transcript, sessionHistory) {
  const normalizedHistory = sanitizeSessionHistory(sessionHistory)
    .filter((entry) => entry.status === 'opened' && entry.url);

  if (!normalizedHistory.length) {
    return null;
  }

  const simplifiedTranscript = simplifyLookup(transcript);
  const lastOpened = normalizedHistory.at(-1);

  const referencesLastSite = /(тот|тотже|предыдущ|прошл|последн|снова|обратно|его|её|эту|этот)/i.test(simplifiedTranscript)
    && /(сайт|страниц|открой|зайди|перейди|вернись|покажи)/i.test(simplifiedTranscript);

  if (referencesLastSite && lastOpened) {
    return {
      title: lastOpened.title || parseHistoryUrl(lastOpened.url)?.hostname || lastOpened.url,
      url: lastOpened.url,
      reason: 'session-history:last-opened',
    };
  }

  for (let index = normalizedHistory.length - 1; index >= 0; index -= 1) {
    const entry = normalizedHistory[index];
    const parsedUrl = parseHistoryUrl(entry.url);
    const hostname = parsedUrl?.hostname?.replace(/^www\./i, '') || '';
    const candidates = [
      entry.title,
      entry.transcript,
      hostname,
      hostname.split('.')[0],
    ]
      .map((value) => simplifyLookup(value))
      .filter(Boolean);

    if (candidates.some((candidate) => candidate && simplifiedTranscript && (candidate.includes(simplifiedTranscript) || simplifiedTranscript.includes(candidate)))) {
      return {
        title: entry.title || hostname || entry.url,
        url: entry.url,
        reason: 'session-history:matched-site',
      };
    }
  }

  return null;
}

function resolveWeatherMemoryUrl(query) {
  const queryStem = simplifyLookup(query);
  const matched = WEATHER_MEMORY.find((entry) => entry.aliases.some((alias) => simplifyLookup(alias) === queryStem));
  return matched?.url || null;
}

function extractWeatherQuery(transcript) {
  const normalized = normalizeWhitespace(transcript);
  const locationMatch = normalized.match(/(?:^|\s)(?:в|во|на)\s+([а-яёa-z0-9\s-]+?)(?:\s+(?:сегодня|завтра|послезавтра|на выходных|будет|будут))?[?!.]*$/i);
  if (locationMatch?.[1]) {
    return normalizeQueryValue(locationMatch[1]);
  }

  return normalizeQueryValue(stripCommandWords(normalized));
}

function extractUrlOrDomain(transcript) {
  const urlMatch = transcript.match(DIRECT_URL_REGEX);
  if (urlMatch) {
    return urlMatch[0];
  }

  const domainMatch = transcript.match(DOMAIN_REGEX);
  if (domainMatch) {
    return `https://${domainMatch[0]}`;
  }

  const spokenDomainMatch = transcript.toLowerCase().match(/\b([a-z0-9-]{2,})\s+(by|ru)\b/);
  if (spokenDomainMatch) {
    return `https://${spokenDomainMatch[1]}.${spokenDomainMatch[2]}`;
  }

  return null;
}

function buildGeminiModelPath() {
  return geminiModel.startsWith('models/') ? geminiModel : `models/${geminiModel}`;
}

function extractResponseText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || '';
}

function parseJsonText(text) {
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

function requestText(url, { method = 'GET', headers = {}, body = null, agent, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
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
      request.destroy(new Error(`Истек таймаут запроса к ${url}`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function requestGeminiJson(prompt) {
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
    timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await requestText(url, requestOptions);
      const payload = raw ? JSON.parse(raw) : {};
      return parseJsonText(extractResponseText(payload));
    } catch (error) {
      const isLastAttempt = attempt === 1;
      const isTimeout = /таймаут/i.test(String(error?.message || ''));
      if (isLastAttempt || !isTimeout) {
        throw error;
      }
    }
  }

  throw new Error('Gemini resolver failed without response');
}

function normalizeResolvedUrl(domain, url) {
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

function extractQuotedPhrases(text) {
  return Array.from(String(text || '').matchAll(/["«](.+?)["»]/g))
    .map((match) => normalizeWhitespace(match[1]))
    .filter(Boolean);
}

function isGenericSiteCategoryQuery(input) {
  return hasKeywordFragment(input, [
    'тур',
    'путев',
    'отел',
    'отдых',
    'виз',
    'погод',
    'новост',
    'курс',
    'карт',
    'справк',
    'объявлен',
    'машин',
    'авто',
    'недвиж',
    'билет',
  ]);
}

function looksLikeStandaloneSiteMention(transcript) {
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

function buildLookupVariants(siteQuery, contextHint, transcript = '') {
  const queryStem = simplifyLookup(siteQuery);
  const variants = new Set();
  const shouldUseContextBrands = isGenericSiteCategoryQuery(siteQuery) || isGenericSiteCategoryQuery(transcript);

  if (siteQuery) {
    variants.add(normalizeWhitespace(siteQuery));
  }

  const quotedPhrases = extractQuotedPhrases(contextHint);
  quotedPhrases.forEach((phrase) => {
    const phraseStem = simplifyLookup(phrase);
    if (
      shouldUseContextBrands ||
      (queryStem && phraseStem && (phraseStem.includes(queryStem) || queryStem.includes(phraseStem)))
    ) {
      variants.add(phrase);
    }
  });

  if (queryStem && queryStem.length >= 3 && queryStem !== simplifyLookup(siteQuery)) {
    variants.add(queryStem);
  }

  return Array.from(variants).filter(Boolean);
}

function buildSiteResolverPrompt(transcript, siteQuery, contextHint, sessionHistory = [], checkedFailures = []) {
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
7. Если запрос общий по смыслу, например "сайт с турами", а в контексте активного персонажа явно есть компания или бренд, сначала попробуй определить официальный сайт этой компании.
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

function buildSiteCandidatePrompt(transcript, lookupVariants, contextHint, sessionHistory = [], checkedFailures = []) {
  const failuresBlock = checkedFailures.length > 0
    ? `\nНе используй уже проверенные и неподходящие варианты:
${checkedFailures.map((failure, index) => `${index + 1}. ${failure.url} -> ${failure.reason}`).join('\n')}`
    : '';
  const sessionHistoryBlock = buildSessionHistoryPromptBlock(sessionHistory);

  return `Ты системный генератор кандидатов домена для голосового аватара.

Нужно предложить несколько наиболее вероятных реальных доменов сайта без поиска.

Правила:
1. Используй только свои знания о реально существующих публичных сайтах.
2. Разрешены только домены .by и .ru.
3. Если в контексте есть бренд или компания, учитывай их как главный ориентир.
4. Если пользователь сказал что-то общее вроде "сайт с турами", можно предложить официальный сайт компании из контекста или самый вероятный тематический сайт.
5. Верни JSON без markdown.

Формат ответа JSON:
{
  "candidates": [
    {
      "title": "Короткое название сайта",
      "domain": "example.by",
      "url": "https://example.by/",
      "reason": "кратко"
    }
  ]
}

Если кандидатов нет, верни:
{
  "candidates": []
}

Фраза пользователя: "${transcript}"
Варианты названия сайта: "${lookupVariants.filter(Boolean).join(', ')}"
Контекст активного персонажа: "${normalizeWhitespace(contextHint || '')}"
${sessionHistoryBlock}${failuresBlock}`;
}

async function resolveSiteWithGemini(transcript, siteQuery, contextHint, sessionHistory = []) {
  const lookupVariants = buildLookupVariants(siteQuery, contextHint, transcript);
  const cacheKeys = Array.from(new Set(
    [siteQuery, transcript]
      .map((value) => simplifyLookup(value))
      .filter(Boolean)
  ));

  for (const cacheKey of cacheKeys) {
    const cached = siteResolutionCache.get(cacheKey);
    if (cached && cached.value?.url && (Date.now() - cached.timestamp) < SITE_RESOLUTION_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const checkedFailures = [];

  for (const lookupVariant of (lookupVariants.length ? lookupVariants : [siteQuery || transcript])) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = await requestGeminiJson(buildSiteResolverPrompt(
        transcript,
        lookupVariant,
        contextHint,
        sessionHistory,
        checkedFailures,
      ));
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
          const safeValue = {
            canResolve: true,
            title,
            reason,
            url: safeUrl,
          };
          cacheKeys.forEach((cacheKey) => {
            siteResolutionCache.set(cacheKey, { value: safeValue, timestamp: Date.now() });
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

  const candidatePayload = await requestGeminiJson(
    buildSiteCandidatePrompt(
      transcript,
      lookupVariants.length ? lookupVariants : [siteQuery || transcript],
      contextHint,
      sessionHistory,
      checkedFailures,
    )
  ).catch(() => null);
  const fallbackCandidates = Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [];

  for (const candidate of fallbackCandidates) {
    const candidateUrl = normalizeResolvedUrl(candidate?.domain, candidate?.url);
    if (!candidateUrl) {
      continue;
    }

    try {
      const safeUrl = await assertPublicUrl(candidateUrl);
      const safeValue = {
        canResolve: true,
        title: normalizeWhitespace(candidate?.title || ''),
        reason: normalizeWhitespace(candidate?.reason || 'gemini-candidates'),
        url: safeUrl,
      };
      cacheKeys.forEach((cacheKey) => {
        siteResolutionCache.set(cacheKey, { value: safeValue, timestamp: Date.now() });
      });
      return safeValue;
    } catch (error) {
      checkedFailures.push({
        url: candidateUrl,
        reason: error.message || 'не прошёл проверку',
      });
    }
  }

  return {
    canResolve: false,
    title: '',
    reason: checkedFailures.at(-1)?.reason || 'Не удалось определить сайт',
    url: '',
  };
}

async function classifyTranscript(transcript, webProviders, contextHint, sessionHistory = []) {
  const normalized = normalizeWhitespace(transcript);
  const lower = normalized.toLowerCase();
  const directUrl = extractUrlOrDomain(normalized);
  const searchQuery = stripCommandWords(normalized) || normalized;
  const siteLookupQuery = extractSiteLookupQuery(normalized) || searchQuery;
  const normalizedSessionHistory = sanitizeSessionHistory(sessionHistory);

  if (!normalized || normalized.length < 4) {
    return { type: 'none', reason: 'too-short' };
  }

  if (directUrl) {
    return {
      type: 'direct-site',
      query: searchQuery,
      url: directUrl,
      sourceType: 'direct-site',
      titleHint: directUrl,
    };
  }

  if (hasKeywordFragment(lower, ['погод', 'температур', 'дожд', 'снег', 'прогноз'])) {
    const weatherQuery = extractWeatherQuery(normalized);
    const weatherUrl = weatherQuery
      ? resolveWeatherMemoryUrl(weatherQuery) || buildUrlFromTemplate(webProviders.weather.urlTemplate, weatherQuery)
      : getProviderHomeUrl(webProviders.weather.urlTemplate);
    return {
      type: 'provider-template',
      providerKey: 'weather',
      query: weatherQuery,
      url: weatherUrl,
      sourceType: 'provider-template',
      titleHint: 'Погода',
    };
  }

  if (hasKeywordFragment(lower, ['новост', 'что нового'])) {
    return {
      type: 'provider-template',
      providerKey: 'news',
      query: searchQuery,
      url: resolveNewsUrl(normalized, webProviders),
      sourceType: 'provider-template',
      titleHint: 'Новости',
    };
  }

  if (hasKeywordFragment(lower, ['курс', 'доллар', 'евро', 'bitcoin', 'биткоин', 'крипт'])) {
    return {
      type: 'provider-template',
      providerKey: 'currency',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.currency.urlTemplate, searchQuery),
      sourceType: 'provider-template',
      titleHint: 'Курс',
    };
  }

  if (hasKeywordFragment(lower, ['карт', 'где находится', 'добрат', 'маршрут'])) {
    return {
      type: 'provider-template',
      providerKey: 'maps',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.maps.urlTemplate, searchQuery),
      sourceType: 'provider-template',
      titleHint: 'Карта',
    };
  }

  if (hasKeywordFragment(lower, ['википед', 'кто такой', 'что такое', 'расскажи про', 'информация о'])) {
    const wikiQuery = extractWikiQuery(normalized);
    if (!wikiQuery) {
      return { type: 'none', reason: 'empty-wiki-query' };
    }
    return {
      type: 'direct-site',
      providerKey: 'wiki',
      query: wikiQuery,
      url: buildWikipediaArticleUrl(wikiQuery),
      sourceType: 'direct-site',
      titleHint: 'Справка',
    };
  }

  if (isExplicitSiteOpenRequest(lower) || /\bсайт\b/i.test(lower) || looksLikeStandaloneSiteMention(normalized)) {
    const historyMatch = resolveFromSessionHistory(normalized, normalizedSessionHistory);
    if (historyMatch?.url) {
      const historyUrl = parseHistoryUrl(historyMatch.url);
      return {
        type: 'direct-site',
        query: siteLookupQuery,
        url: historyMatch.url,
        sourceType: 'direct-site',
        titleHint: historyMatch.title || historyUrl?.hostname || historyMatch.url,
      };
    }

    try {
      const resolved = await resolveSiteWithGemini(normalized, siteLookupQuery, contextHint, normalizedSessionHistory);
      if (resolved.canResolve && resolved.url) {
        siteResolutionCache.set(simplifyLookup(siteLookupQuery), {
          value: {
            canResolve: true,
            title: resolved.title || new URL(resolved.url).hostname,
            reason: resolved.reason || 'gemini',
            url: resolved.url,
          },
          timestamp: Date.now(),
        });
        return {
          type: 'direct-site',
          query: siteLookupQuery,
          url: resolved.url,
          sourceType: 'direct-site',
          titleHint: resolved.title || new URL(resolved.url).hostname,
        };
      }
    } catch (error) {
      console.error('Failed to resolve site with Gemini', error);
    }

    return {
      type: 'unresolved-site',
      query: siteLookupQuery,
      error: 'Не удалось надёжно определить сайт по названию.',
    };
  }

  return { type: 'none', reason: 'no-browser-intent' };
}

function isPrivateIp(ipAddress) {
  if (!ipAddress) return true;

  if (net.isIPv4(ipAddress)) {
    if (ipAddress.startsWith('10.')) return true;
    if (ipAddress.startsWith('127.')) return true;
    if (ipAddress.startsWith('169.254.')) return true;
    if (ipAddress.startsWith('192.168.')) return true;

    const [first, second] = ipAddress.split('.').map(Number);
    if (first === 172 && second >= 16 && second <= 31) return true;
    return false;
  }

  if (net.isIPv6(ipAddress)) {
    const normalized = ipAddress.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80');
  }

  return true;
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только http/https URL');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Локальные адреса запрещены');
  }

  if (!hostname.endsWith('.by') && !hostname.endsWith('.ru')) {
    throw new Error('Разрешены только сайты в доменах .by и .ru');
  }

  const lookup = await dns.lookup(hostname, { all: true });
  if (!lookup.length || lookup.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Внутренние или приватные адреса запрещены');
  }

  return url.toString();
}

function isEmbeddable(headers) {
  const xFrameOptions = headers['x-frame-options'] || '';
  const csp = headers['content-security-policy'] || '';

  if (/deny|sameorigin/i.test(xFrameOptions)) {
    return false;
  }

  if (/frame-ancestors\s+'none'/i.test(csp) || /frame-ancestors\s+[^;]*(self|none)/i.test(csp)) {
    return false;
  }

  return true;
}

function clearBrowserIdleTimer() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function resetBrowserState() {
  clearBrowserIdleTimer();
  browserPromise = null;
  browserInstance = null;
  activePage = null;
  activePageContext = null;
}

async function closeActivePage() {
  const context = activePageContext;
  const page = activePage;
  activePage = null;
  activePageContext = null;

  if (context) {
    await context.close().catch(() => {});
    return;
  }

  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  clearBrowserIdleTimer();
  await closeActivePage();

  const browser = browserInstance || await browserPromise?.catch(() => null);
  browserPromise = null;
  browserInstance = null;

  if (browser) {
    await browser.close().catch(() => {});
  }
}

function scheduleBrowserShutdown() {
  clearBrowserIdleTimer();
  if (!browserPromise || activePage) {
    return;
  }

  browserIdleTimer = setTimeout(() => {
    void closeBrowser();
  }, BROWSER_IDLE_TIMEOUT_MS);
  browserIdleTimer.unref?.();
}

async function getBrowser() {
  clearBrowserIdleTimer();
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--mute-audio'],
    }).then((browser) => {
      browserInstance = browser;
      browser.on('disconnected', resetBrowserState);
      return browser;
    }).catch((error) => {
      resetBrowserState();
      throw error;
    });
  }

  return browserPromise;
}

async function resolveInternalProviderPage(page, intent) {
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

export async function detectBrowserIntent({ transcript, webProviders, contextHint = '', sessionHistory = [] }) {
  const normalizedSessionHistory = sanitizeSessionHistory(sessionHistory);
  return classifyTranscript(transcript, webProviders, contextHint, normalizedSessionHistory);
}

export async function openBrowserIntent(intent) {
  activeRequestId += 1;
  const requestId = activeRequestId;
  const safeUrl = await assertPublicUrl(intent.url);
  const browser = await getBrowser();

  await closeActivePage();

  const context = await browser.newContext({
    viewport: { width: 1440, height: 920 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  activePageContext = context;
  activePage = page;

  try {
    let response = null;
    try {
      response = await page.goto(safeUrl, {
        waitUntil: 'commit',
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      if (error?.name !== 'TimeoutError' || page.url() === 'about:blank') {
        throw error;
      }
    }

    await page.waitForLoadState('domcontentloaded', {
      timeout: Math.min(DEFAULT_TIMEOUT_MS, 6000),
    }).catch(() => {});

    await resolveInternalProviderPage(page, intent);
    await page.waitForTimeout(PAGE_SETTLE_MS);

    const headers = response?.headers() || {};
    const title = normalizeWhitespace(await page.title()) || intent.titleHint || new URL(safeUrl).hostname;
    const embeddable = isEmbeddable(headers);
    let readerText = '';

    let screenshotUrl = null;
    if (embeddable) {
      readerText = normalizeWhitespace(
        await page.evaluate(() => document.body?.innerText || '')
      ).slice(0, MAX_READER_TEXT_LENGTH);
    } else {
      await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 78,
      });
      screenshotUrl = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
    }

    return {
      status: 'ready',
      sourceType: intent.sourceType,
      title,
      url: page.url(),
      embeddable,
      readerText,
      screenshotUrl,
      error: null,
      query: intent.query || '',
    };
  } finally {
    await context.close().catch(() => {});

    if (activeRequestId === requestId && activePage === page) {
      activePage = null;
      activePageContext = null;
      scheduleBrowserShutdown();
    }
  }
}
