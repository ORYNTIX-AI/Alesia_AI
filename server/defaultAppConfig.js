import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEMO_CONTENT_DIR = path.resolve(__dirname, '../demo-content');
const PROMPTS_DIR = path.join(DEMO_CONTENT_DIR, 'prompts');
const GREETINGS_DIR = path.join(DEMO_CONTENT_DIR, 'greetings');
const DEFAULT_CONFIG_FILE = path.join(DEMO_CONTENT_DIR, 'default-app-config.json');

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
export const DEFAULT_AVATAR_MODEL_URL = 'avatars/alesya.glb';
export const BATYUSHKA_AVATAR_MODEL_URL = 'avatars/nikolay.glb';
export const DEFAULT_RUNTIME_PROVIDER = 'gemini-live';
export const YANDEX_REALTIME_RUNTIME_PROVIDER = 'yandex-realtime';
export const YANDEX_LEGACY_RUNTIME_PROVIDER = 'yandex-full-legacy';
export const YANDEX_RUNTIME_PROVIDER = YANDEX_LEGACY_RUNTIME_PROVIDER;
export const DEFAULT_YANDEX_ENABLED_TOOLS = [
  'file_search',
  'open_site',
  'view_page',
  'extract_page_context',
  'summarize_visible_page',
];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
}

export function loadDefaultStoredAppConfig() {
  return readJsonFile(DEFAULT_CONFIG_FILE);
}

export function resolvePromptRef(ref = '') {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef) {
    return '';
  }
  return readTextFile(path.join(PROMPTS_DIR, `${normalizedRef}.md`));
}

export function resolveGreetingRef(ref = '') {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef) {
    return '';
  }
  return readTextFile(path.join(GREETINGS_DIR, `${normalizedRef}.txt`));
}

export function createCharacterRuntimeConfig(overrides = {}) {
  const runtimeProvider = String(overrides.runtimeProvider || overrides.provider || DEFAULT_RUNTIME_PROVIDER).trim() || DEFAULT_RUNTIME_PROVIDER;
  const modelId = String(overrides.modelId || overrides.voiceModelId || DEFAULT_VOICE_MODEL).trim() || DEFAULT_VOICE_MODEL;
  return {
    runtimeProvider,
    modelId,
    voiceModelId: modelId,
    liveInputEnabled: runtimeProvider === DEFAULT_RUNTIME_PROVIDER || runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER
      ? Boolean(overrides.liveInputEnabled)
      : false,
    voiceGatewayUrl: String(overrides.voiceGatewayUrl || '').trim(),
    ttsVoiceName: String(overrides.ttsVoiceName || overrides.voiceName || '').trim(),
    sttProfile: String(overrides.sttProfile || 'general').trim() || 'general',
    outputAudioTranscription: overrides.outputAudioTranscription !== false,
    vectorStoreId: String(overrides.vectorStoreId || '').trim(),
    enabledTools: Array.isArray(overrides.enabledTools)
      ? overrides.enabledTools.map((tool) => String(tool).trim()).filter(Boolean)
      : [],
    webSearchEnabled: overrides.webSearchEnabled === true,
    maxToolResults: Math.max(1, Number(overrides.maxToolResults || 4) || 4),
    fallbackRuntimeProvider: String(
      overrides.fallbackRuntimeProvider
      || overrides.fallbackProvider
      || (runtimeProvider === YANDEX_REALTIME_RUNTIME_PROVIDER ? YANDEX_LEGACY_RUNTIME_PROVIDER : '')
      || '',
    ).trim(),
  };
}

export function getCharacterContentDefaults(characterId = '') {
  const normalizedId = String(characterId || '').trim();
  if (normalizedId === 'alesya-kore') {
    return { promptRef: 'alesya-neo', greetingRef: 'alesya-neo' };
  }
  if (normalizedId === 'alesya-puck' || normalizedId === 'batyushka-2' || normalizedId === 'batyushka-3') {
    return { promptRef: 'batyushka', greetingRef: 'batyushka' };
  }
  return { promptRef: 'alesya-classic', greetingRef: 'alesya-classic' };
}

export function getVectorStoreFallbackForCharacter(characterId = '') {
  if (String(characterId || '').trim() === 'batyushka-3') {
    return String(process.env.YANDEX_BATYUSHKA_VECTOR_STORE_ID || '').trim();
  }
  return '';
}

export const DEFAULT_APP_CONFIG = loadDefaultStoredAppConfig();
