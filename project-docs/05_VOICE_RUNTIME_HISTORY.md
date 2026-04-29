# 05 Voice runtime history

## Purpose

This note is for a second reviewer/AI. It summarizes what has already been tried for:

- `batyushka-2` on Gemini 3.1 Live (`models/gemini-3.1-flash-live-preview`)
- `batyushka-3` on Yandex Realtime (`speech-realtime-250923`)

Do not start by tuning random thresholds again. Most recent failures were lifecycle/state bugs, not just VAD sensitivity.

## Current production state

- Production domain: `https://alesia-ai.constitution.of.by`
- Current footer/package version: `v0.0.25`
- Current `main` includes:
  - `00cba95 Fix Gemini live turn lifecycle`
  - `e2d4eb1 Align live smoke with Gemini turn completion`
  - `4c4af2c Document v0.0.14 production verification`
  - `f591f13 Save current workspace artifacts`
- Current production deploy is `v0.0.25`: `/health` reports version `0.0.25`, commit `d253af9-local-v0.0.25`, and container `ALesia_AI` is healthy.
- Production smoke after `v0.0.23` passed for `gemini-live` and `yandex-realtime`; Yandex Realtime `open_site` verified `https://azbyka.ru/` through the fixed browser runtime.
- Batyushka 2 default Gemini voice and Gemini TTS fallback voice were rolled back from `Sadachbia` to `Zephyr` in `v0.0.24` after phone validation reported stutter. The Sapphire-compatible audio path was not changed.
- `v0.0.25` changes only browser command/context routing: polite site-open commands are detected more reliably, and Batyushka 3 page questions use the app-side browser response instead of a generic native Yandex answer. The voice stream, VAD, WebAudio, mic capture, voice names, and Batyushka 2 Sapphire queue were not changed.

Manual phone validation is still required. WebSocket smoke proves protocol/lifecycle, not real phone speaker/mic echo.

## Important source facts

- Google Live API docs say `START_OF_ACTIVITY_INTERRUPTS` cuts the current model response at activity start. Default unspecified behavior is also `START_OF_ACTIVITY_INTERRUPTS`.
  Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live
- Google docs distinguish `generationComplete` and `turnComplete`: with realtime playback there can be a delay between them while playback finishes.
  Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live
- Google forum reports exist where Live/Native Audio abruptly stops mid-sentence even with `interrupted=false`, including reports that it happens in AI Studio.
  Source: https://discuss.ai.google.dev/t/gemini-live-api-token-generation-suddenly-stops/93097
- There is also a GitHub issue saying `NO_INTERRUPTION` was not always respected for native audio dialog models.
  Source: https://github.com/google-gemini/cookbook/issues/796
- Yandex Realtime docs explicitly warn that speaker playback can be recognized as the agent's own voice and interrupt itself; they recommend headphones or reduced volume.
  Source: https://aistudio.yandex.ru/docs/en/ai-studio/operations/agents/create-voice-agent.html

## Key files

- Gemini client runtime:
  - `src/hooks/useGeminiLive.js`
  - `src/hooks/geminiLiveShared.js`
- Yandex Realtime client runtime:
  - `src/hooks/useYandexRealtimeSession.js`
  - `server/ws/yandexRealtimeShared.js`
  - `server/ws/yandexRealtimeGateway.js`
- Shared session orchestration:
  - `src/features/session/useConversationRuntimeController.js`
  - `src/features/voice/voiceConversationStateMachine.js`
- Audio playback:
  - `src/utils/AudioStreamPlayer.js`
- Relevant tests:
  - `test/client/transcriptRuntime.test.js`
  - `test/server/yandexRealtimeShared.test.js`
  - `test/live/liveSmoke.js`

## Voice history by commit

