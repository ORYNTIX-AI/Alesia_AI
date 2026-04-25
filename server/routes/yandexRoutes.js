export function registerYandexRoutes(app, {
  normalizeWhitespace,
  requestYandexCompletion,
  requestYandexStt,
  requestYandexTts,
  yandexDefaultModelId,
} = {}) {
  app.post('/api/yandex/stt', async (req, res) => {
    try {
      const audioBase64 = String(req.body?.audioBase64 || '').trim();
      const language = normalizeWhitespace(req.body?.language || 'ru-RU') || 'ru-RU';
      const sampleRateHertz = Math.max(8000, Number(req.body?.sampleRateHertz || 16000) || 16000);
      if (!audioBase64) {
        return res.status(400).json({ error: 'Не переданы аудиоданные для Yandex STT' });
      }
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const textResult = await requestYandexStt({
        audioBuffer,
        language,
        sampleRateHertz,
        topic: 'general',
      });
      return res.json({ text: textResult });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось выполнить Yandex STT' });
    }
  });

  app.post('/api/yandex/turn', async (req, res) => {
    try {
      const userText = normalizeWhitespace(req.body?.text || '');
      const systemPrompt = String(req.body?.systemPrompt || '');
      const modelId = normalizeWhitespace(req.body?.modelId || yandexDefaultModelId) || yandexDefaultModelId;
      const voiceName = normalizeWhitespace(req.body?.voiceName || 'ermil') || 'ermil';
      const sampleRateHertz = Math.max(8000, Number(req.body?.sampleRateHertz || 48000) || 48000);
      if (!userText) {
        return res.status(400).json({ error: 'Не передан текст запроса для Yandex turn' });
      }
      const assistantText = await requestYandexCompletion({
        modelId,
        systemPrompt,
        userText,
      });
      if (!assistantText) {
        return res.status(502).json({ error: 'Yandex не вернул текст ответа' });
      }
      const ttsResult = await requestYandexTts({
        text: assistantText,
        voice: voiceName,
        sampleRateHertz,
      });
      return res.json({
        text: assistantText,
        audioBase64: ttsResult.audioBase64,
        sampleRateHertz: ttsResult.sampleRateHertz,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось выполнить Yandex turn' });
    }
  });

  app.post('/api/yandex/tts', async (req, res) => {
    try {
      const text = normalizeWhitespace(req.body?.text || '');
      const voiceName = normalizeWhitespace(req.body?.voiceName || 'ermil') || 'ermil';
      const sampleRateHertz = Math.max(8000, Number(req.body?.sampleRateHertz || 48000) || 48000);
      if (!text) {
        return res.status(400).json({ error: 'Не передан текст для Yandex TTS' });
      }

      const ttsResult = await requestYandexTts({
        text,
        voice: voiceName,
        sampleRateHertz,
      });

      return res.json({
        audioBase64: ttsResult.audioBase64,
        sampleRateHertz: ttsResult.sampleRateHertz,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось синтезировать Yandex TTS' });
    }
  });
}
