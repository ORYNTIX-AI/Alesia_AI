export function BrowserPanel({ panel }) {
  if (panel?.status === 'loading') {
    return (
      <section className="browser-panel browser-panel--state">
        <div className="browser-panel__state browser-panel__state--loading">
          <div className="browser-panel__spinner" />
          <p>Открываю сайт...</p>
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
          title={panel.title || 'Встроенная страница'}
          src={panel.url}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </section>
    );
  }

  if (panel?.status === 'ready') {
    return (
      <section className="browser-panel browser-panel--reader-mode">
        <div className="browser-panel__reader">
          {panel.screenshotUrl && (
            <img className="browser-panel__screenshot" src={panel.screenshotUrl} alt={panel.title || 'Снимок страницы'} />
          )}
          <div className="browser-panel__reader-copy">
            <div className="browser-panel__reader-title">{panel.title || 'Страница'}</div>
            {panel.url && (
              <a className="browser-panel__reader-link" href={panel.url} target="_blank" rel="noreferrer">
                {panel.url}
              </a>
            )}
            <div className="browser-panel__reader-text">
              {panel.readerText || 'Содержимое страницы недоступно.'}
            </div>
          </div>
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
