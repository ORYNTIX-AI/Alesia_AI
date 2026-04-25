import { DEFAULT_TIMEOUT_MS, DIRECT_URL_REGEX, DOMAIN_REGEX, GEMINI_REQUEST_TIMEOUT_MS, MIN_RESOLUTION_STEP_TIMEOUT_MS, PAGE_SETTLE_MS, SITE_RESOLUTION_MIN_SCORE, SITE_RESOLUTION_TIMEOUT_MS, SITE_SEARCH_RESULT_LIMIT, SITE_SEARCH_TIMEOUT_MS, WEATHER_RESULT_URL_PATTERN, WEATHER_MEMORY, buildDomainGuessStems, buildUrlFromTemplate, collectLookupStems, computeStemSimilarity, extractCandidateStems, extractSiteLookupQuery, geminiAgent, getProviderHomeUrl, normalizeCommandTranscript, normalizeQueryValue, normalizeWhitespace, requestText, resolveNewsUrl, scoreResolvedCandidate, simplifyLookup, stripCommandWords, transliterateToLatin } from './shared.js';
import { assertPublicUrl } from './browserRuntime.js';

export async function resolveSiteByDomainGuess(siteQuery) {
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

export function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function extractDuckDuckGoCandidates(html) {
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

export function buildSiteSearchQuery(siteQuery) {
  return `${normalizeWhitespace(siteQuery)} site:by OR site:ru`;
}

export async function searchPublicSiteCandidates(siteQuery, {
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

export function scoreSearchCandidates(siteQuery, transcript, candidates = []) {
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

export function resolveBestScoredCandidate(scoredCandidates = []) {
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

export function sanitizeSessionHistory(sessionHistory) {
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

export function buildSessionHistoryPromptBlock(sessionHistory) {
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

export function parseHistoryUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function resolveFromSessionHistory(transcript, sessionHistory) {
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

export function resolveWeatherMemoryUrl(query) {
  const queryStem = simplifyLookup(query);
  const matched = WEATHER_MEMORY.find((entry) => entry.aliases.some((alias) => simplifyLookup(alias) === queryStem));
  return matched?.url || null;
}

export function extractKnowledgeSourceTokens(source) {
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

export function scoreKnowledgeSourceMatch(siteQuery, transcript, source) {
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

export function resolveFromKnowledgeSources(siteQuery, transcript, knowledgeSources = []) {
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

export function sanitizeRecentTurnsForResolver(recentTurns = []) {
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

export function extractStrongSourceStems(source) {
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

export function resolveMentionedKnowledgeSourceFromTurns(recentTurns = [], knowledgeSources = []) {
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

export function resolveFromRecentTurns(transcript, siteQuery, recentTurns = [], knowledgeSources = []) {
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

export function buildKnowledgeSourceHint(siteQuery, transcript, knowledgeSources = []) {
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

export function normalizeTranscriptForSiteLookup(transcript, knowledgeSources = [], sessionHistory = []) {
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

export function extractWeatherQuery(transcript) {
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

export function normalizeSpokenDomainLabel(label) {
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

export function extractSpokenDomain(transcript) {
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

export function resolveKnownChurchSiteFallback(transcript) {
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

export function shouldUseChurchByDefaultForContext(contextHint = '') {
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


export function extractUrlOrDomain(transcript) {
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
