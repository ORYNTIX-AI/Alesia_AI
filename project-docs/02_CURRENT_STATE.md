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
- 2026-04-27 follow-up: avatar GLB files are now served through an explicit `/avatars/:fileName` route with `model/gltf-binary` and immutable cache headers to avoid browser `ERR_HTTP2_PROTOCOL_ERROR`; footer version is raised to `v0.0.11`.
- 2026-04-27 follow-up: reduced streamed-audio restart gaps, disabled Yandex Realtime server auto-interrupt while keeping native `create_response`, and raised early local-output cancel guard; footer version is raised to `v0.0.12`.
- 2026-04-27 follow-up: restored guarded barge-in for Batyushka 2 Gemini Live: `START_OF_ACTIVITY_INTERRUPTS`, 250ms echo tail, local mic frames pass during assistant playback only for strong user speech (`rms >= 0.18`), and Gemini `interrupted` events are no longer suppressed client-side.
- 2026-04-27 follow-up: reduced Batyushka 3 Yandex Realtime turn latency: final merge window 600ms, normal hold 180ms, short hold 280ms, assistant echo window 400ms, and short answers such as `да`, `нет`, `ок` now count as meaningful turns.
- 2026-04-27 follow-up: restored automatic session greeting for Batyushka 2 and Batyushka 3; Yandex Realtime now lets strong local user speech pass through the playback echo gate and ignores server `speech_started` interrupts when local mic volume is below the user-speech guard.
- Local checks after the guarded barge-in update passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`.
- Deployed guarded barge-in update to `https://alesia-ai.constitution.of.by`; `/health` is OK, container `ALesia_AI` is healthy, active bundle is `assets/index-Cw_LSh5i.js`, and Chromium domain sanity found no page console errors.
- Fixed `test/live/liveSmoke.js` for Gemini 3.1 text turns (`realtimeInput.text` instead of legacy `client_content`).
- Production `LIVE_SMOKE_TARGETS=gemini-live,yandex-realtime,browser,knowledge npm run test:live` passed from a server temp checkout with real production env: Gemini Live returned setup/text/audio, Yandex Realtime opened verified `https://azbyka.ru/`, browser query/action passed, and knowledge returned hits.

## 2026-04-28 Voice cutoff repair

- Footer/package version raised to `v0.0.13`.
- Batyushka 2 Gemini Live returns to `NO_INTERRUPTION` activity handling; Google docs state `START_OF_ACTIVITY_INTERRUPTS` cuts the current response at activity start, which matches the observed half-word cutoff from phone echo/noise.
- Batyushka 2 still keeps local guarded interruption: weak mic echo is suppressed during playback, and only strong local speech can stop local playback.
- Batyushka 3 no longer holds Yandex Realtime final transcripts before creating the local request state. Native Yandex `create_response` can start the assistant response immediately, so client-side final-hold caused `assistant.turn.drop: unexpected-start` and missed answers.
- Local checks after the repair passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`.
- Deployed `v0.0.13` to `https://alesia-ai.constitution.of.by`; `/health` is OK, container `ALesia_AI` is healthy, and active bundle is `assets/index-DyFDlTTd.js`.
- Production `LIVE_SMOKE_TARGETS=gemini-live,yandex-realtime,browser,knowledge npm run test:live` passed on port `3314` with real production env: Gemini Live setup/text/audio, Yandex Realtime verified `open_site`, browser query/action, and knowledge query all succeeded.

## 2026-04-28 Gemini turn lifecycle repair

- Footer/package version raised to `v0.0.14`.
- Root cause found in history/logs: Batyushka 2 could close the local assistant turn on Gemini `generationComplete` or idle fallback while Google was still delivering/playing the turn; late chunks then hit `assistant.turn.drop: unexpected-start` and could be suppressed.
- Gemini Live assistant turns now commit only on `turnComplete`; Batyushka 2 idle fallback also waits while the audio player still has buffered output.
- Added tests that reject treating `generationComplete` as a completed Gemini turn, including the production live-smoke path.
- Production logs after `v0.0.13` showed Batyushka 3 producing `assistant.turn.start`, `assistant.turn.audio-start`, and `assistant.turn.commit` for normal Yandex Realtime turns; no fresh `unexpected-start` was found in the recent checked window.
- Local checks after the lifecycle repair passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.
- Deployed `v0.0.14` to `https://alesia-ai.constitution.of.by`; `/health` is OK, container `ALesia_AI` is healthy, active bundle is `assets/index-BgxocFBR.js`, and the footer shows `v0.0.14`.
- Direct production WebSocket smoke passed: Gemini Live returned text/audio and reached `turnComplete` after `generationComplete`; Yandex Realtime returned text/audio and `assistant_turn_done`.
- Fresh production logs after the smoke had no `assistant.turn.interrupted`, `assistant.turn.drop`, `audio-drop`, `answer-audio-missed`, or `unexpected-start`.

