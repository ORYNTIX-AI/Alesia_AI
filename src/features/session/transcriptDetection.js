import { isBrowserActionFollowupRequest } from './transcriptNetworking.js'

export const MAX_SESSION_WEB_PROMPT_ENTRIES = 5;
const SIDECAR_BOT_VOLUME_GUARD = 0.08;
export const SILENT_TURN_FALLBACK_CHUNK_MAX_CHARS = 160;
export const STOP_SPEECH_PATTERN = /(^|\s)(\u0441\u0442\u043e\u043f|\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0441\u044c|\u0437\u0430\u043c\u043e\u043b\u0447\u0438|\u0445\u0432\u0430\u0442\u0438\u0442|\u0442\u0438\u0448\u0435|\u043f\u0430\u0443\u0437\u0430|\u043d\u0435\s+\u043d\u0430\u0434\u043e|\u043e\u0442\u043c\u0435\u043d\u0430|stop)(?=\s|$)/i;
export const SERVER_STT_FRAGMENT_HOLD_MS = 900;
export const SERVER_STT_FRAGMENT_MERGE_WINDOW_MS = 2400;
export const SERVER_STT_FRAGMENT_MAX_LENGTH = 28;
export const SERVER_STT_FRAGMENT_MAX_WORDS = 4;
export const SERVER_STT_SITE_FRAGMENT_HOLD_MS = 520;
export const SERVER_STT_SHORT_FRAGMENT_HOLD_MS = 650;

export function isLikelyVoiceStopCommand(transcript, { allowFuzzy = false } = {}) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (STOP_SPEECH_PATTERN.test(normalized)) {
    return true;
  }
  if (!allowFuzzy) {
    return false;
  }
  const cleaned = normalized
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length !== 1) {
    return false;
  }
  return new Set([
    '\u043e\u043f\u044b\u0442',
    '\u0441\u0442\u043e\u043f\u0430',
    '\u0441\u0442\u043e\u043f\u044b',
    '\u0441\u0442\u043e\u043a',
    '\u0442\u043e\u043f',
  ]).has(words[0]);
}

export function normalizeTranscriptKey(transcript) {
  return String(transcript || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeSpeechText(transcript) {
  return String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncatePromptValue(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function splitLongSpeechFragment(fragment, maxLength = SILENT_TURN_FALLBACK_CHUNK_MAX_CHARS) {
  const words = normalizeSpeechText(fragment).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const parts = [];
  let current = '';

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    const combined = `${current} ${word}`;
    if (combined.length <= maxLength) {
      current = combined;
      return;
    }

    parts.push(current);
    current = word;
  });

  if (current) {
    parts.push(current);
  }

  return parts;
}

export function splitSpeechPlaybackChunks(text, maxLength = SILENT_TURN_FALLBACK_CHUNK_MAX_CHARS) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) {
    return [];
  }

  const sentenceParts = (normalized.match(/[^.!?…]+[.!?…]?/gu) || [normalized])
    .map((part) => normalizeSpeechText(part))
    .filter(Boolean);

  const chunks = [];
  let current = '';

  sentenceParts.forEach((sentence) => {
    if (sentence.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLongSpeechFragment(sentence, maxLength));
      return;
    }

    if (!current) {
      current = sentence;
      return;
    }

    const combined = `${current} ${sentence}`;
    if (combined.length <= maxLength) {
      current = combined;
      return;
    }

    chunks.push(current);
    current = sentence;
  });

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : splitLongSpeechFragment(normalized, maxLength);
}

export function sanitizeTesterEventDetails(details = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return {};
  }

  const entries = Object.entries(details).slice(0, 8).map(([key, value]) => {
    if (typeof value === 'string') {
      return [key, truncatePromptValue(value, 180)];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return [key, value];
    }
    if (value == null) {
      return [key, ''];
    }
    try {
      return [key, truncatePromptValue(JSON.stringify(value), 180)];
    } catch {
      return [key, truncatePromptValue(String(value), 180)];
    }
  });

  return Object.fromEntries(entries);
}

export function isPrayerRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(молитв|отче\s+наш|богородиц|символ\s+веры|господи\s+помилуй|прочти\s+молитву)/i.test(normalized);
}

