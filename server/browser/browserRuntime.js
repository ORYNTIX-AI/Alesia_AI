import dns from 'dns/promises';
import net from 'net';
import { chromium } from 'playwright';
import { SocksClient } from 'socks';
import { logRuntime } from '../runtimeLogger.js';
import { BROWSER_ORIGIN_PROBE_TIMEOUT_MS, BROWSER_PROXY_MODE, DEFAULT_TIMEOUT_MS, normalizeWhitespace } from './shared.js';
import { clearBrowserIdleTimer, getBrowserPromise, hasActiveSession, resetBrowserState, setBrowserInstance, setBrowserPromise } from './sessionStore.js';

let browserProxyBridgePromise = null;

export function isPrivateIp(ipAddress) {
  if (!ipAddress) return true;

  if (net.isIPv4(ipAddress)) {
    if (ipAddress.startsWith('10.')) return true;
    if (ipAddress.startsWith('127.')) return true;
    if (ipAddress.startsWith('169.254.')) return true;
    if (ipAddress.startsWith('192.168.')) return true;

    const [first, second] = ipAddress.split('.').map(Number);
    if (first === 172 && second >= 16 && second <= 31) return true;
    return false;
  }

  if (net.isIPv6(ipAddress)) {
    const normalized = ipAddress.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80');
  }

  return true;
}

export async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только http/https URL');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Локальные адреса запрещены');
  }

  if (!hostname.endsWith('.by') && !hostname.endsWith('.ru')) {
    throw new Error('Разрешены только сайты в доменах .by и .ru');
  }

  const lookup = await dns.lookup(hostname, { all: true });
  if (!lookup.length || lookup.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Внутренние или приватные адреса запрещены');
  }

  return url.toString();
}

export function isEmbeddable(headers) {
  const xFrameOptions = headers['x-frame-options'] || '';
  const csp = headers['content-security-policy'] || '';

  if (/deny|sameorigin/i.test(xFrameOptions)) {
    return false;
  }

  if (/frame-ancestors\s+'none'/i.test(csp) || /frame-ancestors\s+[^;]*(self|none)/i.test(csp)) {
    return false;
  }

  return true;
}

export function shouldUseBrowserProxy() {
  return ['shared', 'proxy', 'always', 'browser'].includes(BROWSER_PROXY_MODE);
}

export function getConfiguredProxy() {
  if (!shouldUseBrowserProxy()) {
    return null;
  }

  const host = normalizeWhitespace(process.env.PROXY_HOST || '');
  const port = Number.parseInt(process.env.PROXY_PORT || '', 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }

  return {
    scheme: normalizeWhitespace(process.env.PROXY_SCHEME || 'socks5h').toLowerCase(),
    host,
    port,
    username: normalizeWhitespace(process.env.PROXY_USER || ''),
    password: normalizeWhitespace(process.env.PROXY_PASS || ''),
  };
}

export async function probeOriginReachability(targetUrl, timeoutMs = BROWSER_ORIGIN_PROBE_TIMEOUT_MS) {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const port = Number(parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443));
  const hostname = parsedUrl.hostname;
  if (!hostname || !Number.isFinite(port) || port <= 0) {
    return { ok: false, reason: 'invalid_url' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({
      host: hostname,
      port,
      timeout: Math.max(500, timeoutMs),
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'connect_timeout' }));
    socket.once('error', (error) => finish({
      ok: false,
      reason: normalizeWhitespace(error?.code || error?.message || 'connect_error').toLowerCase(),
    }));
  });
}

