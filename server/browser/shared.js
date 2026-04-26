import dns from 'dns/promises';
import https from 'https';
import net from 'net';
import { chromium } from 'playwright';
import { SocksClient } from 'socks';
import { logRuntime } from '../runtimeLogger.js';

export const MAX_READER_TEXT_LENGTH = 4000;
export const DEFAULT_TIMEOUT_MS = 15000;
export const GEMINI_REQUEST_TIMEOUT_MS = 6000;
export const DIRECT_PAGE_CONTEXT_TIMEOUT_MS = 8000;
const parsedSiteResolutionTimeoutMs = Number.parseInt(process.env.SITE_RESOLUTION_TIMEOUT_MS || '', 10);
export const SITE_RESOLUTION_TIMEOUT_MS = Number.isFinite(parsedSiteResolutionTimeoutMs) && parsedSiteResolutionTimeoutMs >= 4000
  ? parsedSiteResolutionTimeoutMs
  : 6000;
export const SITE_RESOLUTION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const SITE_SEARCH_TIMEOUT_MS = 3500;
export const SITE_SEARCH_RESULT_LIMIT = 5;
export const PAGE_SETTLE_MS = 400;
export const SCREENSHOT_SETTLE_MS = 250;
export const SCREENSHOT_CAPTURE_TIMEOUT_MS = 4500;
export const DOMCONTENTLOADED_TIMEOUT_MS = 2500;
export const MIN_RESOLUTION_STEP_TIMEOUT_MS = 900;
export const SESSION_CONTEXT_TEXT_LENGTH = 4200;
export const SESSION_QUERY_TEXT_LENGTH = 9000;
export const VIEWPORT_WIDTH = 1600;
export const VIEWPORT_HEIGHT = 900;
export const BROWSER_VIEW_REFRESH_MS = 9000;
export const MAX_ACTIONABLE_ELEMENTS = 40;
export const MAX_ACTION_LABEL_LENGTH = 120;
export const BROWSER_PROXY_MODE = normalizeWhitespace(process.env.BROWSER_PROXY_MODE || 'direct').toLowerCase();
const parsedBrowserOriginProbeTimeoutMs = Number.parseInt(process.env.BROWSER_ORIGIN_PROBE_TIMEOUT_MS || '', 10);
export const BROWSER_ORIGIN_PROBE_TIMEOUT_MS = Number.isFinite(parsedBrowserOriginProbeTimeoutMs) && parsedBrowserOriginProbeTimeoutMs >= 500
  ? parsedBrowserOriginProbeTimeoutMs
  : 2500;
const parsedBrowserIdleTimeoutMs = Number.parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || '', 10);
export const BROWSER_IDLE_TIMEOUT_MS = Number.isFinite(parsedBrowserIdleTimeoutMs) && parsedBrowserIdleTimeoutMs >= 0
  ? parsedBrowserIdleTimeoutMs
  : 30000;
const parsedSessionTtlMs = Number.parseInt(process.env.BROWSER_SESSION_TTL_MS || '', 10);
export const BROWSER_SESSION_TTL_MS = Number.isFinite(parsedSessionTtlMs) && parsedSessionTtlMs >= 30000
  ? parsedSessionTtlMs
  : 10 * 60 * 1000;
export const DIRECT_URL_REGEX = /\bhttps?:\/\/[^\s]+/i;
export const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
export const WEATHER_RESULT_URL_PATTERN = /https:\/\/www\.gismeteo\.by\/weather-[^/]+-\d+\/?/i;
export const SITE_RESOLUTION_MIN_SCORE = 0.42;
export const SITE_RESOLUTION_MIN_MARGIN = 0.08;
export const KNOWLEDGE_RESOLUTION_MIN_SCORE = 0.58;
export const KNOWLEDGE_RESOLUTION_MIN_MARGIN = 0.06;

