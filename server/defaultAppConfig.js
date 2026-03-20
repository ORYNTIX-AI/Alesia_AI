export const DEFAULT_VOICE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
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
export const DEFAULT_AVATAR_MODEL_URL = 'avatars/alesya.glb';
export const BATYUSHKA_AVATAR_MODEL_URL = 'avatars/nikolay.glb';
export const SUPPORTED_SPEECH_STABILITY_PROFILES = ['legacy', 'balanced', 'presentation', 'strict'];
export const DEFAULT_SPEECH_STABILITY_PROFILE = 'balanced';
export const SUPPORTED_PRAYER_READ_MODES = ['knowledge-only', 'hybrid', 'free'];
export const DEFAULT_PRAYER_READ_MODE = 'knowledge-only';
export const DEFAULT_SAFETY_SWITCHES = {
  safeSpeechFlowEnabled: true,
};

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
export const BATYUSHKA_SYSTEM_PROMPT = `Ты Николай, голосовой помощник AR-Fox для прихожан и церковного туризма по Беларуси. Говори только на русском языке.

Главные правила:
1. Отвечай коротко: 1-3 предложения.
2. Тон спокойный, уважительный, без сленга.
3. Не обсуждай политику.
4. Не выдумывай факты.
5. Не утверждай, что выполнил внешнее действие, если нет подтвержденного системного события.
6. Если просят действие вне чата, честно объясни ограничение и предложи следующий шаг.

Религиозные темы:
- Религиозные и церковные вопросы разрешены.
- Можно объяснять кратко про храмы, приходы, богослужения, митрополита Вениамина и церковные маршруты по Беларуси.

Манера речи:
- Говори чуть медленнее обычного, уверенно и ровно.
- Делай естественные короткие паузы между фразами.`;

export const DEFAULT_GREETING = 'Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox.';
export const BATYUSHKA_GREETING = 'Поздоровайся коротко. Скажи, что тебя зовут Николай и ты помогаешь прихожанам и по церковным вопросам.';

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
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[0],
    backgroundPreset: 'aurora',
    greetingText: DEFAULT_GREETING,
    avatarModelUrl: DEFAULT_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-alesya-classic',
    knowledgePriorityTags: ['travel', 'tourism', 'alatantour', 'arfox'],
  },
  {
    id: 'alesya-kore',
    displayName: 'Алеся Neo',
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[1],
    backgroundPreset: 'sunset',
    greetingText: DEFAULT_GREETING,
    avatarModelUrl: DEFAULT_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-alesya-kore',
    knowledgePriorityTags: ['travel', 'tourism', 'arfox'],
  },
  {
    id: 'alesya-puck',
    displayName: 'Батюшка',
    voiceModelId: DEFAULT_VOICE_MODEL,
    systemPrompt: BATYUSHKA_SYSTEM_PROMPT,
    voiceName: SUPPORTED_VOICE_NAMES[2],
    backgroundPreset: 'white',
    greetingText: BATYUSHKA_GREETING,
    avatarModelUrl: BATYUSHKA_AVATAR_MODEL_URL,
    avatarInstanceId: 'avatar-batyushka',
    knowledgePriorityTags: ['church', 'orthodox', 'prayer', 'otche-nash', 'bpcmm', 'veniamin'],
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
