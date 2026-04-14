import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { logRuntime } from './runtimeLogger.js';
import { DEFAULT_APP_CONFIG_PATH } from './runtimePaths.js';

const defaultConfigPath = DEFAULT_APP_CONFIG_PATH;
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.resolve(path.dirname(defaultConfigPath), 'knowledge');
const DRAFT_PATH = path.join(KNOWLEDGE_DIR, 'draft.json');
const PUBLISHED_PATH = path.join(KNOWLEDGE_DIR, 'published.json');
const FETCH_TIMEOUT_MS = 15000;
const MAX_SOURCE_TEXT_LENGTH = 24000;
const CHUNK_TARGET_LENGTH = 900;
const CHUNK_MIN_LENGTH = 220;
const MAX_BOOTSTRAP_CHARS = 4800;
const MAX_SEARCH_HITS = 5;
const KNOWLEDGE_SCHEMA_VERSION = 1;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&laquo;|&raquo;/gi, ' ')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function extractTitle(html, fallback = '') {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeWhitespace(stripHtml(match?.[1] || '')) || normalizeWhitespace(fallback);
}

function splitIntoSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function buildSummary(text, maxSentences = 4, maxLength = 720) {
  const selected = splitIntoSentences(text).slice(0, maxSentences).join(' ');
  if (selected.length <= maxLength) {
    return selected;
  }
  return `${selected.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function extractConfirmedPrayerExcerpt(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }

  const lowerText = normalized.toLowerCase();

  if (/(богородиц|радуйся)/i.test(lowerText)) {
    const start = lowerText.search(/богородице\s+дево[,!\s]+радуйся|радуйся[,!\s]+благодатная/i);
    if (start >= 0) {
      const tail = normalized.slice(start);
      const endMatch = tail.match(/(?:ныне\s+и\s+присно(?:\s+и)?\s+во\s+веки\s+веков|аминь)[.!?]?/i);
      const snippet = endMatch
        ? tail.slice(0, Math.min(tail.length, endMatch.index + endMatch[0].length))
        : tail.slice(0, 620);
      return normalizeWhitespace(snippet);
    }
  }

  if (/(отче\s+наш)/i.test(lowerText)) {
    const start = lowerText.search(/отче\s+наш[,!\s]/i);
    if (start >= 0) {
      const tail = normalized.slice(start);
      const endMatch = tail.match(/(?:но\s+избав(?:ь|и)\s+нас\s+от\s+лукав(?:ого|аго)|аминь)[.!?]?/i);
      const snippet = endMatch
        ? tail.slice(0, Math.min(tail.length, endMatch.index + endMatch[0].length))
        : tail.slice(0, 760);
      return normalizeWhitespace(snippet);
    }
  }

  return '';
}

function chunkText(text) {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) {
    return [];
  }

  const chunks = [];
  let buffer = '';

  for (const sentence of sentences) {
    const next = normalizeWhitespace(`${buffer} ${sentence}`);
    if (next.length <= CHUNK_TARGET_LENGTH || buffer.length < CHUNK_MIN_LENGTH) {
      buffer = next;
      continue;
    }

    if (buffer.length >= CHUNK_MIN_LENGTH) {
      chunks.push(buffer);
      buffer = sentence;
      continue;
    }

    buffer = next;
  }

  if (buffer.length >= CHUNK_MIN_LENGTH) {
    chunks.push(buffer);
  }

  if (!chunks.length && buffer) {
    chunks.push(buffer);
  }

  return chunks.slice(0, 64);
}

function simplifyToken(value) {
  return normalizeWhitespace(String(value || ''))
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '');
}

const KNOWLEDGE_STOP_TOKENS = new Set([
  'это',
  'эта',
  'этот',
  'эти',
  'года',
  'году',
  'или',
  'для',
  'что',
  'как',
  'при',
  'под',
  'над',
  'без',
  'его',
  'ее',
  'её',
  'они',
  'она',
  'оно',
  'где',
  'кто',
  'про',
  'меня',
  'мне',
  'тебя',
  'тебе',
  'вас',
  'вам',
  'этого',
  'этом',
  'эту',
  'тут',
  'там',
  'здесь',
  'сейчас',
  'потом',
  'пожалуйста',
  'просто',
  'давай',
  'ладно',
  'хорошо',
  'ну',
  'да',
  'нет',
  'ок',
  'ага',
  'угу',
  'есть',
  'ли',
  'сколько',
  'какой',
  'какая',
  'какие',
  'когда',
  'почему',
]);

function tokenize(value) {
  return Array.from(new Set(
    normalizeWhitespace(String(value || ''))
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
      .map((token) => simplifyToken(token))
      .filter((token) => token.length >= 2)
      .filter((token) => !KNOWLEDGE_STOP_TOKENS.has(token))
  ));
}

function buildChunkId(sourceId, index) {
  return `${sourceId}::${index + 1}`;
}

function calcRegistryHash(sources = []) {
  const normalized = JSON.stringify((Array.isArray(sources) ? sources : []).map((source) => ({
    id: String(source.id || ''),
    canonicalUrl: String(source.canonicalUrl || ''),
    seedUrl: String(source.seedUrl || ''),
    tags: Array.isArray(source.tags) ? source.tags.map((tag) => String(tag)) : [],
    aliases: Array.isArray(source.aliases) ? source.aliases.map((alias) => String(alias)) : [],
    scope: String(source.scope || 'shared'),
  })));
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

async function ensureKnowledgeDir() {
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await ensureKnowledgeDir();
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function fetchSource(source) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const url = String(source.seedUrl || source.canonicalUrl || '').trim();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'AlesiaAI-KnowledgeFetcher/1.0',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const title = extractTitle(html, source.title);
    const cleanText = normalizeWhitespace(stripHtml(html)).slice(0, MAX_SOURCE_TEXT_LENGTH);
    if (!cleanText) {
      throw new Error('Пустой текст источника');
    }

    return {
      title,
      fetchedUrl: response.url || url,
      cleanText,
      summary: buildSummary(cleanText),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSourceDocument(source, fetched) {
  const chunks = chunkText(fetched.cleanText).map((text, index) => ({
    id: buildChunkId(source.id, index),
    sourceId: source.id,
    title: fetched.title || source.title || source.id,
    canonicalUrl: source.canonicalUrl,
    scope: source.scope || 'shared',
    tags: Array.isArray(source.tags) ? source.tags : [],
    aliases: Array.isArray(source.aliases) ? source.aliases : [],
    text,
    confirmedExcerpt: extractConfirmedPrayerExcerpt(text),
    tokens: tokenize(`${fetched.title} ${text} ${(source.tags || []).join(' ')} ${(source.aliases || []).join(' ')}`),
  }));

  return {
    sourceId: source.id,
    title: fetched.title || source.title || source.id,
    canonicalUrl: source.canonicalUrl,
    fetchedUrl: fetched.fetchedUrl,
    scope: source.scope || 'shared',
    tags: Array.isArray(source.tags) ? source.tags : [],
    aliases: Array.isArray(source.aliases) ? source.aliases : [],
    summary: fetched.summary,
    chunks,
  };
}

function sanitizeSource(source, index) {
  const safeId = String(source?.id || `source-${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');

  return {
    id: safeId || `source-${index + 1}`,
    title: normalizeWhitespace(source?.title || safeId || `Источник ${index + 1}`),
    canonicalUrl: String(source?.canonicalUrl || source?.seedUrl || '').trim(),
    seedUrl: String(source?.seedUrl || source?.canonicalUrl || '').trim(),
    scope: String(source?.scope || 'shared').trim() || 'shared',
    tags: Array.isArray(source?.tags)
      ? source.tags.map((tag) => normalizeWhitespace(tag)).filter(Boolean)
      : [],
    aliases: Array.isArray(source?.aliases)
      ? source.aliases.map((alias) => normalizeWhitespace(alias)).filter(Boolean)
      : [],
    refreshMode: String(source?.refreshMode || 'manual-publish').trim() || 'manual-publish',
    lastFetchedAt: source?.lastFetchedAt || null,
    lastPublishedAt: source?.lastPublishedAt || null,
    status: String(source?.status || 'approved').trim() || 'approved',
  };
}

function sanitizeSourceRegistry(sources = []) {
  return (Array.isArray(sources) ? sources : [])
    .map((source, index) => sanitizeSource(source, index))
    .filter((source) => source.canonicalUrl && source.seedUrl);
}

function getCharacterPriorityTags(character = null) {
  return Array.isArray(character?.knowledgePriorityTags)
    ? character.knowledgePriorityTags.map((tag) => simplifyToken(tag)).filter(Boolean)
    : [];
}

function scoreKnowledgeChunk(questionTokens, chunk, priorityTags = []) {
  if (!questionTokens.length || !chunk) {
    return 0;
  }

  const tokenSet = new Set(chunk.tokens || []);
  let score = 0;

  for (const token of questionTokens) {
    if (tokenSet.has(token)) {
      score += 2.2;
      continue;
    }

    if (token.length >= 4 && (chunk.text || '').toLowerCase().includes(token)) {
      score += 1.2;
    }
  }

  const titleTokens = tokenize(chunk.title || '');
  for (const token of questionTokens) {
    if (titleTokens.includes(token)) {
      score += 1.5;
    }
  }

  const chunkTags = Array.isArray(chunk.tags) ? chunk.tags.map((tag) => simplifyToken(tag)) : [];
  for (const tag of priorityTags) {
    if (chunkTags.includes(tag)) {
      score += 0.8;
    }
  }

  return Number(score.toFixed(3));
}

export async function getKnowledgeStatus(configSources = []) {
  const [draft, published] = await Promise.all([
    readJsonIfExists(DRAFT_PATH),
    readJsonIfExists(PUBLISHED_PATH),
  ]);
  const sources = sanitizeSourceRegistry(configSources);

  return {
    registryHash: calcRegistryHash(sources),
    sources,
    draft: draft ? {
      builtAt: draft.builtAt,
      sourceCount: draft.documents?.length || 0,
      registryHash: draft.registryHash || '',
    } : null,
    published: published ? {
      builtAt: published.builtAt,
      sourceCount: published.documents?.length || 0,
      registryHash: published.registryHash || '',
    } : null,
  };
}

export async function refreshKnowledgeDraft(configSources = []) {
  const sources = sanitizeSourceRegistry(configSources);
  const startedAt = Date.now();
  const documents = [];
  const failures = [];

  for (const source of sources) {
    try {
      const fetched = await fetchSource(source);
      documents.push(buildSourceDocument(source, fetched));
    } catch (error) {
      failures.push({
        sourceId: source.id,
        url: source.seedUrl,
        error: error.message || 'Не удалось обновить источник',
      });
    }
  }

  const draft = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    registryHash: calcRegistryHash(sources),
    documents,
    failures,
  };

  await writeJson(DRAFT_PATH, draft);
  logRuntime('knowledge.refresh', {
    sourceCount: sources.length,
    builtCount: documents.length,
    failures: failures.length,
    ms: Date.now() - startedAt,
  });
  return draft;
}