export function extractConfirmedPrayerExcerpt(text, question = '') {
  const normalized = normalizeSpeechText(text);
  if (!normalized) {
    return '';
  }

  const lowerText = normalized.toLowerCase();
  const lowerQuestion = normalizeSpeechText(question).toLowerCase();

  if (/(богородиц|радуйся)/i.test(lowerQuestion) || /(богородиц|радуйся)/i.test(lowerText)) {
    const start = lowerText.search(/богородице\s+дево[,!\s]+радуйся|радуйся[,!\s]+благодатная/i);
    if (start >= 0) {
      const tail = normalized.slice(start);
      const endMatch = tail.match(/(?:ныне\s+и\s+присно(?:\s+и)?\s+во\s+веки\s+веков|аминь)[.!?]?/i);
      const snippet = endMatch
        ? tail.slice(0, Math.min(tail.length, endMatch.index + endMatch[0].length))
        : tail.slice(0, 620);
      return normalizeSpeechText(snippet);
    }
  }

  if (/(отче\s+наш|молитв)/i.test(lowerQuestion) || /(отче\s+наш)/i.test(lowerText)) {
    const start = lowerText.search(/отче\s+наш[,!\s]/i);
    if (start >= 0) {
      const tail = normalized.slice(start);
      const endMatch = tail.match(/(?:но\s+избав(?:ь|и)\s+нас\s+от\s+лукав(?:ого|аго)|аминь)[.!?]?/i);
      const snippet = endMatch
        ? tail.slice(0, Math.min(tail.length, endMatch.index + endMatch[0].length))
        : tail.slice(0, 760);
      return normalizeSpeechText(snippet);
    }
  }

  return '';
}

export function pickPrayerReadingHit(hits = [], question = '') {
  if (!Array.isArray(hits) || !hits.length) {
    return null;
  }

  let bestHit = null;
  let bestScore = 0;
  let bestExcerpt = '';

  for (const hit of hits) {
    const text = normalizeSpeechText(hit?.text || '');
    if (!text) {
      continue;
    }
    const excerpt = extractConfirmedPrayerExcerpt(text, question);

    let score = 0;
    if (excerpt.length >= 90) score += 9;
    if (/отче\s+наш[,!]/i.test(text)) score += 6;
    if (/богородице\s+дево[,!]\s*радуйся/i.test(text)) score += 6;
    if (/иже\s+еси\s+на\s+небес[её]х/i.test(text) || /который\s+на\s+небесах/i.test(text)) score += 4;
    if (/благодатная\s+марие/i.test(text) || /благословенна\s+ты\s+в\s+женах/i.test(text)) score += 4;
    if (Array.isArray(hit?.tags) && hit.tags.some((tag) => String(tag).toLowerCase().includes('prayer'))) score += 1;
    if (text.length >= 100) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestHit = hit;
      bestExcerpt = excerpt;
    }
  }

  if (!bestHit || bestExcerpt.length < 80) {
    return null;
  }

  return {
    hit: bestHit,
    excerpt: bestExcerpt,
  };
}

export function normalizeBrowserCommandText(transcript) {
  return normalizeSpeechText(transcript)
    .toLowerCase()
    .replace(/<[^>]{1,24}>/g, ' ')
    .replace(/(^|\s)(?:noise|шум)(?=\s|$)/giu, ' ')
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/(^|\s)(?:блядь|блять|сука|нахуй|нахер|пиздец|ебать|ёпт)(?=\s|$)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGreetingOnlyTranscript(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  const cleaned = normalized.replace(/[.,!?;:()[\]{}"']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return false;
  }

  return /^(?:(?:привет|здравствуйте|здравствуй|добрый день|доброе утро|добрый вечер|доброго дня|хай|hello|hi|hey)(?:\s+|$))+$/i
    .test(cleaned);
}

export function classifyShortHumanTurn(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return 'none';
  }

  if (isGreetingOnlyTranscript(normalized)) {
    return 'greeting';
  }

  if (/^(ага|угу|да|понятно|ясно|ладно|хорошо|спасибо|я слушаю|слушаю)$/i.test(normalized)) {
    return 'backchannel';
  }

  if (/^(?:а ты|а вы|и ты|и вы|кто ты|кто вы|как тебя зовут|как вас зовут|что ты умеешь|что вы умеете|что ты можешь|что вы можете)(?:\s|$)/i.test(normalized)) {
    return 'question';
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && /^(?:кто|что|как|где|когда|почему|зачем|а ты|а вы)(?:\s|$)/i.test(normalized)) {
    return 'question';
  }

  return 'none';
}
export function extractBrowserTarget(transcript) {
  const normalized = normalizeSpeechText(transcript);
  if (!normalized) {
    return '';
  }

  const urlMatch = normalized.match(/\bhttps?:\/\/[^\s]+/i);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }

  const domainMatch = normalized.match(/\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i);
  if (domainMatch?.[0]) {
    return domainMatch[0];
  }

  const spokenDomainMatch = normalized.match(/\b([a-z0-9-]{2,}\s+(?:by|ru))\b/i);
  if (spokenDomainMatch?.[1]) {
    return spokenDomainMatch[1];
  }

  const tailMatch = normalized.match(/(?:открой|открыть|зайди|зайти|перейди|перейти|адкрый|адкрыць|адкрыйце|зайдзи|зайдзі|зайсці|перайдзи|перайдзі|перайсци|перайсці)\s+(?:на\s+|в\s+)?(?:мне\s+)?(?:сайт|страницу|домен|адрес)?\s*(.+)$/iu);
  if (tailMatch?.[1]) {
    return normalizeSpeechText(tailMatch[1]);
  }

  const withSiteMatch = normalized.match(/(?:сайт|сайта|страницу|страница|домен|адрес)\s+(.+)$/iu);
  if (withSiteMatch?.[1]) {
    return normalizeSpeechText(withSiteMatch[1]);
  }

  return normalized;
}

