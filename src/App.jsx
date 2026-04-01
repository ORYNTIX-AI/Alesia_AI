import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls, useProgress } from '@react-three/drei';
import { Avatar, DEFAULT_AVATAR_MODEL_URL } from './components/Avatar';
import { BrowserPanel } from './components/BrowserPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { useAppConfig } from './hooks/useAppConfig';
import { useGeminiLive } from './hooks/useGeminiLive';
import { useYandexVoiceSession } from './hooks/useYandexVoiceSession';
import { useServerStt } from './hooks/useServerStt';
import { AudioStreamPlayer } from './utils/AudioStreamPlayer';

const DEFAULT_PANEL_STATE = {
  status: 'idle',
  browserPanelMode: 'remote',
  sourceType: null,
  title: '',
  url: '',
  clientUrl: '',
  clientHomeUrl: '',
  clientHistory: [],
  clientHistoryIndex: -1,
  clientReloadKey: 0,
  clientFrameLoaded: false,
  clientContextStatus: 'idle',
  clientContextError: '',
  clientFallback: false,
  clientExternalOpened: false,
  note: '',
  embeddable: false,
  readerText: '',
  screenshotUrl: null,
  revision: 0,
  actionableElements: [],
  view: null,
  error: null,
};

const MAX_SESSION_WEB_HISTORY_ENTRIES = 8;
const MAX_SESSION_WEB_PROMPT_ENTRIES = 5;
const SIDECAR_BOT_VOLUME_GUARD = 0.08;
const BROWSER_INTENT_TIMEOUT_MS = 9000;
const BROWSER_INTENT_PENDING_SLA_MS = 8500;
const BROWSER_OPEN_TIMEOUT_MS = 75000;
const BROWSER_CONTEXT_TIMEOUT_MS = 5000;
const BROWSER_ACTION_TIMEOUT_MS = 12000;
const BROWSER_VIEW_POLL_MS = 2500;
const AUTO_RECONNECT_BASE_DELAY_MS = 1200;
const AUTO_RECONNECT_MAX_DELAY_MS = 10000;
const AUTO_RECONNECT_MAX_ATTEMPTS = 8;
const GOAWAY_RECONNECT_MIN_DELAY_MS = 250;
const GOAWAY_RECONNECT_FALLBACK_DELAY_MS = 1500;
const GOAWAY_RECONNECT_BUFFER_MS = 1500;
const CONNECTING_WATCHDOG_TIMEOUT_MS = 20000;
const RELOAD_WATCHDOG_TIMEOUT_MS = 12000;
const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3']);
const GEMINI_31_FLASH_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const AVATAR_QUICK_TAP_COUNT = 4;
const AVATAR_QUICK_TAP_WINDOW_MS = 900;
const BROWSER_INTENT_RETRY_LIMIT = 1;
const BROWSER_INTENT_RETRY_BACKOFF_MS = 180;
const ASSISTANT_QUEUE_TURN_TIMEOUT_MS = 14000;
const ASSISTANT_QUEUE_MAX_HARD_TIMEOUT_MS = 38000;
const MAX_RECENT_INTENT_TURNS = 10;
const BARGE_IN_MIN_GAP_MS = 1200;
const ASSISTANT_BARGE_IN_WARMUP_MS = 320;
const STOP_SPEECH_PATTERN = /(^|\s)(стоп|остановись|замолчи|хватит|тише|пауза|stop)(?=\s|$)/i;
const USER_FINAL_DEDUP_WINDOW_MS = 4200;
const SERVER_STT_FRAGMENT_HOLD_MS = 900;
const SERVER_STT_FRAGMENT_MERGE_WINDOW_MS = 2400;
const SERVER_STT_FRAGMENT_MAX_LENGTH = 28;
const SERVER_STT_FRAGMENT_MAX_WORDS = 4;
const SERVER_STT_SITE_FRAGMENT_HOLD_MS = 520;
const SERVER_STT_SHORT_FRAGMENT_HOLD_MS = 650;
const LIVE_INPUT_COMMIT_EXTRA_MS = 120;
const CLIENT_INLINE_LOAD_TIMEOUT_MS = 12000;

const BACKGROUND_PRESETS = {
  aurora: {
    stage: 'radial-gradient(circle at 20% 18%, rgba(247, 255, 254, 0.16) 0%, transparent 22%), radial-gradient(circle at 78% 22%, rgba(190, 255, 250, 0.14) 0%, transparent 28%), linear-gradient(160deg, #88d3df 0%, #5ba7ba 46%, #1f4f66 100%)',
    canvasBackground: '#6aa7b8',
    shadow: 'rgba(34, 112, 127, 0.28)',
    border: 'rgba(209, 251, 248, 0.42)',
  },
  sunset: {
    stage: 'radial-gradient(circle at 18% 15%, rgba(255, 244, 226, 0.16) 0%, transparent 22%), radial-gradient(circle at 76% 24%, rgba(255, 186, 164, 0.18) 0%, transparent 28%), linear-gradient(160deg, #ffbb77 0%, #ff7d78 48%, #7f467d 100%)',
    canvasBackground: '#d9877d',
    shadow: 'rgba(147, 68, 78, 0.28)',
    border: 'rgba(255, 227, 198, 0.42)',
  },
  midnight: {
    stage: 'radial-gradient(circle at 22% 18%, rgba(128, 222, 255, 0.12) 0%, transparent 18%), radial-gradient(circle at 80% 24%, rgba(135, 129, 255, 0.12) 0%, transparent 22%), linear-gradient(165deg, #15224b 0%, #091327 58%, #020814 100%)',
    canvasBackground: '#16254e',
    shadow: 'rgba(6, 15, 36, 0.42)',
    border: 'rgba(96, 150, 255, 0.24)',
  },
  forest: {
    stage: 'radial-gradient(circle at 20% 18%, rgba(233, 255, 241, 0.12) 0%, transparent 18%), radial-gradient(circle at 76% 24%, rgba(172, 233, 194, 0.12) 0%, transparent 25%), linear-gradient(160deg, #8ac77b 0%, #378a69 44%, #173728 100%)',
    canvasBackground: '#3a7259',
    shadow: 'rgba(29, 74, 52, 0.3)',
    border: 'rgba(219, 255, 228, 0.38)',
  },
  church: {
    stage: 'linear-gradient(180deg, rgba(248, 249, 250, 0.68) 0%, rgba(235, 236, 238, 0.72) 100%), url("/backgrounds/church-real.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(78, 84, 95, 0.18)',
    border: 'rgba(216, 220, 226, 0.92)',
  },
  hotel: {
    stage: 'linear-gradient(180deg, rgba(246, 247, 249, 0.62) 0%, rgba(230, 233, 238, 0.66) 100%), url("/backgrounds/hotel.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(66, 74, 87, 0.2)',
    border: 'rgba(219, 225, 233, 0.9)',
  },
  beach: {
    stage: 'linear-gradient(180deg, rgba(240, 248, 251, 0.45) 0%, rgba(217, 239, 247, 0.55) 100%), url("/backgrounds/beach.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(52, 97, 122, 0.22)',
    border: 'rgba(205, 235, 247, 0.88)',
  },
  white: {
    stage: 'linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%)',
    canvasBackground: '#ffffff',
    shadow: 'rgba(0, 0, 0, 0.1)',
    border: 'rgba(227, 227, 227, 0.9)',
  },
};

function isGemini31FlashLiveModel(modelId) {
  return String(modelId || '').trim() === GEMINI_31_FLASH_LIVE_MODEL;
}

class CanvasErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Html center>
          <div className="avatar-stage__error">
            <strong>Ошибка 3D-аватара</strong>
            <span>{this.state.error?.message}</span>
          </div>
        </Html>
      );
    }

    return this.props.children;
  }
}

function Loader() {
  const { progress } = useProgress();
  return <Html center><div className="loader-overlay">{progress.toFixed(0)}%</div></Html>;
}

function ThemeIcon({ dark }) {
  return dark ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a8.94 8.94 0 0 0 0 18 9 9 0 0 0 8.7-6.75A9.5 9.5 0 0 1 12.75 4.3 9.1 9.1 0 0 1 12 3Z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.76 4.84 5.34 3.42 3.93 4.84l1.41 1.41 1.42-1.41Zm10.49 0 1.41-1.42 1.42 1.42-1.42 1.41-1.41-1.41ZM12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm7 6h3v2h-3v-2ZM2 11h3v2H2v-2Zm15.25 7.16 1.41 1.41 1.42-1.41-1.42-1.41-1.41 1.41ZM5.34 17.75l-1.41 1.41 1.41 1.42 1.42-1.42-1.42-1.41ZM11 19h2v3h-2v-3Zm0-17h2v3h-2V2Z" fill="currentColor" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.52 7.52 0 0 0-1.63-.94L14.4 2.8a.48.48 0 0 0-.49-.4h-3.84a.48.48 0 0 0-.49.4L9.2 5.33a7.52 7.52 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.85a.5.5 0 0 0 .12.63L4.8 11.06l-.04.94.04.94-2.02 1.58a.5.5 0 0 0-.12.63l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.7 1.63.94l.38 2.53a.48.48 0 0 0 .49.4h3.84a.48.48 0 0 0 .49-.4l.38-2.53c.58-.24 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" fill="currentColor" />
    </svg>
  );
}

function FullscreenIcon({ active }) {
  return active ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14H5v5h5v-2H7v-3h2v-2Zm10 0h-4v2h2v3h-3v2h5v-5Zm-9-9H5v5h2V7h3V5Zm9 0h-5v2h3v3h2V5Z" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 14H5v5h5v-2H7v-3Zm12 5v-5h-2v3h-3v2h5ZM7 7h3V5H5v5h2V7Zm10 3h2V5h-5v2h3v3Z" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon({ direction }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={direction === 'left' ? 'm14.41 7.41-1.41-1.41L7 12l6 6 1.41-1.41L9.83 12z' : 'm9.59 16.59 1.41 1.41L17 12 11 6 9.59 7.41 14.17 12z'}
        fill="currentColor"
      />
    </svg>
  );
}

function IconButton({ label, onClick, children, active = false }) {
  return (
    <button className={`icon-button ${active ? 'is-active' : ''}`} type="button" onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

function parseTimeLeftMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1000 ? value : value * 1000;
  }

  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 1000 ? numeric : numeric * 1000;
  }

  const numeric = Number.parseFloat(text.replace(',', '.'));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (text.endsWith('ms')) {
    return numeric;
  }
  if (text.endsWith('m') || text.includes('min')) {
    return numeric * 60000;
  }
  if (text.endsWith('s') || text.includes('sec')) {
    return numeric * 1000;
  }
  return numeric > 1000 ? numeric : numeric * 1000;
}

function CharacterArrow({ direction, onClick }) {
  return (
    <button className={`character-arrow character-arrow--${direction}`} type="button" onClick={onClick} aria-label={direction === 'left' ? 'Предыдущий персонаж' : 'Следующий персонаж'}>
      <ArrowIcon direction={direction} />
    </button>
  );
}

function LiveStatusPill({ status, audioPlayer, getUserVolume, sidecarListening, isRecovering = false }) {
  const [volumes, setVolumes] = useState({ user: 0, bot: 0 });

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const nextUser = getUserVolume ? getUserVolume() : 0;
      const nextBot = audioPlayer?.getVolume ? audioPlayer.getVolume() : 0;
      setVolumes({ user: nextUser, bot: nextBot });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [audioPlayer, getUserVolume]);

  const effectiveStatus = isRecovering && status === 'disconnected' ? 'connecting' : status;
  const isConnected = effectiveStatus === 'connected';
  const label = isConnected
    ? (sidecarListening ? 'Слушаю...' : 'Онлайн')
    : effectiveStatus === 'connecting'
      ? (isRecovering ? 'Восстановление...' : 'Подключение...')
      : effectiveStatus === 'error'
        ? 'Ошибка'
        : 'Отключено';

  return (
    <div className={`live-pill live-pill--${effectiveStatus}`}>
      <span className="live-pill__dot" />
      <span className="live-pill__label">{label}</span>
      <span className="live-pill__meters">
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.user * 2.4)})` }} />
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.bot * 2.4)})` }} />
      </span>
    </div>
  );
}

function buildSignature(character, globalRuntimeConfig = {}) {
  if (!character) return '';
  return [
    String(character.runtimeProvider || 'gemini-live').trim(),
    String(character.modelId || character.voiceModelId || '').trim(),
    character.voiceModelId,
    character.voiceName,
    character.systemPrompt,
    character.greetingText,
    character.liveInputEnabled ? 'live-input-on' : 'live-input-off',
    String(character.voiceGatewayUrl || '').trim(),
    isClientInlinePanelMode(character.browserPanelMode) ? 'client-inline' : 'remote',
    String(character.pageContextMode || 'browser-session').trim(),
    normalizeSpeechStabilityProfile(globalRuntimeConfig.speechStabilityProfile),
    String(globalRuntimeConfig.prayerReadMode || 'knowledge-only').trim().toLowerCase(),
    globalRuntimeConfig.safeSpeechFlowEnabled === false ? 'safe-off' : 'safe-on',
  ].join('|');
}

function normalizeSpeechStabilityProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'presentation' || normalized === 'strict') {
    return normalized;
  }
  return 'balanced';
}

function isClientInlinePanelMode(value) {
  return String(value || '').trim() === 'client-inline';
}

function resolveSpeechStabilityConfig(profile, safeSpeechFlowEnabled) {
  const normalizedProfile = normalizeSpeechStabilityProfile(profile);
  if (!safeSpeechFlowEnabled || normalizedProfile === 'legacy') {
    return {
      profile: 'legacy',
      bargeInHoldMs: 0,
      minTranscriptLength: 1,
      botVolumeGuard: SIDECAR_BOT_VOLUME_GUARD,
      immediateOnSpeechStart: true,
    };
  }

  if (normalizedProfile === 'strict') {
    return {
      profile: 'strict',
      bargeInHoldMs: 320,
      minTranscriptLength: 6,
      botVolumeGuard: 0.09,
      immediateOnSpeechStart: true,
    };
  }

  if (normalizedProfile === 'presentation') {
    return {
      profile: 'presentation',
      bargeInHoldMs: 260,
      minTranscriptLength: 5,
      botVolumeGuard: 0.085,
      immediateOnSpeechStart: true,
    };
  }

  return {
    profile: 'balanced',
    bargeInHoldMs: 180,
    minTranscriptLength: 4,
    botVolumeGuard: SIDECAR_BOT_VOLUME_GUARD,
    immediateOnSpeechStart: true,
  };
}

