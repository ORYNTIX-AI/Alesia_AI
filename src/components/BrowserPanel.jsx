import { useMemo, useRef } from 'react';

function ToolbarButton({ label, onClick, children, disabled = false }) {
  return (
    <button
      className="browser-panel__icon-button"
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
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

function ReloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-4.9 6.02H5.02A7 7 0 1 0 17.65 6.35Z" fill="currentColor" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 3 12h2v8h6v-5h2v5h6v-8h2L12 4Z" fill="currentColor" />
    </svg>
  );
}

export function BrowserPanel({ panel, onAction }) {
  const surfaceRef = useRef(null);
  const wheelLockRef = useRef(0);
  const view = panel?.view || null;
  const viewImageUrl = String(view?.imageUrl || panel?.screenshotUrl || '').trim();
  const hasView = Boolean(viewImageUrl);
  const canInteract = panel?.status === 'ready' && hasView && typeof onAction === 'function';

  const metaLabel = useMemo(() => {
    const title = String(panel?.title || '').trim();
    const url = String(panel?.url || '').trim();
    if (title && url) {
      return `${title} · ${url}`;
    }
    return title || url || '';
  }, [panel?.title, panel?.url]);

  const handleSurfaceClick = (event) => {
    if (!canInteract || !surfaceRef.current) {
      return;
    }

    const rect = surfaceRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const xRatio = (event.clientX - rect.left) / rect.width;
    const yRatio = (event.clientY - rect.top) / rect.height;
    onAction({ type: 'click', xRatio, yRatio });
  };

  const handleWheel = (event) => {
    if (!canInteract) {
      return;
    }

    event.preventDefault();
    const now = Date.now();
    if (now - wheelLockRef.current < 120) {
      return;
    }
    wheelLockRef.current = now;
    onAction({ type: 'wheel', deltaY: event.deltaY });
  };

  if (panel?.status === 'loading') {
    return (
      <section className={`browser-panel ${hasView ? 'browser-panel--loading-visual' : 'browser-panel--state'}`}>
        {hasView && (
          <div className="browser-panel__surface browser-panel__surface--disabled" ref={surfaceRef}>
            <img className="browser-panel__snapshot" src={viewImageUrl} alt={panel.title || 'Сайт'} />
          </div>
        )}
        <div className={`browser-panel__state browser-panel__state--loading${hasView ? ' browser-panel__state--overlay' : ''}`} aria-live="polite">
          <div className="browser-panel__spinner" />
          <strong>{panel.sourceType === 'intent-pending' ? 'Ищу сайт...' : 'Открывается сайт...'}</strong>
          {metaLabel && <span className="browser-panel__meta">{metaLabel}</span>}
        </div>
      </section>
    );
  }

  if (panel?.status === 'error') {
    return (
      <section className="browser-panel browser-panel--state">
        <div className="browser-panel__state browser-panel__state--error">
          <p>{panel.error || 'Не удалось открыть страницу.'}</p>
        </div>
      </section>
    );
  }

  if (panel?.status === 'ready' && hasView) {
    return (
      <section className="browser-panel browser-panel--remote">
        <div className="browser-panel__toolbar">
          <div className="browser-panel__toolbar-meta">
            <strong>{panel.title || 'Сайт'}</strong>
            {panel.url && <span>{panel.url}</span>}
          </div>
          <div className="browser-panel__toolbar-actions">
            <ToolbarButton label="Главная" onClick={() => onAction?.({ type: 'home' })} disabled={!canInteract}>
              <HomeIcon />
            </ToolbarButton>
            <ToolbarButton label="Назад" onClick={() => onAction?.({ type: 'back' })} disabled={!canInteract}>
              <ArrowIcon direction="left" />
            </ToolbarButton>
            <ToolbarButton label="Вперед" onClick={() => onAction?.({ type: 'forward' })} disabled={!canInteract}>
              <ArrowIcon direction="right" />
            </ToolbarButton>
            <ToolbarButton label="Обновить" onClick={() => onAction?.({ type: 'reload' })} disabled={!canInteract}>
              <ReloadIcon />
            </ToolbarButton>
          </div>
        </div>
        <div
          className={`browser-panel__surface${canInteract ? '' : ' browser-panel__surface--disabled'}`}
          ref={surfaceRef}
          onClick={handleSurfaceClick}
          onWheel={handleWheel}
          role={canInteract ? 'button' : undefined}
          tabIndex={canInteract ? 0 : -1}
        >
          <img className="browser-panel__snapshot" src={viewImageUrl} alt={panel.title || 'Сайт'} />
        </div>
      </section>
    );
  }

  return (
    <section className="browser-panel browser-panel--idle" aria-hidden="true">
      <div className="browser-panel__blank" />
    </section>
  );
}
