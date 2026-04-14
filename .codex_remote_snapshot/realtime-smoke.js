const base = 'http://127.0.0.1:8200';
const scenarioArg = process.argv[2] || '';
const PROMPT_BY_SCENARIO = {
  whoami_ru: 'Кто ты?',
  onetwothree_ru: 'раз два три',
  open_church_ru: 'можешь открыть церковный сайт',
  count_churches_ru: 'сколько церквей в беларуси',
};
const prompt = PROMPT_BY_SCENARIO[scenarioArg] || process.env.TEST_PROMPT || process.argv[2] || 'Кто ты?';
const expectedTurns = Number(process.env.EXPECTED_TURNS || process.argv[3] || 1);
const sessionId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const res = await fetch(`${base}/api/voice/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationSessionId: sessionId,
      characterId: 'batyushka-3',
      requestedGatewayUrl: '/yandex-realtime-proxy',
    }),
  });
  const voice = await res.json();
  if (!res.ok) {
    throw new Error(JSON.stringify(voice));
  }

  const wsUrl = `${voice.voiceGatewayUrl || 'ws://127.0.0.1:8200/yandex-realtime-proxy'}?sessionToken=${encodeURIComponent(voice.sessionToken || '')}`;
  const ws = new WebSocket(wsUrl);
  const events = [];
  let greetingDone = false;
  let sent = false;
  let finalTurns = 0;

  const finish = () => {
    const output = {
      sessionId,
      prompt,
      types: events.map((event) => event.type),
      texts: events.filter((event) => event.type === 'assistant_text_delta').map((event) => event.text),
      toolCalls: events
        .filter((event) => event.type === 'tool_call')
        .map((event) => ({ name: event.name, args: event.arguments })),
      toolResults: events
        .filter((event) => event.type === 'tool_result')
        .map((event) => ({
          name: event.name,
          ok: event.result?.ok,
          browserSessionId: event.result?.browserSessionId,
          url: event.result?.url,
          title: event.result?.title,
          raw: event.result,
        })),
      errors: events.filter((event) => event.type === 'error').map((event) => event.message),
    };
    console.log(JSON.stringify(output, null, 2));
    try {
      ws.close();
    } catch {
      // Ignore.
    }
    process.exit(0);
  };

  const timeoutId = setTimeout(() => {
    console.log(JSON.stringify({
      sessionId,
      prompt,
      timeout: true,
      types: events.map((event) => event.type),
    }, null, 2));
    finish();
  }, 30000);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'session.start',
      runtimeConfig: {
        conversationSessionId: sessionId,
        characterId: 'batyushka-3',
        runtimeProvider: 'yandex-realtime',
        liveInputEnabled: false,
        enabledTools: ['open_site', 'view_page', 'extract_page_context', 'summarize_visible_page'],
        browserPanelMode: 'client-inline',
      },
    }));
  };

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    events.push(payload);

    if (payload.type === 'ready' && !sent) {
      setTimeout(() => {
        if (!sent) {
          sent = true;
          greetingDone = true;
          ws.send(JSON.stringify({ type: 'input_text', text: prompt }));
        }
      }, 300);
    }

    if (payload.type === 'assistant_turn_done' && !greetingDone) {
      greetingDone = true;
      setTimeout(() => {
        if (!sent) {
          sent = true;
          ws.send(JSON.stringify({ type: 'input_text', text: prompt }));
        }
      }, 150);
      return;
    }

    if (greetingDone && sent && payload.type === 'assistant_turn_done') {
      finalTurns += 1;
    }

    if (greetingDone && sent && (payload.type === 'error' || finalTurns >= expectedTurns)) {
      clearTimeout(timeoutId);
      setTimeout(finish, 700);
    }
  };

  ws.onerror = () => {};
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