## 2026-04-28 Voice stabilization v0.0.15

- Footer/package version raised to `v0.0.15`.
- `/health` now exposes `version`, `commit`, and `buildTime`; Docker build accepts `APP_VERSION`, `APP_COMMIT`, and `APP_BUILD_TIME` args so production deploys can be verified by commit.
- Batyushka 2 Gemini Live keeps `NO_INTERRUPTION`, but server VAD is less sensitive: low start/end sensitivity, longer prefix padding, and `silenceDurationMs: 800`.
- Batyushka 2 local mic path keeps sending audio during assistant playback, but suppresses weak mic frames for a short tail after playback drains to reduce phone echo false starts without restoring the old hard playback gate.
- Batyushka 3/Yandex Realtime logs peak RMS per throttle window and retries WebAudio scheduling after a suspended AudioContext resumes.
- Exact prayer reading is now sent as a short confirmed fragment instead of a long 900-1200 character turn; voice stop commands can locally interrupt active assistant speech.
- Browser intent detection now treats known Azbyka/Azbyka Vera open-site phrasing as `site_open` before ordinary chat.
- Local checks after the change passed: `npm test`, `npm run lint`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.

## 2026-04-28 Human voice loop v0.0.16

- Footer/package version raised to `v0.0.16`.
- Batyushka 2 keeps Gemini Live `NO_INTERRUPTION`, but local RMS barge-in now stops playback immediately, marks the active turn interrupted, and suppresses late Gemini chunks until `turnComplete`.
- Batyushka 2 endpointing is faster: `prefixPaddingMs: 140`, `silenceDurationMs: 620`, low start/end sensitivity.
- Batyushka 3 Yandex Realtime uses local RMS barge-in plus upstream `interrupt`, and Yandex output prefers HTMLAudio fallback with playback start/end/output-mode telemetry.
- Stop words now include `не надо`/`отмена`; fuzzy stop is enabled for short prayer-reading interruptions such as `опыт`.
- Prayer exact reading is capped to a short confirmed fragment (`<= 340` chars) and strips known page chrome before prayer text.
- Runtime skips knowledge lookup for simple greetings/persona/capability/browser/stop turns; longer lookup/prayer turns get a short high-priority status prompt first.
- Browser voice routing now logs `browser.intent.input`, `browser.intent.classified`, `browser.intent.skipped`, `browser.open.started`, and `browser.open.result`.
- Local checks after the change passed: `npm test`, `npm run lint`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.

## 2026-04-28 Batyushka 2 Gemini 3.1 config alignment v0.0.17

- Footer/package version raised to `v0.0.17`.
- Batyushka 2 keeps the local Orthodox prompt, but its Gemini Live defaults are aligned to the working Gemini 3.1 setup: Live model `models/gemini-3.1-flash-live-preview`, TTS model `gemini-3.1-flash-tts-preview`, audio response modality, prebuilt voice `Schedar`, and output audio transcription enabled.
- `STT_MODEL` now normalizes old Gemini model strings below 3.1 back to `models/gemini-3.1-flash-live-preview`, so copied env values cannot silently restore Gemini 2.5.
- `.env.example` no longer suggests Gemini models below 3.1 for STT/browser resolver defaults.
- Deployed `v0.0.17` to `https://alesia-ai.constitution.of.by`; `/health` is OK, active bundle is `assets/index-BJ6GHkD2.js`, and runtime config for `batyushka-2` has `outputAudioTranscription: true`.
- Production Gemini smoke for `batyushka-2` reached `setupComplete`, returned PCM audio chunks, and reached `turnComplete`; fresh container logs had no `assistant.turn.drop`, `unexpected-start`, `audio-drop`, `answer-audio-missed`, or error matches.