export function buildSocksReply(status, host = '0.0.0.0', port = 0) {
  const normalizedPort = Number.isFinite(Number(port)) ? Number(port) : 0;
  if (net.isIPv6(host)) {
    const payload = Buffer.alloc(4 + 16 + 2);
    payload[0] = 0x05;
    payload[1] = status;
    payload[2] = 0x00;
    payload[3] = 0x04;
    const parts = host.split(':');
    const expanded = [];
    for (const part of parts) {
      if (!part) {
        const missing = 8 - parts.filter(Boolean).length;
        for (let index = 0; index <= missing; index += 1) {
          expanded.push('0000');
        }
      } else {
        expanded.push(part.padStart(4, '0'));
      }
    }
    expanded.slice(0, 8).forEach((part, index) => {
      payload.writeUInt16BE(Number.parseInt(part, 16) || 0, 4 + (index * 2));
    });
    payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 20);
    return payload;
  }

  if (net.isIPv4(host)) {
    const payload = Buffer.alloc(10);
    payload[0] = 0x05;
    payload[1] = status;
    payload[2] = 0x00;
    payload[3] = 0x01;
    host.split('.').slice(0, 4).forEach((part, index) => {
      payload[4 + index] = Number.parseInt(part, 10) || 0;
    });
    payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 8);
    return payload;
  }

  const hostBuffer = Buffer.from(String(host || ''));
  const payload = Buffer.alloc(5 + hostBuffer.length + 2);
  payload[0] = 0x05;
  payload[1] = status;
  payload[2] = 0x00;
  payload[3] = 0x03;
  payload[4] = Math.min(255, hostBuffer.length);
  hostBuffer.copy(payload, 5, 0, Math.min(255, hostBuffer.length));
  payload.writeUInt16BE(Math.max(0, Math.min(65535, normalizedPort)), 5 + Math.min(255, hostBuffer.length));
  return payload;
}

export function parseSocksRequest(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  const atyp = buffer[3];
  if (atyp === 0x01) {
    if (buffer.length < 10) {
      return null;
    }
    return {
      host: `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`,
      port: buffer.readUInt16BE(8),
      bytesUsed: 10,
    };
  }

  if (atyp === 0x03) {
    if (buffer.length < 5) {
      return null;
    }
    const hostLength = buffer[4];
    const totalLength = 5 + hostLength + 2;
    if (buffer.length < totalLength) {
      return null;
    }
    return {
      host: buffer.subarray(5, 5 + hostLength).toString('utf8'),
      port: buffer.readUInt16BE(5 + hostLength),
      bytesUsed: totalLength,
    };
  }

  if (atyp === 0x04) {
    if (buffer.length < 22) {
      return null;
    }
    const segments = [];
    for (let index = 0; index < 8; index += 1) {
      segments.push(buffer.readUInt16BE(4 + (index * 2)).toString(16));
    }
    return {
      host: segments.join(':'),
      port: buffer.readUInt16BE(20),
      bytesUsed: 22,
    };
  }

  return { unsupported: true, bytesUsed: buffer.length };
}

