# План избавления от монолитов

Необходимо разделить огромные файлы `App.jsx` и `proxy.js` на модули для повышения стабильности и читаемости.

## 1. Бэкенд (`server/proxy.js`) -> ~2000 строк

**Цель**: Вынести логику в отдельные файлы.

- **`server/routes/api.js`**: Все HTTP-обработчики (STT, Turn, Conversation, Knowledge).
- **`server/websockets/geminiProxy.js`**: Логика трансляции WS для Gemini (из `attachGeminiBridgeConnection`).
- **`server/websockets/sttProxy.js`**: Логика для стриминга STT.
- **`server/proxy.js`**: Оставить только инициализацию сервера, подключение middleware и маршрутизацию WS/HTTP.

## 2. Фронтенд (`src/App.jsx`) -> ~6000 строк

**Цель**: Вынести утилиты и компоненты.

- **`src/utils/intentClassifier.js`**: Весь regex-код и классификация намерений (`isLikelyBrowserIntent`, `classifyTranscriptIntent`).
- **`src/utils/promptBuilder.js`**: Все функции формирования текстов для AI (`buildRuntimeTurnPrompt`, `buildSessionHistorySummary`).
- **`src/components/AvatarView.jsx`**: Рендеринг 3D сцены (Three.js + Canvas).
- **`src/components/LiveStatus.jsx`**: Физический индикатор "Онлайн/Слушаю" и индикаторы громкости.

## Статус
Разработка остановлена после успешной стабилизации Батюшки 3. Бэкенд готов к разделению.
