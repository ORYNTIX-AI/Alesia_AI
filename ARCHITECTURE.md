# Architecture

## Goal

The repo is organized so that a developer can answer three questions quickly:

1. Which subsystem owns the behavior?
2. Which public module is the only supported entrypoint?
3. Which config/content file changes the demo behavior?

## Main Subsystems

- `avatar`
  - Client entry: `src/features/avatar/index.js`
  - Responsibility: stage presets and avatar scene configuration.
- `voice`
  - Client entry: `src/features/voice/index.js`
  - Responsibility: runtime selection, adapter contract, Gemini/Yandex session wiring.
- `browser`
  - Client entry: `src/features/browser/index.js`
  - Server entry: `server/browser/index.js`
  - Responsibility: intent detection, open/view/query/action browser flow.
- `knowledge`
  - Server entry: `server/routes/knowledgeRoutes.js`
  - Responsibility: local knowledge refresh and query flow.

## Config Source Of Truth

- Demo content: `demo-content/default-app-config.json`
- Prompt files: `demo-content/prompts/*.md`
- Greeting files: `demo-content/greetings/*.txt`
- Runtime persistence and migration: `server/configStore.js`

Persisted config is always `schemaVersion: 2` and stays nested:

- `identity`
- `avatar`
- `background`
- `runtime`
- `browser`
- `content`
- `knowledge`

## Canonical Entry Points

- App shell: `src/App.jsx`
- Session orchestration: `src/features/session/index.js`
- Browser client model/controller: `src/features/browser/index.js`
- Voice adapters/runtime selection: `src/features/voice/index.js`
- HTTP routes: `server/routes/*`
- WebSocket gateways: `server/ws/*`
- Browser server runtime: `server/browser/index.js`

Code outside a feature should import from the feature `index.js` entrypoint, not from internal modules, unless the import stays inside the same feature folder.

## Main Runtime Flows

### Session Start

1. `src/App.jsx` composes the selected character and runtime config.
2. `src/features/session/useDemoSessionController.js` resolves UI state.
3. `src/features/session/useConversationRuntimeController.js` wires transcript, browser and voice runtime behavior.
4. `src/features/voice/useVoiceRuntimeAdapters.js` selects the active runtime session.
5. The chosen runtime connects through `server/ws/*` or HTTP routes.

### Browser Open

1. User turn is classified by session/browser client logic.
2. The server browser entry `server/browser/index.js` resolves intent.
3. The browser session is opened, snapshotted and persisted in active runtime state.
4. The client browser panel receives remote view/context data and renders it.

### Assistant Turn

1. User transcript is normalized in `src/features/session/transcriptFlowModel.js`.
2. Session orchestration queues the assistant turn.
3. The active voice adapter sends the turn to Gemini or Yandex.
4. Runtime output events are mapped back into assistant text/audio/browser state.

## Editing Rules

- Put demo-editable strings and behavior defaults in `demo-content` or persisted config, not in runtime code.
- Keep provider-specific logic inside adapters and gateways, not in UI components.
- Keep UI components presentational; orchestration belongs in hooks/controllers.
- Keep server routes thin; business logic belongs in services/runtime modules.
