// Minimal service worker — required for PWA installability
// No caching strategy: always fetch from network (app is a local tool, not offline-first)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
