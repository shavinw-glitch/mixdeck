/* Piratify service worker — makes the app installable and offline-capable.
   Shell files are cached; API and media requests always go to the network.

   Song audio is NOT cached here, and that is on purpose: a cached response can
   be replayed as a whole file but not seeked (a range request against it either
   misses or returns the entire body), so offline audio lives in IndexedDB as a
   Blob instead — see the offline section of piratify-core.js. This worker is
   only responsible for the shell being there when the network is not. */

/* Bump this when the shell changes — the old cache is dropped on activate. The
   app was renamed from Wavefy, so this starts a fresh cache rather than
   inheriting a client's old one. */
const CACHE = 'piratify-v4';
const SHELL = [
  './',
  './index.html',
  './piratify-core.js',
  './desktop-view.css',
  './liquid-glass.js',
  './manifest.json',
  './icons/icon.svg',
  './vendor/music-metadata.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Every lookup the app makes is cross-origin now (Deezer, Cover Art Archive,
  // Apple, LRCLIB, AudD, Supabase), so nothing under this origin is a data
  // endpoint any more — only the shell below needs handling.

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          /* Only the app shell may replace the cached shell. Caching every
             navigation as index.html meant that opening the diagnostics page
             silently overwrote the app's offline copy with it. */
          const isShell = url.pathname === '/' || url.pathname.endsWith('/index.html');
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(isShell ? './index.html' : event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Shell assets (JS, CSS, icons): network first, cache as the offline
  // fallback. Cache-first here would serve a stale piratify-core.js forever and
  // silently pin every installed client to an old build.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
