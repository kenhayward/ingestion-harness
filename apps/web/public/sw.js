/*
 * CT Studio service worker (docs/design/pwa.md). It does one thing: when a page load cannot
 * reach the server (no network, or the proxy answers 502-504), it shows offline.html instead of
 * the browser's error page. Nothing else is cached or intercepted: /api (the live job stream,
 * uploads, bundle imports) and the built assets always go straight to the network, so a deploy
 * can never leave anyone on an old build. Served with Cache-Control: no-cache (nginx.conf).
 *
 * Bump CACHE when offline.html changes: activate drops every other cache.
 */
const CACHE = 'ct-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** The proxy is up but the app behind it is not. */
const unreachable = (status) => status >= 502 && status <= 504;

const offline = () => caches.match(OFFLINE_URL).then((page) => page || Response.error());

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request).then(
      (response) => (unreachable(response.status) ? offline() : response),
      () => offline(),
    ),
  );
});
