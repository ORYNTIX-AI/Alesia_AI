import { logRuntime } from '../runtimeLogger.js';
import { MIN_RESOLUTION_STEP_TIMEOUT_MS, SITE_RESOLUTION_MIN_SCORE, SITE_RESOLUTION_TIMEOUT_MS, SITE_SEARCH_RESULT_LIMIT, SITE_SEARCH_TIMEOUT_MS, WEATHER_MEMORY, buildUrlFromTemplate, buildWikipediaArticleUrl, collectLookupStems, extractSiteLookupQuery, extractWikiQuery, getProviderHomeUrl, hasKeywordFragment, hasSiteWord, isExplicitSiteOpenRequest, isLikelyInPageNavigationRequest, isTriviallyGenericSiteQuery, normalizeWhitespace, resolveNewsUrl, shouldPreferFastDomainGuess, stripCommandWords } from './shared.js';
import { looksLikeStandaloneSiteMention, resolveSiteWithGemini } from './siteResolution.js';
import { extractUrlOrDomain, extractWeatherQuery, normalizeTranscriptForSiteLookup, parseHistoryUrl, resolveBestScoredCandidate, resolveFromKnowledgeSources, resolveFromRecentTurns, resolveFromSessionHistory, resolveKnownChurchSiteFallback, resolveSiteByDomainGuess, resolveWeatherMemoryUrl, sanitizeSessionHistory, scoreSearchCandidates, searchPublicSiteCandidates, shouldUseChurchByDefaultForContext } from './siteResolutionSupport.js';

export async function classifyTranscript(
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
