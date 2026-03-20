import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls, useProgress } from '@react-three/drei';
import { Avatar, DEFAULT_AVATAR_MODEL_URL } from './components/Avatar';
import { BrowserPanel } from './components/BrowserPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { useAppConfig } from './hooks/useAppConfig';
import { useGeminiLive } from './hooks/useGeminiLive';
import { useSpeechSidecar } from './hooks/useSpeechSidecar';
import { AudioStreamPlayer } from './utils/AudioStreamPlayer';

const DEFAULT_PANEL_STATE = {
  status: 'idle',
  sourceType: null,
  title: '',
  url: '',
  embeddable: false,
  readerText: '',
  screenshotUrl: null,
  error: null,
};

const INTERIM_BROWSER_TRIGGER_DELAY_MS = 320;
const MAX_SESSION_WEB_HISTORY_ENTRIES = 8;
const MAX_SESSION_WEB_PROMPT_ENTRIES = 5;
const SIDECAR_BOT_VOLUME_GUARD = 0.06;
const BROWSER_INTENT_TIMEOUT_MS = 15000;
const BROWSER_OPEN_TIMEOUT_MS = 30000;

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
};

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

function CharacterArrow({ direction, onClick }) {
  return (
    <button className={`character-arrow character-arrow--${direction}`} type="button" onClick={onClick} aria-label={direction === 'left' ? 'Предыдущий персонаж' : 'Следующий персонаж'}>
      <ArrowIcon direction={direction} />
    </button>
  );
}

function LiveStatusPill({ status, audioPlayer, getUserVolume, sidecarListening }) {
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

  const isConnected = status === 'connected';
  const label = isConnected ? (sidecarListening ? 'Слушаю...' : 'Онлайн') : status === 'connecting' ? 'Подключение...' : status === 'error' ? 'Ошибка' : 'Отключено';

  return (
    <div className={`live-pill live-pill--${status}`}>
      <span className="live-pill__dot" />
      <span className="live-pill__label">{label}</span>
      <span className="live-pill__meters">
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.user * 2.4)})` }} />
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.bot * 2.4)})` }} />
      </span>
    </div>
  );
}

function buildSignature(character) {
  if (!character) return '';
  return [character.voiceModelId, character.voiceName, character.systemPrompt, character.greetingText].join('|');
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

  const tailMatch = normalized.match(/(?:открой|открыть|зайди|зайти|перейди|перейти)\s+(?:мне\s+)?(?:сайт|страницу|домен|адрес)?\s*(.+)$/iu);
  if (tailMatch?.[1]) {
    return normalizeSpeechText(tailMatch[1]);
  }

  const withSiteMatch = normalized.match(/(?:сайт|сайта|страницу|страница|домен|адрес)\s+(.+)$/iu);
  if (withSiteMatch?.[1]) {
    return normalizeSpeechText(withSiteMatch[1]);
  }

  return normalized;
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
  const normalized = normalizeSpeechText(transcript).toLowerCase();
  if (!normalized) return false;

  if (/\bhttps?:\/\/[^\s]+/i.test(normalized)) return true;
  if (/\b(?:[a-z0-9-]+\.)+(?:by|ru)\b/i.test(normalized)) return true;
  if (/\b[a-z0-9-]{2,}\s+(?:by|ru)\b/i.test(normalized)) return true;

  const padded = ` ${normalized.replace(/[.,!?;:()[\]{}"']/g, ' ')} `;
  const hasOpenVerb = /(?:^|\s)(открой|открыть|зайди|зайти|перейди|перейти)(?=\s|$)/iu.test(padded);
  const hasLookupVerb = /(?:^|\s)(найди|найти|покажи|посмотри)(?=\s|$)/iu.test(padded);
  const hasWebNoun = /(?:^|\s)(сайт|сайта|страниц[ауые]?|домен|адрес|url|урл|веб|web)(?=\s|$)/iu.test(padded);
  const hasWebContext = /(?:^|\s)(в интернете|в сети|онлайн|online)(?=\s|$)/iu.test(padded);

  if (hasLookupVerb && (hasWebNoun || hasWebContext)) {
    return true;
  }

  if (hasOpenVerb && hasWebNoun) {
    return true;
  }

  if (hasOpenVerb) {
    const target = extractBrowserTarget(normalized);
    if (normalizeTranscriptKey(target).length >= 4) {
      return true;
    }
  }

  return false;
}

