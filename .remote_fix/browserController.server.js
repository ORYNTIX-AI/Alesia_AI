import dns from 'dns/promises';
import https from 'https';
import net from 'net';
import { chromium } from 'playwright';
import { SocksClient } from 'socks';
import { logRuntime } from './runtimeLogger.js';

const MAX_READER_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 15000;
const GEMINI_REQUEST_TIMEOUT_MS = 6000;
const DIRECT_PAGE_CONTEXT_TIMEOUT_MS = 8000;
const parsedSiteResolutionTimeoutMs = Number.parseInt(process.env.SITE_RESOLUTION_TIMEOUT_MS || '', 10);
const SITE_RESOLUTION_TIMEOUT_MS = Number.isFinite(parsedSiteResolutionTimeoutMs) && parsedSiteResolutionTimeoutMs >= 4000
  ? parsedSiteResolutionTimeoutMs
  : 6000;
const SITE_RESOLUTION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const SITE_SEARCH_TIMEOUT_MS = 3500;
const SITE_SEARCH_RESULT_LIMIT = 5;
const PAGE_SETTLE_MS = 400;
const SCREENSHOT_SETTLE_MS = 250;
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 4500;
const DOMCONTENTLOADED_TIMEOUT_MS = 2500;
const MIN_RESOLUTION_STEP_TIMEOUT_MS = 900;
const SESSION_CONTEXT_TEXT_LENGTH = 4200;
const SESSION_QUERY_TEXT_LENGTH = 9000;
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 900;
const BROWSER_VIEW_REFRESH_MS = 9000;
const MAX_ACTIONABLE_ELEMENTS = 40;
const MAX_ACTION_LABEL_LENGTH = 120;
const BROWSER_PROXY_MODE = normalizeWhitespace(process.env.BROWSER_PROXY_MODE || 'direct').toLowerCase();
const parsedBrowserOriginProbeTimeoutMs = Number.parseInt(process.env.BROWSER_ORIGIN_PROBE_TIMEOUT_MS || '', 10);
const BROWSER_ORIGIN_PROBE_TIMEOUT_MS = Number.isFinite(parsedBrowserOriginProbeTimeoutMs) && parsedBrowserOriginProbeTimeoutMs >= 500
  ? parsedBrowserOriginProbeTimeoutMs
  : 2500;
const parsedBrowserIdleTimeoutMs = Number.parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS || '', 10);
const BROWSER_IDLE_TIMEOUT_MS = Number.isFinite(parsedBrowserIdleTimeoutMs) && parsedBrowserIdleTimeoutMs >= 0
  ? parsedBrowserIdleTimeoutMs
  : 30000;
const parsedSessionTtlMs = Number.parseInt(process.env.BROWSER_SESSION_TTL_MS || '', 10);
const BROWSER_SESSION_TTL_MS = Number.isFinite(parsedSessionTtlMs) && parsedSessionTtlMs >= 30000
  ? parsedSessionTtlMs
  : 10 * 60 * 1000;
const DIRECT_URL_REGEX = /\bhttps?:\/\/[^\s]+/i;
const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const WEATHER_RESULT_URL_PATTERN = /https:\/\/www\.gismeteo\.by\/weather-[^/]+-\d+\/?/i;
const SITE_RESOLUTION_MIN_SCORE = 0.42;
const SITE_RESOLUTION_MIN_MARGIN = 0.08;
const KNOWLEDGE_RESOLUTION_MIN_SCORE = 0.58;
const KNOWLEDGE_RESOLUTION_MIN_MARGIN = 0.06;

const WEATHER_MEMORY = [
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
let geminiApiKey = '';
let geminiAgent = null;
let geminiModel = process.env.BROWSER_RESOLVER_MODEL || 'gemini-3-flash-preview';
const siteResolutionCache = new Map();
let browserProxyBridgePromise = null;

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

function normalizeCommandTranscript(input) {
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

function stripCommandWords(transcript) {
  return normalizeWhitespace(
    normalizeCommandTranscript(transcript)
      .replace(/^(ну|пожалуйста|слушай|смотри|спасибо|благодарю|thanks|привет|здравствуй(?:те)?|добрый\s+день|добрый\s+вечер|доброе\s+утро)\s+/i, '')
      .replace(/(^|\s)(можешь|могла бы|поищи|найди|посмотри|покажи|открой|открыть|зайди|зайти|перейди|перейти|скажи|узнай|адкрый|адкрыць|адкрыйце|зайдзі|зайсці|перайдзі|перайсці)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в интернете|на сайте|по сайту|для меня)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|давай|ладно|хорошо|просто|спасибо|благодарю|thanks|компания|компании|фирма|фирмы|бренд|бренда|привет|здравствуй(?:те)?|добрый|доброе|день|вечер|утро|николай|олеся|алеся|батюшка)(?=\s|$)/gi, ' ')
  );
}

function extractSiteLookupQuery(transcript) {
  return normalizeWhitespace(
    normalizeCommandTranscript(transcript)
      .replace(/(^|\s)(можешь|могла бы|открой|открыть|зайди|зайти|перейди|перейти|покажи|посмотри|найди|скажи|узнай|адкрый|адкрыць|адкрыйце|зайдзі|зайсці|перайдзі|перайсці)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице|старонку|старонка|старонцы|главную|главную страницу|официальный|официального|официальную|домашнюю|домашнюю страницу|компания|компании|фирма|фирмы|бренд|бренда)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|я|мне|тебе|ты|давай|ладно|хорошо|просто|спасибо|благодарю|thanks|привет|здравствуй(?:те)?|добрый|доброе|день|вечер|утро|николай|олеся|алеся|батюшка)(?=\s|$)/gi, ' ')
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

function hasSiteWord(transcript) {
  return /(^|\s)(сайт|сайта|страниц[аеиуыу]?|старонк[аеиуыу]?|домен|адрес)(?=\s|$)/i.test(
    normalizeCommandTranscript(transcript)
  );
}