export function isMainPagePhrase(value) {
  const normalized = normalizeSpeechText(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(главн(ая|ую|ой|ое)|главн(ую|ой|ое)?\s+страниц(у|а|е|ой)?|домой|домашн(яя|юю|ей|ее)\s+страниц(а|у|е|ой))/i
    .test(normalized);
}

export function extractMainPageSiteHint(value) {
  const normalized = normalizeSpeechText(value).toLowerCase();
  if (!normalized || !isMainPagePhrase(normalized)) {
    return '';
  }

  return normalizeSpeechText(
    normalized
      .replace(/[.,!?;:()[\]{}"']/g, ' ')
      .replace(/(^|\s)(?:ну|а|и|ладно|тогда|давай|слушай|смотри|прошу|пожалуйста|мне|нам|для|меня)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:перейди|перейти|перейду|перейд[её]м|зайди|зайти|открой|открыть|иди|вернись|вернуться|переход|навигац[а-яё]*)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:на|в|во|к|по|с|со)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:сайт|сайта|страниц[ауые]?|домен|адрес)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:главн(ая|ую|ой|ое)|домой|домашн(яя|юю|ей|ее)|страниц(а|у|е|ой))(?=\s|$)/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function hasExplicitMainPageSiteTarget(value) {
  const normalized = normalizeSpeechText(value).toLowerCase();
  if (!normalized || !isMainPagePhrase(normalized)) {
    return false;
  }

  const directTarget = extractBrowserTarget(normalized);
  if (/\bhttps?:\/\/[^\s]+/i.test(directTarget)) return true;
  if (/\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(directTarget)) return true;
  if (/\b[a-z0-9-]{2,}\s+(?:by|ru)\b/i.test(directTarget)) return true;

  const hint = extractMainPageSiteHint(normalized);
  if (!hint) {
    return false;
  }
  return normalizeTranscriptKey(hint).length >= 4;
}

export function isGenericNavigationTarget(target) {
  const normalized = normalizeSpeechText(target).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/^(на\s+)?(назад|вперед|впер[её]д|обнови|обновить|перезагрузи|перезагрузка)$/.test(normalized)) {
    return true;
  }

  if (!isMainPagePhrase(normalized)) {
    return false;
  }

  return !hasExplicitMainPageSiteTarget(normalized);
}

export function isSimilarIntentKey(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left.includes(right) || right.includes(left);
}

export function buildBrowserIntentKey(transcript) {
  const target = extractBrowserTarget(transcript);
  const key = normalizeTranscriptKey(target);
  if (key) return key;
  return normalizeTranscriptKey(transcript);
}

function hasKnownDirectSiteTarget(transcript) {
  const normalized = normalizeBrowserCommandText(transcript);
  if (!normalized) return false;

  return /(?:^|\s)(?:\u0430\u0437\u0431\u0443\u043a[\u0430-\u044f\u0451]*|azbyka)(?=\s|$)/iu.test(normalized);
}

export function isExplicitBrowserRequest(transcript) {
  const normalized = normalizeBrowserCommandText(transcript);
  if (!normalized) return false;

  if (/\bhttps?:\/\/[^\s]+/i.test(normalized)) return true;
  if (/\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(normalized)) return true;
  if (/\b[a-z0-9-]{2,}\s+(?:by|ru)\b/i.test(normalized)) return true;

  const padded = ` ${normalized} `;
  const hasOpenVerb = /(?:^|\s)(открой|открыть|открою|откроем|откроешь|откроете|зайди|зайти|зайду|зайдём|зайдешь|зайдете|перейди|перейти|перейду|перейдём|перейдешь|перейдете|адкрый|адкрыць|адкрыйце|зайдзи|зайдзі|зайсці|перайдзи|перайдзі|перайсци|перайсці)(?=\s|$)/iu.test(padded);
  const hasPoliteOpen = /(?:^|\s)(прошу|прашу|пожалуйста)\s+(?:[^ ]+\s+){0,4}(открой|открыть|зайди|зайти|перейди|перейти|адкрый|адкрыць|зайдзи|зайдзі|зайсці|перайдзи|перайдзі|перайсци|перайсці)(?=\s|$)/iu
    .test(padded);
  const hasLookupVerb = /(?:^|\s)(найди|найти|покажи|посмотри)(?=\s|$)/iu.test(padded);
  const hasWebNoun = /(?:^|\s)(сайт|сайта|страниц[ауые]?|старонк[ауые]?|домен|адрес|url|урл|веб|web)(?=\s|$)/iu.test(padded);
  const hasWebContext = /(?:^|\s)(в интернете|в сети|онлайн|online)(?=\s|$)/iu.test(padded);
  const hasKnownSiteTarget = hasKnownDirectSiteTarget(normalized);
  const leadingSiteTargetMatch = normalized.match(/^(?:ну|а|и|слушай|смотри|пожалуйста|прошу)?\s*(?:мне\s+)?(?:сайт|сайта|страницу|страница|домен|адрес)\s+(.+)$/iu);
  if (leadingSiteTargetMatch?.[1]) {
    const target = normalizeSpeechText(leadingSiteTargetMatch[1]);
    if (normalizeTranscriptKey(target).length >= 4 && !isGenericNavigationTarget(target)) {
      return true;
    }
  }
  const trailingSiteTargetMatch = normalized.match(/^(.+?)\s+(?:сайт|сайта|страницу|страница)$/iu);
  if (trailingSiteTargetMatch?.[1]) {
    const target = normalizeSpeechText(trailingSiteTargetMatch[1]);
    if (normalizeTranscriptKey(target).length >= 4 && !isGenericNavigationTarget(target)) {
      return true;
    }
  }

  if (hasLookupVerb && (hasWebNoun || hasWebContext)) {
    return true;
  }

  if (hasKnownSiteTarget && (hasOpenVerb || hasPoliteOpen || hasWebNoun || hasWebContext)) {
    return true;
  }

  if ((hasOpenVerb || hasPoliteOpen) && hasWebNoun) {
    return true;
  }

  if (hasOpenVerb || hasPoliteOpen) {
    const target = extractBrowserTarget(normalized);
    if (normalizeTranscriptKey(target).length >= 4 && !isGenericNavigationTarget(target)) {
      return true;
    }
  }

  return false;
}

export function isLikelyBrowserIntent(transcript) {
  return isExplicitBrowserRequest(transcript);
}

export function isBrowserMetaRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^(?:кто ты|кто вы|как тебя зовут|как вас зовут|представься|представьтесь|стоп|повтори|ответь|заверши|замолчи|тише)(?:\s|$)/i.test(normalized);
}

