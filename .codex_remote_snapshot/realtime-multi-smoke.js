const base = 'http://127.0.0.1:8200';
const scenario = process.argv[2] || 'memory_ru';

const SCENARIOS = {
  memory_ru: {
    prompts: [
      'Меня зовут Алексей, запомни',
      'Как меня зовут?',
    ],
    turnsPerPrompt: [1, 1],
  },
  open_followup_ru: {
    prompts: [
      'можешь открыть церковный сайт',
      'сколько церквей в беларуси',
    ],
    turnsPerPrompt: [2, 1],
  },
};

const scenarioConfig = SCENARIOS[scenario] || SCENARIOS.memory_ru;
const prompts = scenarioConfig.prompts;
const turnsPerPrompt = scenarioConfig.turnsPerPrompt || prompts.map(() => 1);
const sessionId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function createVoiceSession() {
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
  return voice;
}

async function main() {
  const voice = await createVoiceSession();
  const wsUrl = `${voice.voiceGatewayUrl || 'ws://127.0.0.1:8200/yandex-realtime-proxy'}?sessionToken=${encodeURIComponent(voice.sessionToken || '')}`;
  const ws = new WebSocket(wsUrl);
  const events = [];
  const turns = [];
  let turnBuffer = null;
  let sentIndex = -1;
  let ready = false;
  let waitingGreeting = true;
  let completedTurnsForCurrentPrompt = 0;

  const flushTurn = () => {
    if (!turnBuffer) {
      return;
    }
    turns.push(turnBuffer);
    turnBuffer = null;
  };

  const sendNextPrompt = () => {
    if (!ready) {
      return;
    }
    if (sentIndex + 1 >= prompts.length) {
      return;
    }
    sentIndex += 1;
    completedTurnsForCurrentPrompt = 0;
    ws.send(JSON.stringify({ type: 'input_text', text: prompts[sentIndex] }));
  };

  const finish = () => {
    flushTurn();
    console.log(JSON.stringify({
      sessionId,
      scenario,
      prompts,
      turns,
      toolCalls: events
        .filter((event) => event.type === 'tool_call')
        .map((event) => ({ name: event.name, args: event.arguments })),
      toolResults: events
        .filter((event) => event.type === 'tool_result')
        .map((event) => ({
          name: event.name,
          ok: event.result?.ok,
          url: event.result?.url,
          title: event.result?.title,
        })),
      errors: events.filter((event) => event.type === 'error').map((event) => event.message),
    }, null, 2));
    try {
      ws.close();
    } catch {
      // Ignore.
    }
    process.exit(0);
  };

  const timeoutId = setTimeout(finish, 90000);

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

    switch (payload.type) {
      case 'ready':
        ready = true;
        setTimeout(sendNextPrompt, 250);
        break;
      case 'assistant_text_delta':
        if (!turnBuffer) {
          turnBuffer = {
            responseId: payload.responseId || '',
            text: '',
            audioEvents: 0,
          };
        }
        turnBuffer.text += String(payload.text || '');
        break;
      case 'assistant_audio_delta':
        if (!turnBuffer) {
          turnBuffer = {
            responseId: payload.responseId || '',
            text: '',
            audioEvents: 0,
          };
        }
        turnBuffer.audioEvents += 1;
        break;
      case 'assistant_turn_done':
        if (waitingGreeting && sentIndex < 0) {
          waitingGreeting = false;
          setTimeout(sendNextPrompt, 150);
          return;
        }
        flushTurn();
        completedTurnsForCurrentPrompt += 1;
        if (sentIndex + 1 < prompts.length && completedTurnsForCurrentPrompt >= (turnsPerPrompt[sentIndex] || 1)) {
          setTimeout(sendNextPrompt, 500);
        } else if (sentIndex + 1 >= prompts.length && completedTurnsForCurrentPrompt >= (turnsPerPrompt[sentIndex] || 1)) {
          clearTimeout(timeoutId);
          setTimeout(finish, 1200);
        }
        break;
      default:
        break;
    }
  };

  ws.onerror = () => {};
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
