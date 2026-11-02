// Minimal service worker — its job is just to make the dashboard an
// installable app (home-screen / "Install"). It deliberately does NOT
// cache anything: the dashboard is live data behind a login, so a cache
// would risk serving stale or wrong-account content. Everything goes
// straight to the network.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* passthrough: let the browser fetch normally */ })
