import React, { useState, Suspense, useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows, useProgress, Html, Center, Resize } from '@react-three/drei';
import { Avatar } from './components/Avatar';
import { useGeminiLive } from './hooks/useGeminiLive';
import { AudioStreamPlayer } from './utils/AudioStreamPlayer';

// Catch errors inside the Canvas (e.g. Model loading)
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
      return <Html center><div style={{ color: 'red', width: 200, textAlign: 'center' }}>Error inside 3D Scene: {this.state.error.message}</div></Html>;
    }
    return this.props.children;
  }
}

// Catch errors outside (e.g. WebGL Context Crashes)
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="avatar-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#ef4444' }}>
          <div style={{ textAlign: 'center', padding: 20 }}>
            <h3>Graphics Error</h3>
            <p>WebGL Context Lost. Please refresh the page.</p>
            <button onClick={() => window.location.reload()} style={{ marginTop: 10, padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: 8 }}>Refresh</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Loader() {
  const { progress } = useProgress();
  return <Html center><div className="loader-overlay" style={{ color: '#333' }}>{progress.toFixed(0)}% loaded</div></Html>;
}

function AudioVisualizer({ audioPlayer, getUserVolume }) {
  const userBarRef = useRef();
  const botBarRef = useRef();
  const requestRef = useRef();

  useEffect(() => {
    const animate = () => {
      // User Volume (Blue)
      if (getUserVolume && userBarRef.current) {
        const vol = getUserVolume();
        userBarRef.current.style.height = `${Math.max(4, vol * 100)}%`;
        userBarRef.current.style.opacity = vol > 0.01 ? 1 : 0.3;
      }

      // Bot Volume (Red)
      if (audioPlayer && botBarRef.current) {
        const vol = audioPlayer.getVolume();
        botBarRef.current.style.height = `${Math.max(4, vol * 100)}%`;
        botBarRef.current.style.opacity = vol > 0.01 ? 1 : 0.3;
      }

      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [audioPlayer, getUserVolume]);

  return (
    <div className="visualizer-container" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 20, pointerEvents: 'none', zIndex: 10 }}>
      {/* User Indicator */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 10, height: 60, background: '#eee', borderRadius: 5, overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
          <div ref={userBarRef} style={{ width: '100%', height: '4%', background: '#3b82f6', transition: 'height 0.05s' }}></div>
        </div>
        <span style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>Вы</span>
      </div>

      {/* Bot Indicator */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 10, height: 60, background: '#eee', borderRadius: 5, overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
          <div ref={botBarRef} style={{ width: '100%', height: '4%', background: '#ef4444', transition: 'height 0.05s' }}></div>
        </div>
        <span style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>ИИ</span>
      </div>
    </div>
  );
}

function App() {
  const [audioPlayer] = useState(() => new AudioStreamPlayer());
  const [initialized, setInitialized] = useState(false);
  const { status, connect, disconnect, error, getUserVolume } = useGeminiLive(audioPlayer);

  const handleStart = async () => {
    await audioPlayer.initialize();
    setInitialized(true);
    connect();
  };

  const handleStop = () => {
    disconnect();
    setInitialized(false);
    audioPlayer.close();
  };

  return (
    <div className="main-container">
      <div className="header">
        <h1 style={{ background: 'none', WebkitTextFillColor: '#333', color: '#333' }}>Голосовой Аватар</h1>
        <div className="status-badge" style={{ borderColor: '#ddd', background: '#f5f5f5', color: '#666' }}>
          <div className={`status-dot ${status}`}></div>
          <span>{status === 'connected' ? 'Онлайн' : status === 'connecting' ? 'Подключение...' : status === 'error' ? 'Ошибка' : 'Отключено'}</span>
        </div>
      </div>

      <AppErrorBoundary>
        <div className="avatar-card" style={{ background: '#fff', borderColor: '#eee', boxShadow: '0 20px 40px rgba(0,0,0,0.1)', position: 'relative' }}>
          <div className="canvas-container">
            <Canvas
              camera={{ position: [0, 0, 0.64], fov: 45 }}
              dpr={[1, 3]} // Support high-DPI screens up to 3x
              gl={{ antialias: true, powerPreference: "high-performance", alpha: true }}
            >
              <color attach="background" args={['#ffffff']} />

              {/* Мягкое освещение */}
              <ambientLight intensity={0.90} />
              <directionalLight position={[0, 0, 5]} intensity={0.68} />
              {/* Environment удалён для снижения яркости */}

              <CanvasErrorBoundary>
                <Suspense fallback={<Loader />}>
                  <group position={[0, -0.75, 0]}>
                    <Avatar audioPlayer={audioPlayer} />
                  </group>
                </Suspense>
              </CanvasErrorBoundary>

              {/* Locked focus on the head area (No Rotation) */}
              <OrbitControls
                target={[0, 0, 0]}
                enableZoom={false}
                enablePan={false}
                enableRotate={false}
              />
            </Canvas>
          </div>

          {/* Visualizers overlay on top of 3D card */}
          {status === 'connected' && <AudioVisualizer audioPlayer={audioPlayer} getUserVolume={getUserVolume} />}
        </div>
      </AppErrorBoundary>

      <div className="controls">
        {error && <div style={{ color: '#ef4444', marginBottom: '10px', fontSize: '0.9em' }}>{error}</div>}

        {!initialized || status === 'disconnected' ? (
          <button className="action-button" onClick={handleStart} disabled={status === 'connecting'}
            style={{ background: '#333', color: 'white' }}>
            Начать разговор
          </button>
        ) : (
          <button className="action-button stop" onClick={handleStop} style={{ borderColor: '#ddd', color: '#333' }}>
            Завершить сессию
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
