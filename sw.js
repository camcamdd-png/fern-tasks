/* Fern Tasks service worker: works offline, picks up updates automatically */
const CACHE = "fern-tasks-v1";
const SHELL = ["./", "index.html", "sync.js", "firebase-config.js", "manifest.json",
               "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.ico"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const sdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !sdk) return;                       // database traffic, photos: straight to network
  // network first (so updates show up), fall back to cache when offline
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});
