import {
  MAX_SESSION_WEB_PROMPT_ENTRIES,
  extractConfirmedPrayerExcerpt,
  isPrayerRequest,
  normalizeSpeechText,
  normalizeTranscriptKey,
  pickPrayerReadingHit,
} from './transcriptDetection.js'

export function buildEarlyBrowserLoadingTitle() {
  return 'Подбираю адрес сайта';
}

function truncatePromptValue(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildSessionHistorySummary(sessionHistory) {
  const recentEntries = Array.isArray(sessionHistory)
    ? sessionHistory.slice(-MAX_SESSION_WEB_PROMPT_ENTRIES)
    : [];

  if (!recentEntries.length) {
    return 'История веб-действий этой сессии пока пуста.';
  }

  return recentEntries
    .map((entry, index) => {
      const title = truncatePromptValue(entry.title || entry.url || entry.transcript || 'Сайт');
      const requestLabel = truncatePromptValue(entry.transcript || 'без уточнения');
      const urlLabel = truncatePromptValue(entry.url || '', 120);

      if (entry.status === 'failed') {
        const reason = truncatePromptValue(entry.note || 'ошибка открытия');
        return `${index + 1}. Не открылся: ${title}. Запрос: "${requestLabel}". Причина: ${reason}.`;
      }

      return `${index + 1}. Открыт: ${title}${urlLabel ? ` (${urlLabel})` : ''}. Запрос: "${requestLabel}".`;
    })
    .join('\n');
}

export function buildWebResultPrompt(transcript, panelState, historySummary) {
  const pageSnippet = truncatePromptValue(panelState.readerText || '', 900);
  return `WEB_CONTEXT_RESULT:
Сайт уже подтверждённо открыт.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState.title || 'Веб-страница', 140)}
URL: ${truncatePromptValue(panelState.url || 'n/a', 180)}
Краткий контекст страницы: ${pageSnippet || 'Текст страницы пока не извлечён.'}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко, естественно и только по факту этого контекста.`;
}

export function buildWebClientResultPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_CLIENT_RESULT:
Сайт открыт прямо в нижней панели у пользователя.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState.title || 'Официальный сайт', 140)}
URL: ${truncatePromptValue(panelState.url || panelState.clientUrl || 'n/a', 180)}
Статус страницы: ${panelState?.clientContextStatus === 'ready' ? 'текст страницы уже подтверждён' : 'страница уже показана, но текст ещё дочитывается'}
Важно: говори, что сайт открыт в нижней панели только по этому служебному контексту.
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и честно: подтверди открытие сайта внизу и предложи помочь короткой справкой, контактами или навигацией по подтверждённым данным.
Не говори, что ты не можешь помочь, если сайт уже открыт.`;
}

export function buildWebClientPendingPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_CLIENT_PENDING:
Сайт ещё открывается в нижней панели или текст страницы ещё не подтверждён.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState.title || 'Сайт', 140)}
URL: ${truncatePromptValue(panelState.url || panelState.clientUrl || 'n/a', 180)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и правдиво: скажи, что сайт уже открывается внизу, а текст страницы ещё дочитывается. Не говори, что страница уже разобрана полностью.
Не говори, что ты не можешь помочь: скажи, что сможешь коротко подсказать сразу после загрузки текста страницы.`;
}

export function buildWebActivePrompt(question, contextResult, historySummary) {
  const pageAnswer = truncatePromptValue(contextResult?.answer || 'Не удалось получить ответ.', 420);
  const pageSnippet = truncatePromptValue(contextResult?.contextSnippet || contextResult?.readerText || 'Текст страницы недоступен.', 700);
  return `WEB_CONTEXT_ACTIVE:
Сайт уже открыт, и вопрос относится к текущей странице.
Вопрос: "${truncatePromptValue(question, 220)}"
Источник: ${truncatePromptValue(contextResult?.title || 'Веб-страница', 140)}
URL: ${truncatePromptValue(contextResult?.url || 'n/a', 180)}
Краткий ответ по странице: ${pageAnswer}
Контекст страницы: ${pageSnippet}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и только по этому контексту.`;
}

export function buildWebFailurePrompt(transcript, errorMessage, historySummary) {
  return `WEB_CONTEXT_ERROR:
Сайт по этому запросу сейчас не подтверждён.
Запрос: "${truncatePromptValue(transcript, 220)}"
Причина: ${truncatePromptValue(errorMessage || 'неизвестная ошибка', 220)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Коротко объясни, что именно не удалось, и попроси уточнить сайт без перечисления доменных зон.`;
}