export function isPersonaDirectQuestion(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^(?:кто ты|кто вы|как тебя зовут|как вас зовут|представься|представьтесь|что ты умеешь|что вы умеете|что ты можешь|что вы можете|чем ты можешь помочь|чем вы можете помочь)(?:\s|$)/i
    .test(normalized);
}

export function isLikelyBrowserPageQuestion(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isLikelyBrowserIntent(normalized) || isBrowserActionFollowupRequest(normalized) || isBrowserMetaRequest(normalized)) {
    return false;
  }
  if (isBrowserContextFollowupRequest(normalized)) {
    return true;
  }
  return /^(?:кто|что|сколько|где|когда|какие|какой|какая|почему|как|есть ли|покажи|найди)(?:\s|$)/i.test(normalized);
}

export function isLikelyUnclearStandaloneTranscript(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized || STOP_SPEECH_PATTERN.test(normalized)) {
    return false;
  }
  if (isLikelyBrowserIntent(normalized) || isBrowserActionFollowupRequest(normalized)) {
    return false;
  }
  if (/[.!?]$/.test(normalized)) {
    return false;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 4) {
    return false;
  }
  return /^(ответит|ну|это|ага|угу|ясно|понятно|ладно|слушаю|я слушаю|спасибо|нет спасибо|не надо|не нужно)$/i
    .test(normalized)
    || (words.length === 1 && normalized.length <= 8);
}

