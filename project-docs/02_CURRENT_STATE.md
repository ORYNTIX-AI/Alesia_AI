# 02_CURRENT_STATE

## Что уже сделано

- Есть явные feature-entrypoints в `src/features/*/index.js`
- Контент демо вынесен в `demo-content/`
- Есть `schemaVersion: 2` для runtime-конфига
- Есть `ARCHITECTURE.md` и архитектурный тест
- `server/browser/` уже частично разрезан на модули
- Локальный quality gate снова живой:
  - `npm run lint` проходит
  - `npm test` проходит
  - `npm run test:architecture` проходит
  - `npm run build` проходит
  - `npm run test:e2e` проходит
- После разрезания восстановлены потерянные helper/export цепочки в:
  - `src/features/session/transcript*`
  - `src/hooks/geminiLiveShared.js`
  - `server/ws/yandexRealtimeShared.js`
  - `server/ws/yandexRealtimeTools.js`
- Исправлены русские строки и regex в voice/session/browser runtime:
  - приветствия, stop-фразы, persona-вопросы, молитвы
  - открытие сайтов и действия `назад / вперёд / обнови / прокрути / нажми`
  - STT prompt и статусы session/browser
- Для `Батюшка 2` в Gemini Live включен профиль `NO_INTERRUPTION`, чтобы эхо телефона не обрезало ответ ассистента на полуслове.
- Gemini audio-only turn теперь финализируется как отвеченный turn, а не дропается как `empty-commit`.
- Для `Батюшка 3` разрешен кодовый fallback `yandex-realtime -> yandex-full-legacy` при runtime/connect ошибках.
- Добавлены unit-тесты на русские voice/browser сценарии и проверку prompt builders на mojibake.
- Для Yandex Realtime cancel теперь отправляется в upstream только для активного незакрытого `response_id`.
- Для Gemini WebSocket добавлен direct fallback на повторной попытке, если настроенный proxy ломает подключение.

## Что сейчас в работе

- Финальная live-проверка голосовых стеков с реальными секретами
- Ручная проверка перебивания и открытия сайтов для `Батюшка 2` / `Батюшка 3`
- Production `https://alesia-ai.constitution.of.by`:
  - 2026-04-24: `Батюшка 3` на Yandex Realtime задеплоен в bundle `index-FOkAWQo1.js`; `/health` отвечает 200, контейнер `ALesia_AI` healthy.
  - 2026-04-24: исправлен `ReferenceError: extractSiteLookupQuery is not defined` в browser intent (`server/browser/siteResolutionSupport.js`), который давал голосовой ответ об ошибке вместо нормального действия.
  - 2026-04-24: короткие/неясные Yandex realtime STT-фрагменты теперь игнорируются без ответа, а короткие финалы держатся дольше и склеиваются с продолжением; это убирает ложные ответы вроде "чем могу помочь" на шум/обрывки.
  - 2026-04-24: доменный browser voice-smoke для `Батюшка 3` прошел: `stt.stream.final.merge`, один `assistant.turn.start`, `assistant.turn.audio-start`, `assistant.turn.lips-started`, `runtime.request.final: answered`, без `answer-audio-missed`, `browser.intent.error`, `runtime.repeat-request`.
  - health отвечает, контейнер живой
  - `Батюшка 3` через Yandex Realtime пересобран и выкачен на домен; актуальный доменный bundle `index-FOkAWQo1.js`, WebSocket-smoke и браузерный voice-smoke через домен прошли, аудио получено, UI стартует до `connected`
  - Docker runtime-образ теперь включает `demo-content/`; без этого сервер падал на `/app/demo-content/default-app-config.json`
  - Ручной vendor-split в Vite отключен: старый split создавал цикл `react-vendor <-> fiber-vendor` и белый экран `Cannot read properties of undefined (reading 'useLayoutEffect')`
  - Для `Батюшка 3` добавлена защита от ложного `audio-start`: клиент считает аудио только после успешной постановки в WebAudio и пишет `assistant.turn.audio-drop`, если звук не принят
  - Для `Батюшка 3` добавлен echo gate: пока ответ ассистента еще играет в WebAudio, клиент не отправляет микрофонный поток обратно в Yandex, чтобы ответ не перебивался собственным эхом
  - Для `Батюшка 3` добавлен endpointing поверх Yandex Realtime: финальные STT-фрагменты буферизуются до короткой паузы и склеиваются, чтобы ассистент не отвечал на обрывки фразы; Yandex-final теперь хранится в отдельном ref, чтобы partial-события не очищали отложенный commit
  - Для silent-ответов Yandex Realtime усилен TTS fallback: меньшие куски, длиннее таймауты и серверная проверка пустого TTS-аудио
  - Для мобильных браузеров добавлен HTMLAudioElement fallback: если WebAudio на телефоне принимает chunk, но фактически не звучит/не дает уровень для рта, аудио проигрывается через обычный audio element, а lip-sync получает fallback-volume
  - Старый PWA/service worker отключен через серверные `/sw.js` и `/registerSW.js`, чтобы браузер не оставался на старом клиентском bundle
  - Свежие production-логи после проверки без `illegal`, `Invalid request`, `response-cancel.ignored` и `audio-drop`
  - `Батюшка 2` через Gemini сейчас блокируется инфраструктурно: прямой доступ Google возвращает `User location is not supported for the API use`, сохраненные proxy либо мертвые, либо возвращают `Socks5 proxy rejected connection - NotAllowed`

