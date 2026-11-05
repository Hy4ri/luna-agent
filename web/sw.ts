/// <reference lib="webworker" />
const worker = globalThis as unknown as ServiceWorkerGlobalScope;

// The server derives the version and static shell from the current Vite build manifest.
const SHELL = "__SHELL_VERSION__";
const FILES: string[] = JSON.parse(`__SHELL_FILES__`);
const CORE: string[] = JSON.parse(`__SHELL_CORE__`);
const allowed = new Set(FILES);

worker.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(async cache => {
    await cache.addAll(CORE);
    await worker.skipWaiting();
  }));
});
worker.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(async keys => {
    // Keep one previous shell for lazy imports from pages that were open during an update.
    const previous = keys.filter(key => key.startsWith("luna-vue-") && key !== SHELL);
    await Promise.all(previous.slice(0, -1).map(key => caches.delete(key)));
    await worker.clients.claim();
  }));
});

// Preserve full offline coverage, but fetch optional chunks sequentially at low priority after page load.
// A failed/offline attempt stops this pass; the next page load retries only missing files.
let warming: Promise<void> | undefined;
async function warmOptional() {
  if (!await caches.has(SHELL)) return;
  const cache = await caches.open(SHELL);
  const cached = new Set((await cache.keys()).map(request => new URL(request.url).pathname));
  for (const path of FILES) {
    if (cached.has(path)) continue;
    // An older worker must not refill a cache removed by a newer activation.
    if (!await caches.has(SHELL)) return;
    const response = await fetch(path, { priority: "low", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return;
    await cache.put(path, response);
  }
}
worker.addEventListener("message", event => {
  if (event.data?.type !== "luna:cache-optional") return;
  warming ??= warmOptional().catch(() => {}).finally(() => { warming = undefined; });
  event.waitUntil(warming);
});

async function previousAsset(path: string) {
  const keys = (await caches.keys()).filter(key => key.startsWith("luna-vue-") && key !== SHELL).reverse();
  for (const cacheName of keys) {
    const cached = await caches.match(path, { cacheName });
    if (cached) return cached;
  }
}
async function installedResponse(url: URL) {
  const cached = await caches.match(url.pathname, { cacheName: SHELL });
  if (!cached) return new Response("Offline", { status: 503 });
  if (url.pathname !== "/") return cached;
  // Match the server's frame policy without storing a shell for every pane URL.
  const headers = new Headers(cached.headers);
  const pane = url.searchParams.get("pane") === "session";
  headers.set("x-frame-options", pane ? "SAMEORIGIN" : "DENY");
  headers.set("content-security-policy", `frame-ancestors ${pane ? "'self'" : "'none'"}`);
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}
worker.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== worker.location.origin) return;
  if (!allowed.has(url.pathname)) {
    if (url.pathname.startsWith("/assets/")) event.respondWith(previousAsset(url.pathname).then(cached => cached ?? fetch(event.request)));
    return;
  }
  // Canonical keys avoid a separate cached shell per session-pane URL or asset query string.
  const key = url.pathname;
  event.respondWith(fetch(event.request).then(response => {
    // Keep the installed HTML paired with its hashed assets. A newer online page must not poison an old shell.
    if (response.ok && key !== "/") {
      const copy = response.clone();
      event.waitUntil(caches.has(SHELL).then(async exists => {
        if (exists) await (await caches.open(SHELL)).put(key, copy);
      }));
    }
    return response;
  }).catch(() => installedResponse(url)));
});
