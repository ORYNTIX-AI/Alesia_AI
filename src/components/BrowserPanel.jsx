export function BrowserPanel({ panel }) {
  if (panel?.status === 'loading') {
    const isResolving = panel.sourceType === 'intent-pending';
    return (
      <section className={`browser-panel ${panel.url && !isResolving ? 'browser-panel--loading-visual' : 'browser-panel--state'}`}>
        {panel.url && !isResolving && (
          <iframe
            className="browser-panel__iframe"
            title={panel.title || 'Сайт'}
            src={panel.url}
            loading="eager"
            referrerPolicy="no-referrer"
          />
        )}
        <div className={`browser-panel__state browser-panel__state--loading${panel.url && !isResolving ? ' browser-panel__state--overlay' : ''}`} aria-live="polite">
          <div className="browser-panel__spinner" />
          <strong>{isResolving ? 'Ищу сайт...' : 'Открывается сайт...'}</strong>
          {panel.url && !isResolving && <span className="browser-panel__meta">{panel.url}</span>}
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

  if (panel?.status === 'ready' && panel.embeddable && panel.url) {
    return (
      <section className="browser-panel">
        <iframe
          className="browser-panel__iframe"
          title={panel.title || 'Сайт'}
          src={panel.url}
          loading="eager"
          referrerPolicy="no-referrer"
        />
      </section>
    );
  }

  if (panel?.status === 'ready' && panel.screenshotUrl) {
    return (
      <section className="browser-panel browser-panel--visual">
        <img className="browser-panel__snapshot" src={panel.screenshotUrl} alt={panel.title || 'Сайт'} />
      </section>
    );
  }

  if (panel?.status === 'ready' && panel.url) {
    return (
      <section className="browser-panel browser-panel--state">
        <div className="browser-panel__state browser-panel__state--error">
          <p>Не удалось отрисовать сайт в окне.</p>
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
