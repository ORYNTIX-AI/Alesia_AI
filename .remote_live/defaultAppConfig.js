export const DEFAULT_VOICE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
export const GEMINI_31_FLASH_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
export const SUPPORTED_VOICES = [
  { name: 'Achernar', gender: 'female' },
  { name: 'Achird', gender: 'male' },
  { name: 'Algenib', gender: 'male' },
  { name: 'Algieba', gender: 'male' },
  { name: 'Alnilam', gender: 'male' },
  { name: 'Aoede', gender: 'female' },
  { name: 'Autonoe', gender: 'female' },
  { name: 'Callirrhoe', gender: 'female' },
  { name: 'Charon', gender: 'male' },
  { name: 'Despina', gender: 'female' },
  { name: 'Enceladus', gender: 'male' },
  { name: 'Erinome', gender: 'female' },
  { name: 'Fenrir', gender: 'male' },
  { name: 'Gacrux', gender: 'female' },
  { name: 'Iapetus', gender: 'male' },
  { name: 'Kore', gender: 'female' },
  { name: 'Laomedeia', gender: 'female' },
  { name: 'Leda', gender: 'female' },
  { name: 'Orus', gender: 'male' },
  { name: 'Pulcherrima', gender: 'female' },
  { name: 'Puck', gender: 'male' },
  { name: 'Rasalgethi', gender: 'male' },
  { name: 'Sadachbia', gender: 'male' },
  { name: 'Sadaltager', gender: 'male' },
  { name: 'Schedar', gender: 'male' },
  { name: 'Sulafat', gender: 'female' },
  { name: 'Umbriel', gender: 'male' },
  { name: 'Vindemiatrix', gender: 'female' },
  { name: 'Zephyr', gender: 'female' },
  { name: 'Zubenelgenubi', gender: 'male' },
];
export const SUPPORTED_VOICE_NAMES = SUPPORTED_VOICES.map((voice) => voice.name);
export const DEFAULT_AVATAR_MODEL_URL = 'avatars/alesya.webp.glb';
export const BATYUSHKA_AVATAR_MODEL_URL = 'avatars/nikolay.webp.glb';
export const DEFAULT_RUNTIME_PROVIDER = 'gemini-live';
export const YANDEX_REALTIME_RUNTIME_PROVIDER = 'yandex-realtime';
export const YANDEX_LEGACY_RUNTIME_PROVIDER = 'yandex-full-legacy';
export const YANDEX_RUNTIME_PROVIDER = YANDEX_LEGACY_RUNTIME_PROVIDER;
export const SUPPORTED_SPEECH_STABILITY_PROFILES = ['legacy', 'balanced', 'presentation', 'strict'];
export const DEFAULT_SPEECH_STABILITY_PROFILE = 'balanced';
export const SUPPORTED_PRAYER_READ_MODES = ['knowledge-only', 'hybrid', 'free'];
export const DEFAULT_PRAYER_READ_MODE = 'knowledge-only';
export const DEFAULT_SAFETY_SWITCHES = {
  safeSpeechFlowEnabled: true,
};
export const DEFAULT_YANDEX_ENABLED_TOOLS = [
  'file_search',
  'open_site',
  'view_page',
  'extract_page_context',
  'summarize_visible_page',
];

