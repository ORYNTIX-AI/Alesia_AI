import dns from 'dns/promises';
import https from 'https';
import net from 'net';
import { chromium } from 'playwright';

const MAX_READER_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const SITE_RESOLUTION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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
let activePage = null;
let activeRequestId = 0;
let geminiApiKey = '';
let geminiAgent = null;
let geminiModel = process.env.BROWSER_RESOLVER_MODEL || 'gemini-2.5-flash';
const siteResolutionCache = new Map();

export function configureBrowserController({ apiKey, agent, model } = {}) {
  geminiApiKey = String(apiKey || '');
  geminiAgent = agent || null;
  geminiModel = String(model || process.env.BROWSER_RESOLVER_MODEL || 'gemini-2.5-flash');
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
      .replace(/(^|\s)(можешь|могла бы|поищи|найди|посмотри|покажи|открой|зайди|перейди|скажи|узнай)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в интернете|на сайте|по сайту|для меня)(?=\s|$)/gi, ' ')
      .replace(/[?!.]/g, ' ')
  );
}

function hasKeyword(transcript, keywords) {
  const value = transcript.toLowerCase();
  return keywords.some((keyword) => value.includes(keyword));
}

function buildUrlFromTemplate(template, query) {
  return template.replace('{query}', encodeURIComponent(query));
}

function isExplicitSiteOpenRequest(lower) {
  return hasKeyword(lower, ['открой', 'зайди', 'перейди', 'открой сайт', 'открой страницу', 'зайди на сайт']);
}

function normalizeQueryValue(input) {
  return normalizeWhitespace(
    String(input || '')
      .replace(/(^|\s)(какая|какой|какие|каково|можешь|мне|пожалуйста|сейчас|будет|будут|есть|ли)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(погода|прогноз)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в|во|на|по)\s*$/gi, ' ')
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

function resolveWeatherMemoryUrl(query) {
  const queryStem = simplifyLookup(query);
  const matched = WEATHER_MEMORY.find((entry) => entry.aliases.some((alias) => simplifyLookup(alias) === queryStem));
  return matched?.url || null;
}

function extractWeatherQuery(transcript) {
  const normalized = normalizeWhitespace(transcript);
  const locationMatch = normalized.match(/(?:^|\s)(?:в|во|на)\s+([а-яёa-z0-9\s-]+?)(?:\s+(?:сегодня|завтра|послезавтра|на выходных|будет|будут))?[?!.]*$/i);
  if (locationMatch?.[1]) {
    return normalizeQueryValue(locationMatch[1]) || 'Minsk';
  }

  return normalizeQueryValue(stripCommandWords(normalized)) || 'Minsk';
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

function requestGeminiJson(prompt) {
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

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-goog-api-key': geminiApiKey,
      },
      agent: geminiAgent,
      timeout: DEFAULT_TIMEOUT_MS,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          const payload = raw ? JSON.parse(raw) : {};
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = payload?.error?.message || `Gemini HTTP ${response.statusCode}`;
            return reject(new Error(apiError));
          }
          return resolve(parseJsonText(extractResponseText(payload)));
        } catch (error) {
          return reject(error);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Истек таймаут Gemini при определении сайта'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
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

function buildSiteResolverPrompt(transcript, siteQuery) {
  return `Ты системный резолвер доменов для голосового аватара.

Нужно определить реальный публичный домен сайта, который пользователь хочет открыть.

Правила:
1. Используй только свои знания о реально существующих популярных публичных сайтах.
2. Никакого поиска и никаких предположений "наверное". Если не уверен, верни canResolve=false.
3. Разрешены только домены .by и .ru.
4. Верни JSON без markdown и без пояснений.
5. Если пользователь назвал именно раздел или бренд сайта, можешь вернуть конкретный URL раздела, но только если уверен.

Формат ответа JSON:
{
  "canResolve": true,
  "title": "Короткое название сайта",
  "domain": "example.by",
  "url": "https://example.by/",
  "reason": "коротко"
}

Если не уверен, верни:
{
  "canResolve": false,
  "title": "",
  "domain": "",
  "url": "",
  "reason": "почему не удалось уверенно определить"
}

Фраза пользователя: "${transcript}"
Название сайта или цель открытия: "${siteQuery}"`;
}

async function resolveSiteWithGemini(transcript, siteQuery) {
  const cacheKey = normalizeWhitespace(siteQuery || transcript).toLowerCase();
  const cached = siteResolutionCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < SITE_RESOLUTION_CACHE_TTL_MS) {
    return cached.value;
  }

  const resolved = await requestGeminiJson(buildSiteResolverPrompt(transcript, siteQuery));
  const canResolve = Boolean(resolved?.canResolve);
  const candidateUrl = normalizeResolvedUrl(resolved?.domain, resolved?.url);

  const value = {
    canResolve,
    title: normalizeWhitespace(resolved?.title || ''),
    reason: normalizeWhitespace(resolved?.reason || ''),
    url: candidateUrl,
  };
  siteResolutionCache.set(cacheKey, { value, timestamp: Date.now() });
  return value;
}

