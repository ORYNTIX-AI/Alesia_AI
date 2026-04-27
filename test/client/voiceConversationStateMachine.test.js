import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_CONVERSATION_EVENTS,
  VOICE_CONVERSATION_STATES,
  createVoiceConversationState,
  isMeaningfulYandexUserTurn,
  reduceVoiceConversationState,
} from '../../src/features/voice/voiceConversationStateMachine.js';

test('voice conversation state machine follows realtime turn lifecycle', () => {
  let state = createVoiceConversationState();

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.SESSION_READY);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.LISTENING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.INPUT_PARTIAL);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.USER_SPEAKING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.INPUT_FINAL_HOLD);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.ENDPOINTING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.INPUT_FINAL_COMMIT);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.THINKING);
  assert.equal(state.turnId, 1);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.TOOL_CALL);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.TOOL_RUNNING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.TOOL_RESULT);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.THINKING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.ASSISTANT_AUDIO_START);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.ASSISTANT_SPEAKING);

  state = reduceVoiceConversationState(state, VOICE_CONVERSATION_EVENTS.ASSISTANT_DONE);
  assert.equal(state.state, VOICE_CONVERSATION_STATES.LISTENING);
});

test('low-value Yandex realtime fragments do not become user turns', () => {
  assert.equal(isMeaningfulYandexUserTurn('а'), false);
  assert.equal(isMeaningfulYandexUserTurn('ага'), false);
  assert.equal(isMeaningfulYandexUserTurn('да'), true);
  assert.equal(isMeaningfulYandexUserTurn('нет'), true);
  assert.equal(isMeaningfulYandexUserTurn('ок'), true);
  assert.equal(isMeaningfulYandexUserTurn('кто ты'), true);
  assert.equal(isMeaningfulYandexUserTurn('открой сайт church.by'), true);
});