export async function publishKnowledgeDraft(configSources = []) {
  const draft = await readJsonIfExists(DRAFT_PATH);
  if (!draft) {
    throw new Error('Черновик базы знаний не найден');
  }

  const sources = sanitizeSourceRegistry(configSources);
  const nextPublished = {
    ...draft,
    publishedAt: new Date().toISOString(),
    registryHash: calcRegistryHash(sources),
  };
  await writeJson(PUBLISHED_PATH, nextPublished);
  logRuntime('knowledge.publish', {
    sourceCount: nextPublished.documents?.length || 0,
    failures: nextPublished.failures?.length || 0,
  });
  return nextPublished;
}

export async function ensureKnowledgePublished(configSources = [], { autoPublishMissing = true } = {}) {
  const sources = sanitizeSourceRegistry(configSources);
  const published = await readJsonIfExists(PUBLISHED_PATH);
  const registryHash = calcRegistryHash(sources);

  if (published?.documents?.length && published.registryHash === registryHash) {
    return published;
  }

  if (!autoPublishMissing) {
    return published;
  }

  const draft = await refreshKnowledgeDraft(sources);
  if (!draft.documents?.length) {
    return published;
  }
  return publishKnowledgeDraft(sources);
}

export async function getPublishedKnowledge() {
  const published = await readJsonIfExists(PUBLISHED_PATH);
  return published && published.schemaVersion === KNOWLEDGE_SCHEMA_VERSION ? published : null;
}

