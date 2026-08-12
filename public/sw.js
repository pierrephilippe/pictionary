const CACHE_NAME = "pictiofady-shell-v3";
const APP_SHELL = ["/", "/offline", "/offline.css", "/manifest.webmanifest", "/favicon.svg"];

const cacheable = (response) => response && response.ok && response.type === "basic";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))),
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

const networkFirstNavigation = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch {
    return await cache.match(request) ?? await cache.match("/") ?? await cache.match("/offline");
  }
};

const cacheFirstStaticAsset = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    // Revalidation is deliberately best-effort: when a device is offline we
    // keep serving its known-good shell without emitting an unhandled promise.
    void refresh.catch(() => undefined);
    return cached;
  }
  return refresh;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/assets/") || ["/manifest.webmanifest", "/favicon.svg", "/offline.css"].includes(url.pathname)) {
    event.respondWith(cacheFirstStaticAsset(request));
  }
});