function normalizeTranscriptKey(transcript) {
  return String(transcript || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeSpeechText(transcript) {
  return String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPrayerRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(молитв|отче\s+наш|богородиц|символ\s+веры|господи\s+помилуй|прочти\s+молитву)/i.test(normalized);
}

function extractConfirmedPrayerExcerpt(text, question = '') {
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

function pickPrayerReadingHit(hits = [], question = '') {
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

function normalizeBrowserCommandText(transcript) {
  return normalizeSpeechText(transcript)
    .toLowerCase()
    .replace(/<[^>]{1,24}>/g, ' ')
    .replace(/(^|\s)(?:noise|шум)(?=\s|$)/giu, ' ')
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/(^|\s)(?:блядь|блять|сука|нахуй|нахер|пиздец|ебать|ёпт)(?=\s|$)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingOnlyTranscript(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return false;
  }

  const cleaned = normalized.replace(/[.,!?;:()[\]{}"']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return false;
  }

  return /^(привет|здравствуйте|здравствуй|добрый день|доброе утро|добрый вечер|доброго дня|хай|hello|hi|hey)$/.test(cleaned);
}

function extractBrowserTarget(transcript) {
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

  const tailMatch = normalized.match(/(?:открой|открыть|зайди|зайти|перейди|перейти|адкрый|адкрыць|адкрыйце|зайдзи|зайдзі|зайсці|перайдзи|перайдзі|перайсци|перайсці)\s+(?:мне\s+)?(?:сайт|страницу|домен|адрес)?\s*(.+)$/iu);
  if (tailMatch?.[1]) {
    return normalizeSpeechText(tailMatch[1]);
  }

  const withSiteMatch = normalized.match(/(?:сайт|сайта|страницу|страница|домен|адрес)\s+(.+)$/iu);
  if (withSiteMatch?.[1]) {
    return normalizeSpeechText(withSiteMatch[1]);
  }

  return normalized;
}

function isMainPagePhrase(value) {
  const normalized = normalizeSpeechText(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(главн(ая|ую|ой|ое)|главн(ую|ой|ое)?\s+страниц(у|а|е|ой)?|домой|домашн(яя|юю|ей|ее)\s+страниц(а|у|е|ой))/i
    .test(normalized);
}

function extractMainPageSiteHint(value) {
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

function hasExplicitMainPageSiteTarget(value) {
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

function isGenericNavigationTarget(target) {
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

function isSimilarIntentKey(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left.includes(right) || right.includes(left);
}

function buildBrowserIntentKey(transcript) {
  const target = extractBrowserTarget(transcript);
  const key = normalizeTranscriptKey(target);
  if (key) return key;
  return normalizeTranscriptKey(transcript);
}

function isExplicitBrowserRequest(transcript) {
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

function isLikelyBrowserIntent(transcript) {
  return isExplicitBrowserRequest(transcript);
}

function classifyTranscriptIntent(transcript) {
  if (isBrowserActionFollowupRequest(transcript)) {
    return 'browser_action';
  }
  if (isBrowserContextFollowupRequest(transcript)) {
    return 'page_query';
  }
  if (isLikelyBrowserIntent(transcript)) {
    return 'site_open';
  }
  return 'chat';
}

function isLikelyIncompleteBrowserRequest(transcript) {
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

function endsWithSentencePunctuation(transcript) {
  return /[.!?…]$/.test(normalizeSpeechText(transcript));
}

function looksLikeIncompleteTranscriptFragment(transcript) {
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

function canMergeServerTranscriptFragments(previousTranscript, nextTranscript) {
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

function mergeServerTranscriptFragments(previousTranscript, nextTranscript) {
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

function getServerFinalHoldDelay(transcript) {
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

function isAssistantBrowserNarration(transcript) {
  const normalized = String(transcript || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(открыва[юе]|открою|смотрю|посмотрю|открывается|пытаюсь открыть).{0,40}(сайт|страниц|погод|новост|карт|википед)/i.test(normalized)
    || /(не удалось открыть|не удалось определить сайт|сайт не открылся)/i.test(normalized);
}

function tokenizeSpeechForOverlap(value) {
  return normalizeSpeechText(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zа-яё0-9-]+/gi, ''))
    .filter((token) => token.length >= 4);
}

function hasTranscriptOverlapWithAssistant(userTranscript, assistantTranscript) {
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

function isLikelyAssistantEchoFinal(transcript, assistantSample, botVolume, speechConfig) {
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

function isBrowserContextFollowupRequest(transcript) {
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

function buildEarlyBrowserLoadingTitle(transcript) {
  const normalized = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Подбираю адрес сайта';
  }
  return 'Подбираю адрес сайта';
}

function truncatePromptValue(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSessionHistorySummary(sessionHistory) {
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

function buildWebResultPrompt(transcript, panelState, historySummary) {
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

function buildWebClientResultPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_CLIENT_RESULT:
Сайт открыт прямо в нижней панели у пользователя.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState.title || 'Официальный сайт', 140)}
URL: ${truncatePromptValue(panelState.url || panelState.clientUrl || 'n/a', 180)}
Статус страницы: ${panelState?.clientContextStatus === 'ready' ? 'текст страницы уже подтверждён' : 'страница уже показана, но текст ещё дочитывается'}
Важно: говори, что сайт открыт в нижней панели только по этому служебному контексту.
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и честно: подтверди открытие сайта внизу и предложи помочь короткой справкой, контактами или вакансиями по подтверждённым данным.`;
}

function buildWebClientPendingPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_CLIENT_PENDING:
Сайт ещё открывается в нижней панели или текст страницы ещё не подтверждён.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState.title || 'Сайт', 140)}
URL: ${truncatePromptValue(panelState.url || panelState.clientUrl || 'n/a', 180)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и правдиво: скажи, что сайт уже открывается внизу, а текст страницы ещё дочитывается. Не говори, что страница уже разобрана полностью.`;
}

function buildWebActivePrompt(question, contextResult, historySummary) {
  const pageAnswer = truncatePromptValue(contextResult?.answer || 'Не удалось получить ответ.', 420);
  const pageSnippet = truncatePromptValue(contextResult?.contextSnippet || contextResult?.readerText || 'Текст страницы недоступен.', 700);
  return `WEB_CONTEXT_ACTIVE:
Сайт уже открыт и вопрос относится к текущей странице.
Вопрос: "${truncatePromptValue(question, 220)}"
Источник: ${truncatePromptValue(contextResult?.title || 'Веб-страница', 140)}
URL: ${truncatePromptValue(contextResult?.url || 'n/a', 180)}
Краткий ответ по странице: ${pageAnswer}
Контекст страницы: ${pageSnippet}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и только по этому контексту.`;
}

function buildWebFailurePrompt(transcript, errorMessage, historySummary) {
  return `WEB_CONTEXT_ERROR:
Сайт по этому запросу сейчас не подтверждён.
Запрос: "${truncatePromptValue(transcript, 220)}"
Причина: ${truncatePromptValue(errorMessage || 'неизвестная ошибка', 220)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Коротко объясни, что именно не удалось, и попроси уточнить сайт без перечисления доменных зон.`;
}

function buildWebOpenPendingPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_OPEN_PENDING:
Сайт уже найден и сервер начал открытие, но нижняя панель ещё не подтвердила показ страницы.
Запрос: "${truncatePromptValue(transcript, 220)}"
Источник: ${truncatePromptValue(panelState?.title || 'Сайт', 140)}
URL: ${truncatePromptValue(panelState?.url || 'n/a', 180)}
Недавняя веб-история:
${truncatePromptValue(historySummary, 420)}

Ответь коротко и честно: скажи, что сайт ещё открывается или панель ещё обновляется. Не говори, что страница уже показана.`;
}

function getClientHomeUrl(url) {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return String(url || '').trim();
  }
}

function buildClientPanelState(intent, currentPanel = null, { status = 'ready', note = '', browserPanelMode = 'client-inline' } = {}) {
  const nextUrl = String(intent?.url || currentPanel?.clientUrl || currentPanel?.url || '').trim();
  const nextTitle = String(intent?.titleHint || currentPanel?.title || nextUrl || 'Сайт').trim();
  const previousHistory = Array.isArray(currentPanel?.clientHistory) ? currentPanel.clientHistory : [];
  const previousIndex = Number.isInteger(currentPanel?.clientHistoryIndex) ? currentPanel.clientHistoryIndex : (previousHistory.length - 1);
  const truncatedHistory = previousHistory.slice(0, Math.max(0, previousIndex) + 1);
  const lastUrl = truncatedHistory[truncatedHistory.length - 1] || '';
  const nextHistory = nextUrl
    ? (lastUrl === nextUrl ? truncatedHistory : [...truncatedHistory, nextUrl])
    : truncatedHistory;
  const nextHistoryIndex = nextHistory.length ? nextHistory.length - 1 : -1;

  return {
    ...DEFAULT_PANEL_STATE,
    browserPanelMode: isClientInlinePanelMode(browserPanelMode) ? 'client-inline' : 'remote',
    status,
    sourceType: intent?.sourceType || intent?.type || currentPanel?.sourceType || 'direct-site',
    title: nextTitle,
    url: nextUrl,
    clientUrl: nextHistoryIndex >= 0 ? nextHistory[nextHistoryIndex] : nextUrl,
    clientHomeUrl: getClientHomeUrl(nextUrl),
    clientHistory: nextHistory,
    clientHistoryIndex: nextHistoryIndex,
    clientReloadKey: Date.now(),
    clientFrameLoaded: false,
    clientContextStatus: status === 'ready' ? 'ready' : 'loading',
    clientContextError: '',
    clientFallback: true,
    clientExternalOpened: false,
    note: note || currentPanel?.note || '',
  };
}

function buildWebActionPrompt(transcript, result, historySummary) {
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

function buildConversationSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSessionBootstrapText(restorePayload, knowledgeContext) {
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
    parts.push(`Последние подтвержденные знания из этой сессии:\n${recentKnowledge}`);
  }

  if (knowledgeContext) {
    parts.push(`Утвержденная база знаний:\n${knowledgeContext}`);
  }

  return parts.join('\n\n');
}

function buildRuntimeTurnPrompt(
  question,
  {
    knowledgeHits = [],
    activePageContext = null,
    prayerReadMode = 'knowledge-only',
    compactMode = false,
  } = {},
) {
  const normalizedQuestion = truncatePromptValue(question, 320);
  const hits = Array.isArray(knowledgeHits) ? knowledgeHits.slice(0, compactMode ? 2 : 3) : [];
  const prayerMode = String(prayerReadMode || 'knowledge-only').trim().toLowerCase();
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
    compactMode ? 220 : 320,
  );
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
1. Если пользователь просит прочитать молитву, используй только подтвержденные фрагменты из утвержденной базы знаний или открытой страницы.
2. Если подтвержденного текста нет, честно скажи, что для точного чтения нужен источник, и предложи открыть страницу с текстом.`
    : prayerMode === 'hybrid'
      ? `Спец-режим молитв:
1. Сначала опирайся на подтвержденные фрагменты из утвержденной базы знаний или открытой страницы.
2. Если подтвержденного текста недостаточно, предупреждай об этом явно.`
      : '';

  if (!hits.length) {
    if (compactMode) {
      return `Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}

Подтвержденных знаний по этому вопросу сейчас нет.

Ответь коротко и по делу.
Если данных мало, скажи это прямо.
Не обещай открытие сайта или действие без подтверждения.`;
    }

    return `RUNTIME_USER_TURN:
Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}

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
    .map((hit, index) => `${index + 1}. ${truncatePromptValue(hit.title || hit.canonicalUrl || 'Источник', 140)}${hit.canonicalUrl ? ` (${truncatePromptValue(hit.canonicalUrl, 140)})` : ''}\nФрагмент: ${truncatePromptValue(hit.confirmedExcerpt || hit.text || '', compactMode ? 180 : 260)}`)
    .join('\n\n');
  const prayerReadingBlock = prayerReadingExcerpt
    ? `Подтвержденный фрагмент для чтения молитвы:
${truncatePromptValue(prayerReadingExcerpt, compactMode ? 520 : 900)}`
    : '';

  if (compactMode) {
    return `Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}

Подтвержденные знания:
${knowledgeBlock}
${prayerReadingBlock ? `\n\n${prayerReadingBlock}` : ''}

Ответь коротко и естественно.
Сначала опирайся на открытую страницу, если она подходит.
Затем используй только подтвержденные знания.
Не выдумывай факты и не обещай действие браузера без подтверждения.
${prayerRequested && prayerMode === 'knowledge-only'
    ? (
      prayerReadingHit
        ? 'Если просят молитву, прочитай только подтвержденный фрагмент полностью, без добавлений от себя.'
        : 'Если просят молитву, используй только подтвержденные фрагменты и не достраивай текст по памяти.'
    )
    : 'Не повторяй вопрос пользователя.'}`;
  }

  return `RUNTIME_USER_TURN:
Вопрос пользователя: "${normalizedQuestion}"
${pageBlock}

Утвержденные знания по этому вопросу:
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
        ? 'В подтвержденных знаниях уже есть подходящий фрагмент молитвы: прочитай именно этот фрагмент полностью, спокойно, без отказа и без добавления текста от себя.'
        : 'Если это чтение молитвы, используй только приведенные подтвержденные фрагменты без добавлений от себя.'
    )
    : 'Ответь кратко, естественно и по делу.'}
${prayerRuleBlock ? `\n\n${prayerRuleBlock}` : ''}`;
}

function resolveExactPrayerReading(question, {
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

function buildExactPrayerReadingPrompt(question, reading) {
  return `RUNTIME_EXACT_READING:
Пользователь попросил молитву: "${truncatePromptValue(question, 220)}"
Разрешено только точное чтение подтвержденного текста.
Источник: ${truncatePromptValue(reading?.sourceTitle || 'Подтверждённый источник', 180)}${reading?.sourceUrl ? ` (${truncatePromptValue(reading.sourceUrl, 180)})` : ''}

Прочитай сейчас только этот текст, полностью и без добавлений от себя:
${truncatePromptValue(reading?.excerpt || '', 1200)}

Правила:
1. Не пересказывай и не сокращай текст.
2. Не добавляй вступление, если пользователь не просил.
3. Не вставляй комментарии и пояснения между строками.
4. Не отказывайся, потому что источник уже подтверждён.`;
}

function buildPrayerSourceRequiredPrompt(question, {
  knowledgeHits = [],
  activePageContext = null,
} = {}) {
  const topHit = Array.isArray(knowledgeHits) ? knowledgeHits[0] : null;
  const sourceTitle = topHit?.title || activePageContext?.title || 'утверждённый источник';
  const sourceUrl = topHit?.canonicalUrl || activePageContext?.url || '';
  return `RUNTIME_PRAYER_SOURCE_REQUIRED:
Пользователь попросил молитву: "${truncatePromptValue(question, 220)}"
Точного подтвержденного текста для чтения сейчас нет.
${sourceUrl ? `Есть ближайший источник: ${truncatePromptValue(sourceTitle, 180)} (${truncatePromptValue(sourceUrl, 180)}).` : 'Под рукой нет открытого подтверждённого источника.'}

Ответь коротко и честно:
1. скажи, что для точного чтения нужен подтверждённый источник;
2. предложи открыть страницу с текстом молитвы;
3. не выдумывай текст по памяти.`;
}

function buildGreetingAckPrompt(greetingText) {
  return `RUNTIME_GREETING_ACK:
Ассистент уже поздоровался в этой сессии.
Пользователь в ответ просто поздоровался: "${truncatePromptValue(greetingText, 120)}"

Не здоровайся заново, не представляйся и не повторяй приветствие.
Ответь одной короткой естественной фразой и сразу перейди к помощи, например в стиле "Чем могу помочь?"`;
}

function parseBrowserActionRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (isMainPagePhrase(normalized) && hasExplicitMainPageSiteTarget(normalized)) {
    return null;
  }

  if (
    /(перейди|перейти|открой|открыть|вернись|вернуться|иди|зайди|зайти|переход|навигац)/i.test(normalized)
    && isMainPagePhrase(normalized)
  ) {
    return { type: 'home' };
  }

  if (isMainPagePhrase(normalized)) {
    return { type: 'home' };
  }

  if (/(^|\s)(назад|вернись назад|вернуться назад)(?=\s|$)/i.test(normalized)) {
    return { type: 'back' };
  }

  if (/(^|\s)(вперед|впер[её]д|далее)(?=\s|$)/i.test(normalized)) {
    return { type: 'forward' };
  }

  if (/(^|\s)(обнови|перезагрузи|обновить страницу)(?=\s|$)/i.test(normalized)) {
    return { type: 'reload' };
  }

  if (/(прокрути|листни|пролистай|скролл)/i.test(normalized)) {
    return { type: 'wheel', deltaY: /(вверх|наверх)/i.test(normalized) ? -960 : 960 };
  }

  const clickMatch = normalized.match(/(?:нажми|кликни|перейди в раздел|открой раздел)\s+(.+)$/iu);
  if (clickMatch?.[1]) {
    const label = normalizeSpeechText(clickMatch[1]).replace(/[.?!]+$/g, '');
    if (label) {
      return { type: 'click-label', label };
    }
  }

  return null;
}

function parseImplicitBrowserActionRequest(transcript) {
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (isMainPagePhrase(normalized)) {
    return { type: 'home' };
  }
  if (/(^|\s)(назад|вернись назад|вернуться назад)(?=\s|$)/i.test(normalized)) {
    return { type: 'back' };
  }
  if (/(^|\s)(вперед|впер[её]д|далее)(?=\s|$)/i.test(normalized)) {
    return { type: 'forward' };
  }
  if (/(^|\s)(обнови|перезагрузи|обновить страницу|перезагрузка)(?=\s|$)/i.test(normalized)) {
    return { type: 'reload' };
  }

  return null;
}

function isBrowserActionFollowupRequest(transcript) {
  return Boolean(parseBrowserActionRequest(transcript));
}

function isTransientIntentError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }
  return message.includes('таймаут')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('503')
    || message.includes('network');
}

function classifyIntentErrorReason(error) {
  if (isTransientIntentError(error)) {
    return 'resolve_timeout';
  }
  return 'navigation_failed';
}

function classifyBrowserOpenErrorReason(error) {
  const explicitCode = String(error?.code || '').trim();
  if (explicitCode) {
    return explicitCode;
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('таймаут') || message.includes('timeout')) {
    return 'network_timeout';
  }
  if (message.includes('запрещ') || message.includes('blocked') || message.includes('домен')) {
    return 'navigation_blocked';
  }
  return 'navigation_failed';
}

async function jsonRequest(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });

  try {
    const { signal: _ignoredSignal, ...restOptions } = options;
    const response = await fetch(url, {
      ...restOptions,
      signal: controller.signal,
    });
    const rawPayload = await response.text().catch(() => '');
    let payload = {};
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const requestError = new Error(
          contentType.includes('text/html')
            ? 'Сервер вернул HTML вместо данных API. Проверьте адрес и прокси.'
            : 'Сервер вернул неверный формат ответа.',
        );
        requestError.code = 'invalid_response_format';
        throw requestError;
      }
    }
    if (!response.ok) {
      const requestError = new Error(payload.error || `Запрос не выполнен (HTTP ${response.status})`);
      if (payload?.errorReason) {
        requestError.code = String(payload.errorReason);
      }
      if (payload?.details && typeof payload.details === 'object') {
        requestError.details = payload.details;
      }
      throw requestError;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Истек таймаут ожидания ответа');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.('abort', abortFromExternal);
  }
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 32);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function App() {
  const [audioPlayer] = useState(() => new AudioStreamPlayer());
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [browserPanel, setBrowserPanel] = useState(DEFAULT_PANEL_STATE);
  const [browserFlowState, setBrowserFlowState] = useState('idle');
  const [activeBrowserSessionId, setActiveBrowserSessionId] = useState('');
  const [conversationSessionId, setConversationSessionId] = useState('');
  const [sessionBootstrapText, setSessionBootstrapText] = useState('');
  const [sessionShouldSendGreeting, setSessionShouldSendGreeting] = useState(true);
  const [liveInputTranscript, setLiveInputTranscript] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [appliedSessionSignature, setAppliedSessionSignature] = useState(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const {
    config,
    loading,
    error: configError,
    saving,
    persistConfig,
  } = useAppConfig();
  const browserRequestIdRef = useRef(0);
  const browserFlowRequestIdRef = useRef(0);
  const browserIntentAbortRef = useRef(null);
  const browserPanelRef = useRef(DEFAULT_PANEL_STATE);
  const browserFlowStateRef = useRef('idle');
  const activeBrowserSessionIdRef = useRef('');
  const conversationSessionIdRef = useRef('');
  const handledTranscriptsRef = useRef([]);
  const sessionWebHistoryRef = useRef([]);
  const lastBrowserCommandRef = useRef({ key: '', transcript: '', timestamp: 0 });
  const browserSpeechGuardUntilRef = useRef(0);
  const browserIntentInFlightRef = useRef(false);
  const inFlightBrowserKeyRef = useRef('');
  const pendingReconnectSignatureRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const goAwayReconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reloadWatchdogTimerRef = useRef(null);
  const manualStopRef = useRef(false);
  const avatarQuickTapTimestampsRef = useRef([]);
  const browserTraceCounterRef = useRef(0);
  const browserViewPollTimerRef = useRef(null);
  const lastLiveFinalRef = useRef({ key: '', timestamp: 0, requestId: 0, source: '' });
  const activeDialogRequestRef = useRef(0);
  const recentTurnsForIntentRef = useRef([]);
  const normalTurnInFlightRef = useRef(false);
  const pendingOrchestratedTurnRef = useRef(null);
  const assistantTurnCountRef = useRef(0);
  const sendTextTurnRef = useRef(null);
  const cancelAssistantOutputRef = useRef(null);
  const assistantPromptQueueRef = useRef([]);
  const assistantPromptInFlightRef = useRef(false);
  const assistantInFlightRequestIdRef = useRef(0);
  const assistantAwaitingResponseRef = useRef(false);
  const assistantPromptTimerRef = useRef(null);
  const assistantPromptSeqRef = useRef(0);
  const recordConversationActionRef = useRef(null);
  const handleBrowserTranscriptRef = useRef(null);
  const handleOrchestratedTurnRef = useRef(null);
  const bargeInCandidateRef = useRef({ startedAt: 0, textKey: '' });
  const lastBargeInAtRef = useRef(0);
  const assistantTurnStartedAtRef = useRef(0);
  const preferServerSttRef = useRef(false);
  const lastAssistantTurnRef = useRef({ text: '', timestamp: 0 });
  const dialogRequestStatesRef = useRef(new Map());
  const sessionGreetingQueuedRef = useRef(false);
  const pendingServerFinalRef = useRef({ text: '', timerId: null, capturedAt: 0 });
  const pendingLiveFinalRef = useRef({ text: '', timerId: null, capturedAt: 0 });
  const pendingClientPanelLoadRef = useRef({
    requestId: 0,
    transcript: '',
    actionType: '',
    targetUrl: '',
    timerId: null,
    frameLoaded: false,
    contextReady: false,
  });

  const selectedCharacter = config?.characters?.find((character) => character.id === config.activeCharacterId) || config?.characters?.[0] || null;
  const safeSpeechFlowEnabled = config?.safetySwitches?.safeSpeechFlowEnabled !== false;
  const runtimeProvider = String(selectedCharacter?.runtimeProvider || 'gemini-live').trim() || 'gemini-live';
  const usesYandexRuntime = runtimeProvider === 'yandex-full';
  const baseSpeechStabilityProfile = normalizeSpeechStabilityProfile(config?.speechStabilityProfile);
  const speechStabilityProfile = baseSpeechStabilityProfile;
  const speechStabilityConfig = selectedCharacter?.id === 'batyushka-2'
    ? {
      ...resolveSpeechStabilityConfig(speechStabilityProfile, safeSpeechFlowEnabled),
      profile: 'batyushka-stable',
      bargeInHoldMs: 560,
      minTranscriptLength: 7,
      botVolumeGuard: 0.115,
      immediateOnSpeechStart: false,
    }
    : resolveSpeechStabilityConfig(speechStabilityProfile, safeSpeechFlowEnabled);
  const prayerReadMode = String(config?.prayerReadMode || 'knowledge-only').trim().toLowerCase();
  const usesLiveInput = Boolean(selectedCharacter?.liveInputEnabled || usesYandexRuntime);
  const usesClientInlinePanel = isClientInlinePanelMode(selectedCharacter?.browserPanelMode);
  const pageContextMode = String(selectedCharacter?.pageContextMode || 'browser-session').trim() === 'url-fetch'
    ? 'url-fetch'
    : 'browser-session';
  const voiceOptions = Array.isArray(config?.supportedVoices) && config.supportedVoices.length > 0
    ? config.supportedVoices.map((voice) => ({
      value: voice.name,
      label: `${voice.name} (${voice.gender === 'male' ? 'мужской' : 'женский'})`,
    }))
    : (config?.supportedVoiceNames?.length ? config.supportedVoiceNames : ['Aoede', 'Kore', 'Puck'])
      .map((voiceName) => ({ value: voiceName, label: voiceName }));
  const uiCharacter = settingsOpen && settingsDraft && selectedCharacter && settingsDraft.id === selectedCharacter.id
    ? { ...selectedCharacter, backgroundPreset: settingsDraft.backgroundPreset, displayName: settingsDraft.displayName }
    : selectedCharacter;
  const activeBackground = BACKGROUND_PRESETS[uiCharacter?.backgroundPreset] || BACKGROUND_PRESETS.aurora;
  const avatarModelUrl = uiCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL;
  const avatarInstanceId = uiCharacter?.avatarInstanceId || `avatar-${uiCharacter?.id || 'default'}`;
  const avatarFrame = BATYUSHKA_CHARACTER_IDS.has(uiCharacter?.id || '')
    ? {
      y: -0.9,
      scale: 1.82,
      camera: { position: [0, 0, 0.36], fov: 35 },
      lights: { ambient: 1.18, directional: 0.96 },
      idleMotion: true,
      idleMotionProfile: {
        yawAmplitude: 0.024,
        yawSpeed: 0.34,
        pitchAmplitude: 0.014,
        pitchSpeed: 0.22,
        bobAmplitude: 0.009,
        bobSpeed: 0.34,
      },
    }
    : {
      y: -0.75,
      scale: 1.3,
      camera: { position: [0, 0, 0.64], fov: 45 },
      lights: { ambient: 1.02, directional: 0.78 },
      idleMotion: true,
      idleMotionProfile: {
        yawAmplitude: 0.03,
        yawSpeed: 0.5,
        pitchAmplitude: 0.02,
        pitchSpeed: 0.3,
      },
    };
  const avatarRenderKey = [
    avatarInstanceId,
    avatarModelUrl,
    uiCharacter?.backgroundPreset || 'aurora',
    avatarFrame.y,
    avatarFrame.scale,
    avatarFrame.camera.position[2],
    avatarFrame.camera.fov,
    avatarFrame.lights.ambient,
    avatarFrame.lights.directional,
    avatarFrame.idleMotion,
    avatarFrame.idleMotionProfile?.yawAmplitude,
    avatarFrame.idleMotionProfile?.yawSpeed,
    avatarFrame.idleMotionProfile?.pitchAmplitude,
    avatarFrame.idleMotionProfile?.pitchSpeed,
    avatarFrame.idleMotionProfile?.bobAmplitude,
    avatarFrame.idleMotionProfile?.bobSpeed,
  ].join('|');
  const themeMode = config?.themeMode === 'dark' ? 'dark' : 'light';
  const runtimeConfig = selectedCharacter
    ? {
      runtimeProvider,
      modelId: selectedCharacter.modelId || selectedCharacter.voiceModelId,
      voiceModelId: selectedCharacter.voiceModelId || selectedCharacter.modelId,
      voiceName: selectedCharacter.voiceName,
      ttsVoiceName: selectedCharacter.ttsVoiceName || selectedCharacter.voiceName,
      systemPrompt: selectedCharacter.systemPrompt,
      greetingText: selectedCharacter.greetingText,
      sessionContextText: sessionBootstrapText,
      shouldSendGreeting: sessionShouldSendGreeting,
      captureUserAudio: usesLiveInput,
      voiceGatewayUrl: selectedCharacter.voiceGatewayUrl || '',
      conversationSessionId,
      characterId: selectedCharacter.id,
      outputAudioTranscription: selectedCharacter.outputAudioTranscription !== false,
      speechStabilityProfile,
      prayerReadMode,
      safeSpeechFlowEnabled,
    }
    : undefined;

  const appendSessionWebHistory = React.useCallback((entry) => {
    const normalizedEntry = {
      status: entry?.status === 'failed' ? 'failed' : 'opened',
      transcript: truncatePromptValue(entry?.transcript || '', 220),
      title: truncatePromptValue(entry?.title || '', 180),
      url: truncatePromptValue(entry?.url || '', 240),
      note: truncatePromptValue(entry?.note || '', 220),
      timestamp: Date.now(),
    };

    sessionWebHistoryRef.current = [
      ...sessionWebHistoryRef.current,
      normalizedEntry,
    ].slice(-MAX_SESSION_WEB_HISTORY_ENTRIES);
  }, []);

  const getSessionHistorySummary = React.useCallback(
    () => buildSessionHistorySummary(sessionWebHistoryRef.current),
    [],
  );

  const getSessionHistoryPayload = React.useCallback(
    () => sessionWebHistoryRef.current.map((entry) => ({
      status: entry.status,
      transcript: entry.transcript,
      title: entry.title,
      url: entry.url,
      note: entry.note,
      timestamp: entry.timestamp,
    })),
    [],
  );

  const clearAssistantPromptTimer = React.useCallback(() => {
    if (assistantPromptTimerRef.current) {
      clearTimeout(assistantPromptTimerRef.current);
      assistantPromptTimerRef.current = null;
    }
  }, []);

  const sendBrowserClientEvent = React.useCallback((event, details = {}) => {
    void fetch('/api/browser/client-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, details }),
    }).catch(() => {});
  }, []);

  const recordConversationAction = React.useCallback((event, details = {}) => {
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        details,
        characterId: selectedCharacter?.id || '',
      }),
    }).catch(() => {});
  }, [selectedCharacter?.id]);

  useEffect(() => {
    recordConversationActionRef.current = recordConversationAction;
  }, [recordConversationAction]);

  const markDialogRequestState = React.useCallback((requestId, state, details = {}) => {
    const safeRequestId = Number(requestId);
    if (!Number.isInteger(safeRequestId) || safeRequestId <= 0) {
      return;
    }

    const nextState = {
      ...(dialogRequestStatesRef.current.get(safeRequestId) || {}),
      requestId: safeRequestId,
      state,
      updatedAt: Date.now(),
      ...details,
    };
    dialogRequestStatesRef.current.set(safeRequestId, nextState);
    recordConversationAction('runtime.request.state', {
      requestId: safeRequestId,
      state,
      ...details,
    });
  }, [recordConversationAction]);

  const finalizeDialogRequest = React.useCallback((requestId, outcome, details = {}) => {
    const safeRequestId = Number(requestId);
    if (!Number.isInteger(safeRequestId) || safeRequestId <= 0) {
      return;
    }

    const existing = dialogRequestStatesRef.current.get(safeRequestId) || null;
    if (existing?.finalized) {
      return;
    }

    const nextState = {
      ...(existing || {}),
      requestId: safeRequestId,
      finalized: true,
      outcome,
      finalizedAt: Date.now(),
      ...details,
    };
    dialogRequestStatesRef.current.set(safeRequestId, nextState);
    recordConversationAction('runtime.request.final', {
      requestId: safeRequestId,
      outcome,
      ...details,
    });
  }, [recordConversationAction]);

  const drainAssistantPromptQueue = React.useCallback(() => {
    if (assistantPromptInFlightRef.current) {
      return;
    }

    let nextPrompt = null;
    while (assistantPromptQueueRef.current.length > 0) {
      const candidate = assistantPromptQueueRef.current.shift();
      if (!candidate) {
        continue;
      }
      if (
        Number.isInteger(candidate.requestId)
        && candidate.requestId > 0
        && candidate.requestId !== activeDialogRequestRef.current
      ) {
        recordConversationAction('assistant.queue.drop', {
          reason: 'stale-request',
          source: candidate.source || '',
          requestId: candidate.requestId,
          activeRequestId: activeDialogRequestRef.current,
        });
        continue;
      }
      nextPrompt = candidate;
      break;
    }

    if (!nextPrompt) {
      return;
    }

    assistantPromptInFlightRef.current = true;
    assistantInFlightRequestIdRef.current = nextPrompt.requestId || activeDialogRequestRef.current;
    assistantAwaitingResponseRef.current = true;

    const sent = sendTextTurnRef.current?.(nextPrompt.text, { interrupt: nextPrompt.interrupt });
    if (!sent) {
      assistantPromptInFlightRef.current = false;
      assistantInFlightRequestIdRef.current = 0;
      assistantAwaitingResponseRef.current = false;
      recordConversationAction('assistant.queue.drop', {
        reason: 'send-failed',
        source: nextPrompt.source || '',
        requestId: nextPrompt.requestId || 0,
      });
      return;
    }

    clearAssistantPromptTimer();
    const handleQueueTurnTimeout = () => {
      const assistantTurnStartedAt = assistantTurnStartedAtRef.current;
      const assistantTurnAgeMs = assistantTurnStartedAt > 0 ? (Date.now() - assistantTurnStartedAt) : 0;
      if (assistantTurnStartedAt > 0 && assistantTurnAgeMs < ASSISTANT_QUEUE_MAX_HARD_TIMEOUT_MS) {
        assistantPromptTimerRef.current = setTimeout(handleQueueTurnTimeout, ASSISTANT_QUEUE_TURN_TIMEOUT_MS);
        return;
      }

      assistantPromptInFlightRef.current = false;
      assistantInFlightRequestIdRef.current = 0;
      assistantAwaitingResponseRef.current = false;
      assistantPromptTimerRef.current = null;
      recordConversationAction('assistant.queue.timeout-release', {
        source: nextPrompt.source || '',
        requestId: nextPrompt.requestId || 0,
      });
      drainAssistantPromptQueue();
    };
    assistantPromptTimerRef.current = setTimeout(handleQueueTurnTimeout, ASSISTANT_QUEUE_TURN_TIMEOUT_MS);

    recordConversationAction('assistant.queue.sent', {
      source: nextPrompt.source || '',
      textLength: nextPrompt.text.length,
      queueSize: assistantPromptQueueRef.current.length,
      requestId: nextPrompt.requestId || 0,
    });
  }, [clearAssistantPromptTimer, recordConversationAction]);

  const enqueueAssistantPrompt = React.useCallback((text, {
    interrupt = true,
    priority = 'normal',
    source = 'runtime',
    dedupeKey = '',
    requestId = activeDialogRequestRef.current,
  } = {}) => {
    const normalizedText = normalizeSpeechText(text);
    if (!normalizedText) {
      return false;
    }

    const normalizedDedupeKey = normalizeSpeechText(dedupeKey || '').toLowerCase();
    if (normalizedDedupeKey) {
      const duplicateInQueue = assistantPromptQueueRef.current.some(
        (entry) => entry.dedupeKey === normalizedDedupeKey && entry.requestId === requestId,
      );
      if (duplicateInQueue) {
        return false;
      }
    }

    const nextEntry = {
      id: `assistant-prompt-${Date.now().toString(36)}-${(assistantPromptSeqRef.current += 1).toString(36)}`,
      text: normalizedText,
      interrupt: Boolean(interrupt),
      source,
      dedupeKey: normalizedDedupeKey,
      requestId: Number.isInteger(requestId) ? requestId : activeDialogRequestRef.current,
    };

    if (priority === 'high') {
      assistantPromptQueueRef.current.unshift(nextEntry);
    } else {
      assistantPromptQueueRef.current.push(nextEntry);
    }

    recordConversationAction('assistant.queue.enqueue', {
      source,
      textLength: normalizedText.length,
      priority,
      queueSize: assistantPromptQueueRef.current.length,
      requestId: nextEntry.requestId || 0,
    });

    drainAssistantPromptQueue();
    return true;
  }, [drainAssistantPromptQueue, recordConversationAction]);

  const releaseAssistantPromptLock = React.useCallback((reason = 'commit') => {
    assistantPromptInFlightRef.current = false;
    assistantInFlightRequestIdRef.current = 0;
    assistantAwaitingResponseRef.current = false;
    clearAssistantPromptTimer();
    recordConversationAction('assistant.queue.release', { reason });
    drainAssistantPromptQueue();
  }, [clearAssistantPromptTimer, drainAssistantPromptQueue, recordConversationAction]);

  const clearAssistantPromptQueue = React.useCallback((reason = 'reset') => {
    assistantPromptQueueRef.current = [];
    assistantPromptInFlightRef.current = false;
    assistantInFlightRequestIdRef.current = 0;
    assistantAwaitingResponseRef.current = false;
    clearAssistantPromptTimer();
    recordConversationAction('assistant.queue.clear', { reason });
  }, [clearAssistantPromptTimer, recordConversationAction]);

  const cancelPendingBrowserWork = React.useCallback((reason = 'new-user-request') => {
    browserIntentAbortRef.current?.abort?.();
    browserIntentAbortRef.current = null;
    browserIntentInFlightRef.current = false;
    browserFlowRequestIdRef.current = 0;
    inFlightBrowserKeyRef.current = '';
    if (pendingClientPanelLoadRef.current?.timerId) {
      clearTimeout(pendingClientPanelLoadRef.current.timerId);
    }
    pendingClientPanelLoadRef.current = {
      requestId: 0,
      transcript: '',
      actionType: '',
      targetUrl: '',
      timerId: null,
      frameLoaded: false,
      contextReady: false,
    };
    void fetch('/api/browser/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).catch(() => {});
  }, []);

  const beginUserRequest = React.useCallback((source = 'stt-final') => {
    const previousRequestId = activeDialogRequestRef.current;
    if (previousRequestId > 0) {
      finalizeDialogRequest(previousRequestId, 'superseded', { source });
    }
    const nextRequestId = activeDialogRequestRef.current + 1;
    activeDialogRequestRef.current = nextRequestId;
    pendingOrchestratedTurnRef.current = null;
    cancelPendingBrowserWork(`superseded:${source}`);
    clearAssistantPromptQueue(`new-user-request:${source}`);
    cancelAssistantOutputRef.current?.();
    recordConversationAction('runtime.request.activate', {
      requestId: nextRequestId,
      source,
    });
    markDialogRequestState(nextRequestId, 'active', { source });
    return nextRequestId;
  }, [cancelPendingBrowserWork, clearAssistantPromptQueue, finalizeDialogRequest, markDialogRequestState, recordConversationAction]);

  const beginAssistantInitiatedRequest = React.useCallback((source = 'assistant-initiated') => {
    const previousRequestId = activeDialogRequestRef.current;
    if (previousRequestId > 0) {
      finalizeDialogRequest(previousRequestId, 'superseded', { source });
    }
    const nextRequestId = activeDialogRequestRef.current + 1;
    activeDialogRequestRef.current = nextRequestId;
    pendingOrchestratedTurnRef.current = null;
    clearAssistantPromptQueue(`assistant-request:${source}`);
    recordConversationAction('runtime.request.activate', {
      requestId: nextRequestId,
      source,
      actor: 'assistant',
    });
    markDialogRequestState(nextRequestId, 'assistant-active', { source });
    return nextRequestId;
  }, [clearAssistantPromptQueue, finalizeDialogRequest, markDialogRequestState, recordConversationAction]);

  const triggerBargeIn = React.useCallback((reason = 'speech-overlap') => {
    const now = Date.now();
    if ((now - lastBargeInAtRef.current) < BARGE_IN_MIN_GAP_MS) {
      return false;
    }
    lastBargeInAtRef.current = now;
    cancelPendingBrowserWork(reason);
    clearAssistantPromptQueue(reason);
    cancelAssistantOutputRef.current?.();
    if (activeDialogRequestRef.current > 0) {
      markDialogRequestState(activeDialogRequestRef.current, 'interrupted', { reason });
    }
    recordConversationActionRef.current?.('assistant.turn.bargein', {
      conversationSessionId: conversationSessionIdRef.current || '',
      reason,
    });
    return true;
  }, [cancelPendingBrowserWork, clearAssistantPromptQueue, markDialogRequestState]);

  const recordConversationTurn = React.useCallback((role, text, source = 'live') => {
    const sessionId = conversationSessionIdRef.current;
    const normalizedText = normalizeSpeechText(text);
    const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
    if (normalizedText) {
      recentTurnsForIntentRef.current = [
        ...recentTurnsForIntentRef.current,
        {
          role: normalizedRole,
          text: truncatePromptValue(normalizedText, 260),
          source: normalizeSpeechText(source || 'live') || 'live',
        },
      ].slice(-MAX_RECENT_INTENT_TURNS);
    }
    if (!sessionId || !normalizedText) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: normalizedRole,
        text: normalizedText,
        source,
        characterId: selectedCharacter?.id || '',
      }),
    }).catch(() => {});
  }, [selectedCharacter?.id]);

  const updateConversationSessionState = React.useCallback((nextState = {}) => {
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    void fetch(`/api/conversation/session/${encodeURIComponent(sessionId)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...nextState,
        characterId: selectedCharacter?.id || '',
      }),
    }).catch(() => {});
  }, [selectedCharacter?.id]);

  const clearPendingServerFinal = React.useCallback(() => {
    const timerId = pendingServerFinalRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingServerFinalRef.current = {
      text: '',
      timerId: null,
      capturedAt: 0,
    };
  }, []);

  const clearPendingLiveFinal = React.useCallback(() => {
    const timerId = pendingLiveFinalRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingLiveFinalRef.current = {
      text: '',
      timerId: null,
      capturedAt: 0,
    };
  }, []);

  const resetSessionRuntimeState = React.useCallback(() => {
    sessionWebHistoryRef.current = [];
    handledTranscriptsRef.current = [];
    browserRequestIdRef.current = 0;
    browserFlowRequestIdRef.current = 0;
    browserIntentAbortRef.current?.abort?.();
    browserIntentAbortRef.current = null;
    lastBrowserCommandRef.current = { key: '', transcript: '', timestamp: 0 };
    browserSpeechGuardUntilRef.current = 0;
    browserIntentInFlightRef.current = false;
    inFlightBrowserKeyRef.current = '';
    normalTurnInFlightRef.current = false;
    pendingOrchestratedTurnRef.current = null;
    activeDialogRequestRef.current = 0;
    lastLiveFinalRef.current = { key: '', timestamp: 0, requestId: 0, source: '' };
    lastAssistantTurnRef.current = { text: '', timestamp: 0 };
    assistantTurnCountRef.current = 0;
    sessionGreetingQueuedRef.current = false;
    assistantPromptQueueRef.current = [];
    assistantPromptInFlightRef.current = false;
    assistantInFlightRequestIdRef.current = 0;
    recentTurnsForIntentRef.current = [];
    dialogRequestStatesRef.current = new Map();
    bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
    lastBargeInAtRef.current = 0;
    clearAssistantPromptTimer();
    clearPendingServerFinal();
    clearPendingLiveFinal();
    if (pendingClientPanelLoadRef.current?.timerId) {
      clearTimeout(pendingClientPanelLoadRef.current.timerId);
    }
    pendingClientPanelLoadRef.current = {
      requestId: 0,
      transcript: '',
      actionType: '',
      targetUrl: '',
      timerId: null,
      frameLoaded: false,
      contextReady: false,
    };
    browserFlowStateRef.current = 'idle';
    setBrowserFlowState('idle');
    activeBrowserSessionIdRef.current = '';
    setActiveBrowserSessionId('');
    setBrowserPanel(DEFAULT_PANEL_STATE);
    setSessionBootstrapText('');
    setSessionShouldSendGreeting(true);

    if (browserViewPollTimerRef.current) {
      clearInterval(browserViewPollTimerRef.current);
      browserViewPollTimerRef.current = null;
    }
  }, [clearAssistantPromptTimer, clearPendingLiveFinal, clearPendingServerFinal]);

  const commitRecognizedUserTranscript = React.useCallback((transcript, {
    source = 'server-stt',
    requestSource = 'server-stt-final',
    sttSessionPrefix = 'server-stt',
    turnSource = 'server-stt',
  } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return false;
    }

    const botVolume = audioPlayer?.getVolume?.() || 0;
    if (isLikelyAssistantEchoFinal(normalized, lastAssistantTurnRef.current, botVolume, speechStabilityConfig)) {
      recordConversationAction('stt.stream.echo-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        textLength: normalized.length,
      });
      return false;
    }

    const transcriptKey = normalizeTranscriptKey(normalized);
    const now = Date.now();
    const previousLiveFinal = lastLiveFinalRef.current;
    const previousRequestState = previousLiveFinal.requestId > 0
      ? dialogRequestStatesRef.current.get(previousLiveFinal.requestId)
      : null;
    const duplicateGeminiFinalInFlight = source === 'gemini-input'
      && transcriptKey
      && previousLiveFinal.key === transcriptKey
      && previousLiveFinal.source === 'gemini-input'
      && previousLiveFinal.requestId > 0
      && !previousRequestState?.finalized;

    if (duplicateGeminiFinalInFlight) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        reason: 'duplicate-live-final-in-flight',
        textLength: normalized.length,
      });
      return false;
    }

    if (
      transcriptKey
      && previousLiveFinal.key === transcriptKey
      && (now - previousLiveFinal.timestamp) < USER_FINAL_DEDUP_WINDOW_MS
    ) {
      recordConversationAction('stt.stream.final-drop', {
        conversationSessionId: conversationSessionIdRef.current || '',
        source,
        reason: 'dedupe-window',
        textLength: normalized.length,
      });
      return false;
    }
    if (botVolume > speechStabilityConfig.botVolumeGuard) {
      triggerBargeIn(`bargein-final-${source}`);
    }

    const requestId = beginUserRequest(requestSource);
    lastLiveFinalRef.current = {
      key: transcriptKey,
      timestamp: now,
      requestId,
      source,
    };
    updateConversationSessionState({
      lastFinalTranscriptHash: transcriptKey,
      activeSttSessionId: conversationSessionIdRef.current
        ? `${sttSessionPrefix}:${conversationSessionIdRef.current}`
        : '',
    });
    recordConversationAction('stt.stream.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source,
      textLength: normalized.length,
    });
    recordConversationAction('user.turn.final', {
      conversationSessionId: conversationSessionIdRef.current || '',
      source,
      textLength: normalized.length,
    });
    recordConversationTurn('user', normalized, turnSource);

    const intentType = classifyTranscriptIntent(normalized);
    const implicitBrowserAction = Boolean(activeBrowserSessionIdRef.current)
      && Boolean(parseImplicitBrowserActionRequest(normalized));
    if (intentType === 'browser_action' || intentType === 'page_query' || intentType === 'site_open' || implicitBrowserAction) {
      handleBrowserTranscriptRef.current?.(normalized, { requestId });
      return true;
    }

    handleOrchestratedTurnRef.current?.(normalized, { requestId });
    return true;
  }, [
    audioPlayer,
    beginUserRequest,
    recordConversationAction,
    recordConversationTurn,
    speechStabilityConfig,
    triggerBargeIn,
    updateConversationSessionState,
  ]);

  const schedulePendingServerFinal = React.useCallback((delayMs = SERVER_STT_FRAGMENT_HOLD_MS) => {
    const bufferedText = normalizeSpeechText(pendingServerFinalRef.current.text);
    if (!bufferedText) {
      clearPendingServerFinal();
      return;
    }

    if (pendingServerFinalRef.current.timerId) {
      clearTimeout(pendingServerFinalRef.current.timerId);
    }

    pendingServerFinalRef.current.timerId = window.setTimeout(() => {
      const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
      clearPendingServerFinal();
      if (!pendingText) {
        return;
      }
      commitRecognizedUserTranscript(pendingText, {
        source: 'server-stt',
        requestSource: 'server-stt-final',
        sttSessionPrefix: 'server-stt',
        turnSource: 'server-stt',
      });
    }, Math.max(180, delayMs));
  }, [clearPendingServerFinal, commitRecognizedUserTranscript]);

  const flushPendingServerFinal = React.useCallback((mode = 'commit') => {
    const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
    clearPendingServerFinal();
    if (mode !== 'commit' || !pendingText) {
      return false;
    }
    return commitRecognizedUserTranscript(pendingText, {
      source: 'server-stt',
      requestSource: 'server-stt-final',
      sttSessionPrefix: 'server-stt',
      turnSource: 'server-stt',
    });
  }, [clearPendingServerFinal, commitRecognizedUserTranscript]);

  const handleServerFinalTranscript = React.useCallback((transcript) => {
    const normalized = normalizeSpeechText(transcript);
    setLiveInputTranscript('');
    if (!normalized || isAssistantBrowserNarration(normalized)) {
      return;
    }

    const now = Date.now();
    const pendingText = normalizeSpeechText(pendingServerFinalRef.current.text);
    const pendingCapturedAt = Number(pendingServerFinalRef.current.capturedAt || 0);
    if (pendingText) {
      const withinMergeWindow = pendingCapturedAt > 0
        && (now - pendingCapturedAt) <= SERVER_STT_FRAGMENT_MERGE_WINDOW_MS;
      if (withinMergeWindow && canMergeServerTranscriptFragments(pendingText, normalized)) {
        const mergedText = mergeServerTranscriptFragments(pendingText, normalized);
        pendingServerFinalRef.current.text = mergedText;
        pendingServerFinalRef.current.capturedAt = now;
        recordConversationAction('stt.stream.final.merge', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: mergedText.length,
        });
        schedulePendingServerFinal(
          looksLikeIncompleteTranscriptFragment(mergedText)
            ? getServerFinalHoldDelay(mergedText)
            : 260,
        );
        return;
      }

      flushPendingServerFinal('commit');
    }

    if (looksLikeIncompleteTranscriptFragment(normalized)) {
      pendingServerFinalRef.current = {
        text: normalized,
        timerId: null,
        capturedAt: now,
      };
      recordConversationAction('stt.stream.final.hold', {
        conversationSessionId: conversationSessionIdRef.current || '',
        textLength: normalized.length,
      });
      schedulePendingServerFinal(getServerFinalHoldDelay(normalized));
      return;
    }

    commitRecognizedUserTranscript(normalized, {
      source: 'server-stt',
      requestSource: 'server-stt-final',
      sttSessionPrefix: 'server-stt',
      turnSource: 'server-stt',
    });
  }, [
    commitRecognizedUserTranscript,
    flushPendingServerFinal,
    recordConversationAction,
    schedulePendingServerFinal,
  ]);

  const handleLiveInputTranscription = React.useCallback((transcript) => {
    const normalized = String(transcript || '').trim();
    const now = Date.now();
    setLiveInputTranscript(normalized);
    if (!normalized) {
      clearPendingLiveFinal();
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      return;
    }

    if (isAssistantBrowserNarration(normalized)) {
      clearPendingLiveFinal();
      return;
    }

    const botVolume = audioPlayer?.getVolume?.() || 0;
    if (botVolume <= speechStabilityConfig.botVolumeGuard) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      return;
    }

    if (STOP_SPEECH_PATTERN.test(normalized)) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      triggerBargeIn('bargein-stop-word');
      return;
    }

    if ((now - assistantTurnStartedAtRef.current) < ASSISTANT_BARGE_IN_WARMUP_MS) {
      return;
    }

    if (speechStabilityConfig.profile === 'legacy') {
      triggerBargeIn('bargein-input');
      return;
    }

    if (normalized.length < speechStabilityConfig.minTranscriptLength) {
      return;
    }

    const textKey = normalizeTranscriptKey(normalized);
    if (bargeInCandidateRef.current.textKey !== textKey) {
      bargeInCandidateRef.current = { startedAt: now, textKey };
      return;
    }

    if ((now - bargeInCandidateRef.current.startedAt) >= speechStabilityConfig.bargeInHoldMs) {
      bargeInCandidateRef.current = { startedAt: 0, textKey: '' };
      triggerBargeIn('bargein-input-hold');
    }
  }, [audioPlayer, clearPendingLiveFinal, speechStabilityConfig, triggerBargeIn]);

  const bootstrapConversationContext = React.useCallback(async (sessionId, { shouldSendGreeting = false } = {}) => {
    const restorePayload = await jsonRequest(
      `/api/conversation/session/${encodeURIComponent(sessionId)}/restore?characterId=${encodeURIComponent(selectedCharacter?.id || '')}`,
      { method: 'GET' },
      10000,
    );
    const restoredCharacterId = String(restorePayload?.restore?.lastCharacterId || '').trim();
    const characterMismatch = Boolean(restoredCharacterId && selectedCharacter?.id && restoredCharacterId !== selectedCharacter.id);
    const effectiveRestorePayload = characterMismatch
      ? { ...restorePayload, restore: null }
      : restorePayload;
    const nextBootstrapText = buildSessionBootstrapText(effectiveRestorePayload, restorePayload?.knowledgeContext || '');
    setSessionBootstrapText(nextBootstrapText);
    setSessionShouldSendGreeting(Boolean(shouldSendGreeting && !effectiveRestorePayload?.restore?.greetingSent));
    assistantTurnCountRef.current = Array.isArray(effectiveRestorePayload?.restore?.recentTurns)
      ? effectiveRestorePayload.restore.recentTurns.filter((turn) => turn?.role === 'assistant' && normalizeSpeechText(turn?.text || '')).length
      : 0;
    lastLiveFinalRef.current = {
      key: normalizeTranscriptKey(effectiveRestorePayload?.restore?.lastFinalTranscriptHash || ''),
      timestamp: 0,
      requestId: 0,
      source: '',
    };
    const restoredBrowserSessionId = String(effectiveRestorePayload?.restore?.browserSessionId || '').trim();
    if (restoredBrowserSessionId) {
      setActiveBrowserSessionId(restoredBrowserSessionId);
      activeBrowserSessionIdRef.current = restoredBrowserSessionId;
      setBrowserPanel((current) => ({
        ...current,
        status: current.status === 'idle' ? 'ready' : current.status,
        title: effectiveRestorePayload?.restore?.browserContext?.title || current.title,
        url: effectiveRestorePayload?.restore?.browserContext?.url || current.url,
      }));
      void jsonRequest(
        `/api/browser/session/${encodeURIComponent(restoredBrowserSessionId)}/view?refresh=1`,
        { method: 'GET' },
        BROWSER_ACTION_TIMEOUT_MS,
      ).then((view) => {
        setBrowserPanel((current) => ({
          ...current,
          status: 'ready',
          title: view.title || current.title,
          url: view.url || current.url,
          screenshotUrl: view.imageUrl || current.screenshotUrl,
          view: {
            imageUrl: view.imageUrl || '',
            width: view.width || 0,
            height: view.height || 0,
            revision: view.revision || 0,
            actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
          },
          revision: view.revision || current.revision || 0,
          actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : current.actionableElements,
        }));
      }).catch((error) => {
        if (/нет активного открытого сайта/i.test(String(error?.message || ''))) {
          activeBrowserSessionIdRef.current = '';
          setActiveBrowserSessionId('');
          setBrowserFlowState('error');
          browserFlowStateRef.current = 'error';
          setBrowserPanel((current) => ({
            ...current,
            status: 'error',
            error: 'Связь с открытым сайтом потеряна. Откройте сайт снова.',
          }));
        }
      });
    } else if (pageContextMode === 'url-fetch' && effectiveRestorePayload?.restore?.browserContext?.url) {
      const restoredUrl = String(effectiveRestorePayload.restore.browserContext.url || '').trim();
      const restoredTitle = String(effectiveRestorePayload.restore.browserContext.title || '').trim();
      if (restoredUrl) {
        browserFlowStateRef.current = 'ready';
        setBrowserFlowState('ready');
        setBrowserPanel((current) => ({
          ...buildClientPanelState({
            url: restoredUrl,
            titleHint: restoredTitle || restoredUrl,
            sourceType: 'restored-site',
          }, current, {
            status: 'ready',
            note: '',
            browserPanelMode: 'client-inline',
          }),
          title: restoredTitle || current.title || restoredUrl,
          url: restoredUrl,
          clientUrl: restoredUrl,
          clientContextStatus: 'loading',
          clientContextError: '',
        }));
        void jsonRequest('/api/browser/url-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: restoredUrl,
            question: 'что сейчас находится на открытой странице',
            requestId: 0,
            conversationSessionId: sessionId,
            characterId: selectedCharacter?.id || '',
          }),
        }, BROWSER_CONTEXT_TIMEOUT_MS + 3000)
          .then((contextResult) => {
            setBrowserPanel((current) => ({
              ...current,
              title: contextResult?.title || current.title,
              url: contextResult?.url || current.url,
              embeddable: contextResult?.embeddable !== false,
              readerText: contextResult?.readerText || current.readerText,
              lastUpdated: contextResult?.lastUpdated || current.lastUpdated,
              clientContextStatus: 'ready',
              clientContextError: '',
              error: null,
            }));
          })
          .catch((contextError) => {
            setBrowserPanel((current) => ({
              ...current,
              clientContextStatus: 'error',
              clientContextError: contextError.message || 'Не удалось быстро прочитать страницу.',
            }));
          });
      }
    }
    return nextBootstrapText;
  }, [pageContextMode, selectedCharacter?.id]);

  const refreshBrowserView = React.useCallback(async (force = false) => {
    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      return null;
    }

    let view;
    try {
      view = await jsonRequest(
        `/api/browser/session/${encodeURIComponent(sessionId)}/view?refresh=${force ? '1' : '0'}`,
        { method: 'GET' },
        BROWSER_ACTION_TIMEOUT_MS,
      );
    } catch (error) {
      if (/нет активного открытого сайта/i.test(String(error?.message || ''))) {
        activeBrowserSessionIdRef.current = '';
        browserFlowStateRef.current = 'error';
        setActiveBrowserSessionId('');
        setBrowserFlowState('error');
        setBrowserPanel((current) => ({
          ...current,
          status: 'error',
          error: 'Связь с открытым сайтом потеряна. Откройте сайт снова.',
        }));
      }
      throw error;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: current.status === 'idle' ? 'ready' : current.status,
      title: view.title || current.title,
      url: view.url || current.url,
      screenshotUrl: view.imageUrl || current.screenshotUrl,
      view: {
        imageUrl: view.imageUrl || '',
        width: view.width || 0,
        height: view.height || 0,
        revision: view.revision || 0,
        actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
      },
      revision: view.revision || current.revision || 0,
      actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : current.actionableElements,
    }));

    return view;
  }, []);

  const setBrowserFlowPhase = React.useCallback((phase) => {
    browserFlowStateRef.current = phase;
    setBrowserFlowState(phase);
  }, []);

  const detectBrowserIntentWithRetry = React.useCallback(async ({
    traceId,
    transcript,
    requestId,
    dedupeKey,
  }) => {
    let lastError = null;
    const maxAttempts = 1 + BROWSER_INTENT_RETRY_LIMIT;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      const attemptAbortController = new AbortController();
      browserIntentAbortRef.current = attemptAbortController;
      const abortTimerId = setTimeout(() => {
        attemptAbortController.abort();
      }, BROWSER_INTENT_PENDING_SLA_MS);

      try {
        const intent = await jsonRequest('/api/browser/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            traceId,
            transcript,
            sessionHistory: getSessionHistoryPayload(),
            activeCharacterId: selectedCharacter?.id || null,
            conversationSessionId: conversationSessionIdRef.current || '',
            recentTurns: recentTurnsForIntentRef.current.slice(-MAX_RECENT_INTENT_TURNS),
          }),
          signal: attemptAbortController.signal,
        }, BROWSER_INTENT_TIMEOUT_MS);

        sendBrowserClientEvent('browser.intent.attempt.success', {
          requestId,
          traceId,
          attempt,
          dedupeKey,
          intentType: intent?.type || 'none',
        });
        return intent;
      } catch (error) {
        lastError = error;
        const transientError = isTransientIntentError(error);
        const canRetryTranscript = /\bhttps?:\/\/[^\s]+/i.test(transcript)
          || /\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(transcript)
          || /\bточка\s*(?:by|ru)\b/i.test(transcript);
        const shouldRetry = transientError && canRetryTranscript && attempt < maxAttempts;
        sendBrowserClientEvent('browser.intent.attempt.error', {
          requestId,
          traceId,
          attempt,
          dedupeKey,
          transient: transientError,
          retryPlanned: shouldRetry,
          error: error?.message || 'Не удалось определить сайт',
        });

        if (!shouldRetry) {
          throw error;
        }

        setBrowserPanel((current) => ({
          ...current,
          status: 'loading',
          title: 'Проверяю адрес еще раз...',
          sourceType: 'intent-pending',
        }));
        await new Promise((resolve) => {
          setTimeout(resolve, BROWSER_INTENT_RETRY_BACKOFF_MS);
        });
      } finally {
        clearTimeout(abortTimerId);
        if (browserIntentAbortRef.current === attemptAbortController) {
          browserIntentAbortRef.current = null;
        }
      }
    }

    throw lastError || new Error('Не удалось определить сайт');
  }, [getSessionHistoryPayload, selectedCharacter?.id, sendBrowserClientEvent]);

  const requestActiveBrowserContext = React.useCallback(async (question, { requestId = 0 } = {}) => {
    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      throw new Error('Нет активного сайта для уточнения контекста');
    }

    return jsonRequest(`/api/browser/session/${encodeURIComponent(sessionId)}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
        requestId: Number.isInteger(requestId) ? requestId : 0,
      }),
    }, BROWSER_CONTEXT_TIMEOUT_MS);
  }, [selectedCharacter?.id]);

  const requestClientInlineContext = React.useCallback(async (url, question, { requestId = 0 } = {}) => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
      throw new Error('Нет адреса страницы для чтения контекста');
    }

    return jsonRequest('/api/browser/url-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: normalizedUrl,
        question,
        requestId: Number.isInteger(requestId) ? requestId : 0,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
      }),
    }, BROWSER_CONTEXT_TIMEOUT_MS + 3000);
  }, [selectedCharacter?.id]);

  const queryKnowledgeForTurn = React.useCallback(async (question) => {
    const normalizedQuestion = normalizeSpeechText(question);
    if (!normalizedQuestion) {
      return { hits: [] };
    }

    return jsonRequest('/api/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: normalizedQuestion,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
      }),
    }, 10000);
  }, [selectedCharacter?.id]);

  const getRuntimePageContextForTurn = React.useCallback(async (question) => {
    if (browserIntentInFlightRef.current) {
      return null;
    }

    if (pageContextMode === 'url-fetch' && browserPanelRef.current?.clientUrl && browserFlowStateRef.current === 'ready') {
      try {
        const contextResult = await requestClientInlineContext(
          browserPanelRef.current.clientUrl,
          question,
          { requestId: activeDialogRequestRef.current },
        );
        return contextResult || null;
      } catch {
        return null;
      }
    }

    if (!activeBrowserSessionIdRef.current || browserFlowStateRef.current !== 'ready') {
      return null;
    }

    try {
      const contextResult = await requestActiveBrowserContext(question, {
        requestId: activeDialogRequestRef.current,
      });
      return contextResult || null;
    } catch {
      return null;
    }
  }, [pageContextMode, requestActiveBrowserContext, requestClientInlineContext]);

  useEffect(() => {
    browserFlowStateRef.current = browserFlowState;
  }, [browserFlowState]);

  useEffect(() => {
    browserPanelRef.current = browserPanel;
  }, [browserPanel]);

  useEffect(() => {
    activeBrowserSessionIdRef.current = activeBrowserSessionId;
  }, [activeBrowserSessionId]);

  useEffect(() => {
    conversationSessionIdRef.current = conversationSessionId;
  }, [conversationSessionId]);

  useEffect(() => {
    if (browserViewPollTimerRef.current) {
      clearInterval(browserViewPollTimerRef.current);
      browserViewPollTimerRef.current = null;
    }

    if (!activeBrowserSessionId || browserFlowState !== 'ready') {
      return undefined;
    }

    void refreshBrowserView(false).catch(() => {});
    browserViewPollTimerRef.current = setInterval(() => {
      void refreshBrowserView(false).catch(() => {});
    }, BROWSER_VIEW_POLL_MS);

    return () => {
      if (browserViewPollTimerRef.current) {
        clearInterval(browserViewPollTimerRef.current);
        browserViewPollTimerRef.current = null;
      }
    };
  }, [activeBrowserSessionId, browserFlowState, refreshBrowserView]);

  const voiceSessionCallbacks = {
      onSessionReady: ({ resumed = false, shouldSendGreeting = false }) => {
        recordConversationAction('model.session.ready', {
          conversationSessionId: conversationSessionIdRef.current || '',
          resumed,
          shouldSendGreeting,
        });
        if (resumed || !shouldSendGreeting || sessionGreetingQueuedRef.current) {
          return;
        }
        const greetingRequestId = beginAssistantInitiatedRequest('session-greeting');
        sessionGreetingQueuedRef.current = true;
        enqueueAssistantPrompt(selectedCharacter?.greetingText || 'Поздоровайся коротко с пользователем.', {
          interrupt: false,
          priority: 'high',
          source: 'session.greeting',
          dedupeKey: `session-greeting:${selectedCharacter?.id || 'default'}`,
          requestId: greetingRequestId,
        });
      },
      onInputTranscription: (text) => {
        if (preferServerSttRef.current) {
          return;
        }
        handleLiveInputTranscription(text);
      },
      onInputTranscriptionCommit: ({ text }) => {
        if (runtimeConfig?.captureUserAudio === false) {
          return;
        }
        if (preferServerSttRef.current) {
          return;
        }
        clearPendingLiveFinal();
        commitRecognizedUserTranscript(text, {
          source: usesYandexRuntime ? 'yandex-input' : 'gemini-input',
          requestSource: usesYandexRuntime ? 'yandex-input-final' : 'gemini-input-final',
          sttSessionPrefix: usesYandexRuntime ? 'yandex-local-vad' : 'gemini-live-input',
          turnSource: usesYandexRuntime ? 'yandex-input-transcription' : 'gemini-input-transcription',
        });
      },
      onAssistantTurnStart: () => {
        if (!assistantAwaitingResponseRef.current) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'unexpected-start',
            browserIntentInFlight: browserIntentInFlightRef.current,
            browserFlowState: browserFlowStateRef.current,
          });
          if (
            browserIntentInFlightRef.current
            || browserFlowStateRef.current === 'intent_pending'
            || browserFlowStateRef.current === 'opening'
          ) {
            cancelAssistantOutputRef.current?.();
          }
          return false;
        }
        assistantTurnStartedAtRef.current = Date.now();
        assistantPromptInFlightRef.current = true;
        recordConversationAction('assistant.turn.start', {
          conversationSessionId: conversationSessionIdRef.current || '',
        });
        return true;
      },
      onAssistantTurnCommit: ({ text, textChunks = 0, audioChunks = 0, durationMs = 0 }) => {
        const inFlightRequestId = assistantInFlightRequestIdRef.current;
        const awaitingResponse = assistantAwaitingResponseRef.current;
        assistantTurnStartedAtRef.current = 0;
        releaseAssistantPromptLock('commit');
        if (!awaitingResponse || inFlightRequestId <= 0) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'unexpected-commit',
            textLength: String(text || '').length,
          });
          return;
        }
        if (inFlightRequestId > 0 && inFlightRequestId !== activeDialogRequestRef.current) {
          recordConversationAction('assistant.turn.drop', {
            reason: 'stale-request',
            requestId: inFlightRequestId,
            activeRequestId: activeDialogRequestRef.current,
            textLength: String(text || '').length,
          });
          return;
        }
        const normalizedAssistantText = normalizeSpeechText(text);
        if (normalizedAssistantText) {
          assistantTurnCountRef.current += 1;
          lastAssistantTurnRef.current = {
            text: normalizedAssistantText,
            timestamp: Date.now(),
          };
          if (assistantTurnCountRef.current === 1 && sessionShouldSendGreeting) {
            updateConversationSessionState({ greetingSent: true });
            setSessionShouldSendGreeting(false);
          }
        }
        recordConversationAction('assistant.turn.commit', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: String(text || '').length,
          textChunks,
          audioChunks,
          durationMs,
        });
        finalizeDialogRequest(inFlightRequestId || activeDialogRequestRef.current, 'answered', {
          textLength: normalizedAssistantText.length,
        });
        recordConversationTurn('assistant', text, usesYandexRuntime ? 'yandex-full' : 'gemini-live');
      },
      onAssistantTurnCancel: ({ text, interrupted = false }) => {
        const inFlightRequestId = assistantInFlightRequestIdRef.current;
        const awaitingResponse = assistantAwaitingResponseRef.current;
        assistantTurnStartedAtRef.current = 0;
        releaseAssistantPromptLock('cancel');
        if (!awaitingResponse && !interrupted) {
          recordConversationAction('assistant.turn.drop', {
            conversationSessionId: conversationSessionIdRef.current || '',
            reason: 'unexpected-cancel',
            textLength: String(text || '').length,
          });
          return;
        }
        recordConversationAction('assistant.turn.cancel', {
          conversationSessionId: conversationSessionIdRef.current || '',
          textLength: String(text || '').length,
          requestId: inFlightRequestId || 0,
          interrupted,
        });
      },
      onAssistantInterrupted: () => {
        recordConversationAction('assistant.turn.interrupted', {
          conversationSessionId: conversationSessionIdRef.current || '',
        });
      },
      onSessionGoAway: (goAway) => {
        const timeLeftRaw = goAway?.timeLeft ?? goAway?.time_left ?? '';
        const timeLeftMs = parseTimeLeftMs(timeLeftRaw);
        const nextSignature = currentSignature || appliedSessionSignature || null;
        const reconnectDelayMs = timeLeftMs == null
          ? GOAWAY_RECONNECT_FALLBACK_DELAY_MS
          : Math.max(
            GOAWAY_RECONNECT_MIN_DELAY_MS,
            Math.min(GOAWAY_RECONNECT_FALLBACK_DELAY_MS, timeLeftMs - GOAWAY_RECONNECT_BUFFER_MS),
          );
        recordConversationAction('model.session.goaway', {
          conversationSessionId: conversationSessionIdRef.current || '',
          timeLeft: timeLeftRaw,
          timeLeftMs: timeLeftMs ?? '',
          reconnectDelayMs,
        });
        if (!initialized || manualStopRef.current || status !== 'connected' || !nextSignature) {
          return;
        }
        if (pendingReconnectSignatureRef.current) {
          return;
        }
        pendingReconnectSignatureRef.current = nextSignature;
        setSessionShouldSendGreeting(false);
        clearAssistantPromptQueue('session-goaway');
        cancelAssistantOutputRef.current?.();
        clearGoAwayReconnectTimer();
        goAwayReconnectTimerRef.current = setTimeout(() => {
          goAwayReconnectTimerRef.current = null;
          if (manualStopRef.current) {
            pendingReconnectSignatureRef.current = null;
            return;
          }
          disconnect();
        }, reconnectDelayMs);
      },
  };

  const geminiSession = useGeminiLive(
    audioPlayer,
    runtimeConfig,
    voiceSessionCallbacks,
  );

  const yandexSession = useYandexVoiceSession(
    audioPlayer,
    runtimeConfig,
    voiceSessionCallbacks,
  );

  const activeVoiceSession = usesYandexRuntime ? yandexSession : geminiSession;
  const {
    status,
    connect,
    disconnect,
    error,
    getUserVolume: getLiveUserVolume,
    sendTextTurn,
    cancelAssistantOutput,
    clearSessionResumption,
  } = activeVoiceSession;

  useEffect(() => {
    sendTextTurnRef.current = sendTextTurn;
    drainAssistantPromptQueue();
  }, [drainAssistantPromptQueue, sendTextTurn]);

  useEffect(() => {
    cancelAssistantOutputRef.current = cancelAssistantOutput;
  }, [cancelAssistantOutput]);

  useEffect(() => {
    if (status === 'connected') {
      drainAssistantPromptQueue();
      return;
    }

    if (status === 'disconnected' || status === 'error') {
      clearAssistantPromptQueue('model-status-change');
    }
  }, [clearAssistantPromptQueue, drainAssistantPromptQueue, status]);

  const {
    status: sttStatus,
    error: sttError,
    disconnect: disconnectServerStt,
    getUserVolume: getServerSttUserVolume,
  } = useServerStt({
    enabled: initialized && status === 'connected' && Boolean(conversationSessionId) && !usesLiveInput && !usesYandexRuntime,
    conversationSessionId,
    language: 'ru-RU',
    onSpeechStart: () => {
      if (!speechStabilityConfig.immediateOnSpeechStart) {
        return;
      }
      if ((audioPlayer?.getVolume?.() || 0) > speechStabilityConfig.botVolumeGuard) {
        triggerBargeIn('bargein-stt');
      }
    },
    onPartialTranscript: handleLiveInputTranscription,
    onFinalTranscript: handleServerFinalTranscript,
  });

  useEffect(() => {
    if (!conversationSessionIdRef.current) {
      return;
    }

    if (sttStatus === 'connected') {
      recordConversationAction('stt.stream.ready', {
        conversationSessionId: conversationSessionIdRef.current,
        sttSessionId: `server-stt:${conversationSessionIdRef.current}`,
      });
      return;
    }

    if (sttStatus === 'error' && sttError) {
      recordConversationAction('stt.stream.error', {
        conversationSessionId: conversationSessionIdRef.current,
        error: sttError,
      });
    }
  }, [recordConversationAction, sttError, sttStatus]);

  useEffect(() => {
    preferServerSttRef.current = !usesLiveInput && sttStatus === 'connected';
  }, [sttStatus, usesLiveInput]);

  useEffect(() => () => {
    clearPendingServerFinal();
    clearPendingLiveFinal();
  }, [clearPendingLiveFinal, clearPendingServerFinal]);

  useEffect(() => {
    if (sttStatus !== 'connected') {
      clearPendingServerFinal();
    }
  }, [clearPendingServerFinal, sttStatus]);

  useEffect(() => {
    if (!usesLiveInput) {
      clearPendingLiveFinal();
    }
  }, [clearPendingLiveFinal, usesLiveInput]);

  const handleOrchestratedUserTurn = React.useCallback(async (transcript, { requestId = 0 } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
      ? requestId
      : activeDialogRequestRef.current;
    if (!normalized || !conversationSessionIdRef.current) {
      return;
    }
    if (effectiveRequestId !== activeDialogRequestRef.current) {
      return;
    }

    if (normalTurnInFlightRef.current) {
      pendingOrchestratedTurnRef.current = { text: normalized, requestId: effectiveRequestId };
      return;
    }

    normalTurnInFlightRef.current = true;
    markDialogRequestState(effectiveRequestId, 'runtime-turn-started', {
      textLength: normalized.length,
    });
    recordConversationAction('runtime.turn.orchestrated.start', {
      conversationSessionId: conversationSessionIdRef.current,
      textLength: normalized.length,
      hasActiveBrowserSession: Boolean(activeBrowserSessionIdRef.current),
    });

    try {
      if (assistantTurnCountRef.current > 0 && isGreetingOnlyTranscript(normalized)) {
        const sent = enqueueAssistantPrompt(buildGreetingAckPrompt(normalized), {
          source: 'runtime.greeting-ack',
          dedupeKey: `runtime-greeting-ack:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        if (!sent) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: 'greeting-ack',
          });
        }
        return;
      }

      const [knowledgeResult, activePageContext] = await Promise.all([
        queryKnowledgeForTurn(normalized).catch(() => ({ hits: [] })),
        getRuntimePageContextForTurn(normalized),
      ]);

      const knowledgeHits = Array.isArray(knowledgeResult?.hits) ? knowledgeResult.hits : [];
      recordConversationAction('runtime.turn.orchestrated.context', {
        conversationSessionId: conversationSessionIdRef.current,
        knowledgeHitCount: knowledgeHits.length,
        hasActivePageContext: Boolean(activePageContext?.url),
      });
      markDialogRequestState(effectiveRequestId, 'runtime-turn-context-ready', {
        knowledgeHitCount: knowledgeHits.length,
        hasActivePageContext: Boolean(activePageContext?.url),
      });
      if (effectiveRequestId !== activeDialogRequestRef.current) {
        return;
      }

      const exactPrayerReading = resolveExactPrayerReading(normalized, {
        knowledgeHits,
        activePageContext,
      });
      if (isPrayerRequest(normalized) && prayerReadMode === 'knowledge-only') {
        const prayerPrompt = exactPrayerReading
          ? buildExactPrayerReadingPrompt(normalized, exactPrayerReading)
          : buildPrayerSourceRequiredPrompt(normalized, {
            knowledgeHits,
            activePageContext,
          });
        const sentPrayerPrompt = enqueueAssistantPrompt(prayerPrompt, {
          source: exactPrayerReading ? 'runtime.prayer.exact' : 'runtime.prayer.source-required',
          dedupeKey: exactPrayerReading
            ? `runtime-prayer-read:${normalizeTranscriptKey(normalized)}`
            : `runtime-prayer-source:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
          priority: 'high',
        });
        if (!sentPrayerPrompt) {
          recordConversationAction('runtime.turn.orchestrated.fail', {
            conversationSessionId: conversationSessionIdRef.current,
            error: 'live-session-unavailable',
            reason: exactPrayerReading ? 'prayer-exact' : 'prayer-source',
          });
        }
        return;
      }

      const sent = enqueueAssistantPrompt(buildRuntimeTurnPrompt(normalized, {
        knowledgeHits,
        activePageContext,
        prayerReadMode,
        compactMode: isGemini31FlashLiveModel(selectedCharacter?.modelId || selectedCharacter?.voiceModelId),
      }), {
        source: 'runtime.turn',
        dedupeKey: `runtime-turn:${normalizeTranscriptKey(normalized)}`,
        requestId: effectiveRequestId,
      });

      if (!sent) {
        recordConversationAction('runtime.turn.orchestrated.fail', {
          conversationSessionId: conversationSessionIdRef.current,
          error: 'live-session-unavailable',
        });
      }
    } finally {
      normalTurnInFlightRef.current = false;
      if (pendingOrchestratedTurnRef.current?.text) {
        const pendingTurn = pendingOrchestratedTurnRef.current;
        pendingOrchestratedTurnRef.current = null;
        if (
          pendingTurn.requestId === activeDialogRequestRef.current
          && normalizeTranscriptKey(pendingTurn.text) !== normalizeTranscriptKey(normalized)
        ) {
          handleOrchestratedTurnRef.current?.(pendingTurn.text, { requestId: pendingTurn.requestId });
        }
      }
    }
  }, [
    enqueueAssistantPrompt,
    getRuntimePageContextForTurn,
    markDialogRequestState,
    selectedCharacter?.voiceModelId,
    queryKnowledgeForTurn,
    prayerReadMode,
    recordConversationAction,
  ]);

  useEffect(() => {
    handleOrchestratedTurnRef.current = (transcript, options = {}) => {
      void handleOrchestratedUserTurn(transcript, options);
    };
  }, [handleOrchestratedUserTurn]);

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearReloadWatchdog = React.useCallback(() => {
    if (reloadWatchdogTimerRef.current) {
      clearTimeout(reloadWatchdogTimerRef.current);
      reloadWatchdogTimerRef.current = null;
    }
  }, []);

  const clearGoAwayReconnectTimer = React.useCallback(() => {
    if (goAwayReconnectTimerRef.current) {
      clearTimeout(goAwayReconnectTimerRef.current);
      goAwayReconnectTimerRef.current = null;
    }
  }, []);

  const resetReconnectState = React.useCallback(() => {
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    clearReconnectTimer();
    clearReloadWatchdog();
    clearGoAwayReconnectTimer();
  }, [clearGoAwayReconnectTimer, clearReconnectTimer, clearReloadWatchdog]);

  const currentSignature = buildSignature(selectedCharacter, {
    speechStabilityProfile,
    prayerReadMode,
    safeSpeechFlowEnabled,
  });
  const sessionNeedsReconnect = status === 'connected' && Boolean(appliedSessionSignature) && appliedSessionSignature !== currentSignature;
  const isRecoveringConnection = initialized && reconnectAttempt > 0 && status !== 'connected';

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    if (status === 'connected') {
      resetReconnectState();
      return;
    }

    if (status === 'connecting') {
      clearReconnectTimer();
    }
  }, [clearReconnectTimer, resetReconnectState, status]);

  useEffect(() => {
    if (status !== 'disconnected' || !pendingReconnectSignatureRef.current) {
      return;
    }

    const nextSignature = pendingReconnectSignatureRef.current;
    pendingReconnectSignatureRef.current = null;
    setAppliedSessionSignature(nextSignature);
    const sessionId = conversationSessionIdRef.current;
    if (!sessionId) {
      connect();
      return;
    }

    void bootstrapConversationContext(sessionId, { shouldSendGreeting: false })
      .then((bootstrapText) => {
        connect({
          runtimeProvider,
          modelId: selectedCharacter?.modelId || selectedCharacter?.voiceModelId,
          voiceModelId: selectedCharacter?.voiceModelId || selectedCharacter?.modelId,
          voiceName: selectedCharacter?.voiceName,
          ttsVoiceName: selectedCharacter?.ttsVoiceName || selectedCharacter?.voiceName,
          systemPrompt: selectedCharacter?.systemPrompt,
          greetingText: selectedCharacter?.greetingText,
          sessionContextText: bootstrapText,
          shouldSendGreeting: false,
          captureUserAudio: usesLiveInput,
          voiceGatewayUrl: selectedCharacter?.voiceGatewayUrl || '',
          outputAudioTranscription: selectedCharacter?.outputAudioTranscription !== false,
          conversationSessionId: sessionId,
        });
      })
      .catch(() => {
        connect();
      });
  }, [bootstrapConversationContext, connect, selectedCharacter?.greetingText, selectedCharacter?.systemPrompt, selectedCharacter?.voiceGatewayUrl, selectedCharacter?.voiceModelId, selectedCharacter?.voiceName, status, usesLiveInput]);

  useEffect(() => {
    if (!initialized || manualStopRef.current || pendingReconnectSignatureRef.current) {
      return;
    }

    if (status !== 'error' && status !== 'disconnected') {
      return;
    }

    if (reconnectTimerRef.current) {
      return;
    }

    const nextAttempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = nextAttempt;
    setReconnectAttempt(nextAttempt);

    const delay = Math.min(
      AUTO_RECONNECT_MAX_DELAY_MS,
      AUTO_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(nextAttempt - 1, 4)),
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const sessionId = conversationSessionIdRef.current;
      if (!sessionId) {
        connect();
        return;
      }

      void bootstrapConversationContext(sessionId, { shouldSendGreeting: false })
        .then((bootstrapText) => {
          recordConversationAction('model.reconnect.restore', {
            attempt: nextAttempt,
            conversationSessionId: sessionId,
          });
          connect({
            runtimeProvider,
            modelId: selectedCharacter?.modelId || selectedCharacter?.voiceModelId,
            voiceModelId: selectedCharacter?.voiceModelId || selectedCharacter?.modelId,
            voiceName: selectedCharacter?.voiceName,
            ttsVoiceName: selectedCharacter?.ttsVoiceName || selectedCharacter?.voiceName,
            systemPrompt: selectedCharacter?.systemPrompt,
            greetingText: selectedCharacter?.greetingText,
            sessionContextText: bootstrapText,
            shouldSendGreeting: false,
            captureUserAudio: usesLiveInput,
            voiceGatewayUrl: selectedCharacter?.voiceGatewayUrl || '',
            outputAudioTranscription: selectedCharacter?.outputAudioTranscription !== false,
            conversationSessionId: sessionId,
          });
        })
        .catch(() => {
          connect();
        });
    }, delay);

    if (nextAttempt >= AUTO_RECONNECT_MAX_ATTEMPTS && !reloadWatchdogTimerRef.current) {
      reloadWatchdogTimerRef.current = setTimeout(() => {
        window.location.reload();
      }, RELOAD_WATCHDOG_TIMEOUT_MS);
    }
  }, [bootstrapConversationContext, connect, initialized, recordConversationAction, selectedCharacter?.greetingText, selectedCharacter?.systemPrompt, selectedCharacter?.voiceGatewayUrl, selectedCharacter?.voiceModelId, selectedCharacter?.voiceName, status, usesLiveInput]);

  useEffect(() => {
    if (!initialized || manualStopRef.current || status !== 'connecting') {
      return undefined;
    }

    const watchdogId = setTimeout(() => {
      disconnect();
    }, CONNECTING_WATCHDOG_TIMEOUT_MS);

    return () => clearTimeout(watchdogId);
  }, [disconnect, initialized, status]);

  useEffect(() => () => {
    clearReconnectTimer();
    clearReloadWatchdog();
    browserIntentAbortRef.current?.abort?.();
    clearAssistantPromptQueue('component-unmount');
  }, [clearAssistantPromptQueue, clearReconnectTimer, clearReloadWatchdog]);

  const commitConfig = async (nextConfig) => {
    try {
      const saved = await persistConfig(nextConfig);
      setSaveError(null);
      return saved;
    } catch (persistError) {
      setSaveError(persistError.message || 'Не удалось сохранить изменения');
      throw persistError;
    }
  };

  const handleStart = async () => {
    await audioPlayer.initialize();
    manualStopRef.current = false;
    resetReconnectState();
    clearSessionResumption();
    setInitialized(true);
    setLiveInputTranscript('');
    resetSessionRuntimeState();
    const nextConversationSessionId = buildConversationSessionId();
    await jsonRequest('/api/conversation/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationSessionId: nextConversationSessionId,
        characterId: selectedCharacter?.id || '',
      }),
    }, 10000);
    setConversationSessionId(nextConversationSessionId);
    conversationSessionIdRef.current = nextConversationSessionId;
    const inputSessionId = usesLiveInput
      ? `gemini-live-input:${nextConversationSessionId}`
      : `server-stt:${nextConversationSessionId}`;
    recordConversationAction('voice.input.start', {
      conversationSessionId: nextConversationSessionId,
      inputSessionId,
      mode: usesYandexRuntime ? 'yandex-local-vad' : (usesLiveInput ? 'gemini-live-input' : 'server-stt'),
    });
    updateConversationSessionState({
      activeSttSessionId: inputSessionId,
    });
    const bootstrapText = await bootstrapConversationContext(nextConversationSessionId, { shouldSendGreeting: true });
    setAppliedSessionSignature(currentSignature);
    connect({
      runtimeProvider,
      modelId: selectedCharacter?.modelId || selectedCharacter?.voiceModelId,
      voiceModelId: selectedCharacter?.voiceModelId || selectedCharacter?.modelId,
      voiceName: selectedCharacter?.voiceName,
      ttsVoiceName: selectedCharacter?.ttsVoiceName || selectedCharacter?.voiceName,
      systemPrompt: selectedCharacter?.systemPrompt,
      greetingText: selectedCharacter?.greetingText,
      sessionContextText: bootstrapText,
      shouldSendGreeting: true,
      captureUserAudio: usesLiveInput,
      voiceGatewayUrl: selectedCharacter?.voiceGatewayUrl || '',
      outputAudioTranscription: selectedCharacter?.outputAudioTranscription !== false,
      conversationSessionId: nextConversationSessionId,
    });
  };

  const handleStop = () => {
    const currentConversationSessionId = conversationSessionIdRef.current || '';
    if (activeDialogRequestRef.current > 0) {
      finalizeDialogRequest(activeDialogRequestRef.current, 'session-stopped');
    }
    recordConversationAction('session.stop.request', {
      conversationSessionId: currentConversationSessionId,
    });
    recordConversationAction('voice.input.closed', {
      conversationSessionId: currentConversationSessionId,
      inputSessionId: currentConversationSessionId
        ? `${usesLiveInput ? 'gemini-live-input' : 'server-stt'}:${currentConversationSessionId}`
        : '',
      mode: usesLiveInput ? 'gemini-live-input' : 'server-stt',
    });
    manualStopRef.current = true;
    cancelPendingBrowserWork('manual-stop');
    clearAssistantPromptQueue('manual-stop');
    cancelAssistantOutputRef.current?.();
    browserIntentAbortRef.current?.abort?.();
    resetReconnectState();
    pendingReconnectSignatureRef.current = null;
    clearSessionResumption();
    updateConversationSessionState({
      activeSttSessionId: '',
    });
    if (currentConversationSessionId) {
      void fetch(`/api/conversation/session/${encodeURIComponent(currentConversationSessionId)}/close`, {
        method: 'POST',
      }).catch(() => {});
    }
    disconnectServerStt();
    disconnect();
    setInitialized(false);
    setLiveInputTranscript('');
    resetSessionRuntimeState();
    recordConversationAction('session.teardown.complete', {
      conversationSessionId: currentConversationSessionId,
    });
    setAppliedSessionSignature(null);
    setConversationSessionId('');
    conversationSessionIdRef.current = '';
    audioPlayer.close();
  };

  const handleCharacterStep = async (direction) => {
    if (!config?.characters?.length) return;

    const currentIndex = config.characters.findIndex((character) => character.id === config.activeCharacterId);
    const nextIndex = (currentIndex + direction + config.characters.length) % config.characters.length;
    const nextConfig = {
      ...config,
      activeCharacterId: config.characters[nextIndex].id,
    };
    await commitConfig(nextConfig);
  };

  const handleThemeToggle = async () => {
    if (!config) return;

    await commitConfig({
      ...config,
      themeMode: themeMode === 'dark' ? 'light' : 'dark',
    });
  };

  const handleFullscreenToggle = React.useCallback(async () => {
    if (typeof document === 'undefined') {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await document.documentElement.requestFullscreen();
    } catch (error) {
      console.warn('Fullscreen toggle failed', error);
    }
  }, []);

  const handleSaveSettings = async () => {
    if (!config || !settingsDraft || !selectedCharacter) return;

    const nextConfig = {
      ...config,
      characters: config.characters.map((character) => (
        character.id === selectedCharacter.id
          ? { ...character, ...settingsDraft }
          : character
      )),
    };

    const savedConfig = await commitConfig(nextConfig);
    const savedCharacter = savedConfig?.characters?.find((character) => character.id === selectedCharacter.id);
    const nextSignature = buildSignature(savedCharacter, {
      speechStabilityProfile: savedConfig?.speechStabilityProfile,
      prayerReadMode: savedConfig?.prayerReadMode,
      safeSpeechFlowEnabled: savedConfig?.safetySwitches?.safeSpeechFlowEnabled !== false,
    });

    if (status === 'connected' && nextSignature && nextSignature !== appliedSessionSignature) {
      pendingReconnectSignatureRef.current = nextSignature;
      setLiveInputTranscript('');
      resetSessionRuntimeState();
      disconnect();
    }

    setSettingsOpen(false);
  };

  const handleOpenSettings = () => {
    setSettingsDraft(selectedCharacter);
    setSettingsOpen(true);
  };

  const handleAvatarStageClick = React.useCallback(() => {
    const now = Date.now();
    const recent = avatarQuickTapTimestampsRef.current.filter((timestamp) => now - timestamp <= AVATAR_QUICK_TAP_WINDOW_MS);
    recent.push(now);
    avatarQuickTapTimestampsRef.current = recent;

    if (recent.length < AVATAR_QUICK_TAP_COUNT) {
      return;
    }

    avatarQuickTapTimestampsRef.current = [];
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const clearPendingClientPanelLoad = React.useCallback(() => {
    const timerId = pendingClientPanelLoadRef.current?.timerId;
    if (timerId) {
      clearTimeout(timerId);
    }
    pendingClientPanelLoadRef.current = {
      requestId: 0,
      transcript: '',
      actionType: '',
      targetUrl: '',
      timerId: null,
      frameLoaded: false,
      contextReady: false,
    };
  }, []);

  const failPendingClientPanelLoad = React.useCallback((errorText, fallbackRequestId = 0) => {
    const pending = pendingClientPanelLoadRef.current;
    const requestId = Number.isInteger(pending?.requestId) && pending.requestId > 0
      ? pending.requestId
      : fallbackRequestId;
    const transcript = normalizeSpeechText(pending?.transcript || '');
    const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;

    clearPendingClientPanelLoad();
    setBrowserFlowPhase('error');
    setBrowserPanel((current) => ({
      ...current,
      status: 'error',
      clientFrameLoaded: false,
      clientContextStatus: 'error',
      clientContextError: errorText,
      error: errorText,
      note: '',
    }));

    if (transcript) {
      appendSessionWebHistory({
        status: 'failed',
        transcript,
        title: panelState.title || 'Сайт',
        url: panelState.url || panelState.clientUrl || '',
        note: errorText,
      });
    }

    sendBrowserClientEvent('browser.inline.error', {
      requestId,
      transcript,
      url: panelState.url || panelState.clientUrl || '',
      error: errorText,
    });

    if (transcript && requestId > 0) {
      enqueueAssistantPrompt(buildWebFailurePrompt(
        transcript,
        errorText,
        getSessionHistorySummary(),
      ), {
        source: 'browser.inline.error',
        dedupeKey: `browser-inline-error:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(panelState.url || panelState.clientUrl || '')}`,
        requestId,
      });
    }

    if (requestId > 0) {
      finalizeDialogRequest(requestId, 'browser-inline-error');
    }
  }, [
    appendSessionWebHistory,
    clearPendingClientPanelLoad,
    enqueueAssistantPrompt,
    finalizeDialogRequest,
    getSessionHistorySummary,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
  ]);

  const finalizePendingClientPanelLoad = React.useCallback(() => {
    const pending = pendingClientPanelLoadRef.current;
    const requestId = Number(pending?.requestId || 0);
    if (requestId > 0 && requestId !== activeDialogRequestRef.current) {
      clearPendingClientPanelLoad();
      return false;
    }

    const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;
    const transcript = normalizeSpeechText(pending.transcript || '');
    const contextReady = panelState.clientContextStatus === 'ready';
    const prompt = pending.actionType === 'action'
      ? (
        contextReady
          ? buildWebActionPrompt(transcript, panelState, getSessionHistorySummary())
          : buildWebClientPendingPrompt(transcript, panelState, getSessionHistorySummary())
      )
      : (
        contextReady
          ? buildWebResultPrompt(transcript, panelState, getSessionHistorySummary())
          : buildWebClientResultPrompt(transcript, panelState, getSessionHistorySummary())
      );

    if (pending.actionType !== 'action') {
      appendSessionWebHistory({
        status: 'opened',
        transcript,
        title: panelState.title || 'Сайт',
        url: panelState.url || panelState.clientUrl || '',
        note: contextReady ? '' : 'Страница показана, текст ещё дочитывается.',
      });
    }

    setBrowserFlowPhase('ready');
    setBrowserPanel((current) => ({
      ...current,
      status: 'ready',
      clientFrameLoaded: true,
      error: null,
      note: contextReady ? '' : 'Сайт открыт внизу. Текст страницы ещё дочитывается.',
    }));

    sendBrowserClientEvent(
      pending.actionType === 'action' ? 'browser.action.complete' : 'browser.open.ready',
      {
        requestId,
        browserPanelMode: 'client-inline',
        title: panelState.title || '',
        url: panelState.url || panelState.clientUrl || '',
        panelConfirmed: true,
        contextReady,
      },
    );

    markDialogRequestState(
      requestId,
      pending.actionType === 'action' ? 'browser-action-ready' : 'browser-open-ready',
      {
        browserPanelMode: 'client-inline',
        panelConfirmed: true,
        contextReady,
      },
    );

    if (transcript && requestId > 0) {
      enqueueAssistantPrompt(prompt, {
        source: pending.actionType === 'action' ? 'browser.inline.action.ready' : 'browser.inline.open.ready',
        dedupeKey: `${pending.actionType || 'open'}:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(panelState.url || panelState.clientUrl || '')}`,
        requestId,
      });

      finalizeDialogRequest(requestId, pending.actionType === 'action' ? 'browser-action-ready' : 'browser-open-ready', {
        browserPanelMode: 'client-inline',
        contextReady,
      });
    }
    clearPendingClientPanelLoad();
    return true;
  }, [
    appendSessionWebHistory,
    clearPendingClientPanelLoad,
    enqueueAssistantPrompt,
    finalizeDialogRequest,
    getSessionHistorySummary,
    markDialogRequestState,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
  ]);

  const armPendingClientPanelLoad = React.useCallback(({
    requestId,
    transcript,
    actionType = 'open',
    targetUrl,
  }) => {
    clearPendingClientPanelLoad();
    const timerId = window.setTimeout(() => {
      failPendingClientPanelLoad('Не удалось вовремя показать сайт внутри панели.', requestId);
    }, CLIENT_INLINE_LOAD_TIMEOUT_MS);
    pendingClientPanelLoadRef.current = {
      requestId,
      transcript,
      actionType,
      targetUrl: String(targetUrl || '').trim(),
      timerId,
      frameLoaded: false,
      contextReady: false,
    };
  }, [clearPendingClientPanelLoad, failPendingClientPanelLoad]);

  const performBrowserAction = React.useCallback(async (actionRequest, transcript = '', { requestId = 0 } = {}) => {
    if (usesClientInlinePanel && browserPanelRef.current?.clientUrl) {
      const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
        ? requestId
        : (normalizeSpeechText(transcript) ? activeDialogRequestRef.current : 0);
      const supportedClientActions = new Set(['back', 'forward', 'home', 'reload']);
      if (!supportedClientActions.has(String(actionRequest?.type || '').trim())) {
        throw new Error('Во встроенной панели сейчас доступны только назад, вперёд, главная и обновить.');
      }

      const currentPanel = browserPanelRef.current || DEFAULT_PANEL_STATE;
      const history = Array.isArray(currentPanel.clientHistory) ? currentPanel.clientHistory : [];
      const currentIndex = Number.isInteger(currentPanel.clientHistoryIndex) ? currentPanel.clientHistoryIndex : -1;
      let nextUrl = String(currentPanel.clientUrl || currentPanel.url || '').trim();
      let nextHistory = [...history];
      let nextHistoryIndex = currentIndex;

      if (actionRequest.type === 'back') {
        if (currentIndex <= 0) {
          throw new Error('Назад переходить уже некуда.');
        }
        nextHistoryIndex = currentIndex - 1;
        nextUrl = nextHistory[nextHistoryIndex];
      } else if (actionRequest.type === 'forward') {
        if (currentIndex < 0 || currentIndex >= nextHistory.length - 1) {
          throw new Error('Вперёд переходить уже некуда.');
        }
        nextHistoryIndex = currentIndex + 1;
        nextUrl = nextHistory[nextHistoryIndex];
      } else if (actionRequest.type === 'home') {
        nextUrl = String(currentPanel.clientHomeUrl || nextUrl).trim();
        if (!nextUrl) {
          throw new Error('Не знаю, какая страница здесь главная.');
        }
        nextHistory = nextHistory.slice(0, Math.max(0, currentIndex) + 1);
        if (nextHistory[nextHistory.length - 1] !== nextUrl) {
          nextHistory.push(nextUrl);
        }
        nextHistoryIndex = nextHistory.length - 1;
      }

      if (!nextUrl) {
        throw new Error('Не удалось определить адрес страницы для этого действия.');
      }

      setBrowserFlowPhase('opening');
      setBrowserPanel((current) => ({
        ...current,
        status: 'loading',
        browserPanelMode: 'client-inline',
        clientUrl: nextUrl,
        url: nextUrl,
        clientHistory: nextHistory,
        clientHistoryIndex: nextHistoryIndex,
        clientReloadKey: Date.now(),
        clientFrameLoaded: false,
        clientContextStatus: 'loading',
        clientContextError: '',
        error: null,
        note: 'Обновляю страницу внизу.',
      }));
      armPendingClientPanelLoad({
        requestId: effectiveRequestId,
        transcript,
        actionType: 'action',
        targetUrl: nextUrl,
      });
      sendBrowserClientEvent('browser.action.request', {
        browserPanelMode: 'client-inline',
        actionType: actionRequest?.type || '',
        transcript,
        requestId: effectiveRequestId,
        url: nextUrl,
      });
      recordConversationAction('browser.action.request', {
        browserPanelMode: 'client-inline',
        actionType: actionRequest?.type || '',
        transcript,
        requestId: effectiveRequestId,
        url: nextUrl,
      });

      void requestClientInlineContext(nextUrl, 'что сейчас находится на открытой странице', {
        requestId: effectiveRequestId,
      })
        .then((contextResult) => {
          if (effectiveRequestId !== activeDialogRequestRef.current) {
            return;
          }
          if (contextResult?.embeddable === false) {
            failPendingClientPanelLoad('Этот сайт запрещает показывать себя внутри панели.', effectiveRequestId);
            return;
          }
          setBrowserPanel((current) => ({
            ...current,
            title: contextResult?.title || current.title,
            url: contextResult?.url || current.url,
            embeddable: contextResult?.embeddable !== false,
            readerText: contextResult?.readerText || current.readerText,
            lastUpdated: contextResult?.lastUpdated || current.lastUpdated,
            clientContextStatus: 'ready',
            clientContextError: '',
            error: null,
          }));
          if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
            pendingClientPanelLoadRef.current.contextReady = true;
            if (pendingClientPanelLoadRef.current.frameLoaded) {
              finalizePendingClientPanelLoad();
            }
          }
        })
        .catch((contextError) => {
          if (effectiveRequestId !== activeDialogRequestRef.current) {
            return;
          }
          setBrowserPanel((current) => ({
            ...current,
            clientContextStatus: 'error',
            clientContextError: contextError.message || 'Не удалось быстро прочитать страницу.',
            note: current.clientFrameLoaded
              ? 'Сайт открыт внизу. Текст страницы прочитать не удалось.'
              : current.note,
          }));
          if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
            if (pendingClientPanelLoadRef.current.frameLoaded) {
              finalizePendingClientPanelLoad();
            }
          }
        });

      return {
        status: 'ready',
        url: nextUrl,
      };
    }

    const sessionId = activeBrowserSessionIdRef.current;
    if (!sessionId) {
      throw new Error('Нет активного сайта для действия');
    }
    const effectiveRequestId = Number.isInteger(requestId) && requestId > 0
      ? requestId
      : activeDialogRequestRef.current;
    const isStaleRequest = () => effectiveRequestId > 0 && effectiveRequestId !== activeDialogRequestRef.current;
    if (isStaleRequest()) {
      return null;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: 'loading',
      sourceType: 'page-action',
    }));
    cancelAssistantOutput();
    setBrowserFlowPhase('opening');
    sendBrowserClientEvent('browser.action.request', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      transcript,
    });
    recordConversationAction('browser.action.request', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      transcript,
    });

    const actionResult = await jsonRequest(`/api/browser/session/${encodeURIComponent(sessionId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...actionRequest,
        conversationSessionId: conversationSessionIdRef.current || '',
        characterId: selectedCharacter?.id || '',
        requestId: effectiveRequestId,
      }),
    }, BROWSER_ACTION_TIMEOUT_MS);
    if (isStaleRequest()) {
      return null;
    }

    setBrowserPanel((current) => ({
      ...current,
      status: 'ready',
      title: actionResult.title || current.title,
      url: actionResult.url || current.url,
      screenshotUrl: actionResult.imageUrl || current.screenshotUrl,
      view: {
        imageUrl: actionResult.imageUrl || '',
        width: actionResult.width || 0,
        height: actionResult.height || 0,
        revision: actionResult.revision || 0,
        actionableElements: Array.isArray(actionResult.actionableElements) ? actionResult.actionableElements : [],
      },
      revision: actionResult.revision || current.revision || 0,
      actionableElements: Array.isArray(actionResult.actionableElements) ? actionResult.actionableElements : current.actionableElements,
      error: null,
    }));
    setBrowserFlowPhase('ready');

    const contextResult = await requestActiveBrowserContext('что сейчас находится на открытой странице', {
      requestId: effectiveRequestId,
    });
    if (isStaleRequest()) {
      return null;
    }
    sendBrowserClientEvent('browser.action.complete', {
      browserSessionId: sessionId,
      actionType: actionRequest?.type || '',
      url: contextResult?.url || actionResult?.url || '',
      title: contextResult?.title || actionResult?.title || '',
    });
    if (transcript) {
      enqueueAssistantPrompt(buildWebActionPrompt(transcript, contextResult, getSessionHistorySummary()), {
        source: 'browser.action.result',
        dedupeKey: `action:${normalizeTranscriptKey(transcript)}:${normalizeTranscriptKey(actionRequest?.type || '')}`,
        requestId: effectiveRequestId,
      });
    }
    return contextResult;
  }, [
    armPendingClientPanelLoad,
    cancelAssistantOutput,
    enqueueAssistantPrompt,
    failPendingClientPanelLoad,
    finalizePendingClientPanelLoad,
    getSessionHistorySummary,
    recordConversationAction,
    requestActiveBrowserContext,
    requestClientInlineContext,
    selectedCharacter?.id,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    usesClientInlinePanel,
  ]);

  const handleBrowserTranscript = React.useCallback(async (transcript, { requestId: dialogRequestId = 0 } = {}) => {
    const normalized = normalizeSpeechText(transcript);
    const effectiveRequestId = Number.isInteger(dialogRequestId) && dialogRequestId > 0
      ? dialogRequestId
      : activeDialogRequestRef.current;
    if (!normalized) return;
    if (effectiveRequestId !== activeDialogRequestRef.current) {
      return;
    }
    markDialogRequestState(effectiveRequestId, 'browser-routing', {
      transcript: truncatePromptValue(normalized, 180),
    });

    if (isAssistantBrowserNarration(normalized)) {
      return;
    }

    const hasClientInlineSession = usesClientInlinePanel && Boolean(browserPanelRef.current?.clientUrl);
    const hasActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current);
    const hasAnyBrowserSession = hasActiveBrowserSession || hasClientInlineSession;
    let intentType = classifyTranscriptIntent(normalized);
    if (hasAnyBrowserSession && parseImplicitBrowserActionRequest(normalized)) {
      intentType = 'browser_action';
    }
    if (intentType === 'browser_action') {
      let browserActionRequest = parseBrowserActionRequest(normalized);
      if (!browserActionRequest && hasActiveBrowserSession) {
        browserActionRequest = parseImplicitBrowserActionRequest(normalized);
      }
      if (!browserActionRequest || browserIntentInFlightRef.current) {
        return;
      }

      if (!activeBrowserSessionIdRef.current && !hasClientInlineSession) {
        const canFallbackToSiteOpen = browserActionRequest.type === 'home'
          && (hasExplicitMainPageSiteTarget(normalized)
            || /\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(normalized)
            || /\bhttps?:\/\/[^\s]+/i.test(normalized)
            || /\bточка\s*(?:by|ru)\b/i.test(normalized));
        if (canFallbackToSiteOpen) {
          // User likely means opening the main page of some site, not navigating inside an active one.
          intentType = 'site_open';
        } else {
          const errorText = 'Сейчас сайт не открыт. Скажите, какой сайт открыть.';
          setBrowserFlowPhase('error');
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: errorText,
          });
          enqueueAssistantPrompt(buildWebFailurePrompt(
            normalized,
            errorText,
            getSessionHistorySummary(),
          ), {
            source: 'browser.action.no-session',
            dedupeKey: `browser-action-no-session:${normalizeTranscriptKey(normalized)}`,
            requestId: effectiveRequestId,
          });
          finalizeDialogRequest(effectiveRequestId, 'browser-no-session');
          return;
        }
      }

      if (activeBrowserSessionIdRef.current || hasClientInlineSession) {
        browserIntentInFlightRef.current = true;
        inFlightBrowserKeyRef.current = 'page-action';
        clearAssistantPromptQueue('browser-action');
        cancelAssistantOutput();
        try {
          await performBrowserAction(browserActionRequest, normalized, { requestId: effectiveRequestId });
        } catch (actionError) {
          setBrowserFlowPhase('error');
          setBrowserPanel((current) => ({
            ...current,
            status: 'error',
            error: actionError.message || 'Не удалось выполнить действие на странице',
          }));
          enqueueAssistantPrompt(buildWebFailurePrompt(
            normalized,
            actionError.message || 'Не удалось выполнить действие на странице',
            getSessionHistorySummary(),
          ), {
            source: 'browser.action.error',
            dedupeKey: `browser-action-error:${normalizeTranscriptKey(normalized)}`,
            requestId: effectiveRequestId,
          });
        } finally {
          browserIntentInFlightRef.current = false;
          inFlightBrowserKeyRef.current = '';
        }
        return;
      }
    }

    if (intentType === 'page_query') {
      if ((!activeBrowserSessionIdRef.current && !hasClientInlineSession) || browserIntentInFlightRef.current) {
        return;
      }

      browserIntentInFlightRef.current = true;
      inFlightBrowserKeyRef.current = 'context-followup';
      clearAssistantPromptQueue('browser-followup');
      cancelAssistantOutput();
      sendBrowserClientEvent('browser.followup.started', {
        browserSessionId: activeBrowserSessionIdRef.current,
        question: normalized,
      });

      try {
        if (hasClientInlineSession) {
          const panelState = browserPanelRef.current || DEFAULT_PANEL_STATE;
          if (panelState.status === 'loading' || panelState.clientContextStatus === 'loading') {
            enqueueAssistantPrompt(buildWebClientPendingPrompt(normalized, panelState, getSessionHistorySummary()), {
              source: 'browser.followup.pending',
              dedupeKey: `browser-followup-pending:${normalizeTranscriptKey(normalized)}`,
              requestId: effectiveRequestId,
            });
            markDialogRequestState(effectiveRequestId, 'browser-followup-pending');
            return;
          }
        }
        const contextResult = hasClientInlineSession
          ? await requestClientInlineContext(browserPanelRef.current?.clientUrl, normalized, {
            requestId: effectiveRequestId,
          })
          : await requestActiveBrowserContext(normalized, {
            requestId: effectiveRequestId,
          });
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }
        sendBrowserClientEvent('browser.followup.ready', {
          browserSessionId: contextResult?.browserSessionId || activeBrowserSessionIdRef.current,
          url: contextResult?.url || '',
          title: contextResult?.title || '',
          browserPanelMode: hasClientInlineSession ? 'client-inline' : 'remote',
        });
        enqueueAssistantPrompt(buildWebActivePrompt(normalized, contextResult, getSessionHistorySummary()), {
          source: 'browser.followup.ready',
          dedupeKey: `browser-followup:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        markDialogRequestState(effectiveRequestId, 'browser-followup-ready');
      } catch (contextError) {
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }
        sendBrowserClientEvent('browser.followup.error', {
          browserSessionId: activeBrowserSessionIdRef.current,
          browserPanelMode: hasClientInlineSession ? 'client-inline' : 'remote',
          question: normalized,
          error: contextError.message || 'Не удалось прочитать текущую страницу',
        });
        enqueueAssistantPrompt(buildWebFailurePrompt(
          normalized,
          contextError.message || 'Не удалось прочитать текущую страницу',
          getSessionHistorySummary(),
        ), {
          source: 'browser.followup.error',
          dedupeKey: `browser-followup-error:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'browser-followup-error');
      } finally {
        browserIntentInFlightRef.current = false;
        inFlightBrowserKeyRef.current = '';
      }
      return;
    }

    if (intentType !== 'site_open') {
      return;
    }

    const dedupeKey = buildBrowserIntentKey(normalized);
    const now = Date.now();
    const lastBrowserCommand = lastBrowserCommandRef.current;
    const isEchoOfRecentBrowserAction = (
      now < browserSpeechGuardUntilRef.current
      && Boolean(lastBrowserCommand.key)
      && isSimilarIntentKey(dedupeKey, lastBrowserCommand.key)
    );

    if (isEchoOfRecentBrowserAction) {
      return;
    }

    if (browserIntentInFlightRef.current) {
      return;
    }

    handledTranscriptsRef.current = handledTranscriptsRef.current.filter((entry) => now - entry.timestamp < 15000);
    if (handledTranscriptsRef.current.some((entry) => isSimilarIntentKey(entry.key, dedupeKey))) {
      return;
    }

    const hadActiveBrowserSession = Boolean(activeBrowserSessionIdRef.current);
    browserIntentInFlightRef.current = true;
    inFlightBrowserKeyRef.current = dedupeKey;
    clearAssistantPromptQueue('browser-site-intent');
    cancelAssistantOutput();
    handledTranscriptsRef.current.push({ key: dedupeKey, timestamp: now });
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    browserFlowRequestIdRef.current = requestId;
    markDialogRequestState(effectiveRequestId, 'browser-intent-started', { browserRequestId: requestId });
    setBrowserFlowPhase('intent_pending');
    setBrowserPanel((current) => ({
      ...current,
      status: 'loading',
      title: buildEarlyBrowserLoadingTitle(normalized),
      sourceType: 'intent-pending',
      error: null,
    }));
    browserTraceCounterRef.current += 1;
    const traceId = `browser-${Date.now().toString(36)}-${browserTraceCounterRef.current.toString(36)}`;
    sendBrowserClientEvent('browser.intent.started', {
      requestId,
      traceId,
      transcript: normalized,
      dedupeKey,
      activeCharacterId: selectedCharacter?.id || '',
      dialogRequestId: effectiveRequestId,
    });

    try {
      let intent;
      try {
        intent = await detectBrowserIntentWithRetry({
          requestId,
          traceId,
          transcript: normalized,
          dedupeKey,
        });
      } catch (requestError) {
        if (browserFlowRequestIdRef.current !== requestId) {
          return;
        }
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }
        browserFlowRequestIdRef.current = 0;
        browserSpeechGuardUntilRef.current = now + 2500;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({
            ...current,
            status: 'ready',
            error: null,
          }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
        }
        const errorReason = classifyIntentErrorReason(requestError);
        const errorMessage = errorReason === 'resolve_timeout'
          ? 'Не успела определить сайт вовремя. Повторите запрос точнее.'
          : (requestError.message || 'Не удалось определить browser intent');
        if (!(hadActiveBrowserSession && activeBrowserSessionIdRef.current)) {
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: errorMessage,
          });
        }
        sendBrowserClientEvent('browser.intent.error', {
          requestId,
          traceId,
          transcript: normalized,
          error: errorMessage,
          errorReason,
        });
        enqueueAssistantPrompt(buildWebFailurePrompt(
          normalized,
          errorMessage,
          getSessionHistorySummary(),
        ), {
          source: 'browser.intent.error',
          dedupeKey: `browser-intent-error:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'browser-intent-error', { browserRequestId: requestId });
        return;
      }

      if (browserFlowRequestIdRef.current !== requestId) {
        return;
      }
      if (effectiveRequestId !== activeDialogRequestRef.current) {
        return;
      }
      sendBrowserClientEvent('browser.intent.result', {
        requestId,
        traceId,
        intentType: intent?.intentType || intent?.type || 'none',
        url: intent?.url || '',
        confidence: intent?.confidence ?? 0,
        confidenceMargin: intent?.confidenceMargin ?? 0,
        resolutionSource: intent?.resolutionSource || '',
        candidateCount: intent?.candidateCount ?? 0,
      });

      if (!intent || intent.type === 'none') {
        browserFlowRequestIdRef.current = 0;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({
            ...current,
            status: 'ready',
            error: null,
          }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: 'Не получилось понять, какой сайт или страницу нужно открыть.',
          });
        }
        sendBrowserClientEvent('browser.intent.unresolved', {
          requestId,
          traceId,
          transcript: normalized,
        });
        enqueueAssistantPrompt(buildWebFailurePrompt(
          normalized,
          'Не получилось понять, какой сайт или страницу нужно открыть.',
          getSessionHistorySummary(),
        ), {
          source: 'browser.intent.none',
          dedupeKey: `browser-intent-none:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'browser-intent-unresolved', { browserRequestId: requestId });
        return;
      }

      if (intent.type === 'unresolved-site') {
        browserFlowRequestIdRef.current = 0;
        browserSpeechGuardUntilRef.current = now + 2500;
        if (hadActiveBrowserSession && activeBrowserSessionIdRef.current) {
          setBrowserFlowPhase('ready');
          setBrowserPanel((current) => ({
            ...current,
            status: 'ready',
            error: null,
          }));
          void refreshBrowserView(true).catch(() => {});
        } else {
          setBrowserFlowPhase('error');
        }
        appendSessionWebHistory({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          note: intent.error || 'Не удалось определить сайт',
        });
        if (!(hadActiveBrowserSession && activeBrowserSessionIdRef.current)) {
          setBrowserPanel({
            ...DEFAULT_PANEL_STATE,
            status: 'error',
            error: intent.error || 'Не распознала сайт',
          });
        }
        sendBrowserClientEvent('browser.intent.unresolved', {
          requestId,
          traceId,
          transcript: normalized,
          error: intent.error || 'Не распознала сайт',
          errorReason: intent.errorReason || 'resolve_low_confidence',
        });
        enqueueAssistantPrompt(buildWebFailurePrompt(normalized, intent.error, getSessionHistorySummary()), {
          source: 'browser.intent.unresolved',
          dedupeKey: `browser-intent-unresolved:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'browser-intent-unresolved', { browserRequestId: requestId });
        return;
      }

      const resolvedTraceId = intent.traceId || traceId;
      lastBrowserCommandRef.current = { key: dedupeKey, transcript: normalized, timestamp: now };
      browserSpeechGuardUntilRef.current = now + 6000;
      setBrowserFlowPhase('opening');
      setBrowserPanel((current) => ({
        ...buildClientPanelState(intent, current, {
          status: 'loading',
          note: usesClientInlinePanel ? 'Открываю сайт внизу.' : 'Открываю сайт у пользователя.',
          browserPanelMode: usesClientInlinePanel ? 'client-inline' : 'remote',
        }),
        error: null,
      }));
      sendBrowserClientEvent('browser.opening', {
        requestId,
        traceId: resolvedTraceId,
        url: intent.url || '',
        sourceType: intent.sourceType || intent.type || '',
        browserPanelMode: usesClientInlinePanel ? 'client-inline' : 'remote',
      });

      if (usesClientInlinePanel) {
        setActiveBrowserSessionId('');
        activeBrowserSessionIdRef.current = '';
        armPendingClientPanelLoad({
          requestId: effectiveRequestId,
          transcript: normalized,
          actionType: 'open',
          targetUrl: intent.url || '',
        });

        void requestClientInlineContext(intent.url || '', 'что сейчас находится на открытой странице', {
          requestId: effectiveRequestId,
        })
          .then((contextResult) => {
            if (effectiveRequestId !== activeDialogRequestRef.current) {
              return;
            }
            if (contextResult?.embeddable === false) {
              failPendingClientPanelLoad('Этот сайт запрещает показывать себя внутри панели.', effectiveRequestId);
              return;
            }
            setBrowserPanel((current) => ({
              ...current,
              title: contextResult?.title || current.title,
              url: contextResult?.url || current.url,
              embeddable: contextResult?.embeddable !== false,
              readerText: contextResult?.readerText || current.readerText,
              lastUpdated: contextResult?.lastUpdated || current.lastUpdated,
              clientContextStatus: 'ready',
              clientContextError: '',
              error: null,
            }));
            if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
              pendingClientPanelLoadRef.current.contextReady = true;
              if (pendingClientPanelLoadRef.current.frameLoaded) {
                finalizePendingClientPanelLoad();
              }
            }
          })
          .catch((contextError) => {
            if (effectiveRequestId !== activeDialogRequestRef.current) {
              return;
            }
            setBrowserPanel((current) => ({
              ...current,
              clientContextStatus: 'error',
              clientContextError: contextError.message || 'Не удалось быстро прочитать страницу.',
              note: current.clientFrameLoaded
                ? 'Сайт открыт внизу. Текст страницы прочитать не удалось.'
                : current.note,
            }));
            if (pendingClientPanelLoadRef.current?.requestId === effectiveRequestId) {
              if (pendingClientPanelLoadRef.current.frameLoaded) {
                finalizePendingClientPanelLoad();
              }
            }
          });
        return;
      }

      try {
        const opened = await jsonRequest('/api/browser/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...intent,
            traceId: resolvedTraceId,
            conversationSessionId: conversationSessionIdRef.current || '',
            characterId: selectedCharacter?.id || '',
            requestId: effectiveRequestId,
          }),
        }, BROWSER_OPEN_TIMEOUT_MS);

        if (browserRequestIdRef.current !== requestId) {
          return;
        }
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }

        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        const nextSessionId = String(opened?.browserSessionId || '');
        if (!nextSessionId) {
          throw new Error('Сервер не передал данные открытого сайта. Проверьте подключение API.');
        }
        setBrowserFlowPhase('ready');
        setBrowserPanel((current) => ({
          ...current,
          ...opened,
          status: 'ready',
          view: opened.view || current.view || null,
          revision: opened.revision || current.revision || 0,
          actionableElements: Array.isArray(opened?.view?.actionableElements)
            ? opened.view.actionableElements
            : (current.actionableElements || []),
          error: null,
        }));
        setActiveBrowserSessionId(nextSessionId);
        activeBrowserSessionIdRef.current = nextSessionId;
        await waitForNextPaint();
        let confirmedOpen = {
          ...opened,
        };
        let panelConfirmed = Boolean(opened?.view?.imageUrl || opened?.screenshotUrl || opened?.browserSessionId);
        try {
          const view = await jsonRequest(
            `/api/browser/session/${encodeURIComponent(nextSessionId)}/view?refresh=1`,
            { method: 'GET' },
            BROWSER_ACTION_TIMEOUT_MS,
          );
          if (browserRequestIdRef.current !== requestId) {
            return;
          }
          confirmedOpen = {
            ...confirmedOpen,
            ...view,
            browserSessionId: nextSessionId,
            screenshotUrl: view.imageUrl || confirmedOpen.screenshotUrl || null,
            view: {
              imageUrl: view.imageUrl || '',
              width: view.width || 0,
              height: view.height || 0,
              revision: view.revision || 0,
              actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
            },
          };
          panelConfirmed = true;
          setBrowserPanel((current) => ({
            ...current,
            status: 'ready',
            title: view.title || current.title,
            url: view.url || current.url,
            screenshotUrl: view.imageUrl || current.screenshotUrl,
            view: {
              imageUrl: view.imageUrl || '',
              width: view.width || 0,
              height: view.height || 0,
              revision: view.revision || 0,
              actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : [],
            },
            revision: view.revision || current.revision || 0,
            actionableElements: Array.isArray(view.actionableElements) ? view.actionableElements : current.actionableElements,
            error: null,
          }));
          await waitForNextPaint();
        } catch (viewError) {
          recordConversationAction('browser.open.view-warning', {
            requestId,
            browserSessionId: nextSessionId,
            error: viewError.message || 'browser view refresh failed',
          });
        }
        appendSessionWebHistory({
          status: 'opened',
          transcript: normalized,
          title: confirmedOpen.title || intent.titleHint || 'Сайт',
          url: confirmedOpen.url || intent.url,
          note: confirmedOpen.query || '',
        });
        sendBrowserClientEvent('browser.open.ready', {
          requestId,
          traceId: resolvedTraceId,
          browserSessionId: nextSessionId,
          title: confirmedOpen?.title || '',
          url: confirmedOpen?.url || '',
          embeddable: Boolean(confirmedOpen?.embeddable),
          panelConfirmed,
        });
        markDialogRequestState(effectiveRequestId, 'browser-open-ready', {
          browserRequestId: requestId,
          browserSessionId: nextSessionId,
          panelConfirmed,
        });
        enqueueAssistantPrompt(
          panelConfirmed
            ? buildWebResultPrompt(normalized, confirmedOpen, getSessionHistorySummary())
            : buildWebOpenPendingPrompt(normalized, confirmedOpen, getSessionHistorySummary()),
          {
          source: 'browser.open.ready',
          dedupeKey: `browser-open-ready:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
          },
        );
      } catch (requestError) {
        if (browserRequestIdRef.current !== requestId) {
          return;
        }
        if (effectiveRequestId !== activeDialogRequestRef.current) {
          return;
        }

        const errorReason = classifyBrowserOpenErrorReason(requestError);
        const errorText = requestError.message || 'Не удалось открыть страницу';
        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        setBrowserFlowPhase('ready');
        setActiveBrowserSessionId('');
        appendSessionWebHistory({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          url: intent.url || '',
          note: errorText,
        });
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          browserPanelMode: 'remote',
          error: errorText,
        });
        sendBrowserClientEvent('browser.open.error', {
          requestId,
          traceId: resolvedTraceId,
          url: intent.url || '',
          error: errorText,
          errorReason,
        });
        enqueueAssistantPrompt(buildWebFailurePrompt(
          normalized,
          errorText,
          getSessionHistorySummary(),
        ), {
          source: 'browser.open.error',
          dedupeKey: `browser-open-error:${normalizeTranscriptKey(normalized)}`,
          requestId: effectiveRequestId,
        });
        finalizeDialogRequest(effectiveRequestId, 'browser-open-error', {
          browserRequestId: requestId,
          errorReason,
        });
      }
    } finally {
      browserIntentAbortRef.current?.abort?.();
      browserIntentAbortRef.current = null;
      if (browserFlowRequestIdRef.current === requestId) {
        browserFlowRequestIdRef.current = 0;
      }
      browserIntentInFlightRef.current = false;
      inFlightBrowserKeyRef.current = '';
    }
  }, [
    appendSessionWebHistory,
    cancelAssistantOutput,
    clearAssistantPromptQueue,
    detectBrowserIntentWithRetry,
    enqueueAssistantPrompt,
    getSessionHistorySummary,
    performBrowserAction,
    recordConversationAction,
    refreshBrowserView,
    requestActiveBrowserContext,
    requestClientInlineContext,
    selectedCharacter?.id,
    sendBrowserClientEvent,
    setBrowserFlowPhase,
    finalizeDialogRequest,
    markDialogRequestState,
    usesClientInlinePanel,
    armPendingClientPanelLoad,
    failPendingClientPanelLoad,
    finalizePendingClientPanelLoad,
  ]);

  useEffect(() => {
    handleBrowserTranscriptRef.current = (transcript, options = {}) => {
      void handleBrowserTranscript(transcript, options);
    };
  }, [handleBrowserTranscript]);

  const handleBrowserPanelAction = React.useCallback(async (action) => {
    if (!action?.type) {
      return;
    }

    if (action.type === 'client-frame-load') {
      const hasPendingLoad = Boolean(
        pendingClientPanelLoadRef.current?.targetUrl
        || pendingClientPanelLoadRef.current?.timerId,
      );
      if (!hasPendingLoad && browserPanelRef.current?.status === 'error') {
        return;
      }
      setBrowserPanel((current) => ({
        ...current,
        clientFrameLoaded: true,
        error: hasPendingLoad ? null : current.error,
      }));
      if (hasPendingLoad) {
        pendingClientPanelLoadRef.current.frameLoaded = true;
        if ((browserPanelRef.current?.clientContextStatus || 'idle') !== 'loading') {
          finalizePendingClientPanelLoad();
        } else {
          setBrowserPanel((current) => ({
            ...current,
            note: 'Сайт уже открыт внизу. Дочитываю текст страницы.',
          }));
        }
      }
      return;
    }

    if (action.type === 'client-frame-error') {
      if (pendingClientPanelLoadRef.current?.targetUrl || pendingClientPanelLoadRef.current?.timerId) {
        failPendingClientPanelLoad('Не удалось показать сайт внутри панели.', pendingClientPanelLoadRef.current.requestId);
        return;
      }
      setBrowserFlowPhase('error');
      setBrowserPanel((current) => ({
        ...current,
        status: 'error',
        clientFrameLoaded: false,
        error: 'Не удалось показать сайт внутри панели.',
      }));
      return;
    }

    if (!activeBrowserSessionIdRef.current && browserPanelRef.current?.clientUrl) {
      try {
        await performBrowserAction(action);
      } catch (error) {
        setBrowserFlowPhase('error');
        setBrowserPanel((current) => ({
          ...current,
          status: 'error',
          error: error.message || 'Не удалось выполнить действие на странице',
        }));
      }
      return;
    }

    if (!activeBrowserSessionIdRef.current) {
      return;
    }

    try {
      await performBrowserAction(action);
    } catch (error) {
      setBrowserFlowPhase('error');
      setBrowserPanel((current) => ({
        ...current,
        status: 'error',
        error: error.message || 'Не удалось выполнить действие на странице',
      }));
    }
  }, [failPendingClientPanelLoad, finalizePendingClientPanelLoad, performBrowserAction, setBrowserFlowPhase]);

  if (loading || !config || !selectedCharacter) {
    return (
      <div className="screen-shell">
        <div className="screen-shell__loading">Загружаю конфиг приложения...</div>
      </div>
    );
  }

  return (
    <div className="screen-shell">
      <div className="app-frame">
        <div className="top-toolbar">
          <div className="top-toolbar__meta">
            <div className="top-toolbar__name">{uiCharacter.displayName}</div>
            <div className="top-toolbar__subline">
              {status === 'connected' ? 'Разговор активен' : 'Готова к разговору'}
            </div>
          </div>

          <div className="top-toolbar__actions">
            <IconButton label="Переключить тему" onClick={handleThemeToggle} active={themeMode === 'dark'}>
              <ThemeIcon dark={themeMode === 'dark'} />
            </IconButton>
            <IconButton label={isFullscreen ? 'Выйти из полноэкранного режима' : 'Включить полноэкранный режим'} onClick={handleFullscreenToggle} active={isFullscreen}>
              <FullscreenIcon active={isFullscreen} />
            </IconButton>
            <IconButton label="Открыть настройки персонажа" onClick={handleOpenSettings}>
              <SettingsIcon />
            </IconButton>
          </div>
        </div>

        <div className="avatar-stage-layout">
          <CharacterArrow direction="left" onClick={() => handleCharacterStep(-1)} />

          <div className="avatar-stage-wrap">
            <div
              className="avatar-stage"
              data-avatar-instance={avatarInstanceId}
              onClick={handleAvatarStageClick}
              style={{
                background: activeBackground.stage,
                '--stage-shadow': activeBackground.shadow,
                '--stage-border': activeBackground.border,
              }}
            >
              <Canvas key={avatarRenderKey} camera={avatarFrame.camera} dpr={[1, 2]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
                {activeBackground.canvasBackground && (
                  <color attach="background" args={[activeBackground.canvasBackground]} />
                )}
                <ambientLight intensity={avatarFrame.lights.ambient} />
                <directionalLight position={[0, 0, 5]} intensity={avatarFrame.lights.directional} />

                <CanvasErrorBoundary>
                  <Suspense fallback={<Loader />}>
                    <group position={[0, avatarFrame.y, 0]}>
                      <Avatar
                        key={avatarRenderKey}
                        audioPlayer={audioPlayer}
                        modelUrl={avatarModelUrl}
                        instanceId={avatarInstanceId}
                        scale={avatarFrame.scale}
                        idleMotion={avatarFrame.idleMotion}
                        idleMotionProfile={avatarFrame.idleMotionProfile}
                      />
                    </group>
                  </Suspense>
                </CanvasErrorBoundary>

                <OrbitControls target={[0, 0, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
              </Canvas>
            </div>

            <LiveStatusPill
              status={status}
              audioPlayer={audioPlayer}
              getUserVolume={usesLiveInput ? getLiveUserVolume : getServerSttUserVolume}
              sidecarListening={Boolean(liveInputTranscript)}
              isRecovering={isRecoveringConnection}
            />
          </div>

          <CharacterArrow direction="right" onClick={() => handleCharacterStep(1)} />
        </div>

        <div className="controls-strip">
          {(!initialized || status === 'disconnected') ? (
            <button className="primary-button" type="button" onClick={handleStart} disabled={status === 'connecting'}>
              Начать разговор
            </button>
          ) : (
            <button className="primary-button primary-button--secondary" type="button" onClick={handleStop}>
              Завершить сессию
            </button>
          )}
        </div>

        <div className="status-stack">
          {error && <div className="notice notice--error">{error}</div>}
          {configError && <div className="notice notice--error">{configError}</div>}
          {saveError && <div className="notice notice--error">{saveError}</div>}
          {sessionNeedsReconnect && <div className="notice notice--warning">Новые настройки голоса и промпта применятся после переподключения.</div>}
          {initialized && reconnectAttempt > 0 && status !== 'connected' && (
            <div className="notice notice--warning">
              Соединение восстанавливается автоматически (попытка {reconnectAttempt}).
            </div>
          )}
        </div>

        <BrowserPanel panel={browserPanel} onAction={handleBrowserPanelAction} />
      </div>

      <SettingsDrawer
        isOpen={settingsOpen}
        draft={settingsDraft}
        voiceOptions={voiceOptions}
        onDraftChange={setSettingsDraft}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        saving={saving}
      />
    </div>
  );
}

export default App;
