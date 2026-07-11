/* PaperLens service worker — offline app shell + runtime caching of CDN libs. */
const SHELL_CACHE = 'paperlens-shell-v6';
const RUNTIME_CACHE = 'paperlens-runtime-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './cv-pipeline.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isShell = url.origin === self.location.origin;

  if (isShell) {
    // Cache-first for our own assets.
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  } else {
    // Stale-while-revalidate for CDN libraries (OpenCV, Tesseract, jsPDF, langs).
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request).then((res) => {
          if (res && res.status === 200) cache.put(request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
