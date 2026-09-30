/* Two of Us service worker: lets the installed app open fast, like a normal app.
 *
 * Privacy: it keeps copies of the app's own files only (the list below).
 * It never stores moods, notes or anything else from the back end. Requests to
 * other sites (the Apps Script back end) are not touched at all: they always go
 * straight to the network.
 *
 * Bump CACHE whenever anything in web/ changes, so phones pick up the new files.
 */
const CACHE = 'two-of-us-v1';

const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './demo.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this app's old copies. Other apps on the same github.io address keep theirs.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('two-of-us-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only this site's own files. Everything else goes to the network untouched.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? cache.match('./') : undefined))
        .then((hit) => hit || fetch(request))
    )
  );
});
