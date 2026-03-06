export const DEFAULT_VOICE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-09-2025';
export const SUPPORTED_VOICE_NAMES = ['Aoede', 'Kore', 'Puck'];

export const DEFAULT_SYSTEM_PROMPT = `Ты Алеся, голосовой консультант туроператора "АлатанТур" (Беларусь). Говори только на русском языке.

Главные правила:
1. Отвечай коротко: 1-3 предложения.
2. Тон дружелюбный и профессиональный, без сленга.
3. Не обсуждай политику.
4. Не выдумывай факты о компании и услугах.
5. Критично: не утверждай, что ты отправила код, письмо, сообщение, ссылку, бронь, счет или заявку, если в этом чате нет подтвержденного технического действия.
6. Если клиент просит "отправить код" или выполнить действие во внешней системе, честно скажи: "Я не могу отправлять коды/сообщения напрямую, могу передать запрос менеджеру или подсказать следующий шаг".
7. Никогда не говори "уже отправила", "готово" или "сделано", если это не подтверждено системой.

Задача:
- Помогать с выбором туров, визовыми вопросами, направлениями и следующими шагами.
- Уточнять детали клиента короткими вопросами (даты, бюджет, состав путешественников).
- В сомнительных случаях прямо говорить о лимитах и предлагать безопасную альтернативу.`;

export const DEFAULT_GREETING = 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.';

export const DEFAULT_WEB_PROVIDERS = {
  weather: {
    label: 'wttr.in',
    urlTemplate: 'https://wttr.in/{query}?lang=ru',
  },
  news: {
    label: 'DuckDuckGo News',
    urlTemplate: 'https://duckduckgo.com/?q={query}&iar=news&ia=news',
  },
  currency: {
    label: 'DuckDuckGo',
    urlTemplate: 'https://duckduckgo.com/?q={query}',
  },
  maps: {
    label: 'OpenStreetMap',
    urlTemplate: 'https://www.openstreetmap.org/search?query={query}',
  },
  wiki: {
    label: 'Wikipedia RU',
    urlTemplate: 'https://ru.wikipedia.org/w/index.php?search={query}',
  },
  search: {
    label: 'DuckDuckGo',
    urlTemplate: 'https://duckduckgo.com/?q={query}',
  },
};

export const DEFAULT_CHARACTERS = [
  {
    id: 'alesya-classic',
    displayName: 'Алеся',
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[0],
    backgroundPreset: 'aurora',
    greetingText: DEFAULT_GREETING,
  },
  {
    id: 'alesya-kore',
    displayName: 'Алеся Neo',
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[1],
    backgroundPreset: 'sunset',
    greetingText: DEFAULT_GREETING,
  },
  {
    id: 'alesya-puck',
    displayName: 'Алеся Flux',
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[2],
    backgroundPreset: 'midnight',
    greetingText: DEFAULT_GREETING,
  },
];

export const DEFAULT_APP_CONFIG = {
  themeMode: 'light',
  activeCharacterId: DEFAULT_CHARACTERS[0].id,
  characters: DEFAULT_CHARACTERS,
  webProviders: DEFAULT_WEB_PROVIDERS,
};
