# 01_ARCHITECTURE

## Общая схема

Проект разделен на клиент, сервер, контент демо и тесты.

- Клиент в `src/`
- Сервер в `server/`
- Контент и настройки демо в `demo-content/`
- Проверки в `test/`

## Как устроен клиент

- `src/App.jsx` собирает экран и связывает подсистемы
- `src/features/avatar/` отвечает за сцену и аватар
- `src/features/voice/` отвечает за выбор и подключение голосового рантайма
- `src/features/browser/` отвечает за состояние и показ browser panel
- `src/features/session/` отвечает за orchestration разговора
- `src/features/config/` отвечает за работу с настройками

Внешние импорты лучше вести через `src/features/*/index.js`.

## Как устроен сервер

- `server/proxy.js` — вход в сервер
- `server/routes/` — HTTP API
- `server/ws/` — websocket-потоки для voice/runtime
- `server/browser/` — серверный browser runtime
- `server/services/` — отдельные сервисы

Смысл такой: routes и ws принимают запросы, а основная логика живет в runtime/service слоях.

## Откуда берется поведение демо

- `demo-content/default-app-config.json` — базовые настройки
- `demo-content/prompts/*.md` — промпты
- `demo-content/greetings/*.txt` — приветствия
- `server/configStore.js` — загрузка, сохранение и нормализация runtime-конфига

## Что важно для правок

- UI лучше менять отдельно от runtime-логики
- provider-specific код не размазывать по UI
- большие изменения сначала сверять с `ARCHITECTURE.md`
- если нужно быстро понять проект, сначала смотри `project-docs/00_INDEX.md` и `02_CURRENT_STATE.md`
