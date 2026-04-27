# 03_NEXT_STEPS

## Ближайшие шаги

1. Найти и прописать рабочий production proxy/регион для Gemini Live:
   - текущий прямой доступ с сервера не поддерживается Google по региону
   - сохраненные proxy не проходят проверку к `generativelanguage.googleapis.com`
2. После замены proxy повторить production smoke для `Батюшка 2` на `https://alesia-ai.constitution.of.by`
3. Подложить реальные локальные секреты в env:
   - `GEMINI_API_KEY`
   - `YANDEX_FOLDER_ID`
   - `YANDEX_API_KEY` или `YANDEX_IAM_TOKEN`
4. Прогнать `npm run test:live`
5. Отдельно руками проверить `Батюшка 2`:
   - старт разговора без повторного приветствия
   - перебивание ответа голосом
   - audio-only ответ Gemini без зависания следующей реплики
   - открытие сайта через фразу `открой сайт bpcmm.by`
6. Отдельно руками проверить `Батюшка 3` на живом микрофоне:
   - качество распознавания первой фразы и слышимость ответа
   - прерывание ответа
   - ответ по knowledge
   - открытие церковного сайта
   - fallback на `yandex-full-legacy`
7. После live-проверки добить `src/features/session/useConversationRuntimeController.js`
8. Потом убрать временные исключения из архитектурного теста

## Что можно делать только после этого

- Дальше улучшать архитектуру точечно
- Чистить остатки legacy-кода
- Обсуждать более глубокий рефакторинг

## Что требует ручного решения

- Что считать минимально достаточным набором demo-сценариев — УТОЧНИТЬ
- Нужен ли отдельный список приоритетов по подсистемам `avatar / voice / browser / knowledge` — ТРЕБУЕТ РЕШЕНИЯ
- Какие именно Yandex-секреты считать каноническими для этого демо — УТОЧНИТЬ
- Какой production proxy считать каноническим для Gemini Live — УТОЧНИТЬ
## 2026-04-25 Remaining manual check

1. Do one real mobile microphone pass on the production domain:
   - start `batyushka-3`;
   - ask two normal questions;
   - interrupt during an answer;
   - ask to open a site;
   - ask what is on the opened page.
2. Full all-provider `npm run test:live` still cannot pass from this server while Gemini returns `1007 User location is not supported`; use the Yandex-only target for Batya 3 work.

## 2026-04-25 Next checks

1. Deploy the current `batyushka-3` Yandex realtime changes to `https://alesia-ai.constitution.of.by`.
2. On the production server, run the live smoke with real env/secrets and verify:
   - Yandex realtime assistant audio is present.
   - `open_site` returns `verified: true`.
   - No repeated service-desk style filler response appears.
   - Runtime logs do not contain `browser.intent.error`, `answer-audio-missed`, `runtime.repeat-request`, or Yandex realtime protocol errors.
3. After server smoke, do one manual mobile/domain pass with live microphone: multi-turn talk, interruption, open site, question about current page.

## 2026-04-25 After semantic fix

1. Production deploy is complete for the generic-ending fix.
2. Semantic production probe passed for `batyushka-3` with no repeated service-desk style endings.
3. Remaining check is a real phone/microphone pass on the domain to catch device playback, echo, and interruption behavior that websocket text probes cannot fully prove.

## 2026-04-25 After native Yandex realtime correction

1. Deploy the native Yandex Realtime correction to production.
2. Re-run production Yandex-only live smoke and verify real audio response, lip-sync, interruption, and browser tool verified snapshots.
3. Re-check logs for absence of mocked/forced reply paths, `create_response:false`, assistant-answer suppression, and delayed `input_text` replay for microphone turns.

## 2026-04-27 After guarded barge-in update

1. Production deploy is complete for the guarded Batyushka 2 / Batyushka 3 barge-in update.
2. On a real phone, verify both opposite cases:
   - user can interrupt an active assistant answer with normal speech;
   - assistant does not cut itself off when the user is silent and the phone speaker is loud.
3. Production smoke with real env passed for `gemini-live,yandex-realtime,browser,knowledge`; remaining validation is a real phone/microphone pass.
