/* Vyaplio service worker – hand-written (Turbopack-friendly, no build plugin).
 *
 * Offline model
 * - A "generation" cache holds one consistent build: the HTML of every app route plus every
 *   /_next/static file reachable from them (JS chunks incl. lazy ones, CSS, fonts), the manifest
 *   and icons. App data lives in IndexedDB, so a complete generation = a fully working app offline.
 * - A generation is built by crawling: fetch each route's HTML, collect /_next/static URLs, then
 *   fetch JS/CSS and collect the URLs they reference, until nothing new is found.
 * - It only becomes "current" once every file is stored (marker written last), so an interrupted
 *   download never leaves a half-cached app; the previous generation keeps serving until then.
 * - The previous generation is kept one more round, so a page still running the old build can
 *   lazily load an old chunk after an update.
 *
 * Updates (no stale-forever cache)
 * - Navigations are network-first (4 s timeout when a cached copy exists). When an online
 *   navigation's HTML references a different set of assets than the cached generation, a new
 *   generation is built in the background. A periodic check (at most every 30 min) covers the rest.
 * - Changing this file (SW_VERSION) installs a new worker; its install builds a fresh generation
 *   first and fails (keeping the old worker) if that is not possible.
 */
const SW_VERSION = "21";
const META = "dm-meta";
const GEN_PREFIX = "dm-gen-";
const STATE_KEY = "/__dm/state";
const MANIFEST_KEY = "/__dm/manifest";
const ROUTES = ["/", "/login", "/pricing", "/restore", "/setup", "/firstweek", "/sale", "/sales", "/stock", "/udhaar", "/galla", "/closeout", "/hisaab", "/suppliers", "/purchase", "/order", "/orders", "/orders/new", "/customer", "/basket", "/alerts", "/more"];
const EXTRAS = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
const OPTIONAL = ["/favicon.ico"];
const CHECK_EVERY_MS = 30 * 60 * 1000;
const NAV_TIMEOUT_MS = 4000;
const ASSET_RE = /(?:\/_next\/)?static\/(?:chunks|media|css)\/[A-Za-z0-9_.~%-]+\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico|wasm|json)/g;
const FILE_RE = /\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico)$/;
const CSS_URL_RE = /url\(\s*["']?([^"')\s]+)["']?\s*\)/g;

const abs = (p) => new URL(p, self.location.origin).href;
const toAsset = (m) => (m.startsWith("/") ? m : "/_next/" + m);

function extractAssets(text, baseUrl) {
  const out = new Set();
  for (const m of text.match(ASSET_RE) || []) out.add(toAsset(m));
  if (baseUrl && baseUrl.endsWith(".css")) {
    for (const m of text.matchAll(CSS_URL_RE)) {
      const ref = m[1];
      if (ref.startsWith("data:") || /^[a-z]+:/i.test(ref)) continue;
      const u = new URL(ref, baseUrl);
      if (u.origin === self.location.origin && u.pathname.startsWith("/_next/static/") && FILE_RE.test(u.pathname)) out.add(u.pathname);
    }
  }
  return out;
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJSON(cacheName, key) {
  const c = await caches.open(cacheName);
  const r = await c.match(abs(key));
  return r ? r.json() : null;
}
const writeJSON = async (cacheName, key, value) =>
  (await caches.open(cacheName)).put(abs(key), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));

let stateMem = null;
async function getState() {
  if (!stateMem) stateMem = (await readJSON(META, STATE_KEY)) || {};
  return stateMem;
}
async function setState(patch) {
  stateMem = { ...(await getState()), ...patch };
  await writeJSON(META, STATE_KEY, stateMem);
}

async function fetchOk(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

/** Fetch route HTML and work out the build fingerprint (the set of assets the routes reference). */
async function readRoutes() {
  const pages = {};
  const routeAssets = {};
  await pool(ROUTES, 4, async (r) => {
    const res = await fetchOk(abs(r));
    const html = await res.text();
    if (!/<html/i.test(html)) throw new Error(`${r} is not HTML`);
    pages[r] = html;
    routeAssets[r] = [...extractAssets(html, abs(r))].sort();
  });
  const fp = await sha(SW_VERSION + "|" + ROUTES.map((r) => r + ":" + routeAssets[r].join(",")).join("|"));
  return { pages, routeAssets, fp };
}

let building = null;
/** Build (or confirm) a complete generation. Resolves to the current generation name. */
function ensureGeneration() {
  if (!building) building = buildGeneration().finally(() => (building = null));
  return building;
}

async function buildGeneration() {
  await broadcast({ updating: true });
  const { pages, routeAssets, fp } = await readRoutes();
  const name = GEN_PREFIX + fp;
  const state = await getState();
  if (state.current === name && (await isComplete(name))) {
    await setState({ checkedAt: Date.now() });
    return name;
  }
  await caches.delete(name); // start clean if an earlier attempt for this build was interrupted
  const cache = await caches.open(name);
  const html = { "Content-Type": "text/html; charset=utf-8" };
  await Promise.all(ROUTES.map((r) => cache.put(abs(r), new Response(pages[r], { headers: html }))));

  const seen = new Set();
  const queue = [];
  const required = new Set(Object.values(routeAssets).flat());
  const skipped = new Set();
  const add = (u) => {
    if (!seen.has(u)) {
      seen.add(u);
      queue.push(u);
    }
  };
  Object.values(routeAssets).forEach((list) => list.forEach(add));
  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    await pool(batch, 6, async (path) => {
      const url = abs(path);
      // Hashed files are immutable: reuse a copy from any earlier generation.
      let res = await caches.match(url);
      if (!res) {
        try {
          res = await fetchOk(url);
        } catch (e) {
          // Referenced straight from a page: must be stored. Found inside JS/CSS text: may be a
          // false match of the URL pattern, so a 404 there is skipped (a real lazy chunk is never 404).
          if (required.has(path) || !/ -> 404$/.test(e.message)) throw e;
          skipped.add(path);
          return;
        }
      }
      if (/\.(js|css)$/.test(path)) {
        const text = await res.clone().text();
        extractAssets(text, url).forEach(add);
      }
      await cache.put(url, res);
    });
  }
  await pool(EXTRAS, 4, async (p) => cache.put(abs(p), await fetchOk(abs(p))));
  await pool(OPTIONAL, 2, async (p) => {
    try {
      await cache.put(abs(p), await fetchOk(abs(p)));
    } catch {
      /* optional */
    }
  });
  // Marker last: a generation without it is never served as current.
  await writeJSON(name, MANIFEST_KEY, { fp, sw: SW_VERSION, routes: routeAssets, files: seen.size - skipped.size, at: Date.now() });
  const previous = state.current && state.current !== name ? state.current : state.previous;
  await setState({ current: name, previous, checkedAt: Date.now() });
  await cleanup();
  return name;
}