## 2026-04-28 Batyushka 2 Sapphire-compatible native Gemini audio v0.0.18

- Footer/package version raised to `v0.0.18`.
- Compared against the provided stable `assistant-sapphire` project and matched the important Gemini Live behavior for `batyushka-2`.
- Batyushka 2 now lets Gemini Live own the native audio turn: recognized input transcription is recorded, but it is not replayed back to Gemini as a second text prompt.
- Removed the explicit `realtimeInputConfig` for Batyushka 2 Gemini 3.1 so the session uses Gemini Live defaults like the stable project.
- Batyushka 2 microphone capture now mirrors the stable project: `getUserMedia({ audio: true })`, `AudioContext({ sampleRate: 16000 })`, `ScriptProcessorNode(4096)`, no local input gain, no local RMS barge-in, and no mic-tail frame gate.
- Batyushka 2 output playback uses simple sequential WebAudio chunk playback instead of pre-scheduled overlapping chunk playback.
- Native Gemini audio that starts before local request bookkeeping is now accepted by creating/recovering a local request instead of dropping it as `assistant.turn.drop: unexpected-start`.
- Local checks after the change passed: `npm run lint`, `npm test`, `npm run test:architecture`, `npm run build`, `npm run test:e2e`.
- Deployed `v0.0.18` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.18`, commit `d253af9-local-v0.0.18`, active bundle `assets/index-iWqBrB4s.js`, and container `ALesia_AI` is healthy.
- Production `batyushka-2` config still uses Gemini 3.1 Live/TTS, `liveInputEnabled: true`, `outputAudioTranscription: true`, `remote` browser panel, and `url-fetch` page context.
- Direct production `batyushka-2` WebSocket text smoke reached `setupComplete`, returned 23 PCM audio chunks, and reached `turnComplete`; fresh logs had no `assistant.turn.drop`, `unexpected-start`, `audio-drop`, or `answer-audio-missed`.

## 2026-04-28 Batyushka 3 native Yandex Realtime simplification v0.0.19

- Footer/package version raised to `v0.0.19`.
- Batyushka 3 Yandex Realtime was still carrying local runtime overlays: local RMS barge-in, final-transcript suppression, echo/backchannel drops, client-side `response.cancel` on `speech_started`, HTMLAudio output preference, and custom VAD fields.
- Aligned Batyushka 3 closer to the official Yandex Realtime voice-agent flow: server VAD in session config, client streams microphone audio, `speech_started` clears only local playback, response audio is accepted from the native response, and final transcripts are recorded without being filtered/replayed.
- Yandex Realtime `turn_detection` now uses the documented minimal shape: `type: server_vad`, `threshold: 0.5`, `silence_duration_ms: 400`; no `prefix_padding_ms`, `create_response`, or `interrupt_response` override.
- Yandex Realtime output now uses sequential WebAudio playback instead of forcing HTMLAudio fallback.
- Local checks after the change passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.
- Deployed `v0.0.19` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.19`, commit `d253af9-local-v0.0.19`, container `ALesia_AI` is healthy, and active bundle is `assets/index-3OSVtMBB.js`.

## 2026-04-28 Voice playback diagnostics and repair v0.0.20

