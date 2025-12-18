// Backend WebSocket Proxy Server
// This relays WebSocket connections through an HTTPS proxy to bypass geo-restrictions

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Proxy Configuration
const PROXY_HOST = process.env.PROXY_HOST || '208.214.162.56';
const PROXY_PORT = process.env.PROXY_PORT || 59100;
const PROXY_USER = process.env.PROXY_USER || 'fxHrisftnZ';
const PROXY_PASS = process.env.PROXY_PASS || 'Shbwy2NdKx';

const PROXY_URL = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

// Gemini API Configuration
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("ERROR: GEMINI_API_KEY is not set in environment variables!");
    process.exit(1);
}
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/gemini-proxy' });

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', proxy: PROXY_HOST });
});

wss.on('connection', (clientWs) => {
    console.log('Client connected to proxy');

    let geminiWs = null;
    let messageBuffer = [];
    let isConnected = false;

    try {
        // Connect to Gemini through proxy
        geminiWs = new WebSocket(GEMINI_WS_URL, {
            agent: proxyAgent
        });

        geminiWs.on('open', () => {
            console.log('Connected to Gemini via proxy');
            isConnected = true;

            // Flush buffered messages
            if (messageBuffer.length > 0) {
                console.log(`Flushing ${messageBuffer.length} buffered messages`);
                messageBuffer.forEach(msg => geminiWs.send(msg));
                messageBuffer = [];
            }
        });

        // Relay messages from client to Gemini (with buffering)
        clientWs.on('message', (data) => {
            if (isConnected && geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.send(data);
            } else {
                console.log('Buffering message while connecting...');
                messageBuffer.push(data);
            }
        });

        // Relay messages from Gemini to client
        geminiWs.on('message', (data) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data);
            }
        });

        geminiWs.on('error', (err) => {
            console.error('Gemini WS Error:', err.message);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(1011, "Gemini Error: " + err.message);
            }
        });

        geminiWs.on('close', (code, reason) => {
            console.log('Gemini WS Closed:', code, reason.toString());
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(code, reason.toString());
            }
        });

    } catch (e) {
        console.error('Failed to create Gemini WS:', e.message);
        clientWs.close(1011, "Proxy Error");
    }

    clientWs.on('close', () => {
        console.log('Client disconnected');
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    clientWs.on('error', (err) => {
        console.error('Client WS Error:', err.message);
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/gemini-proxy`);
});
