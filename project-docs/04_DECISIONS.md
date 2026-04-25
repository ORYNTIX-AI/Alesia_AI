# 04_DECISIONS

## Принятые решения

- `demo-content/` — основной источник редактируемого контента.
  - Почему: так проще менять демо без похода в runtime-код.

- Runtime-конфиг хранится в nested-виде со `schemaVersion: 2`.
  - Почему: меньше хаоса и меньше legacy-форматов на записи.

- Для feature-слоев используются публичные entrypoints `index.js`.
  - Почему: это уменьшает случайные прямые импорты во внутренности модулей.

- Агент сначала читает docs, потом код.
  - Почему: это экономит контекст и снижает риск лишних изменений.

- Без явного запроса не менять UI, архитектуру и бизнес-логику.
  - Почему: задача часто локальная, а побочные правки ломают предсказуемость.

- Общение с пользователем должно быть коротким и понятным.
  - Почему: проекту нужен рабочий ритм без лишней сложности и без раздувания контекста.

- Для `Батюшка 2` открытие сайтов остается через клиентскую orchestration-цепочку transcript -> browser flow.
  - Почему: в этот проход нужен стабильный realtime-разговор и русские browser intents, без добавления Gemini function calling.

- Для realtime-разговора `Батюшка 2` важнее перебивание, чем сверхдлинное ожидание конца речи.
  - Почему: `NO_INTERRUPTION` ломает barge-in, а демо требует бесшовного разговора.

- Gemini proxy не должен быть hardcoded в серверном коде; proxy задается только через env, а при сбое proxy код может попробовать direct fallback на ретрае.
  - Почему: сломанный или устаревший proxy ломает весь realtime-стек на домене, а hardcoded fallback скрывает реальное состояние production env.

## Решения, которые еще не закрыты

- Какой именно набор сценариев обязателен для финального demo-gate — УТОЧНИТЬ
- Где проходит граница между "допустимой локальной правкой" и "архитектурным изменением" — ТРЕБУЕТ РЕШЕНИЯ
## 2026-04-25 Batya 3 realtime decision

- `batyushka-3` uses Yandex AI Studio Realtime (`speech-realtime-250923`) as the primary voice agent path.
  - Why: Yandex docs describe this as the low-latency Russian voice-agent API with WebSocket events, LPCM audio, sessions, and native function calling.
- For `batyushka-3`, site opening and page questions must go through Yandex realtime tool calls (`open_site`, `view_page`, `extract_page_context`, `summarize_visible_page`), not client-side forced replies.
  - Why: the assistant must not say that a site is open until the browser runtime returns verified URL/title/visible state/screenshot or an honest error.
- Scenario text is allowed only as tests/acceptance criteria, not as hardcoded answer behavior.
  - Why: the demo must behave like a live voice agent, not a scripted flow.
