const BACKGROUND_OPTIONS = [
  { value: 'aurora', label: 'Сияние' },
  { value: 'sunset', label: 'Закат' },
  { value: 'midnight', label: 'Ночь' },
  { value: 'forest', label: 'Лес' },
];

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 10.59 4.95-4.95 1.41 1.41L13.41 12l4.95 4.95-1.41 1.41L12 13.41l-4.95 4.95-1.41-1.41L10.59 12 5.64 7.05l1.41-1.41L12 10.59Z" fill="currentColor" />
    </svg>
  );
}

export function SettingsDrawer({
  isOpen,
  draft,
  onDraftChange,
  onClose,
  onSave,
  saving,
}) {
  if (!isOpen || !draft) return null;

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    onDraftChange({
      ...draft,
      [name]: value,
    });
  };

  return (
    <>
      <button className="settings-backdrop" type="button" aria-label="Закрыть настройки" onClick={onClose} />
      <aside className="settings-drawer">
        <div className="settings-drawer__header">
          <div>
            <div className="settings-drawer__eyebrow">Настройки персонажа</div>
            <h2>{draft.displayName}</h2>
          </div>
          <button className="settings-drawer__close" type="button" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <label className="settings-field">
          <span>Имя</span>
          <input name="displayName" value={draft.displayName} onChange={handleInputChange} />
        </label>

        <label className="settings-field">
          <span>Модель голоса</span>
          <input name="voiceModelId" value={draft.voiceModelId} onChange={handleInputChange} />
        </label>

        <label className="settings-field">
          <span>Голос</span>
          <input name="voiceName" value={draft.voiceName} onChange={handleInputChange} />
        </label>

        <label className="settings-field">
          <span>Фон</span>
          <select name="backgroundPreset" value={draft.backgroundPreset} onChange={handleInputChange}>
            {BACKGROUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>Приветствие</span>
          <input name="greetingText" value={draft.greetingText || ''} onChange={handleInputChange} />
        </label>

        <label className="settings-field settings-field--textarea">
          <span>Системный промпт</span>
          <textarea name="systemPrompt" value={draft.systemPrompt} onChange={handleInputChange} />
        </label>

        <div className="settings-drawer__footer">
          <button className="settings-save-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? 'Сохраняю...' : 'Сохранить'}
          </button>
        </div>
      </aside>
    </>
  );
}