async function classifyTranscript(transcript, webProviders) {
  const normalized = normalizeWhitespace(transcript);
  const lower = normalized.toLowerCase();
  const directUrl = extractUrlOrDomain(normalized);
  const searchQuery = stripCommandWords(normalized) || normalized;

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

  if (hasKeyword(lower, ['погода', 'температур', 'дождь', 'снег', 'прогноз'])) {
    const weatherQuery = extractWeatherQuery(normalized);
    const weatherUrl = resolveWeatherMemoryUrl(weatherQuery) || buildUrlFromTemplate(webProviders.weather.urlTemplate, weatherQuery);
    return {
      type: 'provider-template',
      providerKey: 'weather',
      query: weatherQuery,
      url: weatherUrl,
      sourceType: 'provider-template',
      titleHint: 'Погода',
    };
  }

  if (hasKeyword(lower, ['новости', 'топ новости', 'что нового'])) {
    return {
      type: 'provider-template',
      providerKey: 'news',
      query: searchQuery,
      url: resolveNewsUrl(normalized, webProviders),
      sourceType: 'provider-template',
      titleHint: 'Новости',
    };
  }

  if (hasKeyword(lower, ['курс', 'доллар', 'евро', 'bitcoin', 'биткоин', 'крипт'])) {
    return {
      type: 'provider-template',
      providerKey: 'currency',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.currency.urlTemplate, searchQuery),
      sourceType: 'provider-template',
      titleHint: 'Курс',
    };
  }

  if (hasKeyword(lower, ['карта', 'где находится', 'как добраться', 'маршрут'])) {
    return {
      type: 'provider-template',
      providerKey: 'maps',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.maps.urlTemplate, searchQuery),
      sourceType: 'provider-template',
      titleHint: 'Карта',
    };
  }

  if (hasKeyword(lower, ['википед', 'кто такой', 'что такое', 'расскажи про', 'информация о'])) {
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

  if (isExplicitSiteOpenRequest(lower)) {
    try {
      const resolved = await resolveSiteWithGemini(normalized, searchQuery);
      if (resolved.canResolve && resolved.url) {
        const safeUrl = await assertPublicUrl(resolved.url);
        return {
          type: 'direct-site',
          query: searchQuery,
          url: safeUrl,
          sourceType: 'direct-site',
          titleHint: resolved.title || new URL(safeUrl).hostname,
        };
      }
    } catch (error) {
      console.error('Failed to resolve site with Gemini', error);
    }

    return {
      type: 'unresolved-site',
      query: searchQuery,
      error: 'Не смогла уверенно определить реальный домен сайта в .by или .ru.',
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

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
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
      await page.waitForTimeout(1200);
    }
  }
}

export async function detectBrowserIntent({ transcript, webProviders }) {
  return classifyTranscript(transcript, webProviders);
}

export async function openBrowserIntent(intent) {
  activeRequestId += 1;
  const requestId = activeRequestId;
  const safeUrl = await assertPublicUrl(intent.url);
  const browser = await getBrowser();

  if (activePage && !activePage.isClosed()) {
    await activePage.close().catch(() => {});
  }

  const page = await browser.newPage({
    viewport: { width: 1440, height: 920 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  activePage = page;

  try {
    const response = await page.goto(safeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT_MS,
    });

    await resolveInternalProviderPage(page, intent);
    await page.waitForTimeout(1200);

    const headers = response?.headers() || {};
    const title = normalizeWhitespace(await page.title()) || intent.titleHint || new URL(safeUrl).hostname;
    const readerText = normalizeWhitespace(
      await page.evaluate(() => document.body?.innerText || '')
    ).slice(0, MAX_READER_TEXT_LENGTH);
    const embeddable = isEmbeddable(headers);

    let screenshotUrl = null;
    if (!embeddable) {
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
    if (!page.isClosed()) {
      await page.close().catch(() => {});
    }

    if (activeRequestId === requestId && activePage === page) {
      activePage = null;
    }
  }
}