export function requestText(url, { method = 'GET', headers = {}, body = null, agent, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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

    const hardTimeoutId = setTimeout(() => {
      request.destroy(new Error(`Истек таймаут запроса к ${url}`));
    }, Math.max(1000, timeoutMs));

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

export const WEATHER_MEMORY = [
  { aliases: ['минск', 'минске'], url: 'https://yandex.by/pogoda/ru/minsk' },
  { aliases: ['брест'], url: 'https://yandex.by/pogoda/ru/brest' },
  { aliases: ['гродно'], url: 'https://yandex.by/pogoda/ru/grodno' },
  { aliases: ['гомель'], url: 'https://yandex.by/pogoda/ru/gomel' },
  { aliases: ['витебск'], url: 'https://yandex.by/pogoda/ru/vitebsk' },
  { aliases: ['могилев', 'могилёв'], url: 'https://yandex.by/pogoda/ru/mogilev' },
];

let browserPromise = null;
let browserInstance = null;
let browserIdleTimer = null;
let activeBrowserSession = null;
let sessionCleanupTimer = null;
let activeRequestId = 0;
export let geminiApiKey = '';
export let geminiAgent = null;
function normalizeGeminiResolverModel(model = '') {
  const normalized = String(model || '').trim().replace(/^models\//, '');
  if (normalized.startsWith('gemini-') && !normalized.startsWith('gemini-3.1-')) {
    return '';
  }
  return normalized;
}

export let geminiModel = normalizeGeminiResolverModel(process.env.BROWSER_RESOLVER_MODEL || '');
export const siteResolutionCache = new Map();
let browserProxyBridgePromise = null;

export function configureBrowserController({ apiKey, agent, model } = {}) {
  geminiApiKey = String(apiKey || '');
  geminiAgent = agent || null;
  geminiModel = normalizeGeminiResolverModel(model || process.env.BROWSER_RESOLVER_MODEL || '');
}

export function normalizeWhitespace(input) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCommandTranscript(input) {
  return normalizeWhitespace(
    String(input || '')
      .replace(/\bairfox\b/giu, 'arfox')
      .replace(/\bаирфокс\b/giu, 'арфокс')
      .replace(/\bэйрфокс\b/giu, 'арфокс')
      .replace(/<[^>]{1,24}>/g, ' ')
      .replace(/(^|\s)(?:noise|шум)(?=\s|$)/giu, ' ')
      .replace(/[?!.;,:"«»()[\]{}]/g, ' ')
      .replace(/(^|\s)(?:блядь|блять|сука|нахуй|нахер|пиздец|ёпт|ебать)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:прошу|прашу|пожалуйста|калі\s+ласка|спасибо|спс|благодарю|благодарствую|мерси|thanks|thank\s+you)(?=\s|$)/giu, ' ')
  );
}

export function stripCommandWords(transcript) {
  return normalizeWhitespace(
    normalizeCommandTranscript(transcript)
      .replace(/^(ну|пожалуйста|слушай|смотри|спасибо|благодарю|thanks|привет|здравствуй(?:те)?|добрый\s+день|добрый\s+вечер|доброе\s+утро)\s+/i, '')
      .replace(/(^|\s)(можешь|могла бы|поищи|найди|посмотри|покажи|открой|открыть|зайди|зайти|перейди|перейти|скажи|узнай|адкрый|адкрыць|адкрыйце|зайдзі|зайсці|перайдзі|перайсці)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в интернете|на сайте|по сайту|для меня)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|давай|ладно|хорошо|просто|спасибо|благодарю|thanks|компания|компании|фирма|фирмы|бренд|бренда|привет|здравствуй(?:те)?|добрый|доброе|день|вечер|утро|николай|олеся|алеся|батюшка)(?=\s|$)/gi, ' ')
  );
}

export function extractSiteLookupQuery(transcript) {
  return normalizeWhitespace(
    normalizeCommandTranscript(transcript)
      .replace(/(^|\s)(можешь|могла бы|открой|открыть|зайди|зайти|перейди|перейти|покажи|посмотри|найди|скажи|узнай|адкрый|адкрыць|адкрыйце|зайдзі|зайсці|перайдзі|перайсці)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице|старонку|старонка|старонцы|главную|главную страницу|официальный|официального|официальную|домашнюю|домашнюю страницу|компания|компании|фирма|фирмы|бренд|бренда)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|я|мне|тебе|ты|давай|ладно|хорошо|просто|спасибо|благодарю|thanks|привет|здравствуй(?:те)?|добрый|доброе|день|вечер|утро|николай|олеся|алеся|батюшка)(?=\s|$)/gi, ' ')
  );
}