- Footer/package version raised to `v0.0.20`.
- Production logs showed the real user-visible failure mode: audio chunks were accepted and scheduled, but playback could be stopped almost immediately after `speech_started`, leaving no audible voice or lip movement.
- Batyushka 3/Yandex Realtime now logs the whole audio path: `voice.yandex.profile`, `voice.yandex.ready`, `voice.yandex.final-transcript`, `voice.yandex.audio-delta`, `voice.yandex.speech-started`, `voice.yandex.turn-done`, plus server-side `yandex.realtime.*` upstream events.
- Yandex `speech_started` no longer stops already-buffered local playback after the native response has been handed to the player. It can stop only an active streaming turn with real local user volume above the guard.
- Batyushka 2/Gemini 3.1 now forces the Sapphire-compatible audio path for Gemini 3.1 Live even if character metadata is stale: no explicit realtime input config and sequential WebAudio output.
- Playback telemetry now includes stop reasons, queue depth, buffered milliseconds, elapsed milliseconds, scheduled delay, and `earlyEnded` so false "audio-start" can be separated from audible playback.
- Local checks after the change passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.
- Deployed `v0.0.20` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.20`, commit `d253af9-local-v0.0.20`, container `ALesia_AI` is healthy, and active bundle is `assets/index-K9n5_rEe.js`.

## 2026-04-28 Batyushka 2 Sapphire direct playback v0.0.21

- Footer/package version raised to `v0.0.21`.
- Batyushka 2/Gemini 3.1 no longer sends assistant PCM through the shared `AudioStreamPlayer` scheduler. It uses a dedicated Sapphire-style queue: `Float32Array[]`, `AudioContext.createBuffer(..., 24000)`, `BufferSource -> audioContext.destination`, and `onended -> next chunk`.
- The direct Sapphire queue still emits playback telemetry and synthetic volume so the avatar mouth and voice meter can move without putting the audio through the shared gain/analyser path.
- Sapphire-path Gemini setup now matches the provided stable project more closely: audio response modality, prebuilt voice `Zephyr`, input/output audio transcription, no explicit `realtimeInputConfig`, no `thinkingConfig`, no session resumption, and no context window compression. The local Batyushka prompt remains.
- Local checks after the change passed: `npm run lint`, `npm test`, `npm run build`, `npm run test:architecture`, `npm run test:e2e`.
- Deployed `v0.0.21` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.21`, commit `d253af9-local-v0.0.21`, active bundle is `assets/index-DyCMqEDn.js`, and container `ALesia_AI` is healthy.
- Production runtime config was updated only for `batyushka-2`: active character remains `batyushka-2`, voice/tts voice are `Zephyr`, `outputAudioTranscription` is `true`, and Gemini model remains `models/gemini-3.1-flash-live-preview`.
- Production Batyushka 2 direct WebSocket smoke with the Sapphire-style setup returned output transcription and 10 PCM audio chunks.

## 2026-04-29 Shared audio cleanup fix v0.0.22

- Footer/package version raised to `v0.0.22`.
- Found the non-obvious production failure: inactive runtime cleanup could stop the shared audio player. During active `batyushka-3` Yandex sessions, logs showed repeated `assistant.turn.audio-playback-stop` with `reason: "gemini-disconnect"` and `outputMode: "webaudio"`.
- `useGeminiLive`, `useYandexVoiceSession`, and `useYandexRealtimeSession` now use idempotent disconnect cleanup; inactive runtimes no longer stop shared playback just because React rerendered or an adapter object changed.
- `useVoiceRuntimeAdapters` now calls inactive runtime disconnect through refs and depends only on runtime flags, not full session objects.
- Batyushka 2 Sapphire-style Gemini playback now soft-clears queued chunks on Gemini `serverContent.interrupted` instead of stopping the currently playing `BufferSource`, matching the provided stable Sapphire project more closely.
- Local checks passed after the fix: `npm run lint`, `npm test`, `npm run test:architecture`, `npm run build`, `npm run test:e2e`.
- Deployed `v0.0.22` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.22`, commit `d253af9-local-v0.0.22`, active bundle is `assets/index-D7J43UzO.js`, and container `ALesia_AI` is healthy.
- Production live smoke passed for `gemini-live` and `yandex-realtime`; direct `batyushka-2` WebSocket smoke returned text `Мир вам.`, output transcription, 7 PCM chunks, and no `interrupted`.
- Browser fake-mic check against the domain with active `batyushka-3` produced audible-path telemetry: `assistant.turn.audio-playback-ended`, `assistant.turn.commit`, `runtime.request.final: answered`, and last answer `Здравствуйте, меня зовут Николай, помогаю по церковным вопросам.`

## 2026-04-29 Browser panel and male Batyushka 2 voice v0.0.23

- Footer/package version raised to `v0.0.23`.
- Batyushka 2 default Gemini Live voice and Gemini TTS fallback voice are now `Sadachbia`, marked as male in `SUPPORTED_VOICES`. This was later rolled back in `v0.0.24`.
- Site opening is separated from the voice stream: browser intents from native Gemini/Yandex final transcripts run as a side-effect with `preserveVoiceOutput`, `suppressOpeningAck`, and `suppressResultPrompt`, so they do not call `cancelAssistantOutput()` or clear the assistant voice queue.
- Production browser failure cause found and fixed: the Docker runtime installed Chromium but not Playwright system libraries. `/api/browser/open` failed with missing `libglib-2.0.so.0`; Dockerfile now uses `playwright install --with-deps chromium`.
- Deployed `v0.0.23` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.23`, commit `d253af9-local-v0.0.23`, active bundle is `assets/index-BT9O8mQi.js`, and container `ALesia_AI` is healthy.
- Production `/api/browser/intent` resolves `открой сайт азбука веры` to `https://azbyka.ru/`; production `/api/browser/open` returns `verified: true`, page title, URL, and screenshot.
- Production `LIVE_SMOKE_TARGETS=gemini-live,yandex-realtime npm run test:live` passed with real env; Yandex Realtime `open_site` verified `https://azbyka.ru/` through the fixed browser runtime.