## Что сейчас важно

- `src/features/session/useConversationRuntimeController.js` все еще большой файл: около `1874` строк
- `server/browser/index.js` уже тонкий фасад, локальный e2e после правок проходит
- В архитектурном тесте все еще есть временные исключения по размеру файлов
- Локальные unit-тесты покрывают русские transcript/browser сценарии, но live-голос нужно проверять отдельно
- `npm run test:live` требует env:
  - `GEMINI_API_KEY`
  - `YANDEX_FOLDER_ID`
  - `YANDEX_API_KEY` или `YANDEX_IAM_TOKEN`
- Для `Батюшка 3` live-путь Yandex на production проверен через домен; полноценную проверку качества распознавания/ответа все еще лучше делать голосом вручную
- Для `Батюшка 2` на production нужен рабочий proxy/регион для Gemini Live; без него доменный smoke не пройдет.

## Что не стоит делать без запроса

- Не трогать бизнес-логику голосовых рантаймов
- Не менять UI и поведение демо
- Не делать побочный рефакторинг по пути

## Что еще неясно

- Точный формальный список MVP-сценариев — УТОЧНИТЬ
- Полный критерий состояния "идеал" для демо — ТРЕБУЕТ РЕШЕНИЯ
- Где лежат актуальные Yandex-секреты пользователя — УТОЧНИТЬ
## 2026-04-25 Server verification update

- Deployed current `batyushka-3` Yandex realtime/browser changes to `https://alesia-ai.constitution.of.by`; domain health is OK and active bundle is `assets/index-p2S_4E--.js`.
- Server-side `LIVE_SMOKE_TARGETS=yandex-realtime,browser,knowledge npm run test:live` passed on port `3311` with real server env.
- The smoke verified Yandex realtime `open_site` -> `https://azbyka.ru/`, `verified: true`, screenshot/title/url present, browser query/action working, and knowledge query working.
- During live smoke, fixed browser runtime regressions that only appeared on the real server path:
  - missing shared `computeStemSimilarity`;
  - missing `DIRECT_URL_REGEX` / `DOMAIN_REGEX` imports;
  - `getBrowser()` referencing stale module globals instead of `sessionStore`.
- Domain Chromium smoke passed: page title `Алеся ИИ`, primary button `Начать разговор`, no page console errors.

## 2026-04-25 Batya 3 Yandex realtime state