export function hasKeyword(transcript, keywords) {
  const value = transcript.toLowerCase();
  return keywords.some((keyword) => value.includes(keyword));
}

export function hasKeywordFragment(transcript, fragments) {
  const value = simplifyLookup(transcript);
  return fragments.some((fragment) => value.includes(simplifyLookup(fragment)));
}

export function buildUrlFromTemplate(template, query) {
  return template.replace('{query}', encodeURIComponent(query));
}

export function isExplicitSiteOpenRequest(lower) {
  return hasKeyword(lower, [
    'открой',
    'открыть',
    'открою',
    'откроем',
    'откроешь',
    'зайди',
    'зайти',
    'зайду',
    'зайдём',
    'перейди',
    'перейти',
    'перейду',
    'перейдём',
    'адкрый',
    'адкрыць',
    'адкрыйце',
    'зайдзі',
    'зайсці',
    'перайдзі',
    'перайсці',
    'открой сайт',
    'открыть сайт',
    'открою сайт',
    'адкрый сайт',
    'адкрыць сайт',
    'открой страницу',
    'зайди на сайт',
    'можешь открыть',
    'можешь зайти',
    'можешь перейти',
    'прошу открыть',
    'прошу открыть сайт',
    'прашу адкрыць',
    'прашу адкрыць сайт',
  ]);
}

export function hasSiteWord(transcript) {
  return /(^|\s)(сайт|сайта|страниц[аеиуыу]?|старонк[аеиуыу]?|домен|адрес)(?=\s|$)/i.test(
    normalizeCommandTranscript(transcript)
  );
}

export function normalizeQueryValue(input) {
  return normalizeWhitespace(
    normalizeCommandTranscript(input)
      .replace(/(^|\s)(какая|какой|какие|каково|можешь|мне|сейчас|будет|будут|есть|ли)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице|старонку|старонка|старонцы)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(погод[а-яё]*|прогноз[а-яё]*)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в|во|на|по|с|со)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|я|мне|тебе|открою|открой|открыть|адкрый|адкрыць|покажи|посмотри)(?=\s|$)/gi, ' ')
  );
}

export function extractWikiQuery(transcript) {
  return normalizeWhitespace(
    String(transcript || '')
      .replace(/(^|\s)(что такое|кто такой|кто такая|кто такие|расскажи про|информация о|википедия|найди|покажи|открой)(?=\s|$)/gi, ' ')
      .replace(/[?!.]/g, ' ')
  );
}

export function buildWikipediaArticleUrl(query) {
  const normalized = normalizeWhitespace(query).replace(/\s+/g, '_');
  return `https://ru.wikipedia.org/wiki/${encodeURIComponent(normalized)}`;
}

export function getProviderHomeUrl(template) {
  try {
    const url = new URL(template);
    return `${url.origin}/`;
  } catch {
    return template;
  }
}

export function resolveNewsUrl(transcript, webProviders) {
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

export function simplifyLookup(input) {
  return normalizeWhitespace(String(input || ''))
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '')
    .replace(/[еёуюаяыиоьй]$/i, '');
}

export function transliterateToLatin(input) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return String(input || '')
    .toLowerCase()
    .split('')
    .map((char) => map[char] ?? char)
    .join('')
    .replace(/ks/g, 'x')
    .replace(/ii/g, 'i');
}

export const LOOKUP_NOISE_STEMS = new Set([
  'саит',
  'страниц',
  'откро',
  'заид',
  'переид',
  'покаж',
  'посмотр',
  'наид',
  'пожалуист',
  'спасиб',
  'благодар',
  'thanks',
  'thank',
  'компан',
  'фирм',
  'бренд',
]);

