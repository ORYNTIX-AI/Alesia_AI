function normalizeToolArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function buildGeminiLiveToolResponses({
  functionCalls = [],
  activeRuntime = {},
  callbacks = {},
} = {}) {
  const functionResponses = [];

  for (const functionCall of functionCalls) {
    const toolName = String(functionCall?.name || '').trim();
    const callId = String(functionCall?.id || functionCall?.callId || '').trim();
    const args = normalizeToolArgs(functionCall?.args);

    callbacks.onToolCall?.({
      name: toolName,
      callId,
      arguments: args,
      provider: 'gemini-live',
    });

    let result;
    let modelPayload;

    try {
      const response = await fetch('/api/realtime/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName,
          arguments: args,
          conversationSessionId: String(activeRuntime.conversationSessionId || ''),
          characterId: String(activeRuntime.characterId || ''),
          runtimeConfig: activeRuntime,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      result = payload?.result || {
        ok: false,
        status: 'error',
        error: payload?.error || `Tool ${toolName} failed`,
      };
      modelPayload = payload?.modelPayload || result;
    } catch (error) {
      result = {
        ok: false,
        status: 'error',
        error: String(error?.message || `Tool ${toolName} failed`).trim(),
      };
      modelPayload = result;
    }

    callbacks.onToolResult?.({
      name: toolName,
      callId,
      result,
      provider: 'gemini-live',
    });

    if (toolName) {
      functionResponses.push({
        id: callId,
        name: toolName,
        response: modelPayload,
      });
    }
  }

  return functionResponses;
}