- `batyushka-3` now sends recognized Yandex Realtime user turns to the model as real `user_text`; client-side scenario prompts and browser-open orchestration are bypassed for this runtime.
- The Yandex realtime gateway no longer has forced browser/self-intro reply paths. Site opening must come from model tool calls.
- Added `VoiceConversationStateMachine` for Yandex realtime states: `idle/listening/user_speaking/endpointing/thinking/tool_running/assistant_speaking/recovering/error_visible`.
- Browser `open_site` now requires a verified snapshot before it can return `ok: true`: non-blank URL, no `chrome-error`, no HTTP error status when available, and visible title/text/screenshot state.
- Yandex realtime barge-in now interrupts active local audio on `speech_started`; runtime assistant-answer suppression/filtering is no longer used for `batyushka-3`.
- `test/live/liveSmoke.js` now fails Yandex realtime if `open_site` is not verified, screenshot/title/url are missing, assistant audio is absent, or a generic filler appears.
- Local checks passed: `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`, `npm run test:architecture`.
- Local `npm run test:live` did not run because local env is missing `GEMINI_API_KEY`, `YANDEX_FOLDER_ID`, and `YANDEX_API_KEY|YANDEX_IAM_TOKEN`.

## 2026-04-25 Batya 3 semantic production probe

- Found real human-quality failure on production semantic probe: Yandex Realtime produced repeated service-desk style endings after otherwise valid answers.
- Replaced phrase-specific runtime suppression with native Yandex Realtime flow and general natural-dialogue instructions.
- Deployed the fix to `https://alesia-ai.constitution.of.by`; `/health` is OK and container `ALesia_AI` is healthy.
- Re-ran production semantic probe with three turns:
  - "Николай, кто ты?" -> "Меня зовут Николай."
  - "Открой сайт Азбука веры." -> verified `open_site` to `https://azbyka.ru/`, no generic ending.
  - "Что там написано на странице?" -> used page summary tool and answered from the visible page, no generic ending.
- Local checks after the semantic fix passed: `npm test`, `npm run lint`, `npm run build`.

## 2026-04-25 Batya 3 native Yandex realtime correction

- `batyushka-3` now uses Yandex Realtime server VAD with `create_response: true`; audio turns are no longer converted into delayed client `input_text` prompts.
- Client-side Yandex final transcript handling now records the user turn and waits for the native Realtime response instead of sending the transcript back as a new text request.
- Removed runtime assistant-answer filtering/suppression from the Yandex Realtime path. Repeated formulaic replies must be caught by smoke/semantic tests, not hidden from the user.
- Yandex Realtime session instructions explicitly reject the observed service-desk formulas; this is model steering, not runtime answer replacement or audio suppression.
- Local checks for this correction passed: `npm test`, `npm run lint`, `npm run build`.

## 2026-04-25 Batya 3 lazy browser tools update

- Default Yandex Realtime sessions no longer advertise browser tools to the model; tools are only exposed when `advertiseTools: true` is explicitly set for live tool smoke.
- Batya 3 voice browser intents now route through the real application browser runtime, not through native Yandex tool calls in the ordinary conversation session.
- Browser open/page/action replies are generated only after the app has real browser context or an error from the browser runtime.
- The client suppresses and cancels the unwanted native Yandex response for browser-routed audio turns so it does not speak generic filler over the browser operation.
- Deployed to `https://alesia-ai.constitution.of.by`; active bundle `assets/index-DhbK9gZR.js`, `/health` OK, container `ALesia_AI` healthy.
- Domain smoke passed: Yandex realtime greeting returned audio text `Здравствуйте!` with no tool call/generic filler; browser open verified `https://azbyka.ru/` with title and screenshot.
- Follow-up production log fix: removed interrupt for rejected low-value Yandex responses and prevented page-query browser routing when no site is active; redeployed bundle `assets/index-DKnSMV9n.js`.
- Frontend fake-mic acceptance found and fixed the real missed-answer path: greeting finals like `привет` were being classified as unclear and the frontend dropped the assistant audio as `unexpected-start`.
- After redeploy, Chromium fake microphone test against the domain passed end-to-end through the frontend: `stt.stream.final`, `assistant.turn.audio-start`, `runtime.request.final: answered`, last answer `Здравствуйте!`, no `assistant.turn.drop`, no `low-value-yandex-final`, no generic help phrase.

## 2026-04-25 Batya 3 browser concurrency fix

- Found the site-flow failure cause: an ordinary new Yandex voice turn cancelled pending browser work and cleared queued browser speech while a site was still resolving/opening.
- Found production browser intent regressions on the real site path: missing shared imports in `server/browser/intentResolver.js`, `siteResolution.js`, and `siteResolutionSupport.js` caused `ReferenceError` before a page could open.
- Batya 3 now preserves in-flight browser opening for ordinary voice turns, restores a model-generated opening acknowledgement, and lets the browser result attach to the current live dialog instead of being dropped as stale.
- Page questions during a still-loading browser operation now get a truthful pending-page response instead of silent return.
- Batya 3 browser panel mode is `remote`; duplicate site-open STT fragments while a page is already opening are ignored instead of interrupting the verified browser open.
- Local checks passed after the fix: `npm test`, `npm run build`.

