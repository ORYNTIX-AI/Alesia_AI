# 00_INDEX

## Быстрый маршрут по проекту

- `AGENTS.md` — как агенту работать с этим репозиторием
- `README.md` — запуск и команды
- `ARCHITECTURE.md` — более формальное описание архитектуры
- `project-docs/` — короткая рабочая документация по текущему состоянию

## Основные папки

- `demo-content/`
  - `default-app-config.json` — базовый конфиг демо
  - `prompts/` — системные промпты
  - `greetings/` — приветствия персонажей
- `src/`
  - `App.jsx` — тонкая точка сборки клиента
  - `features/` — основные feature-модули
  - `components/` — UI-компоненты
  - `hooks/` — хуки и runtime-обвязка
  - `styles/` — стили
- `server/`
  - `proxy.js` — основной серверный entrypoint
  - `routes/` — HTTP-маршруты
  - `ws/` — websocket gateway
  - `browser/` — browser runtime на сервере
  - `services/` — серверные сервисы
  - `http/` — HTTP-вспомогательные модули
- `test/`
  - `architecture/` — архитектурные проверки
  - `client/` — клиентские тесты
  - `server/` — серверные тесты
  - `e2e/` — Playwright smoke
  - `live/` — live smoke с реальными интеграциями
- `runtime-data/`
  - `app-config.json` — runtime-конфиг
  - `runtime.log` — лог сервера

## Важные файлы

- `package.json` — все команды проекта
- `vite.config.js` — сборка клиента
- `eslint.config.js` — lint
- `playwright.config.js` — e2e
- `.env.example` — пример env
- `project-docs/05_VOICE_RUNTIME_HISTORY.md` — история гипотез и правок по Gemini 3.1 Live / Yandex Realtime

## Что читать в первую очередь

1. `project-docs/02_CURRENT_STATE.md`
2. `project-docs/03_NEXT_STEPS.md`
3. `project-docs/05_VOICE_RUNTIME_HISTORY.md` — если задача касается голосовых рантаймов
4. Только потом нужные файлы кода
