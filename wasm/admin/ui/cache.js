// What the admin last read from its server, kept in this browser
// (IndexedDB), so it opens at once:
//
//   - the session, the posts list and files (posts, index.json) are shown
//     from here while the server is asked again (client.js, shared.js,
//     posts.js, read.js), and redrawn only if they changed;
//   - a file read again sends the etag kept here: unchanged, the Worker
//     answers 304 and nothing is downloaded.
//
// It is only a copy: the server is always asked, and writes go to it as
// before (their etags still guard against overwriting newer versions).
// Anything going wrong here (private browsing, storage full) just means
// no cache. The Storage page can clear it.

const DB_NAME = 'md4c-admin-cache';
const STORE = 'kv';
const MAX_TEXT = 4 * 1024 * 1024; // larger files are not kept
const MAX_AGE = 45 * 24 * 3600 * 1000; // entries not stored again for this long go

let opened;
function db() {
  opened ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

/** Run `fn(objectStore)` in a transaction; its request's result, or undefined on any failure. */
async function run(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const cache = {
  /** The value kept under `key`, or null. */
  async get(key) {
    const hit = await run('readonly', (s) => s.get(key));
    return hit?.value ?? null;
  },
  set(key, value) {
    return run('readwrite', (s) => s.put({ value, at: Date.now() }, key));
  },
  remove(key) {
    return run('readwrite', (s) => s.delete(key));
  },
  clear() {
    return run('readwrite', (s) => s.clear());
  },
  /** How many entries and about how many bytes are kept. */
  async size() {
    const all = await run('readonly', (s) => s.getAll()) ?? [];
    return { entries: all.length, bytes: all.reduce((n, e) => n + JSON.stringify(e.value ?? null).length, 0) };
  },
};

/* Files: { text, etag } by store and key. */
const fileKey = (store, key) => `file\n${store}\n${key}`;
export const cachedFile = (store, key) => cache.get(fileKey(store, key));
export function keepFile(store, key, text, etag) {
  if (typeof text !== 'string' || !etag || text.length > MAX_TEXT) return cache.remove(fileKey(store, key));
  return cache.set(fileKey(store, key), { text, etag });
}
export const forgetFile = (store, key) => cache.remove(fileKey(store, key));

/** Drop what has not been stored again for a while (once per page load). */
async function prune() {
  const d = await db();
  if (!d) return;
  try {
    const t = d.transaction(STORE, 'readwrite');
    const req = t.objectStore(STORE).openCursor();
    const old = Date.now() - MAX_AGE;
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!(c.value?.at > old)) c.delete();
      c.continue();
    };
  } catch {}
}
setTimeout(prune, 5000);
