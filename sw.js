// Bump this version when changing the worker, manifest, or home-screen icon.
// HTML updates are fetched on navigation and saved for the next offline launch.
const CACHE_VERSION = '2027-offline-v1';
const CACHE_PREFIX = `palette-nenga:${self.registration.scope}:`;
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const APP_URL = new URL('index.html', self.registration.scope).href;
const CORE_URLS = [APP_URL, 'manifest.webmanifest', 'assets/sheep.png']
  .map(path => new URL(path, self.registration.scope).href);
const APP_PATHS = new Set([
  new URL(self.registration.scope).pathname,
  new URL(APP_URL).pathname
]);

async function saveCoreFiles() {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    // addAll is atomic: installation succeeds only after all files are saved.
    await cache.addAll(CORE_URLS.map(url => new Request(url, {
      cache: 'reload', signal: controller.signal
    })));
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('install', event => {
  // Updates wait for the user's update action or for old tabs to close.
  event.waitUntil(saveCoreFiles());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting());
  } else if (['OFFLINE_STATUS', 'SAVE_OFFLINE'].includes(event.data?.type) && event.ports[0]) {
    event.waitUntil((async () => {
      try {
        if (event.data.type === 'SAVE_OFFLINE') await saveCoreFiles();
        const cache = await caches.open(CACHE_NAME);
        const saved = await Promise.all(CORE_URLS.map(url => cache.match(url)));
        event.ports[0].postMessage({ ready: saved.every(Boolean), version: CACHE_VERSION });
      } catch (_) {
        event.ports[0].postMessage({ ready: false });
      }
    })());
  }
});

async function openApp(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    // A new visit checks for updated prices. Calculations themselves never fetch.
    const response = await fetch(request, { cache: 'no-cache', signal: controller.signal });
    const destination = new URL(response.url);
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html') ||
        destination.origin !== self.location.origin || !APP_PATHS.has(destination.pathname)) {
      throw new Error('App page is unavailable');
    }
    // Never replace a usable offline page with a server error or a login page.
    try { await cache.put(APP_URL, response.clone()); } catch (_) { /* live page still works */ }
    if (controller.signal.aborted) throw new Error('Page download timed out');
    return response;
  } catch (_) {
    const saved = await cache.match(APP_URL);
    if (saved) return saved;
    return new Response('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接続が必要です</title><body><h1>インターネットに接続してください</h1><p>オフライン用のデータがありません。接続してからページを開き直してください。</p><a href="./index.html">ページを開き直す</a></body></html>', {
      status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && APP_PATHS.has(url.pathname)) {
    event.respondWith(openApp(request));
  } else if (CORE_URLS.includes(url.href) && url.href !== APP_URL) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(url.href) || fetch(request);
    })());
  }
});
