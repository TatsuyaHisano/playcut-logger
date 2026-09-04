/*
 * PLAYCUT LOGGER — Service Worker
 *
 * 方針: 同梱ファイルだけを precache する。外部ドメインへは一切出ない。
 * ネットワークが無い前提で作るので、precache 済みのものは cache-first。
 * cache に無い同一オリジンの GET だけ、念のためネットワークを試す。
 * 別オリジンへのリクエストは触らない（そもそもアプリは出さない）。
 */

const CACHE = "playcut-logger-v1";

/* ./ を含めるのはホーム画面から "/" で起動された場合の保険。 */
const PRECACHE = [
  "./",
  "./index.html",
  "./core.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      /* 1件でも失敗したらオフライン起動できないので、個別に入れて失敗を潰さない。 */
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  /* 別オリジンには関与しない（アプリは出さないが、拡張機能等の混入を避ける）。 */
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      /* ホーム画面起動・リロードのナビゲーションは必ず index.html を返す。 */
      if (request.mode === "navigate") {
        const shell = (await cache.match("./index.html")) || (await cache.match("./"));
        if (shell) return shell;
      }

      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;

      try {
        const fresh = await fetch(request);
        /* 同一オリジンの成功レスポンスだけ足しておく。 */
        if (fresh && fresh.ok && fresh.type === "basic") {
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    })(),
  );
});

/* 画面側から「今すぐ有効化して」と言われたとき用。 */
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