export function buildWebOpenPendingPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_OPEN_PENDING:
Сайт уже найден, и сервер начал открытие, но нижняя панель ещё не подтвердила показ страницы.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState?.title || 'Сайт', 140)}
URL: ${truncatePromptValue(panelState?.url || 'n/a', 180)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и честно: скажи, что сайт ещё открывается или панель ещё обновляется. Не говори, что страница уже показана.`;
}

export function buildWebActionPrompt(transcript, result, historySummary) {
  const pageSnippet = truncatePromptValue(result?.contextSnippet || result?.readerText || 'Текст страницы недоступен.', 700);
  return `WEB_ACTION_RESULT:
Действие на уже открытой странице подтверждённо выполнено.
Команда: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(result?.title || 'Веб-страница', 140)}
URL: ${truncatePromptValue(result?.url || 'n/a', 180)}
Контекст страницы после действия: ${pageSnippet}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и только по факту результата.`;
}

export function buildConversationSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildSessionBootstrapText(restorePayload, knowledgeContext) {
  const parts = [];
  const restore = restorePayload?.restore || null;

  if (restore?.summary) {
    parts.push(`Память разговора:\n${restore.summary}`);
  }

  if (Array.isArray(restore?.recentTurns) && restore.recentTurns.length) {
    const recentTurns = restore.recentTurns
      .slice(-6)
      .map((turn) => `${turn.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${truncatePromptValue(turn.text || '', 220)}`)
      .join('\n');
    parts.push(`Последние реплики:\n${recentTurns}`);
  }

  if (restore?.browserContext?.url) {
    parts.push(`Текущий открытый сайт:\n${restore.browserContext.title || restore.browserContext.url}\n${restore.browserContext.url}`);
  }

  if (Array.isArray(restore?.knowledgeHits) && restore.knowledgeHits.length) {
    const recentKnowledge = restore.knowledgeHits
      .slice(0, 4)
      .map((hit, index) => `${index + 1}. ${truncatePromptValue(hit.title || hit.canonicalUrl || 'Источник', 160)}${hit.canonicalUrl ? ` (${truncatePromptValue(hit.canonicalUrl, 160)})` : ''}\nФрагмент: ${truncatePromptValue(hit.text || '', 280)}`)
      .join('\n\n');
    parts.push(`Последние подтверждённые знания из этой сессии:\n${recentKnowledge}`);
  }

  if (knowledgeContext) {
    parts.push(`Утверждённая база знаний:\n${knowledgeContext}`);
  }

  return parts.join('\n\n');
}

export function buildRecentTurnsPromptBlock(recentTurns = [], currentQuestion = '', compactMode = false) {
  const currentQuestionKey = normalizeTranscriptKey(currentQuestion);
  const recentLines = (Array.isArray(recentTurns) ? recentTurns : [])
    .slice(compactMode ? -3 : -6)
    .filter((turn) => normalizeSpeechText(turn?.text || ''))
    .filter((turn, index, turns) => !(
      index === turns.length - 1
      && turn?.role === 'user'
      && normalizeTranscriptKey(turn?.text || '') === currentQuestionKey
    ))
    .map((turn) => `${turn?.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${truncatePromptValue(turn?.text || '', compactMode ? 120 : 180)}`);

  if (!recentLines.length) {
    return compactMode ? 'Недавние реплики: пусто.' : 'Недавних реплик перед этим вопросом нет.';
  }

  return compactMode
    ? `Недавние реплики:\n${recentLines.join('\n')}`
    : `Краткая память последних реплик:\n${recentLines.join('\n')}`;
}

const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3']);

export function buildRuntimeTurnPrompt(
  question,
  {
    knowledgeHits = [],
    activePageContext = null,
    prayerReadMode = '',
    characterId = '',
    compactMode = false,
    recentTurns = [],
  } = {},
) {
  const normalizedQuestion = truncatePromptValue(question, 320);
  const hits = Array.isArray(knowledgeHits) ? knowledgeHits.slice(0, compactMode ? 1 : 3) : [];
  const defaultPrayerMode = BATYUSHKA_CHARACTER_IDS.has(String(characterId || '').trim())
    ? 'hybrid'
    : 'knowledge-only';
  const prayerMode = String(prayerReadMode || defaultPrayerMode).trim().toLowerCase();
  const prayerRequested = isPrayerRequest(normalizedQuestion);
  const prayerReading = prayerRequested && prayerMode === 'knowledge-only'
    ? pickPrayerReadingHit(hits, normalizedQuestion)
    : null;
  const prayerReadingHit = prayerReading?.hit || null;
  const prayerReadingExcerpt = prayerReading?.excerpt || '';
  const orderedHits = prayerReadingHit
    ? [prayerReadingHit, ...hits.filter((hit) => hit !== prayerReadingHit)]
    : hits;
  const pageTitle = truncatePromptValue(activePageContext?.title || activePageContext?.url || 'Открытый сайт', 160);
  const pageUrl = activePageContext?.url ? truncatePromptValue(activePageContext.url, 160) : '';
  const pageContextSnippet = truncatePromptValue(
    activePageContext?.contextSnippet || activePageContext?.readerText || '',
    compactMode ? 140 : 320,
  );
  const recentTurnsBlock = buildRecentTurnsPromptBlock(recentTurns, normalizedQuestion, compactMode);
  const pageBlock = pageContextSnippet
    ? (
      compactMode
        ? `Открытая страница: ${pageTitle}${pageUrl ? ` (${pageUrl})` : ''}\nФрагмент: ${pageContextSnippet}`
        : `Контекст текущего открытого сайта:
${pageTitle}${pageUrl ? ` (${pageUrl})` : ''}
Фрагмент страницы: ${pageContextSnippet}`
    )
    : (compactMode ? 'Открытая страница не добавлена.' : 'Контекст текущего открытого сайта сейчас не добавлен.');
  const prayerRuleBlock = prayerMode === 'knowledge-only'
    ? `Спец-режим молитв:
1. Если пользователь просит прочитать молитву, используй только подтверждённые фрагменты из утверждённой базы знаний или открытой страницы.
2. Если подтверждённого текста нет, честно скажи, что для точного чтения нужен источник, и предложи открыть страницу с текстом.`
    : prayerMode === 'hybrid'
      ? `Спец-режим молитв:
1. Сначала опирайся на подтверждённые фрагменты из утверждённой базы знаний или открытой страницы.
2. Если подтверждённого текста недостаточно, предупреждай об этом явно.`
      : '';

  if (!hits.length) {
    if (compactMode) {
      return `Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}
${recentTurnsBlock}

Подтверждённых знаний по этому вопросу сейчас нет.
Ответь коротко и по делу, без лишних фраз.`;
    }

    return `RUNTIME_USER_TURN:
Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}
${recentTurnsBlock}

