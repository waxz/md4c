// The admin's service worker. Two jobs:
//
// 1. Files kept in "This browser" (local-store.js, IndexedDB) are served at
//    local-files/<key>, so previews and the file view load them like any
//    other file. A file not there falls back to the published site's copy,
//    as the Worker's /api/raw does for other draft stores.
//
// 2. The admin keeps working when Cloudflare Access signs it out (or the
//    network is gone): the app's own files are cached (precached from
//    offline.json, written by scripts/assemble-blog.mjs), and served from
//    the cache when the network answers with Access's login redirect. Drafts
//    in "This browser" can then still be opened, written and saved. The API
//    is never cached. "?signin" in the address skips the cache once, to go
//    through the Access login again.

const BUILD = '__BUILD__'; // replaced at assemble time, so each deploy installs anew
const CACHE = `md4c-admin-${BUILD}`;
const DB_NAME = 'md4c-admin-local'; // as local-store.js
const scope = new URL(self.registration.scope);
const INDEX = new URL('./', scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch(new URL('offline.json', scope), { cache: 'no-store' });
      const list = res.ok ? await res.json() : [];
      const cache = await caches.open(CACHE);
      await Promise.all([INDEX, ...list].map(async (path) => {
        const url = new URL(path, scope).href;
        const r = await fetch(url, { cache: 'no-cache' }).catch(() => null);
        if (r?.ok && r.type === 'basic' && !signedOut(r)) await cache.put(url, clean(r));
      }));
    } catch (err) {
      console.warn('admin offline cache:', err);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('md4c-admin-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || req.method !== 'GET' || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (path.startsWith('local-files/')) {
    event.respondWith(localFile(path.slice('local-files/'.length)));
    return;
  }
  if (path === 'api' || path.startsWith('api/') || path === 'sw.js') return; // always the network
  event.respondWith(appFile(req, url));
});

/* ---------- 1. Files kept in this browser ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'key' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function readLocal(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction('files').objectStore('files').get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

async function localFile(encoded) {
  let key;
  try {
    key = encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return new Response('Bad path', { status: 400 });
  }
  const rec = await readLocal(key).catch(() => null);
  if (rec) {
    const type = rec.contentType || 'application/octet-stream';
    return new Response(rec.blob, {
      headers: {
        // As the Worker does: HTML and XML are shown as text, and nothing
        // stored here can run in the admin's origin.
        'content-type': /^(text\/html|application\/xml)/.test(type) ? 'text/plain; charset=utf-8' : type,
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        etag: `"${rec.etag}"`,
      },
    });
  }
  // Not in this browser: the published copy (an image the post shares).
  return fetch(new URL(`api/raw/site/${encoded}`, scope)).catch(() => new Response('Not found', { status: 404 }));
}

/* ---------- 2. The app, also when signed out ---------- */

// Access answers a signed-out request with a redirect to its login page,
// on another origin. (Redirects within the admin are fine: Cloudflare's
// static files send /preview.html on to /preview.)
const signedOut = (res) => res.type === 'opaque' || res.type === 'opaqueredirect'
  || (res.redirected && new URL(res.url).origin !== scope.origin);

/**
 * A response without its "redirected" mark. A page the service worker
 * answers with a redirected response is refused by the browser (a blank
 * frame), so redirects are followed here and the result handed on as new.
 */
function clean(res) {
  return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

async function appFile(req, url) {
  const navigate = req.mode === 'navigate';
  if (url.searchParams.has('signin')) return fetch(req); // through the Access login
  // Pages are kept under their path; files under their full (versioned) URL.
  const key = navigate ? new URL(url.pathname, url).href : url.href;
  const cache = await caches.open(CACHE);
  try {
    // A page load is fetched following redirects (a navigation request
    // would hand back an unusable "opaque redirect"); a redirect to the
    // Access login on another origin then fails, and the cache answers.
    const res = navigate
      ? await fetch(url.href, { credentials: 'same-origin', redirect: 'follow', cache: 'no-cache' })
      : await fetch(req);
    if (signedOut(res)) throw new Error('signed out');
    const answer = clean(res);
    if (answer.ok && res.type === 'basic') cache.put(key, answer.clone()).catch(() => {});
    return answer;
  } catch {
    const hit = await cache.match(key) ?? (navigate ? await cache.match(INDEX) : null);
    if (hit) return hit;
    return navigate
      ? Response.redirect(new URL('./?signin', scope).href, 302)
      : new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}