## 2026-04-29 Batyushka 2 voice rollback v0.0.24

- Footer/package version raised to `v0.0.24`.
- Reverted only Batyushka 2 default Gemini Live voice and Gemini TTS fallback voice from `Sadachbia` back to `Zephyr` after phone validation reported stutter with `Sadachbia`; the Sapphire-compatible audio path and browser side-effect logic were not changed.
- Production runtime config active character was restored to `batyushka-2`; Batyushka 2 `voiceName` and `ttsVoiceName` are `Zephyr`.
- The configured `webProviders` list is still present: `weather`, `news`, `currency`, `maps`, `wiki`, `search`. Batyushka 3 still has `open_site`, `view_page`, `extract_page_context`, and `summarize_visible_page` enabled.
- Deployed `v0.0.24` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.24`, commit `d253af9-local-v0.0.24`, and container `ALesia_AI` is healthy.
- Production `/api/browser/intent` still resolves `открой сайт азбука веры` to `https://azbyka.ru/`. No site-opening logic was changed in this rollback.

## 2026-04-29 Browser command/context routing v0.0.25

- Footer/package version raised to `v0.0.25`.
- Voice streaming was intentionally left untouched: no changes to Gemini/Yandex audio, VAD, WebAudio playback, microphone capture, voice names, or the Batyushka 2 Sapphire-style queue.
- Batyushka 2 browser command detection now accepts polite/direct forms like `откройте сайт ...`, `зайдите на сайт ...`, `перейдите на сайт ...`, and `покажите сайт ...`; this fixes cases where a Gemini final transcript was treated as plain chat and the assistant only said it would open the site.
- Batyushka 3 page questions with an active browser now use the app-side browser response as primary: the generic native Yandex response is suppressed, the handler waits briefly for the page to become ready, then answers from the open page context.
- Deployed `v0.0.25` to `https://alesia-ai.constitution.of.by`; `/health` reports version `0.0.25`, commit `d253af9-local-v0.0.25`, and container `ALesia_AI` is healthy.
- Production `/api/browser/intent` resolves `откройте сайт азбука веры` to `https://azbyka.ru/`; production `/api/browser/open` returns `status: ready`, page title `Православный портал «Азбука веры» | Православный сайт`, URL, reader text, and screenshot.

## 2026-04-29 Native realtime browser tools v0.0.26

- Footer/package version raised to `v0.0.26`.
- The voice stream remains the sacred layer: no audio capture, VAD, WebAudio playback, microphone, voice-name, or Sapphire queue changes were made for this version.
- Removed the risky `v0.0.25` transcript side-effect path from native Gemini/Yandex turns: browser commands are no longer replayed through app-side transcript routing and Yandex page answers are no longer made `browser-primary` by suppressing the native model response.
- Batyushka 2 and Batyushka 3 now expose browser/knowledge through native realtime tools: `open_site`, `get_browser_state`, `get_visible_page_summary`, and `query_knowledge`.
- Gemini Live sends those tools in `setup.tools` and answers model tool calls with `toolResponse`; Yandex Realtime advertises the same tool set in the session payload.
- Added `/api/realtime/tool` as the shared server executor for Gemini/Yandex tool calls, backed by the existing browser runtime and knowledge search.
- Local checks passed: `npm run lint`, `npm test`, `npm run test:architecture`, `npm run build`.