Утверждённых знаний по этому вопросу сейчас нет.

Правила ответа:
1. Если текущая открытая страница явно помогает, используй её.
2. Если подтверждённых данных не хватает, скажи это прямо.
3. Не обещай действие браузера без служебного подтверждения.
4. ${prayerRequested && prayerMode === 'knowledge-only'
    ? 'На запрос о молитве не выдумывай текст: коротко попроси источник или предложи открыть страницу с молитвой.'
    : 'Ответь коротко, естественно и по делу.'}
${prayerRuleBlock ? `\n\n${prayerRuleBlock}` : ''}`;
  }

  const knowledgeBlock = orderedHits
    .map((hit, index) => `${index + 1}. ${truncatePromptValue(hit.title || hit.canonicalUrl || 'Источник', 120)}${hit.canonicalUrl ? ` (${truncatePromptValue(hit.canonicalUrl, 120)})` : ''}\nФрагмент: ${truncatePromptValue(hit.confirmedExcerpt || hit.text || '', compactMode ? 120 : 260)}`)
    .join('\n\n');
  const prayerReadingBlock = prayerReadingExcerpt
    ? `Подтверждённый фрагмент для чтения молитвы:
${truncatePromptValue(prayerReadingExcerpt, compactMode ? 520 : 900)}`
    : '';

  if (compactMode) {
    return `Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}
${recentTurnsBlock}

Подтверждённые знания:
${knowledgeBlock}
${prayerReadingBlock ? `\n\n${prayerReadingBlock}` : ''}

Ответь коротко, естественно и сразу по сути.
Не выдумывай факты и не обещай действие браузера без подтверждения.
${prayerRequested && prayerMode === 'knowledge-only'
    ? (
      prayerReadingHit
        ? 'Если просят молитву, прочитай только подтверждённый фрагмент полностью, без добавлений от себя.'
        : 'Если просят молитву, используй только подтверждённые фрагменты и не достраивай текст по памяти.'
    )
    : 'Не повторяй вопрос пользователя.'}`;
  }

  return `RUNTIME_USER_TURN:
Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}
${recentTurnsBlock}

Утверждённые знания по этому вопросу:
${knowledgeBlock}
${prayerReadingBlock ? `\n\n${prayerReadingBlock}` : ''}

Правила ответа:
1. Сначала используй контекст открытого сайта, если он явно подходит.
2. Затем используй только утверждённые знания ниже.
3. Не придумывай новые факты.
4. Не обещай действие браузера без служебного подтверждения.
5. ${prayerRequested && prayerMode === 'knowledge-only'
    ? (
      prayerReadingHit
        ? 'В подтверждённых знаниях уже есть подходящий фрагмент молитвы: прочитай именно этот фрагмент полностью, спокойно, без отказа и без добавления текста от себя.'
        : 'Если это чтение молитвы, используй только приведённые подтверждённые фрагменты без добавлений от себя.'
    )
    : 'Ответь кратко, естественно и по делу.'}