function isStableInterimBrowserCandidate(transcript) {
  const normalized = normalizeSpeechText(transcript);
  if (!normalized || !isExplicitBrowserRequest(normalized)) return false;
  if (normalized.length < 8) return false;
  if (/^(открой|открыть|зайди|зайти|перейди|перейти|найди|найти|покажи|посмотри)\s*(сайт|страницу|домен|адрес)?\s*$/iu.test(normalized)) return false;
  return true;
}

function isLikelyBrowserIntent(transcript) {
  return isExplicitBrowserRequest(transcript);
}

function isAssistantBrowserNarration(transcript) {
  const normalized = String(transcript || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /(открыва[юе]|открою|смотрю|посмотрю|открывается|пытаюсь открыть).{0,40}(сайт|страниц|погод|новост|карт|википед)/i.test(normalized)
    || /(не удалось открыть|не удалось определить сайт|сайт не открылся)/i.test(normalized);
}

function buildEarlyBrowserLoadingTitle(transcript) {
  const normalized = String(transcript || '').replace(/\s+/g, ' ').trim().replace(/[?!.]+$/g, '');
  if (!normalized) {
    return 'Подбираю адрес сайта';
  }

  return `Подбираю адрес: ${truncatePromptValue(normalized, 96)}`;
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

function buildWebPendingPrompt(transcript, titleHint, historySummary) {
  return `WEB_CONTEXT_PENDING:
Служебное событие: browser-controller начал открывать сайт по запросу пользователя.
Исходный запрос пользователя: "${transcript}"
Цель открытия: ${titleHint || 'Сайт'}
Недавняя веб-история этой сессии:
${historySummary}

Ответь одной короткой фразой, что ты открываешь сайт и смотришь страницу.`;
}

function buildWebResultPrompt(transcript, panelState, historySummary) {
  return `WEB_CONTEXT_RESULT:
Служебное событие: browser-controller уже успешно открыл сайт по запросу пользователя. Не говори, что ты не можешь открывать сайты.
Исходный запрос пользователя: "${transcript}"
Источник: ${panelState.title || 'Веб-страница'}
URL: ${panelState.url || 'n/a'}
Недавняя веб-история этой сессии:
${historySummary}
Содержимое страницы:
${panelState.readerText || 'Содержимое страницы не удалось извлечь.'}

Ответь коротко и только на основе этого контекста.`;
}

function buildWebFailurePrompt(transcript, errorMessage, historySummary) {
  return `WEB_CONTEXT_ERROR:
Служебное событие: browser-controller не смог открыть сайт по запросу пользователя. Не говори, что ты вообще не умеешь открывать сайты.
Исходный запрос пользователя: "${transcript}"
Причина: ${errorMessage || 'неизвестная ошибка'}
Недавняя веб-история этой сессии:
${historySummary}

Коротко объясни, что именно в этот раз сайт не открылся, и попроси назвать сайт точнее без упоминания доменов .by или .ru.`;
}

async function jsonRequest(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Запрос не выполнен');
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Истек таймаут ожидания ответа');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function App() {
  const [audioPlayer] = useState(() => new AudioStreamPlayer());
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [browserPanel, setBrowserPanel] = useState(DEFAULT_PANEL_STATE);
  const [liveInputTranscript, setLiveInputTranscript] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [appliedSessionSignature, setAppliedSessionSignature] = useState(null);
  const {
    config,
    loading,
    error: configError,
    saving,
    persistConfig,
  } = useAppConfig();
  const browserRequestIdRef = useRef(0);
  const handledTranscriptsRef = useRef([]);
  const liveTranscriptTimerRef = useRef(null);
  const sessionWebHistoryRef = useRef([]);
  const browserPanelSnapshotRef = useRef(DEFAULT_PANEL_STATE);
  const earlyBrowserFeedbackKeyRef = useRef('');
  const lastBrowserCommandRef = useRef({ key: '', transcript: '', timestamp: 0 });
  const browserSpeechGuardUntilRef = useRef(0);
  const browserIntentInFlightRef = useRef(false);
  const inFlightBrowserKeyRef = useRef('');

  const selectedCharacter = config?.characters?.find((character) => character.id === config.activeCharacterId) || config?.characters?.[0] || null;
  const voiceOptions = (config?.supportedVoiceNames?.length ? config.supportedVoiceNames : ['Aoede', 'Kore', 'Puck'])
    .map((voiceName) => ({ value: voiceName, label: voiceName }));
  const uiCharacter = settingsOpen && settingsDraft && selectedCharacter && settingsDraft.id === selectedCharacter.id
    ? { ...selectedCharacter, backgroundPreset: settingsDraft.backgroundPreset, displayName: settingsDraft.displayName }
    : selectedCharacter;
  const activeBackground = BACKGROUND_PRESETS[uiCharacter?.backgroundPreset] || BACKGROUND_PRESETS.aurora;
  const avatarModelUrl = uiCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL;
  const avatarInstanceId = uiCharacter?.avatarInstanceId || `avatar-${uiCharacter?.id || 'default'}`;
  const avatarRenderKey = [avatarInstanceId, avatarModelUrl, uiCharacter?.backgroundPreset || 'aurora'].join('|');
  const themeMode = config?.themeMode === 'dark' ? 'dark' : 'light';
  const runtimeConfig = selectedCharacter
    ? {
      voiceModelId: selectedCharacter.voiceModelId,
      voiceName: selectedCharacter.voiceName,
      systemPrompt: selectedCharacter.systemPrompt,
      greetingText: selectedCharacter.greetingText,
    }
    : undefined;

  const handleLiveInputTranscription = React.useCallback((transcript) => {
    setLiveInputTranscript(String(transcript || '').trim());
  }, []);

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

  const resetSessionRuntimeState = React.useCallback(() => {
    sessionWebHistoryRef.current = [];
    handledTranscriptsRef.current = [];
    browserRequestIdRef.current = 0;
    browserPanelSnapshotRef.current = DEFAULT_PANEL_STATE;
    earlyBrowserFeedbackKeyRef.current = '';
    lastBrowserCommandRef.current = { key: '', transcript: '', timestamp: 0 };
    browserSpeechGuardUntilRef.current = 0;
    browserIntentInFlightRef.current = false;
    inFlightBrowserKeyRef.current = '';

    if (liveTranscriptTimerRef.current) {
      clearTimeout(liveTranscriptTimerRef.current);
      liveTranscriptTimerRef.current = null;
    }
  }, []);

  const showEarlyBrowserFeedback = React.useCallback((transcript) => {
    const normalized = String(transcript || '').trim();
    if (!isLikelyBrowserIntent(normalized)) {
      return;
    }

    const feedbackKey = normalizeTranscriptKey(normalized);
    if (feedbackKey && feedbackKey === earlyBrowserFeedbackKeyRef.current) {
      return;
    }

    earlyBrowserFeedbackKeyRef.current = feedbackKey;
    setBrowserPanel((current) => {
      if (current.status !== 'loading') {
        browserPanelSnapshotRef.current = current;
      }

      return {
        ...DEFAULT_PANEL_STATE,
        status: 'loading',
        title: buildEarlyBrowserLoadingTitle(normalized),
        sourceType: 'intent-pending',
      };
    });
  }, []);

  const restoreBrowserPanelSnapshot = React.useCallback(() => {
    setBrowserPanel(browserPanelSnapshotRef.current);
    earlyBrowserFeedbackKeyRef.current = '';
  }, []);

  const { status, connect, disconnect, error, getUserVolume, sendTextTurn } = useGeminiLive(
    audioPlayer,
    runtimeConfig,
    { onInputTranscription: handleLiveInputTranscription },
  );

  const currentSignature = buildSignature(selectedCharacter);
  const sessionNeedsReconnect = status === 'connected' && Boolean(appliedSessionSignature) && appliedSessionSignature !== currentSignature;

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

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
    setInitialized(true);
    setLiveInputTranscript('');
    resetSessionRuntimeState();
    setAppliedSessionSignature(currentSignature);
    connect();
  };

  const handleStop = () => {
    disconnect();
    setInitialized(false);
    setLiveInputTranscript('');
    resetSessionRuntimeState();
    setAppliedSessionSignature(null);
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

    await commitConfig(nextConfig);
    setSettingsOpen(false);
  };

  const handleOpenSettings = () => {
    setSettingsDraft(selectedCharacter);
    setSettingsOpen(true);
  };

  const handleBrowserTranscript = React.useCallback(async (transcript) => {
    const normalized = normalizeSpeechText(transcript);
    if (!normalized) return;

    if (isAssistantBrowserNarration(normalized)) {
      return;
    }

    const likelyBrowserIntent = isLikelyBrowserIntent(normalized);
    if (!likelyBrowserIntent) {
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

    showEarlyBrowserFeedback(normalized);
    browserIntentInFlightRef.current = true;
    inFlightBrowserKeyRef.current = dedupeKey;
    handledTranscriptsRef.current.push({ key: dedupeKey, timestamp: now });
    sendTextTurn('Секунду, проверяю.');

    try {
      let intent;
      try {
        intent = await jsonRequest('/api/browser/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: normalized,
            sessionHistory: getSessionHistoryPayload(),
          }),
        }, BROWSER_INTENT_TIMEOUT_MS);
      } catch (requestError) {
        if (earlyBrowserFeedbackKeyRef.current === dedupeKey) {
          restoreBrowserPanelSnapshot();
        }
        browserSpeechGuardUntilRef.current = now + 2500;
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          error: requestError.message || 'Не удалось определить browser intent',
        });
        sendTextTurn(buildWebFailurePrompt(
          normalized,
          requestError.message || 'Не удалось определить browser intent',
          getSessionHistorySummary(),
        ));
        return;
      }

      if (!intent || intent.type === 'none') {
        if (earlyBrowserFeedbackKeyRef.current === dedupeKey) {
          restoreBrowserPanelSnapshot();
        }
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          error: 'Не получилось понять, какой сайт или страницу нужно открыть.',
        });
        sendTextTurn(buildWebFailurePrompt(
          normalized,
          'Не получилось понять, какой сайт или страницу нужно открыть.',
          getSessionHistorySummary(),
        ));
        return;
      }

      if (intent.type === 'unresolved-site') {
        earlyBrowserFeedbackKeyRef.current = '';
        browserSpeechGuardUntilRef.current = now + 2500;
        appendSessionWebHistory({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          note: intent.error || 'Не удалось определить сайт',
        });
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          error: intent.error || 'Не распознала сайт',
        });
        sendTextTurn(buildWebFailurePrompt(normalized, intent.error, getSessionHistorySummary()));
        return;
      }

      const requestId = browserRequestIdRef.current + 1;
      browserRequestIdRef.current = requestId;
      earlyBrowserFeedbackKeyRef.current = '';
      lastBrowserCommandRef.current = { key: dedupeKey, transcript: normalized, timestamp: now };
      browserSpeechGuardUntilRef.current = now + 6000;
      setBrowserPanel({
        ...DEFAULT_PANEL_STATE,
        status: 'loading',
        url: intent.url,
        title: intent.titleHint || 'Открываю страницу',
        sourceType: intent.sourceType || intent.type,
      });
      sendTextTurn(buildWebPendingPrompt(normalized, intent.titleHint || intent.url, getSessionHistorySummary()));

      try {
        const opened = await jsonRequest('/api/browser/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(intent),
        }, BROWSER_OPEN_TIMEOUT_MS);

        if (browserRequestIdRef.current !== requestId) {
          return;
        }

        earlyBrowserFeedbackKeyRef.current = '';
        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        setBrowserPanel(opened);
        appendSessionWebHistory({
          status: 'opened',
          transcript: normalized,
          title: opened.title || intent.titleHint || 'Сайт',
          url: opened.url || intent.url,
          note: opened.query || '',
        });
        sendTextTurn(buildWebResultPrompt(normalized, opened, getSessionHistorySummary()));
      } catch (requestError) {
        if (browserRequestIdRef.current !== requestId) {
          return;
        }

        earlyBrowserFeedbackKeyRef.current = '';
        browserSpeechGuardUntilRef.current = Date.now() + 2500;
        appendSessionWebHistory({
          status: 'failed',
          transcript: normalized,
          title: intent.titleHint || intent.query || 'Сайт',
          url: intent.url || '',
          note: requestError.message || 'Не удалось открыть страницу',
        });
        setBrowserPanel({
          ...DEFAULT_PANEL_STATE,
          status: 'error',
          error: requestError.message || 'Не удалось открыть страницу',
        });
        sendTextTurn(buildWebFailurePrompt(
          normalized,
          requestError.message || 'Не удалось открыть страницу',
          getSessionHistorySummary(),
        ));
      }
    } finally {
      browserIntentInFlightRef.current = false;
      inFlightBrowserKeyRef.current = '';
    }
  }, [appendSessionWebHistory, getSessionHistoryPayload, getSessionHistorySummary, restoreBrowserPanelSnapshot, sendTextTurn, showEarlyBrowserFeedback]);

  const handleSidecarTranscript = React.useCallback((transcript) => {
    const normalized = String(transcript || '').trim();
    if (!normalized || !isLikelyBrowserIntent(normalized) || isAssistantBrowserNarration(normalized)) {
      return;
    }

    if ((audioPlayer?.getVolume?.() || 0) > SIDECAR_BOT_VOLUME_GUARD) {
      return;
    }

    void handleBrowserTranscript(normalized);
  }, [audioPlayer, handleBrowserTranscript]);

  const { isSupported: sidecarSupported, isListening: sidecarListening } = useSpeechSidecar({
    enabled: status === 'connected',
    onFinalTranscript: handleSidecarTranscript,
    language: 'ru-RU',
  });

  useEffect(() => {
    if (status !== 'connected' || (sidecarSupported && sidecarListening) || !isStableInterimBrowserCandidate(liveInputTranscript)) {
      if (liveTranscriptTimerRef.current) {
        clearTimeout(liveTranscriptTimerRef.current);
        liveTranscriptTimerRef.current = null;
      }
      return undefined;
    }

    showEarlyBrowserFeedback(liveInputTranscript);

    liveTranscriptTimerRef.current = setTimeout(() => {
      handleBrowserTranscript(liveInputTranscript);
    }, INTERIM_BROWSER_TRIGGER_DELAY_MS);

    return () => {
      if (liveTranscriptTimerRef.current) {
        clearTimeout(liveTranscriptTimerRef.current);
        liveTranscriptTimerRef.current = null;
      }
    };
  }, [handleBrowserTranscript, liveInputTranscript, showEarlyBrowserFeedback, sidecarListening, sidecarSupported, status]);

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
              style={{
                background: activeBackground.stage,
                '--stage-shadow': activeBackground.shadow,
                '--stage-border': activeBackground.border,
              }}
            >
              <Canvas key={avatarRenderKey} camera={{ position: [0, 0, 0.64], fov: 45 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
                <color attach="background" args={[activeBackground.canvasBackground]} />
                <ambientLight intensity={0.92} />
                <directionalLight position={[0, 0, 5]} intensity={0.68} />

                <CanvasErrorBoundary>
                  <Suspense fallback={<Loader />}>
                    <group position={[0, -0.75, 0]}>
                      <Avatar key={avatarRenderKey} audioPlayer={audioPlayer} modelUrl={avatarModelUrl} instanceId={avatarInstanceId} />
                    </group>
                  </Suspense>
                </CanvasErrorBoundary>

                <OrbitControls target={[0, 0, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
              </Canvas>
            </div>

            <LiveStatusPill status={status} audioPlayer={audioPlayer} getUserVolume={getUserVolume} sidecarListening={sidecarListening} />
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
        </div>

        <BrowserPanel panel={browserPanel} />
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
