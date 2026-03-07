import dns from 'dns/promises';
import net from 'net';
import { chromium } from 'playwright';

const MAX_READER_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const DIRECT_URL_REGEX = /\bhttps?:\/\/[^\s]+/i;
const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const WEATHER_RESULT_URL_PATTERN = /https:\/\/www\.gismeteo\.by\/weather-[^/]+-\d+\/?/i;

const POPULAR_SITES = [
  { aliases: ['онлайнер', 'онлинер', 'onliner'], url: 'https://www.onliner.by/', title: 'Onliner BY' },
  { aliases: ['куфар', 'kufar'], url: 'https://www.kufar.by/', title: 'Kufar BY' },
  { aliases: ['ав бай', 'av.by', 'авто бай', 'авбай', 'av by'], url: 'https://av.by/', title: 'AV BY' },
  { aliases: ['яндекс карты', 'карты яндекс'], url: 'https://yandex.by/maps/', title: 'Яндекс Карты BY' },
  { aliases: ['яндекс', 'yandex', 'яндекс бай', 'yandex by'], url: 'https://yandex.by/', title: 'Yandex BY' },
  { aliases: ['гисметео', 'gismeteo', 'гис метео'], url: 'https://www.gismeteo.by/', title: 'Gismeteo BY' },
  { aliases: ['майл', 'mail.ru', 'mail ru', 'мэйл', 'мейл', 'майл ру'], url: 'https://mail.ru/', title: 'Mail.ru' },
  { aliases: ['новости mail', 'mail новости'], url: 'https://news.mail.ru/', title: 'Новости Mail.ru' },
  { aliases: ['банки ру', 'banki.ru', 'banki ru'], url: 'https://www.banki.ru/', title: 'Банки.ру' },
  { aliases: ['википедия', 'wikipedia'], url: 'https://ru.wikipedia.org/', title: 'Wikipedia RU' },
];

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

function matchPopularSite(lower) {
  return POPULAR_SITES.find((site) => site.aliases.some((alias) => lower.includes(alias)));
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

function classifyTranscript(transcript, webProviders) {
  const normalized = normalizeWhitespace(transcript);
  const lower = normalized.toLowerCase();
  const directUrl = extractUrlOrDomain(normalized);
  const searchQuery = stripCommandWords(normalized) || normalized;
  const matchedSite = matchPopularSite(lower);

  if (!normalized || normalized.length < 4) {
    return { type: 'none', reason: 'too-short' };
  }

  if (matchedSite) {
    return {
      type: 'direct-site',
      query: searchQuery,
      url: matchedSite.url,
      sourceType: 'direct-site',
      titleHint: matchedSite.title,
    };
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
    return {
      type: 'unresolved-site',
      query: searchQuery,
      error: 'Не распознала сайт. Назови популярный домен .by или .ru.',
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
