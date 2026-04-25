/**
 * @typedef {object} ConversationTurnPipeline
 * @property {(text: string, options?: object) => Promise<boolean> | boolean} enqueueTurn
 * @property {(reason?: string) => void} cancelPendingTurns
 * @property {(mode?: string) => boolean} flushPendingFinals
 * @property {(sessionId: string, options?: object) => Promise<string>} restoreConversationState
 */

export function createConversationTurnPipeline(pipeline = {}) {
  return {
    enqueueTurn: pipeline.enqueueTurn || (() => false),
    cancelPendingTurns: pipeline.cancelPendingTurns || (() => {}),
    flushPendingFinals: pipeline.flushPendingFinals || (() => false),
    restoreConversationState: pipeline.restoreConversationState || (async () => ''),
    ...pipeline,
  }
}