export async function searchKnowledge({ question, character = null, limit = MAX_SEARCH_HITS } = {}) {
  const published = await getPublishedKnowledge();
  const questionTokens = tokenize(question);
  if (!published?.documents?.length || !questionTokens.length) {
    return { hits: [], source: 'published' };
  }

  const priorityTags = getCharacterPriorityTags(character);
  const scored = [];

  for (const document of published.documents) {
    for (const chunk of document.chunks || []) {
      const score = scoreKnowledgeChunk(questionTokens, chunk, priorityTags);
      if (score <= 0) {
        continue;
      }
      scored.push({
        score,
        sourceId: document.sourceId,
        title: document.title,
        canonicalUrl: document.canonicalUrl,
        tags: document.tags,
        text: chunk.text,
        confirmedExcerpt: chunk.confirmedExcerpt || '',
      });
    }
  }

  const sorted = scored
    .sort((left, right) => right.score - left.score);
  const topScore = sorted[0]?.score || 0;
  const minRelevanceScore = Math.max(1.8, Number((topScore * 0.45).toFixed(3)));
  if (topScore < 1.8) {
    return { hits: [], source: 'published' };
  }

  const hits = sorted
    .filter((hit) => hit.score >= minRelevanceScore)
    .slice(0, Math.max(1, limit))
    .map((hit) => ({
      score: hit.score,
      sourceId: hit.sourceId,
      title: hit.title,
      canonicalUrl: hit.canonicalUrl,
      tags: hit.tags,
      text: hit.text,
      confirmedExcerpt: hit.confirmedExcerpt || '',
    }));

  return { hits, source: 'published' };
}

export async function buildKnowledgeBootstrapContext(character = null) {
  const published = await getPublishedKnowledge();
  if (!published?.documents?.length) {
    return '';
  }

  const priorityTags = getCharacterPriorityTags(character);
  const sortedDocuments = [...published.documents].sort((left, right) => {
    const leftPriority = (left.tags || []).some((tag) => priorityTags.includes(simplifyToken(tag))) ? 1 : 0;
    const rightPriority = (right.tags || []).some((tag) => priorityTags.includes(simplifyToken(tag))) ? 1 : 0;
    return rightPriority - leftPriority;
  });

  const parts = [];
  let totalLength = 0;
  for (const document of sortedDocuments) {
    const part = `- ${document.title} (${document.canonicalUrl}): ${document.summary}`;
    if (totalLength + part.length > MAX_BOOTSTRAP_CHARS) {
      break;
    }
    parts.push(part);
    totalLength += part.length;
  }

  return parts.join('\n');
}

export async function getKnowledgeSources(configSources = []) {
  return sanitizeSourceRegistry(configSources);
}
