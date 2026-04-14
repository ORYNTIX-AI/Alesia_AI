# Очередь задач (TODO)

## Обязательно к выполнению следующей ИИ:

1.  **Начать декомпозицию `server/proxy.js`**:
    - Перенести все `app.post('/api/...')` и `app.get('/api/...')` в `server/routes/api.js`.
    - Это высвободит около 800 строк кода.

2.  **Выделить `geminiProxy.js`**:
    - Вынести функцию `attachGeminiBridgeConnection` и сопутствующие ей `sanitizeGeminiProxySetupMessage`, `createGeminiUpstreamSocket` в отдельный модуль в `server/websockets/`.

3.  **Очистить `src/App.jsx`**:
    - В файле ~30 функций-утилит (от строки 312 до 1475), которые не связаны с React-стейтом напрямую.
    - Вынести их в `src/utils/promptBuilder.js` и `src/utils/intentClassifier.js`.

4.  **Проверка после каждого шага**:
    - Запускать `node -c server/proxy.js` для проверки бэкенда.
    - Запускать `npm run build` (или `npx vite build`) для проверки фронтенда.

**Важно**: Сохранять все изменения в коде (синтаксис, логику Батюшки 3), которые были сделаны для стабильности.