export function isLookupNoiseStem(stem) {
  if (!stem) return true;
  if (LOOKUP_NOISE_STEMS.has(stem)) return true;
  if (stem.startsWith('спасиб')) return true;
  if (stem.startsWith('благодар')) return true;
  if (stem.startsWith('thank')) return true;
  return false;
}

export function collectLookupStems(input) {
  return Array.from(new Set(
    normalizeWhitespace(input)
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => token.length >= 3)
      .filter((token) => ![
        'сайт',
        'страница',
        'открой',
        'открыть',
        'открою',
        'зайди',
        'зайти',
        'зайду',
        'перейди',
        'перейти',
        'перейду',
        'покажи',
        'посмотри',
        'найди',
      ].includes(token))
      .map((token) => simplifyLookup(token))
      .filter((token) => token.length >= 2)
      .filter((token) => !isLookupNoiseStem(token))
  ));
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
  const union = new Set([...leftBigrams, ...rightBigrams]).size || 1;
  return intersection / union;
}

export function extractCandidateStems(title, url) {
  const stems = new Set(collectLookupStems(title));
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, '');
    const hostTokens = hostname.split('.').filter(Boolean).slice(0, -1);
    hostTokens.forEach((token) => stems.add(simplifyLookup(token)));
    parsed.pathname.split('/').filter(Boolean).forEach((token) => {
      const normalized = simplifyLookup(decodeURIComponent(token));
      if (normalized.length >= 2) {
        stems.add(normalized);
      }
    });
  } catch {
    // Ignore URL parse failures here; assertPublicUrl handles strict validation.
  }
  return Array.from(stems).filter(Boolean);
}

export function scoreResolvedCandidate(siteQuery, transcript, title, url) {
  const sourceStems = collectLookupStems(siteQuery);
  const fallbackStems = sourceStems.length ? sourceStems : collectLookupStems(transcript);
  const candidateStems = extractCandidateStems(title, url);

  if (!fallbackStems.length || !candidateStems.length) {
    return 0;
  }

  const scoreSum = fallbackStems.reduce((acc, sourceStem) => {
    const sourceStemLatin = transliterateToLatin(sourceStem);
    const bestCandidateScore = candidateStems.reduce((best, candidateStem) => {
      const candidateStemLatin = transliterateToLatin(candidateStem);
      const similarity = Math.max(
        computeStemSimilarity(sourceStem, candidateStem),
        computeStemSimilarity(sourceStemLatin, candidateStemLatin),
      );
      return similarity > best ? similarity : best;
    }, 0);
    return acc + bestCandidateScore;
  }, 0);

  return Number((scoreSum / fallbackStems.length).toFixed(3));
}