function normalizeQueryValue(input) {
  return normalizeWhitespace(
    normalizeCommandTranscript(input)
      .replace(/(^|\s)(какая|какой|какие|каково|можешь|мне|сейчас|будет|будут|есть|ли)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(сайт|сайта|страницу|страница|странице|старонку|старонка|старонцы)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(погод[а-яё]*|прогноз[а-яё]*)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(в|во|на|по|с|со)(?=\s|$)/gi, ' ')
      .replace(/(^|\s)(а|ну|сам|сама|само|самим|самой|я|мне|тебе|открою|открой|открыть|адкрый|адкрыць|покажи|посмотри)(?=\s|$)/gi, ' ')
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

function transliterateToLatin(input) {
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

const LOOKUP_NOISE_STEMS = new Set([
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

function isLookupNoiseStem(stem) {
  if (!stem) return true;
  if (LOOKUP_NOISE_STEMS.has(stem)) return true;
  if (stem.startsWith('спасиб')) return true;
  if (stem.startsWith('благодар')) return true;
  if (stem.startsWith('thank')) return true;
  return false;
}

function collectLookupStems(input) {
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

function extractCandidateStems(title, url) {
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

function scoreResolvedCandidate(siteQuery, transcript, title, url) {
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

function extractDomainGuessStem(siteQuery) {
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

function buildDomainGuessStems(siteQuery) {
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

function shouldPreferFastDomainGuess(siteQuery, transcript = '') {
  const normalizedQuery = normalizeWhitespace(siteQuery);
  if (!normalizedQuery) {
    return false;
  }

  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0 || queryTokens.length > 2) {
    return false;
  }

  const normalizedTranscript = normalizeWhitespace(String(transcript || '').toLowerCase());
  if (!looksLikeStandaloneSiteMention(normalizedQuery) && !isExplicitSiteOpenRequest(normalizedTranscript)) {
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

function isTriviallyGenericSiteQuery(siteQuery) {
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

function isLikelyInPageNavigationRequest(transcript) {
  const normalized = normalizeWhitespace(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasNavigationVerb = /(перейди|перейти|вернись|вернуться|иди|зайди|зайти|открой|открыть|перайдзі|перайсці|зайдзі|зайсці|адкрый|адкрыць)/i.test(normalized);
  const hasNavigationTarget = /(главн(ая|ую|ой)|главную страницу|домой|домашн(яя|юю)\s+страниц(а|у)|назад|вперед|впер[её]д|обнови|перезагрузи)/i
    .test(normalized);
  return hasNavigationVerb && hasNavigationTarget;
}

async function resolveSiteByDomainGuess(siteQuery) {
  const stems = buildDomainGuessStems(siteQuery);
  if (!stems.length) {
    return null;
  }

  for (const stem of stems) {
    const guessUrls = [
      `https://${stem}.by/`,
      `https://www.${stem}.by/`,
      `https://${stem}.ru/`,
      `https://www.${stem}.ru/`,
    ];

    for (const guessUrl of guessUrls) {
      try {
        const safeUrl = await assertPublicUrl(guessUrl);
        return {
          canResolve: true,
          title: stem,
          reason: 'domain-guess',
          url: safeUrl,
          score: 0.6,
        };
      } catch {
        // Ignore non-resolving domain guesses.
      }
    }
  }

  return null;
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractDuckDuckGoCandidates(html) {
  const candidates = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(html);
  while (match) {
    const href = decodeHtmlEntities(match[1] || '');
    const title = decodeHtmlEntities(match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let targetUrl = href;

    try {
      if (href.startsWith('//duckduckgo.com/l/')) {
        const parsed = new URL(`https:${href}`);
        targetUrl = decodeURIComponent(parsed.searchParams.get('uddg') || '');
      } else if (href.startsWith('https://duckduckgo.com/l/')) {
        const parsed = new URL(href);
        targetUrl = decodeURIComponent(parsed.searchParams.get('uddg') || '');
      }
    } catch {
      // Ignore result URL decode failures and keep raw href.
    }

    if (targetUrl) {
      candidates.push({
        title,
        url: targetUrl,
      });
    }
    match = pattern.exec(html);
  }

  return candidates;
}

function buildSiteSearchQuery(siteQuery) {
  return `${normalizeWhitespace(siteQuery)} site:by OR site:ru`;
}

async function searchPublicSiteCandidates(siteQuery, {
  timeoutMs = SITE_SEARCH_TIMEOUT_MS,
  deadlineAt = 0,
} = {}) {
  const remainingBudget = deadlineAt > 0 ? (deadlineAt - Date.now()) : timeoutMs;
  const effectiveTimeoutMs = Math.min(
    timeoutMs,
    Math.max(MIN_RESOLUTION_STEP_TIMEOUT_MS, remainingBudget - 160),
  );
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs < MIN_RESOLUTION_STEP_TIMEOUT_MS) {
    return [];
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(buildSiteSearchQuery(siteQuery))}`;
  const html = await requestText(searchUrl, {
    agent: geminiAgent,
    timeoutMs: effectiveTimeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AlesiaAI/1.0; +https://alesia-ai.constitution.of.by)',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
    },
  });

  const rawCandidates = extractDuckDuckGoCandidates(html).slice(0, SITE_SEARCH_RESULT_LIMIT * 2);
  const validated = [];

  for (const candidate of rawCandidates) {
    if (deadlineAt > 0 && Date.now() >= deadlineAt - 120) {
      break;
    }
    try {
      const safeUrl = await assertPublicUrl(candidate.url);
      validated.push({
        title: candidate.title || safeUrl,
        url: safeUrl,
      });
    } catch {
      // Skip non-public or disallowed URLs.
    }
    if (validated.length >= SITE_SEARCH_RESULT_LIMIT) {
      break;
    }
  }

  return validated;
}

function scoreSearchCandidates(siteQuery, transcript, candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const baseScore = scoreResolvedCandidate(siteQuery, transcript, candidate.title, candidate.url);
      const hostScore = scoreResolvedCandidate(siteQuery, transcript, '', candidate.url);
      let penalty = 0;
      const candidateText = `${candidate.title || ''} ${candidate.url || ''}`.toLowerCase();

      try {
        const parsed = new URL(candidate.url);
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        if (pathSegments.length > 1) {
          penalty += 0.24;
        }
        if (pathSegments.some((segment) => /\d{2,}/.test(segment) || segment.length >= 24)) {
          penalty += 0.12;
        }
        if (/\.(html?|php|aspx?)$/i.test(parsed.pathname)) {
          penalty += 0.12;
        }
      } catch {
        penalty += 0.2;
      }

      if (/(как правильно|правописан|пишется|орфограф|ударени|склонени)/i.test(candidateText)) {
        penalty += 0.34;
      }

      const score = Number(Math.max(0, Math.min(1, (hostScore * 0.72) + (baseScore * 0.28) - penalty)).toFixed(3));
      return {
        ...candidate,
        score,
      };
    })
    .filter((candidate) => candidate.score >= 0.32)
    .sort((left, right) => right.score - left.score);
}

function resolveBestScoredCandidate(scoredCandidates = []) {
  const best = scoredCandidates[0] || null;
  const second = scoredCandidates[1] || null;
  if (!best) {
    return null;
  }

  const confidenceMargin = Number((best.score - (second?.score || 0)).toFixed(3));
  const hasMargin = !second || confidenceMargin >= SITE_RESOLUTION_MIN_MARGIN;
  if (best.score < SITE_RESOLUTION_MIN_SCORE || !hasMargin) {
    return null;
  }

  return {
    title: best.title || best.url,
    url: best.url,
    reason: 'search-fallback',
    score: best.score,
    margin: confidenceMargin,
    candidates: scoredCandidates.slice(0, SITE_SEARCH_RESULT_LIMIT).map((candidate) => ({
      title: candidate.title,
      url: candidate.url,
      score: candidate.score,
    })),
  };
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

function extractKnowledgeSourceTokens(source) {
  const tokens = new Set();
  const values = [
    source?.title || '',
    ...(Array.isArray(source?.tags) ? source.tags : []),
    ...(Array.isArray(source?.aliases) ? source.aliases : []),
  ];

  values.forEach((value) => {
    collectLookupStems(value).forEach((token) => tokens.add(token));
  });

  try {
    const hostname = new URL(String(source?.canonicalUrl || '')).hostname.replace(/^www\./i, '');
    hostname
      .split('.')
      .filter(Boolean)
      .slice(0, -1)
      .forEach((token) => {
        const normalized = simplifyLookup(token);
        if (normalized.length >= 2) {
          tokens.add(normalized);
          if (normalized.length >= 5) {
            tokens.add(normalized.slice(1));
          }
          if (normalized.length >= 6) {
            tokens.add(normalized.slice(2));
          }
        }
      });
  } catch {
    // Ignore invalid knowledge source URLs here.
  }

  return Array.from(tokens).filter(Boolean);
}

function scoreKnowledgeSourceMatch(siteQuery, transcript, source) {
  const sourceTokens = extractKnowledgeSourceTokens(source);
  if (!sourceTokens.length) {
    return 0;
  }

  const queryTokens = collectLookupStems(siteQuery).length
    ? collectLookupStems(siteQuery)
    : collectLookupStems(transcript);

  if (!queryTokens.length) {
    return 0;
  }

  const total = queryTokens.reduce((acc, queryToken) => {
    const queryTokenLatin = transliterateToLatin(queryToken);
    const bestScore = sourceTokens.reduce((best, sourceToken) => {
      const sourceTokenLatin = transliterateToLatin(sourceToken);
      const similarity = Math.max(
        computeStemSimilarity(queryToken, sourceToken),
        computeStemSimilarity(queryTokenLatin, sourceTokenLatin),
      );
      return similarity > best ? similarity : best;
    }, 0);
    return acc + bestScore;
  }, 0);

  return Number((total / queryTokens.length).toFixed(3));
}

function resolveFromKnowledgeSources(siteQuery, transcript, knowledgeSources = []) {
  const candidates = Array.isArray(knowledgeSources) ? knowledgeSources : [];
  if (!candidates.length) {
    return null;
  }

  const scored = candidates
    .map((source) => ({
      source,
      score: scoreKnowledgeSourceMatch(siteQuery, transcript, source),
    }))
    .filter((entry) => entry.score >= KNOWLEDGE_RESOLUTION_MIN_SCORE)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best?.source?.canonicalUrl) {
    return null;
  }

  const margin = Number((best.score - (second?.score || 0)).toFixed(3));
  if (second && margin < KNOWLEDGE_RESOLUTION_MIN_MARGIN) {
    return null;
  }

  return {
    title: best.source.title || best.source.canonicalUrl,
    url: best.source.canonicalUrl,
    reason: 'knowledge-source',
    score: best.score,
    margin,
    candidates: scored.slice(0, SITE_SEARCH_RESULT_LIMIT).map((entry) => ({
      title: entry.source?.title || entry.source?.canonicalUrl || '',
      url: entry.source?.canonicalUrl || '',
      score: entry.score,
    })),
  };
}

function sanitizeRecentTurnsForResolver(recentTurns = []) {
  if (!Array.isArray(recentTurns)) {
    return [];
  }

  return recentTurns
    .slice(-8)
    .map((turn) => ({
      role: turn?.role === 'assistant' ? 'assistant' : 'user',
      text: normalizeWhitespace(turn?.text || '').slice(0, 240),
    }))
    .filter((turn) => turn.text.length >= 2);
}

function extractStrongSourceStems(source) {
  const stems = new Set();
  const aliases = Array.isArray(source?.aliases) ? source.aliases : [];
  aliases.forEach((alias) => {
    const normalized = simplifyLookup(alias);
    if (normalized.length >= 4) {
      stems.add(normalized);
    }
  });

  try {
    const hostname = new URL(String(source?.canonicalUrl || '')).hostname.replace(/^www\./i, '');
    const hostStem = simplifyLookup(hostname.split('.')[0] || '');
    if (hostStem.length >= 4) {
      stems.add(hostStem);
    }
  } catch {
    // Ignore malformed canonical URLs.
  }

  return Array.from(stems);
}

function resolveMentionedKnowledgeSourceFromTurns(recentTurns = [], knowledgeSources = []) {
  const turnsText = sanitizeRecentTurnsForResolver(recentTurns).map((turn) => turn.text).join(' ');
  const compactText = simplifyLookup(turnsText);
  if (!compactText) {
    return null;
  }

  let best = null;
  (Array.isArray(knowledgeSources) ? knowledgeSources : []).forEach((source) => {
    const strongStems = extractStrongSourceStems(source);
    strongStems.forEach((stem) => {
      if (!compactText.includes(stem)) {
        return;
      }
      const score = Math.min(1, 0.7 + Math.min(0.25, stem.length / 40));
      if (!best || score > best.score) {
        best = { source, score, matchedStem: stem };
      }
    });
  });

  if (!best?.source?.canonicalUrl) {
    return null;
  }

  return {
    title: best.source.title || best.source.canonicalUrl,
    url: best.source.canonicalUrl,
    score: Number(best.score.toFixed(3)),
    matchedStem: best.matchedStem,
  };
}

function resolveFromRecentTurns(transcript, siteQuery, recentTurns = [], knowledgeSources = []) {
  const normalizedTurns = sanitizeRecentTurnsForResolver(recentTurns);
  if (!normalizedTurns.length) {
    return null;
  }

  const normalizedTranscript = normalizeWhitespace(transcript);
  const referencesPreviousSite = /(сам|сама|это|этот|эту|того|тот|тот же|этот же|его|е[её]|предыдущ|последн|снова|обратно)/i
    .test(normalizedTranscript);
  if (!referencesPreviousSite) {
    return null;
  }

  const explicitMention = resolveMentionedKnowledgeSourceFromTurns(normalizedTurns, knowledgeSources);
  if (explicitMention?.url) {
    return {
      title: explicitMention.title,
      url: explicitMention.url,
      reason: 'recent-turn-mention',
      score: explicitMention.score,
      margin: explicitMention.score,
      candidates: [{
        title: explicitMention.title,
        url: explicitMention.url,
        score: explicitMention.score,
      }],
    };
  }

  const recentTurnsText = normalizedTurns.map((turn) => turn.text).join('\n');
  const match = resolveFromKnowledgeSources('', recentTurnsText, knowledgeSources);
  if (!match?.url) {
    return null;
  }

  return {
    title: match.title || match.url,
    url: match.url,
    reason: 'recent-turn-context',
    score: Number((Math.max(0.62, match.score || 0.62)).toFixed(3)),
    margin: match.margin ?? (match.score || 0.62),
    candidates: Array.isArray(match.candidates) ? match.candidates : [],
  };
}

function buildKnowledgeSourceHint(siteQuery, transcript, knowledgeSources = []) {
  const candidates = Array.isArray(knowledgeSources) ? knowledgeSources : [];
  if (!candidates.length) {
    return '';
  }

  const scored = candidates
    .map((source) => ({
      source,
      score: scoreKnowledgeSourceMatch(siteQuery, transcript, source),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best?.source || best.score < 0.62) {
    return '';
  }
  if (second && (best.score - second.score) < 0.08) {
    return '';
  }

  try {
    const hostname = new URL(String(best.source.canonicalUrl || '')).hostname.replace(/^www\./i, '');
    const stem = simplifyLookup(hostname.split('.')[0] || '');
    if (stem.length >= 3) {
      return stem;
    }
  } catch {
    // Ignore malformed URLs; use aliases/title fallback.
  }

  const fallbackToken = extractKnowledgeSourceTokens(best.source).sort((left, right) => right.length - left.length)[0] || '';
  return fallbackToken.length >= 3 ? fallbackToken : '';
}

function normalizeTranscriptForSiteLookup(transcript, knowledgeSources = [], sessionHistory = []) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) {
    return {
      transcript: '',
      siteHint: '',
      usedHistoryHint: false,
      usedKnowledgeHint: false,
    };
  }

  const lowered = normalized.toLowerCase()
    .replace(/\bточка\s+бай\b/gi, '.by')
    .replace(/\bточка\s+ру\b/gi, '.ru');

  const historyMatch = resolveFromSessionHistory(lowered, sessionHistory);
  if (historyMatch?.url && /(тот|тот же|предыдущ|прошл|последн|снова|обратно)/i.test(lowered)) {
    const parsed = parseHistoryUrl(historyMatch.url);
    const hostStem = simplifyLookup(parsed?.hostname?.replace(/^www\./i, '').split('.')[0] || '');
    return {
      transcript: lowered,
      siteHint: hostStem,
      usedHistoryHint: Boolean(hostStem),
      usedKnowledgeHint: false,
    };
  }

  const siteQuery = extractSiteLookupQuery(lowered) || stripCommandWords(lowered) || lowered;
  const knowledgeHint = buildKnowledgeSourceHint(siteQuery, lowered, knowledgeSources);
  return {
    transcript: lowered,
    siteHint: knowledgeHint,
    usedHistoryHint: false,
    usedKnowledgeHint: Boolean(knowledgeHint),
  };
}

function extractWeatherQuery(transcript) {
  const normalized = normalizeWhitespace(transcript);
  const lowered = normalized.toLowerCase();

  const knownCity = WEATHER_MEMORY.find((entry) => entry.aliases
    .some((alias) => simplifyLookup(lowered).includes(simplifyLookup(alias))));
  if (knownCity?.aliases?.[0]) {
    return normalizeQueryValue(knownCity.aliases[0]);
  }

  const locationMatch = normalized.match(/(?:^|\s)(?:в|во|на)\s+([а-яёa-z0-9\s-]+?)(?:\s+(?:сегодня|завтра|послезавтра|на выходных|будет|будут))?[?!.]*$/i);
  if (locationMatch?.[1]) {
    const normalizedLocation = normalizeQueryValue(locationMatch[1]);
    if (normalizedLocation.length >= 2) {
      return normalizedLocation;
    }
  }

  const fallbackValue = normalizeQueryValue(stripCommandWords(normalized));
  if (fallbackValue.length < 2) {
    return '';
  }
  if (/(^|\s)(открою|открой|открыть|покажи|посмотри|найди|перейди|зайди)(\s|$)/i.test(fallbackValue)) {
    return '';
  }

  return fallbackValue;
}

function normalizeSpokenDomainLabel(label) {
  const cleaned = normalizeWhitespace(
    String(label || '')
      .toLowerCase()
      .replace(/[.,;!?()[\]{}"«»]/g, ' ')
      .replace(/(^|\s)(?:открой|открыть|зайди|зайти|перейди|перейти|найди|найти|покажи|посмотри|иди|вернись|вернуться|переход|навигац[а-яё]*)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:сайт|сайта|страниц[ауые]?|домен|адрес|точка|на|в|во|к|по|с|со|для)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:главн(ая|ую|ой|ое)|домой|домашн(яя|юю|ей|ее)|страниц(а|у|е|ой))(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:ну|а|и|ладно|тогда|просто|давай|прошу|пожалуйста|калі|ласка|мне|нам|сам|сама|само|этот|эта|эту|тот|та|ту)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:официальн[а-яё]*|компан[а-яё]*|фирм[а-яё]*|бренд[а-яё]*)(?=\s|$)/giu, ' ')
  );
  if (!cleaned) {
    return '';
  }

  const tokens = cleaned
    .split(/\s+/)
    .map((token) => transliterateToLatin(token))
    .map((token) => token.replace(/[^a-z0-9-]+/gi, ''))
    .filter(Boolean);

  if (!tokens.length) {
    return '';
  }

  return tokens.join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function extractSpokenDomain(transcript) {
  const source = String(transcript || '').toLowerCase();
  if (!source) {
    return null;
  }

  const normalized = source
    .replace(/[«»"']/g, ' ')
    .replace(/[!?;:,()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return null;
  }

  const patterns = [
    /([a-zа-яё0-9-]+(?:\s+[a-zа-яё0-9-]+){0,4})\s*(?:\.|точка)\s*(by|ru)\b/giu,
    /([a-zа-яё0-9-]+\s+[a-zа-яё0-9-]+(?:\s+[a-zа-яё0-9-]+){0,3})\s+(by|ru)\b/giu,
  ];
  const candidates = [];

  patterns.forEach((pattern) => {
    let match = pattern.exec(normalized);
    while (match) {
      const label = normalizeSpokenDomainLabel(match[1]);
      const tld = String(match[2] || '').toLowerCase();
      if (label.length >= 2 && (tld === 'by' || tld === 'ru')) {
        candidates.push(`https://${label}.${tld}`);
      }
      match = pattern.exec(normalized);
    }
  });

  if (!candidates.length) {
    return null;
  }

  return candidates.at(-1);
}

function resolveKnownChurchSiteFallback(transcript) {
  const normalized = normalizeWhitespace(transcript).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes('church.by')
    || normalized.includes('сайт церкви')
    || normalized.includes('церкви беларуси')
    || normalized.includes('церковь беларуси')
    || normalized.includes('белорусская православная церковь')
    || normalized.includes('православная церковь беларуси')
    || normalized.includes('сайт белорусской православной церкви')
    || normalized.includes('бпц')
    || normalized.includes('белорусск') && normalized.includes('православ')
    || normalized.includes('минск') && normalized.includes('епарх')
    || normalized.includes('церковный сайт')
    || normalized.includes('православный сайт')
    || normalized.includes('церковный ресурс')
  ) {
    return 'http://church.by/';
  }
  if (
    normalized.includes('московск') && normalized.includes('патриархат')
    || normalized.includes('патриархия')
  ) {
    return 'https://patriarchia.ru/';
  }
  if (normalized.includes('азбук') || normalized.includes('azbyka')) {
    return 'https://azbyka.ru/';
  }
  if (normalized.includes('правмир') || normalized.includes('pravmir')) {
    return 'https://www.pravmir.ru/';
  }
  return null;
}

function shouldUseChurchByDefaultForContext(contextHint = '') {
  const normalized = normalizeWhitespace(contextHint).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('батюшк')
    || normalized.includes('николай')
    || normalized.includes('православ')
    || normalized.includes('церков')
    || normalized.includes('прихожан')
  );
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

  const spokenDomain = extractSpokenDomain(transcript);
  if (spokenDomain) {
    return spokenDomain;
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

function buildLookupVariants(siteQuery, _contextHint = '', transcript = '') {
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

function buildBigrams(stem) {
  const result = new Set();
  for (let index = 0; index < stem.length - 1; index += 1) {
    result.add(stem.slice(index, index + 2));
  }
  return result;
}

function computeStemSimilarity(left, right) {
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

async function resolveSiteWithGemini(
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

async function classifyTranscript(
  transcript,
  webProviders,
  contextHint,
  sessionHistory = [],
  traceId = '',
  knowledgeSources = [],
  recentTurns = [],
) {
  const rawTranscript = normalizeWhitespace(transcript);
  if (/^RUNTIME_[A-Z_]+:/i.test(rawTranscript)) {
    return { type: 'none', reason: 'runtime-system-prompt' };
  }

  const normalizedSessionHistory = sanitizeSessionHistory(sessionHistory);
  const normalizedInput = normalizeTranscriptForSiteLookup(rawTranscript, knowledgeSources, normalizedSessionHistory);
  const normalized = normalizeWhitespace(normalizedInput.transcript);
  const lower = normalized.toLowerCase();
  const directUrl = extractUrlOrDomain(normalized) || resolveKnownChurchSiteFallback(normalized);
  const searchQuery = stripCommandWords(normalized) || normalized;
  let siteLookupQuery = extractSiteLookupQuery(normalized) || searchQuery;
  if (normalizedInput.siteHint) {
    const queryTokens = collectLookupStems(siteLookupQuery);
    if (!queryTokens.includes(normalizedInput.siteHint)) {
      siteLookupQuery = normalizeWhitespace(`${siteLookupQuery} ${normalizedInput.siteHint}`);
    }
  }

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
      : (WEATHER_MEMORY[0]?.url || getProviderHomeUrl(webProviders.weather.urlTemplate));
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

  if (
    isLikelyInPageNavigationRequest(normalized)
    && !hasSiteWord(normalized)
    && !looksLikeStandaloneSiteMention(normalized)
    && isTriviallyGenericSiteQuery(siteLookupQuery)
  ) {
    return { type: 'none', reason: 'in-page-navigation-command' };
  }

  if (isExplicitSiteOpenRequest(lower) || hasSiteWord(normalized) || looksLikeStandaloneSiteMention(normalized)) {
    const recentTurnMatch = resolveFromRecentTurns(normalized, siteLookupQuery, recentTurns, knowledgeSources);
    if (recentTurnMatch?.url) {
      logRuntime('browser.resolve.recent-turn-match', {
        traceId,
        query: siteLookupQuery,
        url: recentTurnMatch.url,
        score: recentTurnMatch.score,
      });
      return {
        type: 'direct-site',
        query: siteLookupQuery,
        url: recentTurnMatch.url,
        sourceType: 'recent-turn-context',
        titleHint: recentTurnMatch.title,
        resolutionSource: 'recent-turn-context',
        confidence: recentTurnMatch.score,
        confidenceMargin: recentTurnMatch.margin ?? recentTurnMatch.score ?? 0,
        candidates: recentTurnMatch.candidates || [{
          title: recentTurnMatch.title,
          url: recentTurnMatch.url,
          score: recentTurnMatch.score,
        }],
      };
    }

    const resolutionDeadlineAt = Date.now() + SITE_RESOLUTION_TIMEOUT_MS;
    const getResolutionBudget = () => resolutionDeadlineAt - Date.now();
    const hasResolutionBudget = (reserveMs = 0) => getResolutionBudget() > reserveMs;

    if (isTriviallyGenericSiteQuery(siteLookupQuery)) {
      if (shouldUseChurchByDefaultForContext(contextHint)) {
        return {
          type: 'direct-site',
          query: 'church.by',
          url: 'http://church.by/',
          sourceType: 'character-default',
          titleHint: 'church.by',
          resolutionSource: 'character-default',
          confidence: 0.62,
          confidenceMargin: 0.62,
          candidates: [{
            title: 'Белорусская Православная Церковь',
            url: 'http://church.by/',
            score: 0.62,
          }],
        };
      }
      return {
        type: 'unresolved-site',
        query: siteLookupQuery,
        error: 'Не услышала название сайта. Назовите его точнее.',
        errorReason: 'resolve_low_confidence',
        confidence: 0,
        confidenceMargin: 0,
        candidates: [],
      };
    }

    const historyMatch = resolveFromSessionHistory(normalized, normalizedSessionHistory);
    if (historyMatch?.url) {
      const historyUrl = parseHistoryUrl(historyMatch.url);
      return {
        type: 'direct-site',
        query: siteLookupQuery,
        url: historyMatch.url,
        sourceType: 'direct-site',
        titleHint: historyMatch.title || historyUrl?.hostname || historyMatch.url,
        resolutionSource: 'session-history',
        confidence: 0.72,
        confidenceMargin: 0.72,
        candidates: [{
          title: historyMatch.title || historyUrl?.hostname || historyMatch.url,
          url: historyMatch.url,
          score: 0.72,
        }],
      };
    }

    const knowledgeMatch = resolveFromKnowledgeSources(siteLookupQuery, normalized, knowledgeSources);
    if (knowledgeMatch?.url) {
      logRuntime('browser.resolve.knowledge-source-match', {
        traceId,
        query: siteLookupQuery,
        url: knowledgeMatch.url,
        score: knowledgeMatch.score,
      });
      return {
        type: 'direct-site',
        query: siteLookupQuery,
        url: knowledgeMatch.url,
        sourceType: 'knowledge-source',
        titleHint: knowledgeMatch.title,
        resolutionSource: 'knowledge-source',
        confidence: knowledgeMatch.score,
        confidenceMargin: knowledgeMatch.margin ?? knowledgeMatch.score ?? 0,
        candidates: knowledgeMatch.candidates || [{
          title: knowledgeMatch.title,
          url: knowledgeMatch.url,
          score: knowledgeMatch.score,
        }],
      };
    }

    if (shouldPreferFastDomainGuess(siteLookupQuery, normalized)) {
      const guessedFast = await resolveSiteByDomainGuess(siteLookupQuery);
      if (guessedFast?.url) {
        logRuntime('browser.resolve.fast-domain-guess', {
          traceId,
          query: siteLookupQuery,
          url: guessedFast.url,
        });
        return {
          type: 'direct-site',
          query: siteLookupQuery,
          url: guessedFast.url,
          sourceType: 'direct-site',
          titleHint: guessedFast.title || new URL(guessedFast.url).hostname,
          resolutionSource: 'domain-guess',
          confidence: guessedFast.score ?? 0.6,
          confidenceMargin: guessedFast.score ?? 0.6,
          candidates: [{
            title: guessedFast.title || new URL(guessedFast.url).hostname,
            url: guessedFast.url,
            score: guessedFast.score ?? 0.6,
          }],
        };
      }
    }

    let fallbackCandidates = [];
    let resolutionTimedOut = false;
    try {
      if (hasResolutionBudget(MIN_RESOLUTION_STEP_TIMEOUT_MS + 120)) {
        const searchTimeoutMs = Math.min(
          SITE_SEARCH_TIMEOUT_MS,
          Math.max(
            MIN_RESOLUTION_STEP_TIMEOUT_MS,
            getResolutionBudget() - (MIN_RESOLUTION_STEP_TIMEOUT_MS + 120),
          ),
        );
        const searchCandidates = await searchPublicSiteCandidates(siteLookupQuery, {
          timeoutMs: searchTimeoutMs,
          deadlineAt: resolutionDeadlineAt,
        });
        const scoredCandidates = scoreSearchCandidates(siteLookupQuery, normalized, searchCandidates);
        fallbackCandidates = scoredCandidates.slice(0, SITE_SEARCH_RESULT_LIMIT).map((candidate) => ({
          title: candidate.title,
          url: candidate.url,
          score: candidate.score,
        }));
        const searchResolved = resolveBestScoredCandidate(scoredCandidates);
        if (searchResolved?.url) {
          logRuntime('browser.resolve.search-fallback-match', {
            traceId,
            query: siteLookupQuery,
            url: searchResolved.url,
            score: searchResolved.score,
          });
          return {
            type: 'direct-site',
            query: siteLookupQuery,
            url: searchResolved.url,
            sourceType: 'search-fallback',
            titleHint: searchResolved.title || new URL(searchResolved.url).hostname,
            resolutionSource: 'search-fallback',
            confidence: searchResolved.score,
            confidenceMargin: searchResolved.margin ?? searchResolved.score ?? 0,
            candidates: searchResolved.candidates || [],
          };
        }

        const bestGuess = scoredCandidates[0];
        if (bestGuess?.url && bestGuess.score >= SITE_RESOLUTION_MIN_SCORE) {
          const secondGuess = scoredCandidates[1];
          const bestGuessMargin = Number((bestGuess.score - (secondGuess?.score || 0)).toFixed(3));
          logRuntime('browser.resolve.search-best-guess', {
            traceId,
            query: siteLookupQuery,
            url: bestGuess.url,
            score: bestGuess.score,
            margin: bestGuessMargin,
          });
          return {
            type: 'direct-site',
            query: siteLookupQuery,
            url: bestGuess.url,
            sourceType: 'search-fallback',
            titleHint: bestGuess.title || new URL(bestGuess.url).hostname,
            resolutionSource: 'search-best-guess',
            confidence: bestGuess.score,
            confidenceMargin: bestGuessMargin,
            candidates: fallbackCandidates,
          };
        }
      } else {
        resolutionTimedOut = true;
      }
    } catch (error) {
      logRuntime('browser.resolve.search-fallback-error', {
        traceId,
        query: siteLookupQuery,
        error,
      }, 'error');
    }

    let geminiTimedOut = false;
    if (hasResolutionBudget(180)) {
      try {
        const resolved = await resolveSiteWithGemini(
          normalized,
          siteLookupQuery,
          contextHint,
          normalizedSessionHistory,
          traceId,
          { totalBudgetMs: Math.max(180, getResolutionBudget()) },
        );
        if (resolved.canResolve && resolved.url) {
          siteResolutionCache.set(simplifyLookup(siteLookupQuery), {
            value: {
              canResolve: true,
              title: resolved.title || new URL(resolved.url).hostname,
              reason: resolved.reason || 'gemini',
              url: resolved.url,
              score: resolved.score ?? null,
            },
            timestamp: Date.now(),
          });
          return {
            type: 'direct-site',
            query: siteLookupQuery,
            url: resolved.url,
            sourceType: 'direct-site',
            titleHint: resolved.title || new URL(resolved.url).hostname,
            resolutionSource: resolved.reason || 'gemini',
            confidence: resolved.score ?? SITE_RESOLUTION_MIN_SCORE,
            confidenceMargin: resolved.score ?? SITE_RESOLUTION_MIN_SCORE,
            candidates: [{
              title: resolved.title || new URL(resolved.url).hostname,
              url: resolved.url,
              score: resolved.score ?? SITE_RESOLUTION_MIN_SCORE,
            }],
          };
        }
      } catch (error) {
        geminiTimedOut = /таймаут|timeout/i.test(String(error?.message || ''));
        logRuntime('browser.resolve.gemini-error', {
          traceId,
          query: siteLookupQuery,
          error,
        }, 'error');
      }
    } else {
      resolutionTimedOut = true;
    }

    if (getResolutionBudget() <= 0) {
      resolutionTimedOut = true;
    }
    const errorReason = (geminiTimedOut || resolutionTimedOut) ? 'resolve_timeout' : 'resolve_low_confidence';
    return {
      type: 'unresolved-site',
      query: siteLookupQuery,
      error: geminiTimedOut
        ? 'Не успела определить сайт вовремя. Повторите запрос точнее.'
        : 'Не удалось уверенно определить сайт. Назовите его точнее.',
      errorReason,
      confidence: 0,
      confidenceMargin: 0,
      candidates: fallbackCandidates,
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

function clearSessionCleanupTimer() {
  if (sessionCleanupTimer) {
    clearTimeout(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }
}

function buildBrowserSessionId() {
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function hasActiveSession() {
  return Boolean(activeBrowserSession?.page && !activeBrowserSession.page.isClosed());
}

function resetBrowserState(reason = 'browser-disconnected') {
  if (activeBrowserSession?.id) {
    logRuntime('browser.session.reset', {
      reason,
      browserSessionId: activeBrowserSession.id,
      url: activeBrowserSession.url || '',
    }, 'error');
  }
  clearBrowserIdleTimer();
  clearSessionCleanupTimer();
  browserPromise = null;
  browserInstance = null;
  activeBrowserSession = null;
}

async function closeActivePage(reason = 'unknown') {
  clearSessionCleanupTimer();
  const session = activeBrowserSession;
  const context = session?.context || null;
  const page = session?.page || null;
  if (session?.id) {
    logRuntime('browser.session.close', {
      reason,
      browserSessionId: session.id,
      url: session.url || '',
    });
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

export async function closeBrowser() {
  clearBrowserIdleTimer();
  clearSessionCleanupTimer();
  await closeActivePage('close-browser');

  const browser = browserInstance || await browserPromise?.catch(() => null);
  browserPromise = null;
  browserInstance = null;

  if (browser) {
    await browser.close().catch(() => {});
  }
}

export function cancelPendingBrowserOperations(reason = 'manual-cancel') {
  activeRequestId += 1;
  logRuntime('browser.request.cancelled', {
    reason,
    activeRequestId,
    browserSessionId: activeBrowserSession?.id || '',
    url: activeBrowserSession?.url || '',
  });
}

function scheduleBrowserShutdown() {
  clearBrowserIdleTimer();
  if (!browserPromise || hasActiveSession()) {
    return;
  }

  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    if (hasActiveSession()) {
      return;
    }
    void closeBrowser();
  }, BROWSER_IDLE_TIMEOUT_MS);
  browserIdleTimer.unref?.();
}

function scheduleSessionCleanup() {
  clearSessionCleanupTimer();
  if (!activeBrowserSession) {
    scheduleBrowserShutdown();
    return;
  }

  const elapsedMs = Date.now() - activeBrowserSession.lastAccessAt;
  const remainingMs = Math.max(1000, BROWSER_SESSION_TTL_MS - elapsedMs);
  sessionCleanupTimer = setTimeout(() => {
    if (!activeBrowserSession) {
      scheduleBrowserShutdown();
      return;
    }

    const idleMs = Date.now() - activeBrowserSession.lastAccessAt;
    if (idleMs >= BROWSER_SESSION_TTL_MS) {
      logRuntime('browser.session.expired', {
        browserSessionId: activeBrowserSession.id,
        idleMs,
      });
      void closeActivePage('session-ttl-expired');
      return;
    }

    scheduleSessionCleanup();
  }, remainingMs);
  sessionCleanupTimer.unref?.();
}

function touchBrowserSession(session) {
  if (!session || activeBrowserSession?.id !== session.id) {
    return;
  }

  clearBrowserIdleTimer();
  session.lastAccessAt = Date.now();
  scheduleSessionCleanup();
}

function shouldUseBrowserProxy() {
  return ['shared', 'proxy', 'always', 'browser'].includes(BROWSER_PROXY_MODE);
}

function getConfiguredProxy() {
  if (!shouldUseBrowserProxy()) {
    return null;
  }

  const host = normalizeWhitespace(process.env.PROXY_HOST || '');
  const port = Number.parseInt(process.env.PROXY_PORT || '', 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }

  return {
    scheme: normalizeWhitespace(process.env.PROXY_SCHEME || 'socks5h').toLowerCase(),
    host,
    port,
    username: normalizeWhitespace(process.env.PROXY_USER || ''),
    password: normalizeWhitespace(process.env.PROXY_PASS || ''),
  };
}

async function probeOriginReachability(targetUrl, timeoutMs = BROWSER_ORIGIN_PROBE_TIMEOUT_MS) {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const port = Number(parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443));
  const hostname = parsedUrl.hostname;
  if (!hostname || !Number.isFinite(port) || port <= 0) {
    return { ok: false, reason: 'invalid_url' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({
      host: hostname,
      port,
      timeout: Math.max(500, timeoutMs),
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'connect_timeout' }));
    socket.once('error', (error) => finish({
      ok: false,
      reason: normalizeWhitespace(error?.code || error?.message || 'connect_error').toLowerCase(),
    }));
  });
}

function buildSocksReply(status, host = '0.0.0.0', port = 0) {
  const normalizedPort = Number.isFinite(Number(port)) ? Number(port) : 0;
  if (net.isIPv6(host)) {
    const payload = Buffer.alloc(4 + 16 + 2);
    payload[0] = 0x05;
    payload[1] = status;
    payload[2] = 0x00;
    payload[3] = 0x04;
    const parts = host.split(':');
    const expanded = [];
    for (const part of parts) {
      if (!part) {
        const missing = 8 - parts.filter(Boolean).length;
        for (let index = 0; index <= missing; index += 1) {
          expanded.push('0000');
        }
      } else {
        expanded.push(part.padStart(4, '0'));
      }
    }
    expanded.slice(0, 8).forEach((part, index) => {
      payload.writeUInt16BE(Number.parseInt(part, 16) || 0, 4 + (index * 2));
    });
    payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 20);
    return payload;
  }

  if (net.isIPv4(host)) {
    const payload = Buffer.alloc(10);
    payload[0] = 0x05;
    payload[1] = status;
    payload[2] = 0x00;
    payload[3] = 0x01;
    host.split('.').slice(0, 4).forEach((part, index) => {
      payload[4 + index] = Number.parseInt(part, 10) || 0;
    });
    payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 8);
    return payload;
  }

  const hostBuffer = Buffer.from(String(host || ''));
  const payload = Buffer.alloc(5 + hostBuffer.length + 2);
  payload[0] = 0x05;
  payload[1] = status;
  payload[2] = 0x00;
  payload[3] = 0x03;
  payload[4] = Math.min(255, hostBuffer.length);
  hostBuffer.copy(payload, 5, 0, Math.min(255, hostBuffer.length));
  payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 5 + Math.min(255, hostBuffer.length));
  return payload;
}

function parseSocksRequest(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  const atyp = buffer[3];
  if (atyp === 0x01) {
    if (buffer.length < 10) {
      return null;
    }
    return {
      host: `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`,
      port: buffer.readUInt16BE(8),
      bytesUsed: 10,
    };
  }

  if (atyp === 0x03) {
    if (buffer.length < 5) {
      return null;
    }
    const hostLength = buffer[4];
    const totalLength = 5 + hostLength + 2;
    if (buffer.length < totalLength) {
      return null;
    }
    return {
      host: buffer.subarray(5, 5 + hostLength).toString('utf8'),
      port: buffer.readUInt16BE(5 + hostLength),
      bytesUsed: totalLength,
    };
  }

  if (atyp === 0x04) {
    if (buffer.length < 22) {
      return null;
    }
    const segments = [];
    for (let index = 0; index < 8; index += 1) {
      segments.push(buffer.readUInt16BE(4 + (index * 2)).toString(16));
    }
    return {
      host: segments.join(':'),
      port: buffer.readUInt16BE(20),
      bytesUsed: 22,
    };
  }

  return { unsupported: true, bytesUsed: buffer.length };
}

function createBrowserProxyBridgeServer(proxyConfig) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      let stage = 'greeting';
      let buffer = Buffer.alloc(0);
      let upstreamSocket = null;
      let settled = false;

      const cleanup = () => {
        clientSocket.removeAllListeners('data');
        clientSocket.removeAllListeners('error');
        clientSocket.removeAllListeners('close');
      };

      const fail = (status = 0x01, error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          logRuntime('browser.proxy.bridge.error', {
            message: normalizeWhitespace(error?.message || String(error || '')),
          }, 'error');
        }
        try {
          clientSocket.write(buildSocksReply(status));
        } catch {}
        cleanup();
        clientSocket.destroy();
        upstreamSocket?.destroy();
      };

      const complete = async (host, port, remainingBuffer) => {
        try {
          const connection = await SocksClient.createConnection({
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              type: 5,
              userId: proxyConfig.username || undefined,
              password: proxyConfig.password || undefined,
            },
            command: 'connect',
            destination: {
              host,
              port,
            },
            timeout: DEFAULT_TIMEOUT_MS,
          });

          if (settled) {
            connection.socket.destroy();
            return;
          }

          settled = true;
          upstreamSocket = connection.socket;
          clientSocket.write(buildSocksReply(0x00));
          if (remainingBuffer?.length) {
            upstreamSocket.write(remainingBuffer);
          }
          cleanup();
          upstreamSocket.on('error', () => clientSocket.destroy());
          upstreamSocket.on('close', () => clientSocket.destroy());
          clientSocket.on('error', () => upstreamSocket.destroy());
          clientSocket.on('close', () => upstreamSocket.destroy());
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        } catch (error) {
          fail(0x05, error);
        }
      };

      clientSocket.on('data', (chunk) => {
        if (settled) {
          return;
        }

        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 'greeting') {
          if (buffer.length < 2) {
            return;
          }

          const methodsLength = buffer[1];
          if (buffer.length < 2 + methodsLength) {
            return;
          }

          clientSocket.write(Buffer.from([0x05, 0x00]));
          buffer = buffer.subarray(2 + methodsLength);
          stage = 'request';
        }

        if (stage === 'request') {
          if (buffer.length < 4) {
            return;
          }

          if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
            fail(0x07, new Error('Unsupported SOCKS command'));
            return;
          }

          const request = parseSocksRequest(buffer);
          if (!request) {
            return;
          }
          if (request.unsupported) {
            fail(0x08, new Error('Unsupported SOCKS address type'));
            return;
          }

          const remainingBuffer = buffer.subarray(request.bytesUsed);
          buffer = Buffer.alloc(0);
          stage = 'connecting';
          void complete(request.host, request.port, remainingBuffer);
        }
      });

      clientSocket.on('error', () => {
        upstreamSocket?.destroy();
      });
      clientSocket.on('close', () => {
        upstreamSocket?.destroy();
      });
    });

    server.once('error', (error) => {
      browserProxyBridgePromise = null;
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        browserProxyBridgePromise = null;
        reject(new Error('Failed to bind browser proxy bridge'));
        return;
      }

      logRuntime('browser.proxy.bridge.ready', {
        host: '127.0.0.1',
        port: address.port,
        upstreamHost: proxyConfig.host,
        upstreamPort: proxyConfig.port,
      });

      resolve({
        server,
        endpoint: `socks5://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function getBrowserLaunchProxy() {
  const proxyConfig = getConfiguredProxy();
  if (!proxyConfig) {
    return null;
  }

  if (!proxyConfig.scheme.startsWith('socks')) {
    const launchScheme = proxyConfig.scheme.replace(/h$/, '') || 'http';
    const proxy = {
      server: `${launchScheme}://${proxyConfig.host}:${proxyConfig.port}`,
    };
    if (proxyConfig.username) {
      proxy.username = proxyConfig.username;
    }
    if (proxyConfig.password) {
      proxy.password = proxyConfig.password;
    }
    return proxy;
  }

  if (!proxyConfig.username && !proxyConfig.password) {
    return {
      server: `socks5://${proxyConfig.host}:${proxyConfig.port}`,
    };
  }

  if (!browserProxyBridgePromise) {
    browserProxyBridgePromise = createBrowserProxyBridgeServer(proxyConfig);
  }

  const bridge = await browserProxyBridgePromise;
  return {
    server: bridge.endpoint,
  };
}

async function getBrowser() {
  clearBrowserIdleTimer();
  if (!browserPromise) {
    const launchOptions = {
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--mute-audio'],
    };
    const browserProxy = await getBrowserLaunchProxy();
    if (browserProxy) {
      launchOptions.proxy = browserProxy;
    }

    browserPromise = chromium.launch(launchOptions).then((browser) => {
      browserInstance = browser;
      browser.on('disconnected', () => resetBrowserState('playwright-browser-disconnected'));
      return browser;
    }).catch((error) => {
      resetBrowserState('browser-launch-failed');
      throw error;
    });
  }

  return browserPromise;
}

function safeHostnameFromUrl(url, fallback = '') {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

function toHttpFallbackUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    parsed.protocol = 'http:';
    return parsed.toString();
  } catch {
    return '';
  }
}

function shouldRetryWithHttpFallback(url, error) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    return false;
  }

  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return message.includes('err_ssl')
    || message.includes('ssl')
    || message.includes('certificate');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getRegistrableDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) {
      return hostname;
    }
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

function isSameSiteUrl(left, right) {
  const leftDomain = getRegistrableDomain(left);
  const rightDomain = getRegistrableDomain(right);
  return Boolean(leftDomain) && Boolean(rightDomain) && leftDomain === rightDomain;
}

function truncateText(value, maxLength = 360) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

async function readPageText(page) {
  return normalizeWhitespace(
    await page.evaluate(() => document.body?.innerText || '')
  );
}

async function extractActionableElements(page) {
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

async function refreshBrowserSessionSnapshot(session, {
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

function tokenizeQuestion(question) {
  return normalizeWhitespace(String(question || '').toLowerCase())
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
    .map((token) => simplifyLookup(token))
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
}

function splitContextSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((chunk) => normalizeWhitespace(chunk))
    .filter((chunk) => chunk.length >= 20);
}

function scoreSentenceAgainstTokens(sentence, tokens) {
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

function selectRelevantContext(text, question) {
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

function buildSessionQueryAnswer(question, session) {
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

function htmlToPlainText(html) {
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

function serializeSession(session) {
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
    error: null,
    query: session.query || '',
    lastUpdated: session.lastUpdatedAt,
    revision: session.revision || 0,
    view,
  };
}

function scoreActionableElement(target, element) {
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

function findBestActionableElement(session, label) {
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

export async function detectBrowserIntent({
  transcript,
  webProviders,
  knowledgeSources = [],
  recentTurns = [],
  contextHint = '',
  sessionHistory = [],
  traceId = '',
}) {
  const normalizedSessionHistory = sanitizeSessionHistory(sessionHistory);
  const result = await classifyTranscript(
    transcript,
    webProviders,
    contextHint,
    normalizedSessionHistory,
    traceId,
    knowledgeSources,
    recentTurns,
  );
  const normalizedResult = result?.type === 'direct-site' || result?.type === 'provider-template'
    ? {
      ...result,
      resolutionSource: result?.resolutionSource || result?.sourceType || result?.type || 'direct-site',
      confidence: Number.isFinite(result?.confidence) ? result.confidence : (result?.type === 'provider-template' ? 1 : 0.8),
      candidates: Array.isArray(result?.candidates) ? result.candidates : (result?.url ? [{
        title: result?.titleHint || result?.url,
        url: result.url,
        score: Number.isFinite(result?.confidence) ? result.confidence : (result?.type === 'provider-template' ? 1 : 0.8),
      }] : []),
    }
    : {
      ...result,
      confidence: Number.isFinite(result?.confidence) ? result.confidence : 0,
      candidates: Array.isArray(result?.candidates) ? result.candidates : [],
    };
  const topCandidate = normalizedResult.candidates?.[0] || null;
  const secondCandidate = normalizedResult.candidates?.[1] || null;
  const confidenceMargin = Number.isFinite(normalizedResult?.confidenceMargin)
    ? Number(normalizedResult.confidenceMargin)
    : Number((((topCandidate?.score ?? normalizedResult?.confidence ?? 0) - (secondCandidate?.score ?? 0)) || 0).toFixed(3));
  const candidateCount = Array.isArray(normalizedResult.candidates) ? normalizedResult.candidates.length : 0;
  const resultWithContract = {
    ...normalizedResult,
    intentType: normalizedResult?.type || 'none',
    confidenceMargin,
    candidateCount,
    errorReason: normalizedResult?.errorReason || '',
  };
  logRuntime('browser.intent.classified', {
    traceId,
    transcript,
    type: resultWithContract?.type || 'none',
    url: resultWithContract?.url || '',
    error: resultWithContract?.error || '',
    errorReason: resultWithContract?.errorReason || '',
    resolutionSource: resultWithContract?.resolutionSource || '',
    confidence: resultWithContract?.confidence ?? 0,
    confidenceMargin: resultWithContract?.confidenceMargin ?? 0,
    candidateCount,
  });
  return resultWithContract;
}

export async function openBrowserIntent(intent) {
  const traceId = String(intent?.traceId || '');
  const startedAt = Date.now();
  const safeUrl = await assertPublicUrl(intent.url);
  activeRequestId += 1;
  const requestId = activeRequestId;
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
    if (activeBrowserSession?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.page.closed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    activeBrowserSession = null;
    scheduleBrowserShutdown();
  });
  browserSession.page.on('crash', () => {
    if (activeBrowserSession?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.page.crashed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    activeBrowserSession = null;
    scheduleBrowserShutdown();
  });
  browserSession.context.on('close', () => {
    if (activeBrowserSession?.id !== browserSession.id) {
      return;
    }
    logRuntime('browser.session.context.closed', {
      browserSessionId: browserSession.id,
      url: browserSession.url || '',
    }, 'error');
    activeBrowserSession = null;
    scheduleBrowserShutdown();
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

    logRuntime('browser.open.phase', {
      traceId,
      phase: 'session-ready',
      browserSessionId: browserSession.id,
      readerTextLength: browserSession.readerText.length,
      screenshot: Boolean(browserSession.screenshotUrl),
      requestId,
      ms: Date.now() - startedAt,
    });

    if (activeRequestId !== requestId) {
      throw new Error('Открытие было прервано более новым запросом');
    }

    await closeActivePage('open-replace');

    if (activeRequestId !== requestId) {
      throw new Error('Открытие было прервано более новым запросом');
    }

    activeBrowserSession = browserSession;
    clearBrowserIdleTimer();
    touchBrowserSession(browserSession);

    return serializeSession(browserSession);
  } catch (error) {
    if (activeBrowserSession?.id === browserSession.id) {
      activeBrowserSession = null;
    }
    await context.close().catch(() => {});
    scheduleBrowserShutdown();
    throw error;
  }
}

export async function getBrowserSessionContext(sessionId) {
  const session = requireActiveBrowserSession(String(sessionId || '').trim());
  await refreshBrowserSessionSnapshot(session, {
    includeScreenshot: false,
    readerTextLimit: SESSION_CONTEXT_TEXT_LENGTH,
    queryTextLimit: SESSION_QUERY_TEXT_LENGTH,
  });
  touchBrowserSession(session);

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
  const session = requireActiveBrowserSession(String(sessionId || '').trim());
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
  touchBrowserSession(session);

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
  const session = requireActiveBrowserSession(String(sessionId || '').trim());
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
    touchBrowserSession(session);
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

async function waitForNavigationAfterAction(page, previousUrl) {
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
  const session = requireActiveBrowserSession(String(sessionId || '').trim());
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
  touchBrowserSession(session);

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
