import {
  buildModelSafeToolPayload,
  normalizeWhitespace,
  safeJsonParse,
} from '../ws/yandexRealtimeShared.js';
import { executeToolCall } from '../ws/yandexRealtimeTools.js';

function normalizeToolArgs(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    return safeJsonParse(value, {}) || {};
  }
  if (typeof value === 'object') {
    return value;
  }
  return {};
}

export function registerRealtimeToolRoutes(app, {
  logRuntime,
} = {}) {
  app.post('/api/realtime/tool', async (req, res) => {
    const toolName = normalizeWhitespace(req.body?.toolName || req.body?.name || '');
    const conversationSessionId = normalizeWhitespace(req.body?.conversationSessionId || '');
    const characterId = normalizeWhitespace(req.body?.characterId || '');
    const rawArgs = normalizeToolArgs(req.body?.arguments ?? req.body?.args);

    if (!toolName) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    const connectionState = {
      route: 'http-realtime-tool',
      conversationSessionId,
      characterId,
      runtimeConfig: req.body?.runtimeConfig && typeof req.body.runtimeConfig === 'object'
        ? req.body.runtimeConfig
        : {},
      closedResponseIds: new Set(),
      pendingResponseDoneTimers: new Map(),
    };

    try {
      const result = await executeToolCall(toolName, rawArgs, connectionState);
      const modelPayload = buildModelSafeToolPayload(toolName, result);
      logRuntime?.('realtime.tool.http.ok', {
        toolName,
        conversationSessionId,
        characterId,
      });
      return res.json({
        ok: true,
        toolName,
        result,
        modelPayload,
      });
    } catch (error) {
      const message = normalizeWhitespace(error?.message || 'Tool failed');
      logRuntime?.('realtime.tool.http.error', {
        toolName,
        conversationSessionId,
        characterId,
        error: message,
      }, 'error');
      return res.status(500).json({
        ok: false,
        toolName,
        result: {
          ok: false,
          status: 'error',
          error: message,
        },
        modelPayload: {
          ok: false,
          status: 'error',
          error: message,
        },
      });
    }
  });
}