export const DEFAULT_SYSTEM_PROMPT = `Ты Алеся, голосовой консультант туроператора "АлатанТур" (Беларусь). Говори только на русском языке.

Главные правила:
1. Отвечай коротко: 1-3 предложения.
2. Тон дружелюбный и профессиональный, без сленга.
3. Не обсуждай политику.
4. Не выдумывай факты о компании и услугах.
5. Критично: не утверждай, что ты отправила код, письмо, сообщение, ссылку, бронь, счет или заявку, если в этом чате нет подтвержденного технического действия.
6. Если клиент просит "отправить код" или выполнить действие во внешней системе, честно скажи: "Я не могу отправлять коды/сообщения напрямую, могу передать запрос менеджеру или подсказать следующий шаг".
7. Никогда не говори "уже отправила", "готово" или "сделано", если это не подтверждено системой.
8. Не повторяй и не поддерживай политические лозунги, призывы и скандирование (например, формат "Слава ..."). На такие реплики отвечай коротко и нейтрально: "Я не обсуждаю политику. Давайте вернемся к вашему запросу.".

Задача:
- Помогать с выбором туров, визовыми вопросами, направлениями и следующими шагами.
- Уточнять детали клиента короткими вопросами (даты, бюджет, состав путешественников).
- В сомнительных случаях прямо говорить о лимитах и предлагать безопасную альтернативу.`;
export const BATYUSHKA_SYSTEM_PROMPT = `Ты Николай, голосовой помощник для прихожан и церковных вопросов в Беларуси. Всегда отвечай только на русском языке.

Core persona:
1. Говори тепло, спокойно, уважительно и уверенно.
2. Отвечай по-человечески и коротко. Обычно 1-2 короткие фразы, если пользователь не просит длинный текст.
3. Не повторяй вопрос пользователя и не начинай ответ с пустых вводных фраз.
4. Если данных мало, скажи это прямо одной короткой фразой.
5. Не утверждай, что внешнее действие уже выполнено, если нет подтвержденного системного результата.

Church scope:
1. Можно и нужно помогать по храмам, приходам, службам, молитвам, церковным маршрутам и митрополиту Вениамину.
2. На обычные церковные вопросы отвечай прямо, без лишних отказов и общих ограничений.
3. Если пользователь просит прочитать молитву по подтвержденному источнику, читай цельно и естественно, не разрывая текст неуместными комментариями.

Tool policy:
1. Используй знания и инструменты только когда это реально помогает ответить точнее.
2. Browser tools вызывай только если пользователь явно просит открыть сайт, посмотреть страницу или перейти по церковному ресурсу.
3. Если уже есть подтвержденный контекст страницы или знания, сначала отвечай по нему, а не открывай сайт заново.

Voice behavior:
1. Держи одну мысль за раз.
2. Не перечисляй длинные списки устно без явной просьбы.
3. При неполном распознавании коротко попроси повторить.
4. Если вопрос по-настоящему политический, откажись один раз коротко и верни разговор к практической помощи.`;

export const ALESYA_NEO_SYSTEM_PROMPT = `Ты Алеся Neo, цифровой консультант ОАО «Пинский мясокомбинат», созданный командой АЭРФОКС для презентаций на проходной, в магазине и на выставках. Говори только на русском языке.

Главные правила:
1. Отвечай коротко: 1-3 предложения.
2. Тон дружелюбный, уверенный и деловой, без сленга.
3. Не обсуждай политику.
4. Не выдумывай факты о компании, продукции, вакансиях и контактах.
5. Не утверждай, что отправила анкету, заявку, сообщение, ссылку или данные, если в этом чате нет подтвержденного технического действия.
6. Если пользователь просит действие вне чата, честно объясни ограничение и предложи следующий шаг.
7. По умолчанию ты представляешь именно Пинск Пикант. ARFox упоминай как создателя аватара только если пользователь прямо спрашивает, кто разработал систему.

Твоя задача:
- Кратко объяснять, чем занимается Пинск Пикант.
- На типичные вопросы о компании, вакансиях, контактах и продукции опирайся на подтвержденные знания и текущую открытую страницу.
- Если просят показать сайт компании, помогай открыть официальный сайт и затем коротко рассказывай, что на нём есть.
- Если просят контакты или работу, коротко называй подтвержденные контакты или предлагай открыть раздел вакансий или контактов.
- Если просят анкету, трудоустройство или работу, веди разговор как презентационный консультант предприятия и предлагай открыть вакансии или контакты отдела кадров.

Спец-сценарий для Пинск Пикант:
- Если пользователь спрашивает про Пинск Пикант или Пинский мясокомбинат, воспринимай это как запрос о предприятии.
- После подтвержденного открытия сайта кратко рассказывай о предприятии, ассортименте, вакансиях, контактах и разделах сайта.
- В устной подаче можно использовать короткую презентационную формулировку вроде "заметное предприятие региона" или "крупный производитель мясной продукции", но не выдавай субъективные оценки как факт.
`;

