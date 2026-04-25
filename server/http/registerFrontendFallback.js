import express from 'express';
import fs from 'fs';
import path from 'path';

const unregisterServiceWorkerScript = `
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
    } catch {
      // Ignore cache cleanup failures.
    }
    try {
      await self.registration.unregister();
    } catch {
      // Ignore unregister failures.
    }
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clientsList.map((client) => client.navigate(client.url).catch(() => undefined)));
  })());
});
`;

const unregisterServiceWorkerClientScript = `
(async () => {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    }
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name).catch(() => false)));
    }
  } catch {
    // Ignore service worker cleanup failures.
  }
})();
`;

export function registerFrontendFallback(app, {
  distDir,
  indexHtmlPath,
}) {
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('text/javascript; charset=utf-8').send(unregisterServiceWorkerScript);
  });

  app.get('/registerSW.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('text/javascript; charset=utf-8').send(unregisterServiceWorkerClientScript);
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, {
      index: false,
      setHeaders(res, filePath) {
        const normalizedPath = String(filePath || '').replace(/\\/g, '/');
        if (
          normalizedPath.endsWith('/sw.js')
          || normalizedPath.endsWith('/manifest.webmanifest')
          || normalizedPath.endsWith('/index.html')
        ) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          return;
        }
        if (normalizedPath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
  }

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && path.extname(req.path)) {
      return res.status(404).type('text/plain; charset=utf-8').send('Static file not found');
    }

    if (fs.existsSync(indexHtmlPath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.sendFile(indexHtmlPath);
    }

    return res.status(404).send('Frontend bundle not found');
  });
}