## 2026-04-25 Batya 3 Yandex turn gating deploy

- Batya 3 Yandex realtime now keeps short/incomplete final STT fragments on hold for a short merge window and commits them as one user turn after the phrase stabilizes.
- This follows the Yandex realtime turn model more closely: one user utterance should produce one assistant answer instead of several competing turns.
- Footer version is raised to `v0.0.3`.
- Current production deploy is live on `https://alesia-ai.constitution.of.by`; `/health` is OK and the active bundle is `assets/index-yfgPhMap.js`.
- Local checks passed after the change: `npm test`, `npm run build`.

## 2026-04-26 Avatar and Batya 2 runtime config

- Fixed production runtime config that still pointed Batyushka avatars to missing `avatars/nikolay.webp.glb`; the working asset is `avatars/nikolay.glb`.
- Batyushka 2 remains on `models/gemini-3.1-flash-live-preview` and now uses the same browser principle as Batyushka 3: `remote` panel with `url-fetch` page context.
- Domain Chromium check no longer shows `Ошибка 3D-аватара`; footer version is raised to `v0.0.4`.
- Production deploy restored after `/app/data/app-config.json` was found empty; domain `/health` is OK again, active character is `batyushka-3`, and the active bundle is `assets/index-Bllxplk_.js`.
- Current blocker for Batyushka 2 live Gemini testing is infrastructure: server env has no working Gemini proxy (`proxyHost` is empty), so Gemini Live can still hit regional restrictions until a supported-region proxy is configured.
- Added a Brazil proxy in production env without committing credentials; `/health` now reports proxy host `196.19.122.152` and scheme `http`.
- Gemini Live smoke for Batyushka 2 through the proxy passed `setupComplete` and returned both text and audio (`Христос воскресе.`, 10 audio chunks).
- Production active character is now `batyushka-2`; Chromium domain check shows `Батюшка 2`, footer `v0.0.4`, no 3D avatar error, and no console errors.

## 2026-04-27 Batya 2 Gemini 3.1 TTS update

- Project rules now forbid Google/Gemini models below 3.1 in production defaults/config.
- Default Gemini Live model is `models/gemini-3.1-flash-live-preview`.
- `batyushka-2` has an explicit TTS model: `gemini-3.1-flash-tts-preview`.
- Added server route `/api/gemini/tts` that calls Gemini `generateContent` with `responseModalities: ["AUDIO"]` and `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- Batyushka 2 silent-audio repair now uses Gemini 3.1 Flash TTS instead of Yandex TTS.
- Footer version is raised to `v0.0.5`.
- Deployed to `https://alesia-ai.constitution.of.by`; `/health` is OK, runtime config is active on `batyushka-2`, and `/api/gemini/tts` returned PCM audio for a short Russian phrase.
- 2026-04-27 follow-up: mobile playback now uses the scheduled WebAudio path instead of forcing per-chunk HTMLAudio output; footer version is raised to `v0.0.6`.
- 2026-04-27 follow-up: Batyushka 2 now hard-gates microphone frames during and shortly after assistant playback to stop echo from becoming a false Gemini barge-in; footer version is raised to `v0.0.7`.
- 2026-04-27 follow-up: fixed Batyushka 2 echo hold so it no longer extends itself forever after assistant speech, disabled automatic session greeting for Batyushka 2, and reduced Gemini Live endpointing delay; footer version is raised to `v0.0.8`.
- 2026-04-27 follow-up: Batyushka 2 Gemini Live now uses `NO_INTERRUPTION` activity handling so phone echo/noise cannot server-interrupt the assistant mid-phrase; footer version is raised to `v0.0.9`.
- 2026-04-27 follow-up: frontend HTML now loads `/registerSW.js` to unregister old service workers and clear stale browser caches on real clients; footer version is raised to `v0.0.10`.