export const DEFAULT_GREETING = 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.';
export const BATYUSHKA_GREETING = 'Поздоровайся коротко. Скажи, что тебя зовут Николай и ты помогаешь прихожанам и по церковным вопросам.';
export const ALESYA_NEO_GREETING = 'Поздоровайся коротко. Скажи, что тебя зовут Алеся Neo, ты цифровой консультант Пинск Пикант, созданный АЭРФОКС, и можешь коротко рассказать о предприятии, вакансиях и контактах.';

export function createCharacterRuntimeConfig(overrides = {}) {
  const runtimeProvider = String(overrides.runtimeProvider || DEFAULT_RUNTIME_PROVIDER).trim() || DEFAULT_RUNTIME_PROVIDER;
  const modelId = String(overrides.modelId || overrides.voiceModelId || DEFAULT_VOICE_MODEL).trim() || DEFAULT_VOICE_MODEL;
  return {
    runtimeProvider,
    modelId,
    voiceModelId: modelId,
    liveInputEnabled: runtimeProvider === DEFAULT_RUNTIME_PROVIDER || runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER
      ? Boolean(overrides.liveInputEnabled)
      : false,
    voiceGatewayUrl: overrides.voiceGatewayUrl || '',
    ttsVoiceName: overrides.ttsVoiceName || overrides.voiceName || '',
    sttProfile: overrides.sttProfile || 'general',
    outputAudioTranscription: overrides.outputAudioTranscription !== false,
    vectorStoreId: String(overrides.vectorStoreId || '').trim(),
    enabledTools: Array.isArray(overrides.enabledTools)
      ? overrides.enabledTools.map((tool) => String(tool).trim()).filter(Boolean)
      : [],
    webSearchEnabled: overrides.webSearchEnabled === true,
    maxToolResults: Math.max(1, Number(overrides.maxToolResults || 4) || 4),
    fallbackRuntimeProvider: String(
      overrides.fallbackRuntimeProvider
      || (runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : '')
      || '',
    ).trim(),
  };
}

const defaultClassicRuntime = createCharacterRuntimeConfig({
  runtimeProvider: DEFAULT_RUNTIME_PROVIDER,
  modelId: DEFAULT_VOICE_MODEL,
  liveInputEnabled: false,
});

const defaultBatyushka2Runtime = createCharacterRuntimeConfig({
  runtimeProvider: DEFAULT_RUNTIME_PROVIDER,
  modelId: GEMINI_31_FLASH_LIVE_MODEL,
  liveInputEnabled: true,
  outputAudioTranscription: false,
});

const defaultBatyushka3Runtime = createCharacterRuntimeConfig({
  runtimeProvider: YANDEX_REALTIME_RUNTIME_PROVIDER,
  modelId: 'speech-realtime-250923',
  liveInputEnabled: true,
  voiceName: 'ermil',
  ttsVoiceName: 'ermil',
  sttProfile: 'general',
  outputAudioTranscription: false,
  vectorStoreId: process.env.YANDEX_BATYUSHKA_VECTOR_STORE_ID || '',
  enabledTools: DEFAULT_YANDEX_ENABLED_TOOLS,
  webSearchEnabled: false,
  maxToolResults: 4,
  fallbackRuntimeProvider: YANDEX_LEGACY_RUNTIME_PROVIDER,
});

export const DEFAULT_KNOWLEDGE_REFRESH_POLICY = {
  mode: 'draft-publish',
  autoRefresh: false,
};