${prayerRuleBlock ? `\n\n${prayerRuleBlock}` : ''}`;
}

export function resolveExactPrayerReading(question, {
  knowledgeHits = [],
  activePageContext = null,
} = {}) {
  const normalizedQuestion = normalizeSpeechText(question);
  if (!isPrayerRequest(normalizedQuestion)) {
    return null;
  }

  const reading = pickPrayerReadingHit(knowledgeHits, normalizedQuestion);
  if (reading?.excerpt) {
    return {
      sourceTitle: reading.hit?.title || reading.hit?.canonicalUrl || 'Подтверждённый источник',
      sourceUrl: reading.hit?.canonicalUrl || '',
      excerpt: reading.excerpt,
      sourceKind: 'knowledge',
    };
  }

  const pageExcerpt = extractConfirmedPrayerExcerpt(
    activePageContext?.readerText || activePageContext?.contextSnippet || '',
    normalizedQuestion,
  );
  if (pageExcerpt.length >= 80) {
    return {
      sourceTitle: activePageContext?.title || activePageContext?.url || 'Открытая страница',
      sourceUrl: activePageContext?.url || '',
      excerpt: pageExcerpt,
      sourceKind: 'page',
    };
  }

  return null;
}

export function buildExactPrayerReadingPrompt(question, reading) {
  return `RUNTIME_EXACT_READING:
Пользователь попросил молитву: "${truncatePromptValue(question, 220)}"
Разрешено только точное чтение подтверждённого текста.
Источник: ${truncatePromptValue(reading?.sourceTitle || 'Подтверждённый источник', 180)}${reading?.sourceUrl ? ` (${truncatePromptValue(reading.sourceUrl, 180)})` : ''}

Прочитай сейчас только этот текст, полностью и без добавлений от себя:
${truncatePromptValue(reading?.excerpt || '', 1200)}

Правила:
1. Не пересказывай и не сокращай текст.
2. Не добавляй вступление, если пользователь не просил.
3. Не вставляй комментарии и пояснения между строками.
4. Не отказывайся, потому что источник уже подтверждён.`;
}

export function buildPrayerSourceRequiredPrompt(question, {
  knowledgeHits = [],
  activePageContext = null,
} = {}) {
  const topHit = Array.isArray(knowledgeHits) ? knowledgeHits[0] : null;
  const sourceTitle = topHit?.title || activePageContext?.title || 'утверждённый источник';
  const sourceUrl = topHit?.canonicalUrl || activePageContext?.url || '';
  return `RUNTIME_PRAYER_SOURCE_REQUIRED:
Пользователь попросил молитву: "${truncatePromptValue(question, 220)}"
Точного подтверждённого текста для чтения сейчас нет.
${sourceUrl ? `Есть ближайший источник: ${truncatePromptValue(sourceTitle, 180)} (${truncatePromptValue(sourceUrl, 180)}).` : 'Под рукой нет открытого подтверждённого источника.'}

Ответь коротко и честно:
1. скажи, что для точного чтения нужен подтверждённый источник;
2. предложи открыть страницу с текстом молитвы;
3. не выдумывай текст по памяти.`;
}

export function buildGreetingAckPrompt(greetingText) {
  return `RUNTIME_GREETING_ACK:
Ассистент уже поздоровался в этой сессии.
Пользователь в ответ просто поздоровался: "${truncatePromptValue(greetingText, 120)}"

Не здоровайся заново, не представляйся и не повторяй приветствие.
Не вызывай никакие tools, не открывай сайты и не делай browser actions.
Ответь одной короткой естественной фразой, без дежурной справочной формулы.`;
}

export function buildPersonaDirectPrompt(transcript) {
  return `RUNTIME_PERSONA_DIRECT_ANSWER:
Пользователь спросил о тебе напрямую: "${truncatePromptValue(transcript, 180)}"

Ответь по роли кратко и по существу.
Не переводи ответ в пустую справочную формулу.
Не вызывай tools и не запускай browser actions.
В конце можно добавить одну живую фразу о том, чем полезен прямо сейчас.`;
}

export function buildBrowserOpeningAckPrompt(transcript) {
  return `RUNTIME_BROWSER_OPENING_ACK:
Пользователь попросил открыть сайт: "${truncatePromptValue(transcript, 180)}"

Не вызывай tools, не уточняй и не повторяй запрос.
Скажи одну короткую фразу ровно о том, что сайт уже открывается.`;
}

export function buildRepeatRequestPrompt(transcript) {
  return `RUNTIME_REPEAT_REQUEST:
Пользователь сказал слишком короткую или неясную реплику: "${truncatePromptValue(transcript, 120)}"

Ответь одной короткой фразой по-русски: попроси повторить или уточнить.`;
}
