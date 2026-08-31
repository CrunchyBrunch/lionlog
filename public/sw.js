const CACHE_PREFIX = "lionlog-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v0.2.0-alpha.2`;
const SCOPE_URL = new URL("./", self.registration.scope).href;
const APPLICATION_DOCUMENT_MARKER = 'data-lionlog-shell="v0.2.0-alpha.2"';
const CORE_ASSETS = [
  SCOPE_URL,
  new URL("./manifest.webmanifest", self.registration.scope).href,
  new URL("./icons/icon-192.png", self.registration.scope).href,
  new URL("./icons/icon-512.png", self.registration.scope).href,
  new URL("./icons/apple-touch-icon.png", self.registration.scope).href,
];

async function isExpectedApplicationDocument(response) {
  if (!response.ok || response.redirected || response.type === "opaqueredirect") return false;

  const responseUrl = new URL(response.url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (responseUrl.origin !== self.location.origin || !contentType.includes("text/html")) return false;

  return (await response.clone().text()).includes(APPLICATION_DOCUMENT_MARKER);
}

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const shellResponse = await fetch(SCOPE_URL, { cache: "reload" });

  if (!(await isExpectedApplicationDocument(shellResponse))) {
    throw new Error("LionLog application shell was unavailable or unverified.");
  }

  await cache.put(SCOPE_URL, shellResponse.clone());
  const html = await shellResponse.text();
  const assetUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], SCOPE_URL))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => url.href);

  await Promise.allSettled(
    [...new Set([...CORE_ASSETS.slice(1), ...assetUrls])].map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (response.ok) await cache.put(url, response);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheApplicationShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (!response.ok) return (await caches.match(SCOPE_URL)) ?? response;

        if (await isExpectedApplicationDocument(response)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(SCOPE_URL, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(SCOPE_URL)) ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