async function isComplete(name) {
  if (!(await caches.has(name))) return false;
  return Boolean(await (await caches.open(name)).match(abs(MANIFEST_KEY)));
}

async function cleanup() {
  const { current, previous } = await getState();
  const keep = new Set([META, current, previous].filter(Boolean));
  for (const k of await caches.keys()) if (!keep.has(k) && (k.startsWith("dm-") || k.startsWith(GEN_PREFIX))) await caches.delete(k);
}

async function statusPayload() {
  const { current } = await getState();
  const ready = Boolean(current) && (await isComplete(current));
  return { type: "dm-sw-status", ready, updating: Boolean(building), version: SW_VERSION, generation: current || null };
}
async function broadcast(extra = {}) {
  const msg = { ...(await statusPayload()), ...extra };
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

async function maybeUpdate(force) {
  const { checkedAt = 0 } = await getState();
  if (!force && Date.now() - checkedAt < CHECK_EVERY_MS) return;
  try {
    await ensureGeneration();
  } catch {
    /* offline / server down: keep serving the current generation */
  }
  await broadcast();
}

self.addEventListener("install", (event) => {
  // Fails install (old worker keeps control) unless a full generation could be stored.
  event.waitUntil(ensureGeneration().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      stateMem = null;
      await cleanup();
      await self.clients.claim();
      await broadcast();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "status" || data.type === "check") {
    event.waitUntil(
      (async () => {
        if (event.source) event.source.postMessage(await statusPayload());
        if (data.type === "check") await maybeUpdate(Boolean(data.force));
      })(),
    );
  }
});

const isRsc = (req, url) =>
  url.searchParams.has("_rsc") || req.headers.get("RSC") === "1" || req.headers.has("Next-Router-State-Tree") || req.headers.has("Next-Router-Prefetch");

function routeKey(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES.includes(p) ? p : null;
}

async function cachedRoute(key) {
  const { current, previous } = await getState();
  for (const name of [current, previous]) {
    if (name && (await caches.has(name))) {
      const hit = await (await caches.open(name)).match(abs(key));
      if (hit) return hit;
    }
  }
  return null;
}

const OFFLINE_HTML = `<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vyaplio</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5ecd7;color:#1f1a14;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px}a{display:inline-block;margin-top:16px;padding:14px 28px;border-radius:16px;background:#0e5a5e;color:#f5ecd7;font-weight:700;text-decoration:none}</style></head>
<body><div><p><b>इंटरनेट नहीं है — यह पेज इस फ़ोन में सेव नहीं है।</b><br>No internet — this page is not saved on this phone.</p><a href="/">दुकान खोलें · Open shop</a></div></body></html>`;

async function handleNavigate(event, url) {
  const key = routeKey(url.pathname);
  const cached = key ? await cachedRoute(key) : null;
  const network = fetch(event.request).then((res) => {
    if (res.ok && key) {
      // Online visit: if this HTML references a different build than the cache, refresh the cache.
      event.waitUntil(
        res
          .clone()
          .text()
          .then(async (html) => {
            const { current } = await getState();
            const man = current ? await readJSON(current, MANIFEST_KEY).catch(() => null) : null;
            const now = [...extractAssets(html, url.href)].sort().join(",");
            const was = man && man.routes && man.routes[key] ? man.routes[key].join(",") : null;
            await maybeUpdate(was !== now);
          })
          .catch(() => {}),
      );
    }
    return res;
  });
  if (!cached) {
    // Nothing cached for this URL (unknown route, or the first download has not finished yet).
    return network.catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch {
    /* offline */
  }
  network.catch(() => {});
  return cached;
}

const isCacheFirst = (url) =>
  url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || /\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico)$/.test(url.pathname);

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const { current } = await getState();
    if (current) (await caches.open(current)).put(req.url.split("?")[0], res.clone()).catch(() => {});
  }
  return res;
}

async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === "/sw.js" || url.pathname.startsWith("/__dm/")) return;
  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(event, url));
    return;
  }
  // Router payloads always go to the network; when offline the router falls back to a full page load.
  if (isRsc(req, url)) return;
  event.respondWith(isCacheFirst(url) ? cacheFirst(req) : networkFirst(req));
});
