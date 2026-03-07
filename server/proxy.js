import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { WebSocketServer, WebSocket } from 'ws';
import { closeBrowser, configureBrowserController, detectBrowserIntent, openBrowserIntent } from './browserController.js';
import { getAppConfigPath, loadAppConfig, saveAppConfig } from './configStore.js';
import { SUPPORTED_VOICE_NAMES } from './defaultAppConfig.js';

const PROXY_SCHEME = (process.env.PROXY_SCHEME || 'socks5h').toLowerCase();
const PROXY_HOST = process.env.PROXY_HOST || '45.145.57.227';
const PROXY_PORT = process.env.PROXY_PORT || 13475;
const PROXY_USER = process.env.PROXY_USER || 'PhKW0n';
const PROXY_PASS = process.env.PROXY_PASS || 'zaahsk';
const encodedProxyUser = encodeURIComponent(PROXY_USER);
const encodedProxyPass = encodeURIComponent(PROXY_PASS);
const proxyAuth = PROXY_USER && PROXY_PASS ? `${encodedProxyUser}:${encodedProxyPass}@` : '';
const PROXY_URL = `${PROXY_SCHEME}://${proxyAuth}${PROXY_HOST}:${PROXY_PORT}`;
const proxyAgent = PROXY_SCHEME.startsWith('socks')
  ? new SocksProxyAgent(PROXY_URL)
  : new HttpsProxyAgent(PROXY_URL);

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set in environment variables!');
  process.exit(1);
}
configureBrowserController({
  apiKey: API_KEY,
  agent: proxyAgent,
});
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/gemini-proxy' });
let shutdownInProgress = false;

app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
  const config = await loadAppConfig();
  res.json({
    status: 'ok',
    proxy: PROXY_HOST,
    proxyScheme: PROXY_SCHEME,
    configPath: getAppConfigPath(),
    characters: config.characters.length,
  });
});

app.get('/api/app-config', async (req, res) => {
  try {
    const config = await loadAppConfig();
    res.json({
      ...config,
      supportedVoiceNames: SUPPORTED_VOICE_NAMES,
    });
  } catch (error) {
    console.error('Failed to load app config', error);
    res.status(500).json({ error: 'Не удалось загрузить конфиг приложения' });
  }
});

app.put('/api/app-config', async (req, res) => {
  try {
    const saved = await saveAppConfig(req.body);
    res.json({
      ...saved,
      supportedVoiceNames: SUPPORTED_VOICE_NAMES,
    });
  } catch (error) {
    console.error('Failed to save app config', error);
    res.status(400).json({ error: 'Не удалось сохранить конфиг приложения' });
  }
});

app.post('/api/browser/intent', async (req, res) => {
  try {
    const config = await loadAppConfig();
    const transcript = String(req.body?.transcript || '');
    const contextHint = String(req.body?.contextHint || '');
    const sessionHistory = Array.isArray(req.body?.sessionHistory) ? req.body.sessionHistory : [];
    const intent = await detectBrowserIntent({
      transcript,
      contextHint,
      sessionHistory,
      webProviders: config.webProviders,
    });
    res.json(intent);
  } catch (error) {
    console.error('Failed to detect browser intent', error);
    res.status(500).json({ error: 'Не удалось определить browser intent' });
  }
});

app.post('/api/browser/open', async (req, res) => {
  try {
    const intent = req.body || {};
    if (!intent.url) {
      return res.status(400).json({ error: 'URL для открытия не передан' });
    }

    const result = await openBrowserIntent(intent);
    res.json(result);
  } catch (error) {
    console.error('Failed to open browser intent', error);
    res.status(400).json({
      status: 'error',
      error: error.message || 'Не удалось открыть страницу',
    });
  }
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
}

wss.on('connection', (clientWs) => {
  console.log('Client connected to proxy');

  let geminiWs = null;
  let messageBuffer = [];
  let isConnected = false;

  try {
    geminiWs = new WebSocket(GEMINI_WS_URL, { agent: proxyAgent });

    geminiWs.on('open', () => {
      console.log('Connected to Gemini via proxy');
      isConnected = true;

      if (messageBuffer.length > 0) {
        console.log(`Flushing ${messageBuffer.length} buffered messages`);
        messageBuffer.forEach((message) => geminiWs.send(message));
        messageBuffer = [];
      }
    });

    clientWs.on('message', (data) => {
      if (isConnected && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(data);
      } else {
        messageBuffer.push(data);
      }
    });

    geminiWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    geminiWs.on('error', (error) => {
      console.error('Gemini WS Error:', error.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, `Gemini Error: ${error.message}`);
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log('Gemini WS Closed:', code, reason.toString());
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason.toString());
      }
    });
  } catch (error) {
    console.error('Failed to create Gemini WS:', error.message);
    clientWs.close(1011, 'Proxy Error');
  }

  clientWs.on('close', () => {
    console.log('Client disconnected');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  clientWs.on('error', (error) => {
    console.error('Client WS Error:', error.message);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (fs.existsSync(indexHtmlPath)) {
    return res.sendFile(indexHtmlPath);
  }

  return res.status(404).send('Frontend bundle not found');
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/gemini-proxy`);
});

async function shutdown(signal) {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  console.log(`Received ${signal}, shutting down gracefully`);
  const forcedExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000);
  forcedExitTimer.unref?.();

  try {
    for (const client of wss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    await new Promise((resolve) => {
      wss.close(() => resolve());
    });

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await closeBrowser();
    clearTimeout(forcedExitTimer);
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed', error);
    clearTimeout(forcedExitTimer);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
