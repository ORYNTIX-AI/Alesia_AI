function formatEventTime(timestamp) {
  if (!timestamp) {
    return '--:--:--';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function renderDetailValue(value) {
  if (value == null || value === '') {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'да' : 'нет';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '—';
  }
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function SettingRow({ label, value, min, max, step = 1, suffix = '', onChange }) {
  return (
    <label className="tester-field">
      <span>{label}</span>
      <div className="tester-field__range">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <strong>{value}{suffix}</strong>
      </div>
    </label>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label className="tester-field tester-field--toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function TesterDrawer({
  isOpen,
  onToggle,
  settings,
  onSettingsChange,
  status,
  events = [],
  onClearEvents,
}) {
  const reversedEvents = [...events].reverse();

  return (
    <>
      <button
        className={`tester-drawer__handle ${isOpen ? 'is-open' : ''}`}
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls="tester-drawer"
      >
        Тестер
      </button>
      <aside id="tester-drawer" className={`tester-drawer ${isOpen ? 'is-open' : ''}`}>
        <div className="tester-drawer__header">
          <div>
            <div className="tester-drawer__eyebrow">Живой журнал</div>
            <h2>Тестовая панель</h2>
          </div>
          <button className="tester-drawer__close" type="button" onClick={onToggle} aria-label="Закрыть панель">
            ×
          </button>
        </div>

        <div className="tester-drawer__body">
          <section className="tester-block">
            <h3>Сейчас</h3>
            <div className="tester-status-grid">
              <div>
                <span>Соединение</span>
                <strong>{status.connection}</strong>
              </div>
              <div>
                <span>Ответ</span>
                <strong>{status.assistantState}</strong>
              </div>
              <div>
                <span>Буфер звука</span>
                <strong>{status.bufferedAudioMs} мс</strong>
              </div>
              <div>
                <span>Последняя причина</span>
                <strong>{status.lastIssue || '—'}</strong>
              </div>
            </div>
            <div className="tester-status-stack">
              <div>
                <span>Текущая расшифровка</span>
                <strong>{status.partialTranscript || '—'}</strong>
              </div>
              <div>
                <span>Последняя фраза пользователя</span>
                <strong>{status.lastUserTurn || '—'}</strong>
              </div>
              <div>
                <span>Последний ответ</span>
                <strong>{status.lastAssistantTurn || '—'}</strong>
              </div>
            </div>
          </section>

          <section className="tester-block">
            <h3>Настройки</h3>
            <SettingRow
              label="Пауза перед ответом"
              value={settings.pauseMs}
              min={260}
              max={900}
              step={20}
              suffix=" мс"
              onChange={(value) => onSettingsChange({ pauseMs: value })}
            />
            <SettingRow
              label="Задержка перед перебиванием"
              value={settings.interruptHoldMs}
              min={120}
              max={640}
              step={20}
              suffix=" мс"
              onChange={(value) => onSettingsChange({ interruptHoldMs: value })}
            />
            <SettingRow
              label="Сила защиты от эха"
              value={settings.echoGuard}
              min={0}
              max={100}
              step={1}
              onChange={(value) => onSettingsChange({ echoGuard: value })}
            />
            <SettingRow
              label="Длина первой фразы"
              value={settings.firstReplySentences}
              min={1}
              max={3}
              step={1}
              suffix=" предл."
              onChange={(value) => onSettingsChange({ firstReplySentences: value })}
            />
            <SettingRow
              label="Память последних реплик"
              value={settings.memoryTurnCount}
              min={2}
              max={12}
              step={1}
              suffix=" шт."
              onChange={(value) => onSettingsChange({ memoryTurnCount: value })}
            />
            <ToggleRow
              label="Автовосстановление связи"
              checked={settings.autoReconnect}
              onChange={(value) => onSettingsChange({ autoReconnect: value })}
            />
            <ToggleRow
              label="Показывать текущую расшифровку"
              checked={settings.showPartialTranscript}
              onChange={(value) => onSettingsChange({ showPartialTranscript: value })}
            />
            <ToggleRow
              label="Показывать причины потерь"
              checked={settings.showDropReasons}
              onChange={(value) => onSettingsChange({ showDropReasons: value })}
            />
          </section>

          <section className="tester-block">
            <div className="tester-block__header">
              <h3>События</h3>
              <button className="tester-clear-button" type="button" onClick={onClearEvents}>
                Очистить
              </button>
            </div>
            <div className="tester-event-list">
              {reversedEvents.length === 0 && (
                <div className="tester-event tester-event--empty">Пока пусто.</div>
              )}
              {reversedEvents.map((entry) => (
                <article key={entry.id} className="tester-event">
                  <div className="tester-event__head">
                    <strong>{entry.event}</strong>
                    <span>{formatEventTime(entry.ts)}</span>
                  </div>
                  <div className="tester-event__details">
                    {Object.entries(entry.details || {}).map(([key, value]) => (
                      <div key={key} className="tester-event__detail">
                        <span>{key}</span>
                        <strong>{renderDetailValue(value)}</strong>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
