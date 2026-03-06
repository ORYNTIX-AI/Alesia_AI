import dns from 'dns/promises';
import net from 'net';
import { chromium } from 'playwright';

const MAX_READER_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const DIRECT_URL_REGEX = /\bhttps?:\/\/[^\s]+/i;
const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;

let browserPromise = null;
let activePage = null;
let activeRequestId = 0;

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

function normalizeQueryValue(input) {
  return normalizeWhitespace(
    String(input || '')
      .replace(/(^|\s)(какая|какой|какие|каково|можешь|мне|пожалуйста|сейчас|будет|будут|есть|ли)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(погода|прогноз)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в|во|на|по)\s*$/gi, ' ')
  );
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

  return null;
}

function classifyTranscript(transcript, webProviders) {
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
    return {
      type: 'provider-template',
      providerKey: 'weather',
      query: weatherQuery,
      url: buildUrlFromTemplate(webProviders.weather.urlTemplate, weatherQuery),
      sourceType: 'provider-template',
      titleHint: 'Погода',
    };
  }

  if (hasKeyword(lower, ['новости', 'топ новости', 'что нового'])) {
    return {
      type: 'provider-template',
      providerKey: 'news',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.news.urlTemplate, searchQuery),
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
    return {
      type: 'provider-template',
      providerKey: 'wiki',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.wiki.urlTemplate, searchQuery),
      sourceType: 'provider-template',
      titleHint: 'Справка',
    };
  }

  if (hasKeyword(lower, ['найди', 'поищи', 'посмотри в интернете', 'поиск', 'сайт', 'ссылк'])) {
    return {
      type: 'search-fallback',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.search.urlTemplate, searchQuery),
      sourceType: 'search-fallback',
      titleHint: 'Поиск',
    };
  }

  if (/[?？]$/.test(normalized) || hasKeyword(lower, ['какая', 'какой', 'какие', 'можешь'])) {
    return {
      type: 'search-fallback',
      query: searchQuery,
      url: buildUrlFromTemplate(webProviders.search.urlTemplate, searchQuery),
      sourceType: 'search-fallback',
      titleHint: 'Поиск',
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
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  activePage = page;

  try {
    const response = await page.goto(safeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT_MS,
    });

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
        quality: 55,
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