export function createBrowserProxyBridgeServer(proxyConfig) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      let stage = 'greeting';
      let buffer = Buffer.alloc(0);
      let upstreamSocket = null;
      let settled = false;

      const cleanup = () => {
        clientSocket.removeAllListeners('data');
        clientSocket.removeAllListeners('error');
        clientSocket.removeAllListeners('close');
      };

      const fail = (status = 0x01, error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          logRuntime('browser.proxy.bridge.error', {
            message: normalizeWhitespace(error?.message || String(error || '')),
          }, 'error');
        }
        try {
          clientSocket.write(buildSocksReply(status));
        } catch {}
        cleanup();
        clientSocket.destroy();
        upstreamSocket?.destroy();
      };

      const complete = async (host, port, remainingBuffer) => {
        try {
          const connection = await SocksClient.createConnection({
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              type: 5,
              userId: proxyConfig.username || undefined,
              password: proxyConfig.password || undefined,
            },
            command: 'connect',
            destination: {
              host,
              port,
            },
            timeout: DEFAULT_TIMEOUT_MS,
          });

          if (settled) {
            connection.socket.destroy();
            return;
          }

          settled = true;
          upstreamSocket = connection.socket;
          clientSocket.write(buildSocksReply(0x00));
          if (remainingBuffer?.length) {
            upstreamSocket.write(remainingBuffer);
          }
          cleanup();
          upstreamSocket.on('error', () => clientSocket.destroy());
          upstreamSocket.on('close', () => clientSocket.destroy());
          clientSocket.on('error', () => upstreamSocket.destroy());
          clientSocket.on('close', () => upstreamSocket.destroy());
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        } catch (error) {
          fail(0x05, error);
        }
      };

      clientSocket.on('data', (chunk) => {
        if (settled) {
          return;
        }

        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 'greeting') {
          if (buffer.length < 2) {
            return;
          }

          const methodsLength = buffer[1];
          if (buffer.length < 2 + methodsLength) {
            return;
          }

          clientSocket.write(Buffer.from([0x05, 0x00]));
          buffer = buffer.subarray(2 + methodsLength);
          stage = 'request';
        }

        if (stage === 'request') {
          if (buffer.length < 4) {
            return;
          }

          if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
            fail(0x07, new Error('Unsupported SOCKS command'));
            return;
          }

          const request = parseSocksRequest(buffer);
          if (!request) {
            return;
          }
          if (request.unsupported) {
            fail(0x08, new Error('Unsupported SOCKS address type'));
            return;
          }

          const remainingBuffer = buffer.subarray(request.bytesUsed);
          buffer = Buffer.alloc(0);
          stage = 'connecting';
          void complete(request.host, request.port, remainingBuffer);
        }
      });

      clientSocket.on('error', () => {
        upstreamSocket?.destroy();
      });
      clientSocket.on('close', () => {
        upstreamSocket?.destroy();
      });
    });

    server.once('error', (error) => {
      browserProxyBridgePromise = null;
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        browserProxyBridgePromise = null;
        reject(new Error('Failed to bind browser proxy bridge'));
        return;
      }

      logRuntime('browser.proxy.bridge.ready', {
        host: '127.0.0.1',
        port: address.port,
        upstreamHost: proxyConfig.host,
        upstreamPort: proxyConfig.port,
      });

      resolve({
        server,
        endpoint: `socks5://127.0.0.1:${address.port}`,
      });
    });
  });
}

export async function getBrowserLaunchProxy() {
  const proxyConfig = getConfiguredProxy();
  if (!proxyConfig) {
    return null;
  }

  if (!proxyConfig.scheme.startsWith('socks')) {
    const launchScheme = proxyConfig.scheme.replace(/h$/, '') || 'http';
    const proxy = {
      server: `${launchScheme}://${proxyConfig.host}:${proxyConfig.port}`,
    };
    if (proxyConfig.username) {
      proxy.username = proxyConfig.username;
    }
    if (proxyConfig.password) {
      proxy.password = proxyConfig.password;
    }
    return proxy;
  }

  if (!proxyConfig.username && !proxyConfig.password) {
    return {
      server: `socks5://${proxyConfig.host}:${proxyConfig.port}`,
    };
  }

  if (!browserProxyBridgePromise) {
    browserProxyBridgePromise = createBrowserProxyBridgeServer(proxyConfig);
  }

  const bridge = await browserProxyBridgePromise;
  return {
    server: bridge.endpoint,
  };
}

export async function getBrowser() {
  clearBrowserIdleTimer();
  if (!getBrowserPromise()) {
    const launchOptions = {
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--mute-audio'],
    };
    const browserProxy = await getBrowserLaunchProxy();
    if (browserProxy) {
      launchOptions.proxy = browserProxy;
    }

    const launchPromise = chromium.launch(launchOptions).then((browser) => {
      setBrowserInstance(browser);
      browser.on('disconnected', () => resetBrowserState('playwright-browser-disconnected'));
      return browser;
    }).catch((error) => {
      resetBrowserState('browser-launch-failed');
      throw error;
    });
    setBrowserPromise(launchPromise);
  }

  return getBrowserPromise();
}

export function safeHostnameFromUrl(url, fallback = '') {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

export function toHttpFallbackUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    parsed.protocol = 'http:';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function shouldRetryWithHttpFallback(url, error) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    return false;
  }

  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return message.includes('err_ssl')
    || message.includes('ssl')
    || message.includes('certificate');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getRegistrableDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) {
      return hostname;
    }
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

export function isSameSiteUrl(left, right) {
  const leftDomain = getRegistrableDomain(left);
  const rightDomain = getRegistrableDomain(right);
  return Boolean(leftDomain) && Boolean(rightDomain) && leftDomain === rightDomain;
}