export function classifyTranscriptIntent(transcript, { hasActiveBrowserSession = false } = {}) {
  if (isBrowserActionFollowupRequest(transcript)) {
    return 'browser_action';
  }
  if (isBrowserContextFollowupRequest(transcript)) {
    return 'page_query';
  }
  if (hasActiveBrowserSession && isLikelyBrowserPageQuestion(transcript)) {
    return 'page_query';
  }
  if (isLikelyBrowserIntent(transcript)) {
    return 'site_open';
  }
  return 'chat';
}

export function shouldSkipKnowledgeForTranscript(transcript, { hasActiveBrowserSession = false } = {}) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return true;
  }
  const intentType = classifyTranscriptIntent(normalized, { hasActiveBrowserSession });
  if (intentType !== 'chat') {
    return true;
  }
  if (
    isLikelyVoiceStopCommand(normalized, { allowFuzzy: true })
    || isGreetingOnlyTranscript(normalized)
    || isPersonaDirectQuestion(normalized)
    || isLikelyUnclearStandaloneTranscript(normalized)
  ) {
    return true;
  }
  if (/^(?:\u043a\u0430\u043a\s+\u0434\u0435\u043b\u0430|\u0447\u0442\u043e\s+\u0442\u044b\s+\u0443\u043c\u0435\u0435\u0448\u044c|\u0447\u0442\u043e\s+\u0432\u044b\s+\u0443\u043c\u0435\u0435\u0442\u0435|\u0447\u0435\u043c\s+\u043f\u043e\u043c\u043e\u0436\u0435\u0448\u044c|\u0441\u043f\u0430\u0441\u0438\u0431\u043e)(?:\s|$)/i.test(normalized)) {
    return true;
  }
  return false;
}

export function isLikelyIncompleteBrowserRequest(transcript) {
  const normalized = normalizeBrowserCommandText(transcript);
  if (!normalized || !isExplicitBrowserRequest(normalized)) {
    return false;
  }

  const stripped = normalizeSpeechText(
    normalized
      .replace(/(^|\s)(?:ну|а|и|ладно|тогда|давай|слушай|смотри|прошу|пожалуйста|мне|нам|для|меня)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:открой|открыть|открою|откроем|откроешь|откроете|зайди|зайти|зайду|зайдём|зайдешь|зайдете|перейди|перейти|перейду|перейдём|перейдешь|перейдете|найди|найти|покажи|посмотри|адкрый|адкрыць|адкрыйце|зайдзи|зайдзі|зайсці|перайдзи|перайдзі|перайсци|перайсці)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:официальн(?:ый|ая|ое|ую|ого|ой)|главн(?:ый|ая|ое|ую|ого|ой)|этот|эту|это|тот|ту|такой)(?=\s|$)/giu, ' ')
      .replace(/(^|\s)(?:сайт|сайта|страниц[ауые]?|старонк[ауые]?|домен|адрес|url|урл|веб|web)(?=\s|$)/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  return normalizeTranscriptKey(stripped).length < 4;
}

export function endsWithSentencePunctuation(transcript) {
  return /[.!?…]$/.test(normalizeSpeechText(transcript));
}

export function looksLikeIncompleteTranscriptFragment(transcript) {
  const normalized = normalizeSpeechText(transcript);
  if (!normalized || endsWithSentencePunctuation(normalized) || STOP_SPEECH_PATTERN.test(normalized)) {
    return false;
  }

  const intentType = classifyTranscriptIntent(normalized);
  if (intentType === 'browser_action' || intentType === 'page_query') {
    return false;
  }

  if (intentType === 'site_open') {
    return isLikelyIncompleteBrowserRequest(normalized);
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1)?.toLowerCase() || '';
  const looksLikeTrailingVerb = /(?:ешь|ете|ем|им|ют|ут|ет|ит|ать|ять|ить|еть|уть|ти|ться|чь|ай|яй|уй)$/.test(lastWord)
    || /^(?:могу|можешь|можете|хочу|хочешь|хотел|хотела|надо|нужно|нужен|нужна|буду|будешь|давай)$/i.test(lastWord);
  if (
    words.length >= 2
    && words.length <= SERVER_STT_FRAGMENT_MAX_WORDS
    && normalized.length <= SERVER_STT_FRAGMENT_MAX_LENGTH
    && looksLikeTrailingVerb
  ) {
    return true;
  }

  return /(что|чтобы|кроме|потому|если|когда|куда|как|какой|какая|какие|ты|меня|мне|тебя|нам|вам|и|а|но|или|про|о|об|по|на|в|во|для|ещё|еще|что-нибудь|чего-нибудь|какой-нибудь)$/i.test(normalized);
}

