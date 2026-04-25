# Alesia AI Demo

Demo app with four live subsystems:

- `avatar`: 3D avatar scene
- `voice`: Gemini Live, Yandex Realtime, Yandex Legacy
- `browser`: open, inspect, query, and act on websites
- `knowledge`: local knowledge sources and query flow

Architecture source of truth: [ARCHITECTURE.md](D:/Oryntix/Git/Alesia_AI/ARCHITECTURE.md)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from [.env.example](D:/Oryntix/Git/Alesia_AI/.env.example).

3. Start client and server:

```bash
npm run dev
```

## Main Scripts

- `npm run dev`: start server and client together
- `npm run dev:server`: start Node API/proxy only
- `npm run dev:client`: start Vite only
- `npm run lint`: lint `src`, `server`, and `test`
- `npm test`: deterministic unit and smoke tests
- `npm run build`: production build
- `npm run test:e2e`: deterministic Playwright smoke
- `npm run verify`: `lint + test + build + test:e2e`
- `npm run test:live`: real live smoke against Gemini, Yandex, browser, and knowledge integrations
- `npm run demo:gate`: `verify + test:live`

## Config And Content

- `demo-content/default-app-config.json`: versioned demo config
- `demo-content/prompts/*.md`: system prompts
- `demo-content/greetings/*.txt`: character greetings
- `server/configStore.js`: strict `schemaVersion: 2` sanitize, load, save, and migration logic

Persisted config stays nested on disk:

- `identity`
- `avatar`
- `background`
- `runtime`
- `browser`
- `content`
- `knowledge`

Legacy flat fields are normalized on read and are never written back.

## Editing The Demo

To change a character, edit `demo-content/default-app-config.json` or use the in-app settings drawer.

Main character fields:

- `displayName`
- `runtimeProvider`
- `voiceModelId`
- `voiceName`
- `ttsVoiceName`
- `backgroundPreset`
- `browserPanelMode`
- `pageContextMode`
- `promptRef`
- `greetingRef`

Prompt and greeting source files live in:

- `demo-content/prompts`
- `demo-content/greetings`

## Current Architecture

See [ARCHITECTURE.md](D:/Oryntix/Git/Alesia_AI/ARCHITECTURE.md) for canonical entrypoints and runtime flows.

## Live Smoke Notes

`npm run test:live` requires configured live secrets:

- `GEMINI_API_KEY`
- `YANDEX_FOLDER_ID`
- `YANDEX_API_KEY` or `YANDEX_IAM_TOKEN`

The live smoke starts a dedicated local server instance, runs live runtime flows, and fails if:

- required env vars are missing
- browser open/query/action fails
- Gemini live websocket flow fails
- Yandex realtime flow fails
- Yandex legacy turn or STT/TTS fails
- runtime log contains `level: error`