- `954443b` - implemented Yandex Realtime runtime.
- `87efeb0` - early Batya 3 stabilization: reconnect, barge-in fix, Docker healthcheck.
- `3094d59` - refactor and tightened Yandex realtime turns.
- `a5541dc` - added Gemini 3.1 TTS fallback for Batya 2.
- `68bed55` - tried preventing Batya 2 echo self-interrupts.
- `5b27dfc` - hard-gated Batya 2 mic frames during assistant playback.
- `83048c1` - fixed Batya 2 response gating and greeting/session behavior.
- `181f853` - set Batya 2 Gemini activity handling to `NO_INTERRUPTION`.
- `1f793b0` - fixed streamed voice continuity; Yandex `interrupt_response:false`, threshold increased.
- `6edb26b` - restored guarded barge-in; reintroduced `START_OF_ACTIVITY_INTERRUPTS`, lowered holds, restored greetings.
- `0743d36` - reverted Batya 2 to `NO_INTERRUPTION`; removed Yandex final hold before native response tracking.
- `00cba95` - fixed Gemini turn lifecycle: commit only on `turnComplete`, not `generationComplete`.
- `e2d4eb1` - fixed live smoke to wait for Gemini `turnComplete`.
- `4de676f` - saved older dirty Claude worktree changes on branch `claude/zen-buck-3059b7`; keep it as historical evidence, not current truth.

## Gemini 3.1 Live: what was tried

### Tried: Gemini 3.1 migration

Changed production/default Gemini Live model to `models/gemini-3.1-flash-live-preview` and TTS to `gemini-3.1-flash-tts-preview`.

Result:

- Required by project rule.
- Did not itself solve mobile audio cutoff.
- TTS fallback repaired some silent-audio paths, but not mid-word Live cutoff.

### Tried: HTMLAudioElement fallback for mobile

The player previously tried mobile fallback through HTML audio chunks when WebAudio did not visibly drive lip-sync/volume.

Result:

- Helped some playback acceptance cases.
- Later follow-up moved back toward scheduled WebAudio because per-chunk HTML audio introduced gaps/restart risk.
- This was not the root cause of Batya 2 half-word cutoff.

### Tried: hard mic gate during assistant playback

Batya 2 mic frames were dropped while assistant output was active and shortly after it ended.

Result:

- Reduced false echo barge-in.
- Made real barge-in worse and risked losing the user's first words.
- Did not solve all cutoff paths because local client lifecycle could still close/suppress late assistant chunks.

### Tried: echo hold tuning

Values were moved around:

- long echo hold around `1800ms`
- shorter tail around `250ms`
- local strong-user guard around RMS `0.18`

Result:

- Long hold blocked real user input too aggressively.
- Short hold reduced latency but did not stop Google/server-side or local lifecycle cutoffs.
- RMS threshold tuning alone is not a solution.

### Tried: disabling automatic greeting

Batya 2 greeting was disabled at one point to avoid immediate echo/self-interrupt.

Result:

- Reduced one early overlap case.
- Bad UX and did not fix normal answer cutoff.
- Greeting later restored.

### Tried: `START_OF_ACTIVITY_INTERRUPTS`

This was restored in `6edb26b` to improve barge-in.

Result:

- Failed for the phone/speaker scenario.
- Production logs showed `assistant.turn.interrupted` around the user-reported cutoff window.
- Google docs say this mode cuts current model response at activity start, so it is unsafe for Batya 2 with phone echo.

Conclusion:

- Do not re-enable `START_OF_ACTIVITY_INTERRUPTS` for Batya 2 unless you also solve echo with a hardware/duplex strategy.

### Tried: `NO_INTERRUPTION`

Set for Batya 2 in `181f853`, restored again in `0743d36`.

Result:

- Correct direction for self-cutoff protection.
- Not sufficient by itself because the local client was also closing assistant turns too early on `generationComplete`/idle fallback.
- There is an external GitHub report that `NO_INTERRUPTION` may not be perfectly respected in some native audio setups, so logs must still be checked.

### Tried: suppressing/ignoring Gemini `interrupted`

The client previously ignored `serverContent.interrupted` for Batya 2 when no strong local speech was detected.

Result:

- Useful as a defensive layer.
- Not enough if server had already stopped generation or if local playback state was already flushed.
- Should remain secondary, not the main model.

### Tried: treating `generationComplete` as end of turn

This was the important wrong assumption. The code committed assistant turns when either `turnComplete` or `generationComplete` arrived.

Observed result:

- Production logs after a normal assistant commit showed `assistant.turn.drop: unexpected-start`.
- This means the local request state had already been released while additional server content was still arriving.
- On mobile this can manifest as half-word or mid-phrase cutoff because later chunks may be dropped/suppressed.

Current fix:

- Commit Gemini assistant turns only on `turnComplete`.
- Live smoke also waits only for `turnComplete`.
- Batya 2 idle fallback checks `audioPlayer.getBufferedMs()` and does not close the turn while buffered output remains.

Do not undo this without a stronger lifecycle model.

## Gemini 3.1 Live: hypotheses that did not hold

- "It is only outputAudioTranscription." No. Batya 2 has `outputAudioTranscription:false`, but cutoff still happened.
- "It is only WebAudio vs HTMLAudio." No. Playback path changes helped gaps but not the lifecycle/drop problem.
- "It is only activityHandling." Partly. `START_OF_ACTIVITY_INTERRUPTS` clearly caused server cutoffs, but `NO_INTERRUPTION` alone did not fix local premature commit.
- "It is just RMS threshold." No. Thresholds can reduce echo false positives, but cannot fix `generationComplete` vs `turnComplete`.
- "Disable greeting and the problem is gone." No. It avoids one overlap but normal answers can still cut.
- "Live smoke passed, so phone is solved." No. WebSocket smoke does not reproduce physical echo, browser audio focus, or mobile autoplay constraints.

## Yandex Realtime: what was tried

### Tried: native Yandex Realtime with server VAD

Current server config uses:

- `turn_detection.type: server_vad`
- `create_response: true`
- `interrupt_response: false`

Result:

- Correct direction for native Yandex flow.
- The server can start response quickly after final transcript.
- Client must be ready to accept assistant output before/during final transcript bookkeeping.

### Tried: client-side final transcript hold/merge

Yandex finals were held for merge windows:

- `2200ms` merge + `520ms` normal hold + `760ms` short hold
- later reduced to `600ms`, `180ms`, `280ms`

Result:

- Initial idea: prevent duplicate/fragment answers.
- Actual failure: Yandex native `create_response:true` can start the assistant response before the client commits local request state.
- This caused `assistant.turn.drop: unexpected-start` and made Batya 3 appear not to answer.

Current fix:

- For native Yandex Realtime, do not hold final transcript before creating local request state.
- `handleYandexRealtimeFinalTranscript` commits native request state immediately.

### Tried: filtering "low value" short phrases

Earlier `isMeaningfulYandexUserTurn` dropped very short final transcripts; later minimum was loosened to allow `да`, `нет`, `ок`.

Result:

- Filtering single filler sounds is useful.
- Dropping all short answers is wrong for Russian dialogue.
- This was not the main "does not answer" bug, but it can make user turns disappear.

### Tried: Yandex echo gate during playback

Client suppressed outgoing mic audio while assistant output was buffered/playing; window was reduced from about `2400ms` to `400ms`.

Result:

- Needed because Yandex docs warn the agent can recognize its own speaker output.
- Too long a gate loses user speech.
- Too short a gate risks echo and false turns.
- This is a balancing layer, not root cause of missed responses.

### Tried: server `interrupt_response:true`

Earlier config allowed server-side interrupt on new speech.

Result:

- More natural barge-in in clean audio conditions.
- Bad with phone speaker echo.
- Changed to `interrupt_response:false` in `1f793b0`.

### Tried: local `speech_started` interruption

Client receives Yandex `speech_started`, checks local `userVolumeRef`, then interrupts local audio only when local user volume is strong enough.

Result:

- Better than trusting server VAD alone.
- Still cannot perfectly distinguish real speech from loud speaker echo on all phones.
- Should be kept as a guard, not replaced by unconditional interrupt.

### Tried: native tools advertised to Yandex session

Browser tools were initially advertised more broadly to Yandex Realtime.

Result:

- Caused generic/model-driven browser/filler behavior.
- Current ordinary Batya 3 conversation routes browser intents through app-side browser runtime.
- Native Yandex tools are exposed only for explicit live tool smoke.

### Tried: assistant-answer suppression/forced replies

Several paths suppressed or replaced model answers to avoid generic service-desk phrases.

Result:

- Hid symptoms but made runtime state harder to reason about.
- Later removed/limited; semantic tests/log checks should catch bad formulaic answers instead of silently replacing them.

### Tried: browser concurrency fixes

Ordinary voice turns could cancel in-flight browser work and clear queued speech during site opening.

Result:

- Fixed by preserving in-flight browser opening and ignoring duplicate site-open fragments while a page is already opening.
- This fixed browser/site flows but is separate from plain "Batya 3 does not answer".

## Yandex Realtime: hypotheses that did not hold

- "Batya 3 does not answer because Yandex produces no audio." Not generally true. Prod logs after `v0.0.13` show `assistant.turn.audio-start` and `assistant.turn.commit`.
- "Longer final hold fixes fragmented STT." It reduced duplicate fragments but broke native response tracking with `create_response:true`.
- "Use client text replay instead of native response." This caused delayed/duplicated state and was moved away from.
- "Suppress generic answers at runtime." This hides bugs and creates state races; use instructions/tests, not answer replacement.
- "Advertise all tools to native Yandex all the time." This made ordinary dialogue less predictable.
- "Unconditional barge-in on `speech_started` is safe." Not on phones; speaker echo can trigger it.

## What to inspect next if bugs remain

### Batya 2: Sapphire-compatible baseline

The provided stable `assistant-sapphire` project showed the important difference was not only model/voice names. It keeps Gemini Live native:

- no explicit `realtimeInputConfig`;
- no local RMS barge-in or mic-tail gate;
- no extra gain on microphone frames;
- no replay of `inputAudioTranscription` back to Gemini as a new text prompt;
- audio chunks are played sequentially, one source after the previous `onended`.

`v0.0.18` applied part of that profile only to `batyushka-2` on `models/gemini-3.1-flash-live-preview`, but it still used the shared `AudioStreamPlayer` sequential mode for output.

`v0.0.21` removes that remaining difference. Batyushka 2 Gemini output now bypasses the shared player and uses a dedicated direct queue matching Sapphire playback: `Float32Array[]`, one `BufferSource` at a time, `createBuffer(..., 24000)`, direct connection to `audioContext.destination`, and `onended` starts the next chunk. It also uses `Zephyr`, input/output audio transcription, and no `thinkingConfig`, session resumption, context window compression, or explicit realtime input config on the Sapphire path. The app keeps the local Batyushka prompt and the backend key/proxy transport. Production WebSocket smoke for `batyushka-2` returned output transcription and 10 PCM chunks.

`v0.0.22` fixes the hidden integration difference that was still cutting playback: React/runtime cleanup from an inactive runtime could call `audioPlayer.stop()` on the shared player. Production logs showed this directly during active `batyushka-3` Yandex sessions as `assistant.turn.audio-playback-stop` with `reason: "gemini-disconnect"`. Gemini/Yandex disconnects are now idempotent, unmount cleanup is stable, and runtime adapters disconnect inactive runtimes through refs rather than on every session-object change. On the Batyushka 2 Sapphire path, Gemini `serverContent.interrupted` now soft-clears queued chunks without stopping the currently playing `BufferSource`, matching the stable Sapphire behavior where `stopAudio()` does not hold and stop the active source.

`v0.0.23` keeps that voice path intact and fixes site opening outside the audio stream. Browser intents detected from native Gemini/Yandex final transcripts are now side-effects: they open/update the lower browser panel without cancelling assistant audio or clearing the voice queue, and without injecting separate browser acknowledgement/result prompts. The production browser runtime also needed a container fix: Chromium was installed, but Playwright system libraries were missing (`libglib-2.0.so.0`), so `/api/browser/open` could not start the browser. Docker now installs Chromium with `playwright install --with-deps chromium`.

`v0.0.24` reverts the only Batyushka 2 voice-related change from `v0.0.23`: Gemini Live and Gemini TTS fallback voice return from `Sadachbia` to `Zephyr`. No browser side-effect code, Sapphire-compatible Gemini audio queue, VAD settings, or lifecycle cleanup was changed. Production `webProviders` still includes `weather`, `news`, `currency`, `maps`, `wiki`, and `search`; `/api/browser/intent` still resolves `открой сайт азбука веры` to `https://azbyka.ru/`.

