/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const SHELL = "luna-shell-v7";
const FILES = ["/", "/manifest.webmanifest", "/icon.svg", "/settings.js", "/sync.js", "/cron.js", "/analytics.js", "/analytics.css", "/settings.css"];
self.addEventListener("install", (e: ExtendableEvent) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !FILES.includes(url.pathname)) return;
  // Network first so updates show at once; the cache only covers offline starts.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(async () => (await caches.match(e.request)) ?? new Response("Offline", { status: 503 })));
});