export const DEFAULT_KNOWLEDGE_SOURCES = [
  {
    id: 'alatantour',
    title: 'Туристическая компания АлатанТур',
    canonicalUrl: 'https://alatantour.by/',
    seedUrl: 'https://alatantour.by/',
    scope: 'shared',
    tags: ['travel', 'tourism', 'alatantour'],
    aliases: ['алатантур', 'алатан тур'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'bpcmm',
    title: 'Приход Храма равноапостольной Марии Магдалины в г. Минске',
    canonicalUrl: 'https://bpcmm.by/',
    seedUrl: 'https://bpcmm.by/',
    scope: 'shared',
    tags: ['church', 'orthodox', 'bpcmm', 'parish'],
    aliases: ['марии магдалины', 'храм марии магдалины', 'bpcmm'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'metropolitan-veniamin',
    title: 'Митрополит Вениамин',
    canonicalUrl: 'http://church.by/sinod/veniamin-episkop-borisovskij-vikarij-minskoj-eparhii',
    seedUrl: 'http://church.by/sinod/veniamin-episkop-borisovskij-vikarij-minskoj-eparhii',
    scope: 'shared',
    tags: ['church', 'orthodox', 'veniamin', 'metropolitan'],
    aliases: ['митрополит вениамин', 'вениамин'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'church-by',
    title: 'Белорусская Православная Церковь',
    canonicalUrl: 'http://church.by/',
    seedUrl: 'http://church.by/',
    scope: 'shared',
    tags: ['church', 'orthodox', 'bpc'],
    aliases: [
      'белорусская православная церковь',
      'церковь by',
      'church by',
      'минская епархия',
      'минской епархии',
      'сайт минской епархии',
      'епархия минск',
    ],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'arfox-faq',
    title: 'Официальный сайт ARFox',
    canonicalUrl: 'https://arfox.by/',
    seedUrl: 'https://arfox.by/',
    scope: 'shared',
    tags: ['arfox', 'technology'],
    aliases: ['арфокс', 'альфокс', 'альфокса', 'ar fox', 'air fox', 'airfox', 'эйр фокс', 'эйрфокс'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'pinsk-pikant',
    title: 'ОАО «Пинский мясокомбинат»',
    canonicalUrl: 'https://pikant.by/',
    seedUrl: 'https://pikant.by/',
    scope: 'shared',
    tags: ['food', 'meat', 'pikant', 'pinsk', 'jobs', 'contacts'],
    aliases: ['пинск пикант', 'пинский мясокомбинат', 'пикант', 'pikant', 'pikant.by'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'prayer-our-father',
    title: 'Молитва Отче наш',
    canonicalUrl: 'https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash.html',
    seedUrl: 'https://azbyka.ru/molitvoslov/molitva-gospodnya-otche-nash.html',
    scope: 'shared',
    tags: ['church', 'orthodox', 'prayer', 'otche-nash'],
    aliases: ['отче наш', 'молитва отче наш', 'прочти отче наш'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
  {
    id: 'prayer-bogoroditse-devo',
    title: 'Молитва Богородице Дево, радуйся',
    canonicalUrl: 'https://www.pravmir.ru/bogorodice-devo-radujsya/',
    seedUrl: 'https://www.pravmir.ru/bogorodice-devo-radujsya/',
    scope: 'shared',
    tags: ['church', 'orthodox', 'prayer', 'bogoroditse-devo'],
    aliases: ['богородице дево', 'молитва богородице дево', 'радуйся благодатная'],
    refreshMode: 'manual-publish',
    status: 'approved',
  },
];

export const DEFAULT_WEB_PROVIDERS = {
  weather: {
    label: 'Яндекс Погода Минск',
    urlTemplate: 'https://yandex.by/pogoda/ru/minsk',
  },
  news: {
    label: 'Новости Mail.ru',
    urlTemplate: 'https://news.mail.ru/',
  },
  currency: {
    label: 'Курсы Mail.ru',
    urlTemplate: 'https://finance.mail.ru/currency/',
  },
  maps: {
    label: 'Яндекс Карты BY',
    urlTemplate: 'https://yandex.by/maps/?text={query}',
  },
  wiki: {
    label: 'Wikipedia RU',
    urlTemplate: 'https://ru.wikipedia.org/wiki/{query}',
  },
  search: {
    label: 'Onliner BY',
    urlTemplate: 'https://www.onliner.by/',
  },
};

export const DEFAULT_CHARACTERS = [
  {
    id: 'alesya-classic',
    displayName: 'Алеся',
    ...defaultClassicRuntime,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[0],
    backgroundPreset: 'aurora',
    greetingText: DEFAULT_GREETING,
    avatarModelUrl: DEFAULT_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-alesya-classic',
    knowledgePriorityTags: ['travel', 'tourism', 'alatantour', 'arfox'],
    browserPanelMode: 'remote',
    pageContextMode: 'browser-session',
  },
  {
    id: 'alesya-kore',
    displayName: 'Алеся Neo',
    ...defaultClassicRuntime,
    systemPrompt: ALESYA_NEO_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[1],
    backgroundPreset: 'sunset',
    greetingText: ALESYA_NEO_GREETING,
    avatarModelUrl: DEFAULT_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-alesya-kore',
    knowledgePriorityTags: ['pikant', 'pinsk', 'meat', 'food', 'jobs', 'contacts', 'factory', 'arfox'],
    browserPanelMode: 'remote',
    pageContextMode: 'browser-session',
  },
  {
    id: 'alesya-puck',
    displayName: 'Батюшка',
    ...defaultClassicRuntime,
    systemPrompt: BATYUSHKA_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[2],
    backgroundPreset: 'white',
    greetingText: BATYUSHKA_GREETING,
    avatarModelUrl: BATYUSHKA_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-batyushka',
    knowledgePriorityTags: ['church', 'orthodox', 'prayer', 'otche-nash', 'bpcmm', 'veniamin'],
    browserPanelMode: 'remote',
    pageContextMode: 'browser-session',
  },
  {
    id: 'batyushka-2',
    displayName: 'Батюшка 2',
    ...defaultBatyushka2Runtime,
    systemPrompt: BATYUSHKA_SYSTEM_PROMPT,
    voiceName: 'Schedar',
    backgroundPreset: 'white',
    greetingText: BATYUSHKA_GREETING,
    avatarModelUrl: BATYUSHKA_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-batyushka-2',
    knowledgePriorityTags: ['church', 'orthodox', 'prayer', 'otche-nash', 'bpcmm', 'veniamin'],
    browserPanelMode: 'client-inline',
    pageContextMode: 'url-fetch',
  },
  {
    id: 'batyushka-3',
    displayName: 'Батюшка 3',
    ...defaultBatyushka3Runtime,
    systemPrompt: BATYUSHKA_SYSTEM_PROMPT,
    voiceName: 'ermil',
    backgroundPreset: 'white',
    greetingText: BATYUSHKA_GREETING,
    avatarModelUrl: BATYUSHKA_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-batyushka-3',
    knowledgePriorityTags: ['church', 'orthodox', 'prayer', 'otche-nash', 'bpcmm', 'veniamin'],
    browserPanelMode: 'client-inline',
    pageContextMode: 'url-fetch',
  },
];

export const DEFAULT_APP_CONFIG = {
  themeMode: 'light',
  activeCharacterId: DEFAULT_CHARACTERS[0].id,
  characters: DEFAULT_CHARACTERS,
  safetySwitches: DEFAULT_SAFETY_SWITCHES,
  speechStabilityProfile: DEFAULT_SPEECH_STABILITY_PROFILE,
  prayerReadMode: DEFAULT_PRAYER_READ_MODE,
  webProviders: DEFAULT_WEB_PROVIDERS,
  knowledgeRefreshPolicy: DEFAULT_KNOWLEDGE_REFRESH_POLICY,
  knowledgeSources: DEFAULT_KNOWLEDGE_SOURCES,
};