export function extractDomainGuessStem(siteQuery) {
  const tokens = normalizeWhitespace(siteQuery)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => transliterateToLatin(token))
    .map((token) => token.replace(/[^a-z0-9-]+/gi, ''))
    .filter(Boolean)
    .filter((token) => token.length >= 1)
    .filter((token) => !['сайт', 'официальный', 'главная', 'страница'].includes(token));

  if (!tokens.length) {
    return '';
  }

  const singleLetters = tokens.filter((token) => token.length === 1).join('');
  const longerTokens = tokens.filter((token) => token.length >= 2);

  if (singleLetters.length >= 1 && longerTokens.length >= 1) {
    const merged = `${singleLetters}${longerTokens[0]}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (merged.length >= 3) {
      return merged;
    }
  }

  const compact = tokens.join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (compact.length >= 3) {
    return compact;
  }

  const primary = tokens.sort((left, right) => right.length - left.length)[0];
  return primary.length >= 3 ? primary : '';
}

export function buildDomainGuessStems(siteQuery) {
  const primaryStem = extractDomainGuessStem(siteQuery);
  if (!primaryStem) {
    return [];
  }

  const variants = new Set([primaryStem]);
  if (primaryStem.includes('ks')) {
    variants.add(primaryStem.replace(/ks/g, 'x'));
  }
  if (primaryStem.includes('iy')) {
    variants.add(primaryStem.replace(/iy/g, 'y'));
  }
  if (primaryStem.includes('ii')) {
    variants.add(primaryStem.replace(/ii/g, 'i'));
  }
  if (primaryStem.includes('oo')) {
    variants.add(primaryStem.replace(/oo/g, 'o'));
  }

  return Array.from(variants).filter((value) => value.length >= 3);
}

function looksLikeStandaloneSiteMentionForFastGuess(transcript) {
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

export function shouldPreferFastDomainGuess(siteQuery, transcript = '') {
  const normalizedQuery = normalizeWhitespace(siteQuery);
  if (!normalizedQuery) {
    return false;
  }

  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0 || queryTokens.length > 2) {
    return false;
  }

  const normalizedTranscript = normalizeWhitespace(String(transcript || '').toLowerCase());
  if (!looksLikeStandaloneSiteMentionForFastGuess(normalizedQuery) && !isExplicitSiteOpenRequest(normalizedTranscript)) {
    return false;
  }

  const genericTokens = new Set([
    'сайт',
    'страница',
    'официальный',
    'официальная',
    'официальное',
    'официальные',
    'главная',
    'домашняя',
    'открой',
    'открыть',
    'адкрый',
    'адкрыць',
    'перайдзі',
    'перайсці',
    'зайди',
    'зайти',
    'зайдзі',
    'зайсці',
    'перейди',
    'перейти',
    'найди',
    'найти',
    'покажи',
    'посмотри',
  ]);

  const hasOnlyMeaningfulTokens = queryTokens.every((token) => {
    const simplified = simplifyLookup(token);
    return simplified.length >= 3 && !genericTokens.has(simplified);
  });
  if (!hasOnlyMeaningfulTokens) {
    return false;
  }

  const hasSpokenTld = /\b(?:точка\s*)?(?:by|ru)\b/i.test(normalizedTranscript);
  if (hasSpokenTld) {
    return true;
  }

  const hasSplitBrandTokens = queryTokens.length === 2
    && queryTokens.some((token) => token.length === 1)
    && queryTokens.some((token) => token.length >= 3);

  if (hasSplitBrandTokens) {
    return true;
  }

  return queryTokens.length === 1 && queryTokens[0].length >= 5;
}

export function isTriviallyGenericSiteQuery(siteQuery) {
  const genericTokens = new Set([
    'сайт',
    'сайта',
    'страница',
    'страницу',
    'странице',
    'главная',
    'главную',
    'домой',
    'домашняя',
    'домашнюю',
    'официальный',
    'официальную',
    'официального',
    'на',
    'в',
    'во',
    'по',
    'к',
    'для',
    'мне',
    'пожалуйста',
    'открой',
    'открыть',
    'открою',
    'откроем',
    'адкрый',
    'адкрый',
    'адкрыць',
    'зайди',
    'зайти',
    'зайду',
    'зайдзі',
    'зайсці',
    'перейди',
    'перейти',
    'перейду',
    'перайдзі',
    'перайсці',
    'покажи',
    'посмотри',
    'найди',
    'найти',
    'какой',
    'какая',
    'какое',
    'какие',
    'какойнибудь',
    'какой-нибудь',
    'нибудь',
    'любой',
    'любая',
    'любое',
    'любые',
    'любую',
    'чтонибудь',
    'что-нибудь',
    'что-то',
    'какой-то',
    'какойто',
  ]);

  const meaningfulTokens = normalizeWhitespace(siteQuery)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
    .filter(Boolean)
    .filter((token) => token.length >= 3)
    .filter((token) => !genericTokens.has(token));

  return meaningfulTokens.length === 0;
}

export function isLikelyInPageNavigationRequest(transcript) {
  const normalized = normalizeWhitespace(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasNavigationVerb = /(перейди|перейти|вернись|вернуться|иди|зайди|зайти|открой|открыть|перайдзі|перайсці|зайдзі|зайсці|адкрый|адкрыць)/i.test(normalized);
  const hasNavigationTarget = /(главн(ая|ую|ой)|главную страницу|домой|домашн(яя|юю)\s+страниц(а|у)|назад|вперед|впер[её]д|обнови|перезагрузи)/i
    .test(normalized);
  return hasNavigationVerb && hasNavigationTarget;
}
