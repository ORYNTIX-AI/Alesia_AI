export const VOICE_CONVERSATION_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  USER_SPEAKING: 'user_speaking',
  ENDPOINTING: 'endpointing',
  THINKING: 'thinking',
  TOOL_RUNNING: 'tool_running',
  ASSISTANT_SPEAKING: 'assistant_speaking',
  RECOVERING: 'recovering',
  ERROR_VISIBLE: 'error_visible',
});

export const VOICE_CONVERSATION_EVENTS = Object.freeze({
  SESSION_READY: 'session_ready',
  SESSION_STOP: 'session_stop',
  INPUT_PARTIAL: 'input_partial',
  INPUT_FINAL_HOLD: 'input_final_hold',
  INPUT_FINAL_COMMIT: 'input_final_commit',
  INPUT_IGNORED: 'input_ignored',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  ASSISTANT_START: 'assistant_start',
  ASSISTANT_AUDIO_START: 'assistant_audio_start',
  ASSISTANT_DONE: 'assistant_done',
  ASSISTANT_CANCELLED: 'assistant_cancelled',
  BARGE_IN: 'barge_in',
  RECOVERING: 'recovering',
  ERROR: 'error',
});

const STATE_SET = new Set(Object.values(VOICE_CONVERSATION_STATES));
const EVENT_TO_STATE = {
  [VOICE_CONVERSATION_EVENTS.SESSION_READY]: VOICE_CONVERSATION_STATES.LISTENING,
  [VOICE_CONVERSATION_EVENTS.SESSION_STOP]: VOICE_CONVERSATION_STATES.IDLE,
  [VOICE_CONVERSATION_EVENTS.INPUT_PARTIAL]: VOICE_CONVERSATION_STATES.USER_SPEAKING,
  [VOICE_CONVERSATION_EVENTS.INPUT_FINAL_HOLD]: VOICE_CONVERSATION_STATES.ENDPOINTING,
  [VOICE_CONVERSATION_EVENTS.INPUT_FINAL_COMMIT]: VOICE_CONVERSATION_STATES.THINKING,
  [VOICE_CONVERSATION_EVENTS.INPUT_IGNORED]: VOICE_CONVERSATION_STATES.LISTENING,
  [VOICE_CONVERSATION_EVENTS.TOOL_CALL]: VOICE_CONVERSATION_STATES.TOOL_RUNNING,
  [VOICE_CONVERSATION_EVENTS.TOOL_RESULT]: VOICE_CONVERSATION_STATES.THINKING,
  [VOICE_CONVERSATION_EVENTS.ASSISTANT_START]: VOICE_CONVERSATION_STATES.ASSISTANT_SPEAKING,
  [VOICE_CONVERSATION_EVENTS.ASSISTANT_AUDIO_START]: VOICE_CONVERSATION_STATES.ASSISTANT_SPEAKING,
  [VOICE_CONVERSATION_EVENTS.ASSISTANT_DONE]: VOICE_CONVERSATION_STATES.LISTENING,
  [VOICE_CONVERSATION_EVENTS.ASSISTANT_CANCELLED]: VOICE_CONVERSATION_STATES.LISTENING,
  [VOICE_CONVERSATION_EVENTS.BARGE_IN]: VOICE_CONVERSATION_STATES.USER_SPEAKING,
  [VOICE_CONVERSATION_EVENTS.RECOVERING]: VOICE_CONVERSATION_STATES.RECOVERING,
  [VOICE_CONVERSATION_EVENTS.ERROR]: VOICE_CONVERSATION_STATES.ERROR_VISIBLE,
};

const LOW_VALUE_USER_FRAGMENTS = new Set([
  'а',
  'и',
  'ну',
  'да',
  'ага',
  'угу',
  'ок',
  'ладно',
  'хм',
  'мм',
]);

function normalizeVoiceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s?!.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeState(value) {
  const normalized = String(value || '').trim();
  return STATE_SET.has(normalized) ? normalized : VOICE_CONVERSATION_STATES.IDLE;
}

export function createVoiceConversationState(initialState = VOICE_CONVERSATION_STATES.IDLE) {
  return {
    state: normalizeState(initialState),
    previousState: '',
    event: 'init',
    reason: 'init',
    changedAt: Date.now(),
    turnId: 0,
  };
}

export function reduceVoiceConversationState(currentState, event, details = {}) {
  const current = currentState && typeof currentState === 'object'
    ? currentState
    : createVoiceConversationState();
  const nextState = EVENT_TO_STATE[event] || current.state || VOICE_CONVERSATION_STATES.IDLE;
  const normalizedNextState = normalizeState(nextState);
  const nextTurnId = event === VOICE_CONVERSATION_EVENTS.INPUT_FINAL_COMMIT
    ? Number(current.turnId || 0) + 1
    : Number(current.turnId || 0);

  if (
    normalizedNextState === current.state
    && nextTurnId === Number(current.turnId || 0)
    && event !== VOICE_CONVERSATION_EVENTS.TOOL_RESULT
  ) {
    return current;
  }

  return {
    state: normalizedNextState,
    previousState: current.state || VOICE_CONVERSATION_STATES.IDLE,
    event,
    reason: String(details.reason || event || ''),
    changedAt: Date.now(),
    turnId: nextTurnId,
  };
}

export function isVoiceConversationBusy(state) {
  return [
    VOICE_CONVERSATION_STATES.USER_SPEAKING,
    VOICE_CONVERSATION_STATES.ENDPOINTING,
    VOICE_CONVERSATION_STATES.THINKING,
    VOICE_CONVERSATION_STATES.TOOL_RUNNING,
    VOICE_CONVERSATION_STATES.ASSISTANT_SPEAKING,
    VOICE_CONVERSATION_STATES.RECOVERING,
  ].includes(normalizeState(state));
}

export function isMeaningfulYandexUserTurn(text = '') {
  const normalized = normalizeVoiceText(text).replace(/[?!.]+$/g, '').trim();
  if (!normalized) {
    return false;
  }
  if (LOW_VALUE_USER_FRAGMENTS.has(normalized)) {
    return false;
  }
  const compact = normalized.replace(/\s+/g, '');
  if (compact.length < 4) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(compact);
}