export function canMergeServerTranscriptFragments(previousTranscript, nextTranscript) {
  const previous = normalizeSpeechText(previousTranscript);
  const next = normalizeSpeechText(nextTranscript);
  if (!previous || !next) {
    return false;
  }

  if (endsWithSentencePunctuation(previous) || STOP_SPEECH_PATTERN.test(next)) {
    return false;
  }

  return looksLikeIncompleteTranscriptFragment(previous);
}

export function mergeServerTranscriptFragments(previousTranscript, nextTranscript) {
  const previous = normalizeSpeechText(previousTranscript);
  const next = normalizeSpeechText(nextTranscript);
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return normalizeSpeechText(`${previous} ${next}`);
}

export function getServerFinalHoldDelay(transcript) {
  const normalized = normalizeSpeechText(transcript);
  if (!normalized) {
    return SERVER_STT_FRAGMENT_HOLD_MS;
  }

  const intentType = classifyTranscriptIntent(normalized);
  if (intentType === 'site_open') {
    return SERVER_STT_SITE_FRAGMENT_HOLD_MS;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && normalized.length <= 18) {
    return SERVER_STT_SHORT_FRAGMENT_HOLD_MS;
  }

  return SERVER_STT_FRAGMENT_HOLD_MS;
}

export function isAssistantBrowserNarration(transcript) {
  const normalized = String(transcript || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(открыва[юе]|открою|смотрю|посмотрю|открывается|пытаюсь открыть).{0,40}(сайт|страниц|погод|новост|карт|википед)/i.test(normalized)
    || /(не удалось открыть|не удалось определить сайт|сайт не открылся)/i.test(normalized);
}

export function tokenizeSpeechForOverlap(value) {
  return normalizeSpeechText(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
    .filter((token) => token.length >= 4);
}

export function hasTranscriptOverlapWithAssistant(userTranscript, assistantTranscript) {
  const normalizedUser = normalizeSpeechText(userTranscript).toLowerCase();
  const normalizedAssistant = normalizeSpeechText(assistantTranscript).toLowerCase();
  if (!normalizedUser || !normalizedAssistant) {
    return false;
  }

  if (normalizedAssistant.includes(normalizedUser) || normalizedUser.includes(normalizedAssistant)) {
    return true;
  }

  const userTokens = tokenizeSpeechForOverlap(normalizedUser);
  const assistantTokens = new Set(tokenizeSpeechForOverlap(normalizedAssistant));
  if (!userTokens.length || !assistantTokens.size) {
    return false;
  }

  const matched = userTokens.filter((token) => assistantTokens.has(token)).length;
  return matched >= Math.min(2, userTokens.length);
}

export function isLikelyAssistantEchoFinal(transcript, assistantSample, botVolume, speechConfig) {
  const normalized = normalizeSpeechText(transcript);
  if (!normalized || STOP_SPEECH_PATTERN.test(normalized)) {
    return false;
  }

  const latestAssistantText = normalizeSpeechText(assistantSample?.text || '');
  const latestAssistantTs = Number(assistantSample?.timestamp || 0);
  if (!latestAssistantText || !latestAssistantTs) {
    return false;
  }

  if ((Date.now() - latestAssistantTs) > 15000) {
    return false;
  }

  const guard = Number(speechConfig?.botVolumeGuard || SIDECAR_BOT_VOLUME_GUARD);
  if ((Number(botVolume) || 0) <= (guard + 0.02)) {
    return false;
  }

  return hasTranscriptOverlapWithAssistant(normalized, latestAssistantText)
    || isAssistantBrowserNarration(normalized);
}

export function isBrowserContextFollowupRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (isLikelyBrowserIntent(normalized)) {
    return false;
  }

  return /(что\s+(внизу|на\s+этой\s+странице|на\s+сайте|здесь|там)|что\s+тут|что\s+видишь|о\s+ч[её]м\s+сайт|что\s+написано|что\s+сейчас\s+открыто)/i
    .test(normalized);
}