`v0.0.25` keeps the voice path unchanged and narrows the fix to browser routing. Batyushka 2 now recognizes polite/direct browser commands such as `откройте сайт азбука веры`; Batyushka 3 page questions with an active browser are routed as browser-primary responses, wait briefly for page readiness, and answer from the open page context instead of letting the native Yandex response say it cannot see the site.

`v0.0.26` makes the browser/context integration native again instead of routing native final transcripts through app-side side effects. The voice path is unchanged. Batyushka 2 and Batyushka 3 now expose `open_site`, `get_browser_state`, `get_visible_page_summary`, and `query_knowledge` as official realtime tools; Gemini Live sends them in `setup.tools` and replies with `toolResponse`, while Yandex Realtime advertises the same tools in the session payload. The server endpoint `/api/realtime/tool` is the shared executor for both runtimes. The `v0.0.25` browser-primary suppression path is removed from native voice turns.

### For Batya 2 half-word cutoff

Check logs in this order:

1. `assistant.turn.interrupted`
   - If present, server/client still thinks a barge-in happened.
   - Check whether `START_OF_ACTIVITY_INTERRUPTS` somehow returned.
2. `assistant.turn.drop` with `unexpected-start`
   - Indicates local lifecycle/request state released too early.
3. `assistant.turn.commit` timing vs audio duration/chunk count
   - Too-early commit can still drop late content.
4. WebSocket raw events:
   - order of `generationComplete`, audio chunks, `turnComplete`, `interrupted`.
5. `audioPlayer.stop()` callers:
   - user stop/manual stop
   - local strong barge-in path
   - `serverContent.interrupted`
   - disconnect/unmount

Do not start with RMS values.

### For Batya 3 no-answer

`v0.0.19` removes the earlier local overlays from the Batyushka 3 Yandex Realtime path. The baseline should now be the documented Realtime pattern: server VAD, native response creation, clear local playback on `speech_started`, and play native audio deltas. Do not re-add local RMS barge-in, final-transcript suppression, echo/backchannel drops, or custom VAD fields as a first fix.

`v0.0.20` adds the missing observability for the user-visible failure: accepted audio can be stopped before it is actually heard. Check `voice.yandex.speech-started`, `assistant.turn.audio-playback-stop`, `elapsedMs`, `durationMs`, `earlyEnded`, `bufferedMs`, and `voice.yandex.audio-delta` before changing model/VAD settings again. The client now ignores `speech_started` for already-buffered Yandex playback after the response is committed; otherwise speaker echo can make the app report `audio-start` while the user hears nothing.

Check logs in this order:

1. `stt.stream.final`
   - If absent, microphone/input path did not reach Yandex.
2. `runtime.request.activate` / `awaiting-native-response`
   - If absent, client did not create local request state.
3. `assistant.turn.start`
   - If present followed by `assistant.turn.drop: unexpected-start`, state race returned.
4. `assistant.turn.audio-start`
   - If absent but text exists, inspect TTS/audio delta path.
5. `assistant.turn.commit`
   - If present, the server/model answered; remaining issue is playback/UI perception.

## Known local artifacts saved for review

- `output/*.wav` and `output/live-audio/*.wav` are committed in `main` as audio samples.
- Deploy archives are also committed in `main` because the user requested saving all current workspace changes.
- `.claude/worktrees/*` are committed as gitlinks, not full folders.
- The dirty `zen-buck` worktree was separately committed and pushed:
  - branch `claude/zen-buck-3059b7`
  - commit `4de676f Save voice runtime worktree changes`

## Recommended next review stance

1. Treat `v0.0.26` as the current production baseline.
2. Do not reintroduce `START_OF_ACTIVITY_INTERRUPTS` for Batya 2 as a quick fix.
3. Do not reintroduce Yandex final-hold before local request state.
4. If changing audio playback, verify `AudioStreamPlayer.stop()` is not called by lifecycle cleanup while chunks are still expected.
5. Add logging around raw Gemini `serverContent` order before changing more thresholds.
6. Use a real phone test after any change, because WebSocket smoke cannot prove acoustic echo behavior.
