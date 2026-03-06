import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls, useProgress } from '@react-three/drei';
import { Avatar } from './components/Avatar';
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

const BACKGROUND_PRESETS = {
  aurora: 'linear-gradient(180deg, rgba(102, 181, 199, 0.95), rgba(240, 250, 250, 0.8))',
  sunset: 'linear-gradient(180deg, rgba(255, 188, 121, 0.92), rgba(255, 233, 205, 0.82))',
  midnight: 'linear-gradient(180deg, rgba(34, 52, 92, 0.92), rgba(17, 24, 39, 0.88))',
  forest: 'linear-gradient(180deg, rgba(71, 120, 99, 0.92), rgba(218, 236, 226, 0.84))',
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

function buildWebPendingPrompt(transcript) {
  return `WEB_CONTEXT_PENDING: Пользователь попросил проверить внешний источник по запросу "${transcript}". Коротко скажи, что ты сейчас смотришь сайт.`;
}

function buildWebResultPrompt(transcript, panelState) {
  return `WEB_CONTEXT_RESULT:
Исходный запрос пользователя: "${transcript}"
Источник: ${panelState.title || 'Веб-страница'}
URL: ${panelState.url || 'n/a'}
Содержимое страницы:
${panelState.readerText || 'Содержимое страницы не удалось извлечь.'}

Ответь коротко и только на основе этого контекста.`;
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Запрос не выполнен');
  }
  return payload;
}

function App() {
  const [audioPlayer] = useState(() => new AudioStreamPlayer());
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [browserPanel, setBrowserPanel] = useState(DEFAULT_PANEL_STATE);
  const [saveError, setSaveError] = useState(null);
  const [appliedSessionSignature, setAppliedSessionSignature] = useState(null);
  const {
    config,
    loading,
    error: configError,
    saving,
    setConfig,
    persistConfig,
  } = useAppConfig();
  const browserRequestIdRef = useRef(0);
  const handledTranscriptsRef = useRef([]);

  const selectedCharacter = config?.characters?.find((character) => character.id === config.activeCharacterId) || config?.characters?.[0] || null;
  const themeMode = config?.themeMode === 'dark' ? 'dark' : 'light';
  const runtimeConfig = selectedCharacter
    ? {
      voiceModelId: selectedCharacter.voiceModelId,
      voiceName: selectedCharacter.voiceName,
      systemPrompt: selectedCharacter.systemPrompt,
      greetingText: selectedCharacter.greetingText,
    }
    : undefined;

  const { status, connect, disconnect, error, getUserVolume, sendTextTurn } = useGeminiLive(audioPlayer, runtimeConfig);

  const currentSignature = buildSignature(selectedCharacter);
  const sessionNeedsReconnect = status === 'connected' && Boolean(appliedSessionSignature) && appliedSessionSignature !== currentSignature;

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  const commitConfig = async (nextConfig) => {
    setConfig(nextConfig);
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
    setAppliedSessionSignature(currentSignature);
    connect();
  };

  const handleStop = () => {
    disconnect();
    setInitialized(false);
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
    const normalized = transcript.trim();
    if (!normalized) return;

    const dedupeKey = normalized.toLowerCase();
    const now = Date.now();
    handledTranscriptsRef.current = handledTranscriptsRef.current.filter((entry) => now - entry.timestamp < 15000);
    if (handledTranscriptsRef.current.some((entry) => entry.key === dedupeKey)) {
      return;
    }

    handledTranscriptsRef.current.push({ key: dedupeKey, timestamp: now });

    let intent;
    try {
      intent = await jsonRequest('/api/browser/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: normalized }),
      });
    } catch (requestError) {
      setBrowserPanel({
        ...DEFAULT_PANEL_STATE,
        status: 'error',
        error: requestError.message || 'Не удалось определить browser intent',
      });
      return;
    }

    if (!intent || intent.type === 'none') {
      return;
    }

    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    setBrowserPanel({
      ...DEFAULT_PANEL_STATE,
      status: 'loading',
      url: intent.url,
      title: intent.titleHint || 'Открываю страницу',
      sourceType: intent.sourceType || intent.type,
    });

    sendTextTurn(buildWebPendingPrompt(normalized));

    try {
      const opened = await jsonRequest('/api/browser/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
      });

      if (browserRequestIdRef.current !== requestId) {
        return;
      }

      setBrowserPanel(opened);
      sendTextTurn(buildWebResultPrompt(normalized, opened));
    } catch (requestError) {
      if (browserRequestIdRef.current !== requestId) {
        return;
      }

      setBrowserPanel({
        ...DEFAULT_PANEL_STATE,
        status: 'error',
        error: requestError.message || 'Не удалось открыть страницу',
      });
    }
  }, [sendTextTurn]);

  const {
    isSupported: sidecarSupported,
    isListening: sidecarListening,
    error: sidecarError,
  } = useSpeechSidecar({
    enabled: status === 'connected',
    onFinalTranscript: handleBrowserTranscript,
  });

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
            <div className="top-toolbar__name">{selectedCharacter.displayName}</div>
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
            <div className="avatar-stage" style={{ background: BACKGROUND_PRESETS[selectedCharacter.backgroundPreset] || BACKGROUND_PRESETS.aurora }}>
              <Canvas camera={{ position: [0, 0, 0.64], fov: 45 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
                <color attach="background" args={['#00000000']} />
                <ambientLight intensity={0.92} />
                <directionalLight position={[0, 0, 5]} intensity={0.68} />

                <CanvasErrorBoundary>
                  <Suspense fallback={<Loader />}>
                    <group position={[0, -0.75, 0]}>
                      <Avatar audioPlayer={audioPlayer} />
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
          {sidecarError && <div className="notice notice--warning">Ошибка распознавания речи: {sidecarError}</div>}
          {status === 'connected' && !sidecarSupported && <div className="notice notice--warning">Браузер не поддерживает распознавание речи для веб-режима. Голосовой режим продолжает работать.</div>}
        </div>

        <BrowserPanel panel={browserPanel} />
      </div>

      <SettingsDrawer
        isOpen={settingsOpen}
        draft={settingsDraft}
        onDraftChange={setSettingsDraft}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        saving={saving}
      />
    </div>
  );
}

export default App;
