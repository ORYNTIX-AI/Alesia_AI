import React, { Suspense, useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html, OrbitControls, useProgress } from '@react-three/drei'
import { Avatar } from './Avatar.jsx'
import { BrowserPanel } from './BrowserPanel.jsx'

class CanvasErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
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
      )
    }

    return this.props.children
  }
}

function Loader() {
  const { progress } = useProgress()
  return <Html center><div className="loader-overlay">{progress.toFixed(0)}%</div></Html>
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
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.52 7.52 0 0 0-1.63-.94L14.4 2.8a.48.48 0 0 0-.49-.4h-3.84a.48.48 0 0 0-.49.4L9.2 5.33a7.52 7.52 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.85a.5.5 0 0 0 .12.63L4.8 11.06l-.04.94.04.94-2.02 1.58a.5.5 0 0 0-.12.63l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.7 1.63.94l.38 2.53a.48.48 0 0 0 .49.4h3.84a.48.48 0 0 0 .49-.4l.38-2.53c.58-.24 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" fill="currentColor" />
    </svg>
  )
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
  )
}

function ArrowIcon({ direction }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={direction === 'left' ? 'm14.41 7.41-1.41-1.41L7 12l6 6 1.41-1.41L9.83 12z' : 'm9.59 16.59 1.41 1.41L17 12 11 6 9.59 7.41 14.17 12z'}
        fill="currentColor"
      />
    </svg>
  )
}

function IconButton({ label, onClick, children, active = false }) {
  return (
    <button className={`icon-button ${active ? 'is-active' : ''}`} type="button" onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

function CharacterArrow({ direction, onClick }) {
  return (
    <button
      className={`character-arrow character-arrow--${direction}`}
      type="button"
      onClick={onClick}
      aria-label={direction === 'left' ? 'Предыдущий персонаж' : 'Следующий персонаж'}
    >
      <ArrowIcon direction={direction} />
    </button>
  )
}

function LiveStatusPill({
  status,
  audioPlayer,
  getUserVolume,
  sidecarListening,
  isRecovering = false,
}) {
  const [volumes, setVolumes] = useState({ user: 0, bot: 0 })

  useEffect(() => {
    let frame = 0
    const loop = () => {
      const nextUser = getUserVolume ? getUserVolume() : 0
      const nextBot = audioPlayer?.getVolume ? audioPlayer.getVolume() : 0
      setVolumes({ user: nextUser, bot: nextBot })
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [audioPlayer, getUserVolume])

  const effectiveStatus = isRecovering && status === 'disconnected' ? 'connecting' : status
  const isConnected = effectiveStatus === 'connected'
  const label = isConnected
    ? (sidecarListening ? 'Слушаю...' : 'Онлайн')
    : effectiveStatus === 'connecting'
      ? (isRecovering ? 'Восстановление...' : 'Подключение...')
      : effectiveStatus === 'error'
        ? 'Ошибка'
        : 'Отключено'

  return (
    <div className={`live-pill live-pill--${effectiveStatus}`}>
      <span className="live-pill__dot" />
      <span className="live-pill__label">{label}</span>
      <span className="live-pill__meters">
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.user * 2.4)})` }} />
        <span style={{ transform: `scaleY(${Math.max(0.25, volumes.bot * 2.4)})` }} />
      </span>
    </div>
  )
}

export function LoadingShell() {
  return (
    <div className="screen-shell">
      <div className="screen-shell__loading">Загружаю конфиг приложения...</div>
    </div>
  )
}

export function DemoShell({
  activeBackground,
  audioPlayer,
  avatarFrame,
  avatarInstanceId,
  avatarModelUrl,
  avatarRenderKey,
  browserPanel,
  configError,
  error,
  getLiveUserVolume,
  getServerSttUserVolume,
  initialized,
  isFullscreen,
  isRecoveringConnection,
  liveInputTranscript,
  onAvatarStageClick,
  onBrowserPanelAction,
  onCharacterStep,
  onFullscreenToggle,
  onOpenSettings,
  onStart,
  onStop,
  onThemeToggle,
  reconnectAttempt,
  saveError,
  sessionNeedsReconnect,
  status,
  themeMode,
  uiCharacter,
  usesLiveInput,
}) {
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
            <IconButton label="Переключить тему" onClick={onThemeToggle} active={themeMode === 'dark'}>
              <ThemeIcon dark={themeMode === 'dark'} />
            </IconButton>
            <IconButton
              label={isFullscreen ? 'Выйти из полноэкранного режима' : 'Включить полноэкранный режим'}
              onClick={onFullscreenToggle}
              active={isFullscreen}
            >
              <FullscreenIcon active={isFullscreen} />
            </IconButton>
            <IconButton label="Открыть настройки персонажа" onClick={onOpenSettings}>
              <SettingsIcon />
            </IconButton>
          </div>
        </div>

        <div className="avatar-stage-layout">
          <CharacterArrow direction="left" onClick={() => onCharacterStep(-1)} />

          <div className="avatar-stage-wrap">
            <div
              className="avatar-stage"
              data-avatar-instance={avatarInstanceId}
              onClick={onAvatarStageClick}
              style={{
                background: activeBackground.stage,
                '--stage-shadow': activeBackground.shadow,
                '--stage-border': activeBackground.border,
              }}
            >
              <Canvas
                key={avatarRenderKey}
                camera={avatarFrame.camera}
                dpr={[1, 2]}
                gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
                onCreated={({ scene, camera, gl }) => {
                  if (typeof window !== 'undefined') {
                    window.__ALESIA_AVATAR_DEBUG__ = { scene, camera, gl }
                  }
                }}
              >
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
                        focusYRatio={avatarFrame.focusYRatio}
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

          <CharacterArrow direction="right" onClick={() => onCharacterStep(1)} />
        </div>

        <div className="controls-strip">
          {(!initialized || status === 'disconnected') ? (
            <button className="primary-button" type="button" onClick={onStart} disabled={status === 'connecting'}>
              Начать разговор
            </button>
          ) : (
            <button className="primary-button primary-button--secondary" type="button" onClick={onStop}>
              Завершить сессию
            </button>
          )}
        </div>

        <div className="status-stack">
          {error && <div className="notice notice--error">{error}</div>}
          {configError && <div className="notice notice--error">{configError}</div>}
          {saveError && <div className="notice notice--error">{saveError}</div>}
          {sessionNeedsReconnect && (
            <div className="notice notice--warning">
              Новые настройки голоса и промпта применятся после переподключения.
            </div>
          )}
          {initialized && reconnectAttempt > 0 && status !== 'connected' && (
            <div className="notice notice--warning">
              Соединение восстанавливается автоматически (попытка {reconnectAttempt}).
            </div>
          )}
        </div>

        <BrowserPanel panel={browserPanel} onAction={onBrowserPanelAction} />
      </div>
    </div>
  )
}
