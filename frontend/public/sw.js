// ─── PinVid Service Worker ─────────────────────────────────────────────────
// Tier 1: Intercept Pinterest CDN requests and inject Referer/Origin headers
// so the browser can load pinimg.com media directly without server proxying.

const PINTEREST_DOMAINS = ["pinimg.com", "pinterest.com"];
const SPOOF_HEADERS = {
  Referer: "https://www.pinterest.com/",
  Origin: "https://www.pinterest.com",
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only intercept requests to Pinterest CDN domains
  const isPinterest = PINTEREST_DOMAINS.some((d) => url.hostname.endsWith(d));
  if (!isPinterest) return; // Let everything else pass through normally

  event.respondWith(
    (async () => {
      try {
        // Clone the original request's headers and add our spoofed ones
        const modifiedHeaders = new Headers(event.request.headers);
        modifiedHeaders.set("Referer", SPOOF_HEADERS.Referer);
        modifiedHeaders.set("Origin", SPOOF_HEADERS.Origin);

        const modifiedRequest = new Request(event.request.url, {
          method: event.request.method,
          headers: modifiedHeaders,
          mode: "cors",
          credentials: "omit",
          redirect: "follow",
        });

        const response = await fetch(modifiedRequest);

        // If Pinterest still blocked it (403/451), let it fall through
        // so the frontend's Tier 2/3 fallback can handle it
        if (!response.ok) {
          return response;
        }

        // Clone the response with CORS-permissive headers so the video
        // element / HLS.js can consume it
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      } catch (err) {
        // Network error — let it bubble up so frontend error handler fires
        return fetch(event.request);
      }
    })()
  );
});
