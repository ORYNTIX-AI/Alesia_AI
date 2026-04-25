export function createYandexRuntimeService({
  normalizeWhitespace,
  yandexApiKey = '',
  yandexIamToken = '',
  yandexFolderId = '',
  yandexDefaultModelId = 'yandexgpt-lite/latest',
  yandexSttUrl = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
  yandexTtsUrl = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
  yandexLlmUrl = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
}) {
  function getYandexAuthorizationHeader() {
    if (yandexApiKey) {
      return `Api-Key ${yandexApiKey}`;
    }
    if (yandexIamToken) {
      return `Bearer ${yandexIamToken}`;
    }
    throw new Error('Yandex auth is not configured');
  }

  function buildYandexModelUri(modelId = '') {
    const normalizedModelId = normalizeWhitespace(modelId || yandexDefaultModelId || 'yandexgpt-lite/latest');
    if (!normalizedModelId) {
      throw new Error('Yandex model id is not configured');
    }
    if (/^[a-z]+:\/\//i.test(normalizedModelId)) {
      return normalizedModelId;
    }
    if (!yandexFolderId) {
      throw new Error('YANDEX_FOLDER_ID is not configured');
    }
    return `gpt://${yandexFolderId}/${normalizedModelId}`;
  }

  async function parseJsonResponse(response) {
    const textPayload = await response.text();
    if (!textPayload) {
      return {};
    }
    try {
      return JSON.parse(textPayload);
    } catch {
      return { raw: textPayload };
    }
  }

  async function requestYandexStt({
    audioBuffer,
    language = 'ru-RU',
    topic = 'general',
    sampleRateHertz = 16000,
  }) {
    const params = new URLSearchParams({
      lang: language || 'ru-RU',
      topic: topic || 'general',
      format: 'lpcm',
      sampleRateHertz: String(sampleRateHertz || 16000),
    });
    const response = await fetch(`${yandexSttUrl}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: getYandexAuthorizationHeader(),
        'Content-Type': 'application/octet-stream',
      },
      body: audioBuffer,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload?.error_message || payload?.message || `Yandex STT failed (${response.status})`);
    }
    return normalizeWhitespace(payload?.result || payload?.text || '');
  }

  async function requestYandexCompletion({
    modelId = '',
    systemPrompt = '',
    userText = '',
  }) {
    const body = {
      modelUri: buildYandexModelUri(modelId),
      completionOptions: {
        stream: false,
        temperature: 0.18,
        maxTokens: '220',
      },
      messages: [
        ...(normalizeWhitespace(systemPrompt) ? [{ role: 'system', text: systemPrompt }] : []),
        { role: 'user', text: userText },
      ],
    };
    const response = await fetch(yandexLlmUrl, {
      method: 'POST',
      headers: {
        Authorization: getYandexAuthorizationHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `Yandex completion failed (${response.status})`);
    }
    const alternative = payload?.result?.alternatives?.[0] || payload?.alternatives?.[0] || {};
    return normalizeWhitespace(
      alternative?.message?.text
        || alternative?.text
        || payload?.result?.message?.text
        || payload?.result?.text
        || '',
    );
  }

  async function requestYandexTts({
    text,
    voice = 'ermil',
    sampleRateHertz = 48000,
  }) {
    const form = new URLSearchParams({
      text,
      lang: 'ru-RU',
      voice: normalizeWhitespace(voice || 'ermil') || 'ermil',
      format: 'lpcm',
      sampleRateHertz: String(sampleRateHertz || 48000),
    });
    const response = await fetch(yandexTtsUrl, {
      method: 'POST',
      headers: {
        Authorization: getYandexAuthorizationHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const audioArrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      const errorText = Buffer.from(audioArrayBuffer).toString('utf8');
      let message = `Yandex TTS failed (${response.status})`;
      try {
        const parsed = JSON.parse(errorText);
        message = parsed?.message || parsed?.error_message || message;
      } catch {
        if (normalizeWhitespace(errorText)) {
          message = errorText;
        }
      }
      throw new Error(message);
    }
    if (audioArrayBuffer.byteLength === 0) {
      throw new Error('Yandex TTS returned empty audio');
    }
    return {
      audioBase64: Buffer.from(audioArrayBuffer).toString('base64'),
      sampleRateHertz: Number(sampleRateHertz || 48000),
    };
  }

  return {
    requestYandexCompletion,
    requestYandexStt,
    requestYandexTts,
  };
}
