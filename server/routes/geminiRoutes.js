import https from 'https';

const GEMINI_31_FLASH_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_TTS_DEFAULT_SAMPLE_RATE = 24000;
const GEMINI_GENERATE_CONTENT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function normalizeGeminiModelId(value = '', fallback = GEMINI_31_FLASH_TTS_MODEL) {
  const normalized = String(value || '').trim().replace(/^models\//, '');
  if (!normalized) {
    return fallback;
  }
  if (normalized.startsWith('gemini-') && !normalized.startsWith('gemini-3.1-')) {
    return fallback;
  }
  return normalized;
}

function parseGeminiSampleRate(mimeType = '') {
  const match = /rate=(\d+)/i.exec(String(mimeType || ''));
  return Math.max(8000, Number(match?.[1] || GEMINI_TTS_DEFAULT_SAMPLE_RATE) || GEMINI_TTS_DEFAULT_SAMPLE_RATE);
}

function parseJsonPayload(textPayload = '') {
  if (!textPayload) {
    return {};
  }
  try {
    return JSON.parse(textPayload);
  } catch {
    return { raw: textPayload };
  }
}

function postJsonWithAgent(url, body, { agent } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(url, {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.byteLength),
      },
      timeout: 30000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          payload: parseJsonPayload(text),
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Gemini TTS request timed out'));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function extractInlineAudio(payload = {}) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inlineData = part?.inlineData || part?.inline_data;
    const audioBase64 = String(inlineData?.data || '').trim();
    if (audioBase64) {
      return {
        audioBase64,
        sampleRateHertz: parseGeminiSampleRate(inlineData?.mimeType || inlineData?.mime_type || ''),
      };
    }
  }
  return { audioBase64: '', sampleRateHertz: GEMINI_TTS_DEFAULT_SAMPLE_RATE };
}

export function registerGeminiRoutes(app, {
  apiKey = '',
  agent = null,
  logRuntime = () => {},
  normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim(),
} = {}) {
  app.post('/api/gemini/tts', async (req, res) => {
    try {
      if (!apiKey) {
        return res.status(503).json({ error: 'Gemini API key is not configured' });
      }

      const text = normalizeWhitespace(req.body?.text || '');
      const voiceName = normalizeWhitespace(req.body?.voiceName || 'Schedar') || 'Schedar';
      const modelId = normalizeGeminiModelId(req.body?.modelId);
      const stylePrompt = normalizeWhitespace(req.body?.stylePrompt || '');
      if (!text) {
        return res.status(400).json({ error: 'No text for Gemini TTS' });
      }

      const contents = stylePrompt
        ? `${stylePrompt}\n\n${text}`
        : text;
      const body = {
        contents: [{ parts: [{ text: contents }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      };

      const url = `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await postJsonWithAgent(url, body, { agent });
      if (!response.ok) {
        const message = response.payload?.error?.message
          || response.payload?.message
          || `Gemini TTS failed (${response.status})`;
        logRuntime('gemini.tts.error', { status: response.status, message });
        return res.status(502).json({ error: message });
      }

      const audio = extractInlineAudio(response.payload);
      if (!audio.audioBase64) {
        logRuntime('gemini.tts.empty-audio', { modelId, voiceName });
        return res.status(502).json({ error: 'Gemini TTS returned empty audio' });
      }

      logRuntime('gemini.tts.ok', {
        modelId,
        voiceName,
        textLength: text.length,
        sampleRateHertz: audio.sampleRateHertz,
      });
      return res.json(audio);
    } catch (error) {
      const message = error?.message || 'Gemini TTS failed';
      logRuntime('gemini.tts.error', { message });
      return res.status(502).json({ error: message });
    }
  });
}
