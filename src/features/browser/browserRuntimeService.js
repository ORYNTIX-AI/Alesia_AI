/**
 * @typedef {object} BrowserRuntimeService
 * @property {(transcript: string, options?: object) => Promise<object>} detectIntent
 * @property {(intent: object, options?: object) => Promise<object>} open
 * @property {(reason?: string) => Promise<void> | void} cancelOpen
 * @property {(sessionId: string, options?: object) => Promise<object>} getView
 * @property {(sessionId: string, options?: object) => Promise<object>} getContext
 * @property {(sessionId: string, question: string) => Promise<object>} queryPage
 * @property {(sessionId: string, action: object) => Promise<object>} runAction
 */

export function createBrowserRuntimeService(service = {}) {
  return {
    detectIntent: service.detectIntent || (async () => ({})),
    open: service.open || (async () => ({})),
    cancelOpen: service.cancelOpen || (() => {}),
    getView: service.getView || (async () => ({})),
    getContext: service.getContext || (async () => ({})),
    queryPage: service.queryPage || (async () => ({})),
    runAction: service.runAction || (async () => ({})),
    ...service,
  }
}
