// Talks to the admin Worker's /api. Also exposes a storagesdk adapter over
// it, so the shared site build (lib/site-build.js) runs unchanged in the
// browser, writing through the Worker into R2.

import { defineAdapter, Storage, StorageError } from './vendor/storagesdk-core/adapter-kit.js';

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = data?.code;
    this.current = data?.current;
    this.assets = data?.assets;
  }
}

async function request(method, path, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(method === 'GET' ? {} : { 'x-admin-request': '1' }), ...headers },
    body,
  });
  if (res.status === 401 || (res.status === 403 && !res.headers.get('content-type')?.includes('json'))) {
    // Access session expired: reload to go through the Access login again.
    throw new ApiError(res.status, { error: 'Your Cloudflare Access session has expired. Reload the page to sign in again.', code: 'auth' });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new ApiError(res.status, data);
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const q = (o) => new URLSearchParams(o).toString();

/* ---------- Storage kept in this browser ---------- */

// "This browser only" stores live in localStorage and are mirrored into
// cookies scoped to /api, so every API request (also images loaded by
// previews) carries them. The Worker uses them per request, never saves them.
const LOCAL_KEY = 'md4c-admin-stores';
const COOKIE_PREFIX = 'md4c_stores_';
const COOKIE_CHUNK = 3500;
const MAX_CHUNKS = 6;

function syncCookies(list) {
  const attrs = `; Path=/api; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
  let value = '';
  if (list.length) {
    const bytes = new TextEncoder().encode(JSON.stringify(list));
    value = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const chunks = value.match(new RegExp(`.{1,${COOKIE_CHUNK}}`, 'g')) ?? [];
  if (chunks.length > MAX_CHUNKS) throw new Error('Too much storage is kept in this browser; remove a store or save it in KV');
  for (let i = 0; i < 12; i++) {
    document.cookie = i < chunks.length ? `${COOKIE_PREFIX}${i}=${chunks[i]}${attrs}` : `${COOKIE_PREFIX}${i}=; Max-Age=0${attrs}`;
  }
}

export const browserStores = {
  /** Store settings, with their secrets, kept in this browser. */
  all() {
    try {
      const list = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },
  save(list) {
    syncCookies(list);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  },
};

try {
  syncCookies(browserStores.all());
} catch (err) {
  console.error(err);
}

export const api = {
  session: () => request('GET', 'session'),

  /** Every post in every store: { posts: [{ store, key, status, title, date, tags, … }] }. */
  posts: () => request('GET', 'posts'),

  /** Every object under `prefix`; `.folders` = kept (possibly empty) folders. */
  async listAll(store, prefix = '') {
    const items = [];
    const folders = new Set();
    let cursor;
    do {
      const page = await request('GET', `list?${q({ store, prefix, ...(cursor ? { cursor } : {}) })}`);
      items.push(...page.items);
      for (const f of page.folders ?? []) folders.add(f);
      cursor = page.cursor;
    } while (cursor);
    items.folders = [...folders];
    return items;
  },

  /** Keep a folder ("assets/talks/"), so it exists before anything is in it. */
  createFolder: (store, prefix) => request('POST', 'folder', {
    body: JSON.stringify({ store, prefix }),
    headers: { 'content-type': 'application/json' },
  }),

  deleteFolder: (store, prefix) => request('DELETE', `folder?${q({ store, prefix })}`),

  /** Copy a draft store's attachment to the site at the same path. */
  copyToSite: (store, key, { overwrite = false, ifMatch } = {}) => request('POST', 'copy', {
    body: JSON.stringify({ from: { store, key }, overwrite, ...(ifMatch ? { ifMatch } : {}) }),
    headers: { 'content-type': 'application/json' },
  }),

  /** { text|bytes, etag } of an object. */
  async read(store, key, as = 'text') {
    const res = await request('GET', `file?${q({ store, key })}`, { raw: true });
    const etag = res.headers.get('x-object-etag') ?? '';
    return as === 'bytes'
      ? { bytes: new Uint8Array(await res.arrayBuffer()), etag }
      : { text: await res.text(), etag };
  },

  fileUrl: (store, key) => `api/file?${q({ store, key })}`,

  /** Path-style URL: relative links inside a post resolve against it. */
  rawUrl: (store, key) => new URL(`api/raw/${store}/${key.split('/').map(encodeURIComponent).join('/')}`, location.href).href,

  /** Create (etag null) or update (etag of the version being replaced).
   *  `ofPublished`: the new file is the draft of the published post at `key`. */
  write(store, key, body, etag, { ofPublished = false } = {}) {
    return request('PUT', `file?${q({ store, key, ...(ofPublished ? { ofPublished: '1' } : {}) })}`, {
      body,
      headers: etag === undefined ? {} : etag === null ? { 'if-none-match': '*' } : { 'if-match': `"${etag}"` },
    });
  },

  remove(store, key, etag) {
    return request('DELETE', `file?${q({ store, key })}`, { headers: etag ? { 'if-match': `"${etag}"` } : {} });
  },

  move(from, to, etag) {
    return request('POST', 'move', {
      body: JSON.stringify({ from, to, ...(etag ? { ifMatch: etag } : {}) }),
      headers: { 'content-type': 'application/json' },
    });
  },

  /** Copy a draft to the site with the files it uses (the draft stays).
   *  `overwrite` lists public files to replace; `siteEtag` = the public copy last seen. */
  publish(from, etag, overwrite = [], siteEtag, { skip = [], dryRun = false, postBody } = {}) {
    return request('POST', 'publish', {
      body: JSON.stringify({
        from, ...(etag ? { ifMatch: etag } : {}), ...(siteEtag ? { siteIfMatch: siteEtag } : {}), overwrite, skip, dryRun,
        ...(postBody !== undefined ? { postBody } : {}),
      }),
      headers: { 'content-type': 'application/json' },
    });
  },

  /** Draft stores: deployed ones, and the ones saved from the Storage page. */
  storage: () => request('GET', 'storage'),

  /** Save the stores kept in KV (`version` from storage()). */
  saveStorage: (version, stores) => request('PUT', 'storage', {
    body: JSON.stringify({ version, stores }),
    headers: { 'content-type': 'application/json' },
  }),

  /** Try a store; `location` is "kv" or "browser"; `check` only validates (browser). */
  testStorage: (store, location, check = false) => request('POST', 'storage/test', {
    body: JSON.stringify({ store, location, check }),
    headers: { 'content-type': 'application/json' },
  }),

  indexNow: (urls) => request('POST', 'indexnow', {
    body: JSON.stringify({ urls }),
    headers: { 'content-type': 'application/json' },
  }),
};

function toStorageError(err) {
  if (!(err instanceof ApiError)) return err;
  const code = err.status === 404 ? 'NotFound' : err.status === 409 ? 'Conflict'
    : err.status === 401 || err.status === 403 ? 'Unauthorized' : err.status === 400 ? 'InvalidArgument' : 'Provider';
  return new StorageError({ code, message: err.message, cause: err });
}

const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw toStorageError(err);
  }
};

const notSupported = (what) => async () => {
  throw new StorageError({ code: 'NotSupported', message: `${what} is not available in the admin` });
};

/** A storagesdk Storage over one store of the admin API (used by the site build). */
export function adminStorage(store) {
  const meta = (i) => ({
    path: i.key, size: i.size, contentType: i.contentType, etag: i.etag, lastModified: new Date(i.uploaded),
  });
  return new Storage({
    adapter: defineAdapter({
      name: 'admin-api',
      raw: { store },
      download: wrap(async (path) => {
        const { bytes, etag } = await api.read(store, path, 'bytes');
        return { path, size: bytes.byteLength, contentType: '', etag, lastModified: new Date(), body: bytes };
      }),
      head: wrap(async (path) => {
        const found = (await api.listAll(store, path)).find((i) => i.key === path);
        if (!found) throw new ApiError(404, { error: `${path} not found` });
        return meta(found);
      }),
      list: wrap(async (o) => {
        const items = (await api.listAll(store, o?.prefix ?? '')).map(meta);
        return { items };
      }),
      url: async (path) => api.fileUrl(store, path),
      upload: wrap(async (path, body) => {
        const info = await api.write(store, path, body);
        return meta(info);
      }),
      delete: wrap(async (path) => {
        await api.remove(store, path);
      }),
      copy: notSupported('copy'),
      move: notSupported('move'),
      uploadUrl: notSupported('uploadUrl'),
      snapshots: {
        create: notSupported('snapshots'), list: async () => [], head: notSupported('snapshots'),
        delete: notSupported('snapshots'), get: () => { throw new StorageError({ code: 'NotSupported', message: 'snapshots' }); },
      },
      forks: {
        create: notSupported('forks'), list: async () => [], head: notSupported('forks'), delete: notSupported('forks'),
        get: () => { throw new StorageError({ code: 'NotSupported', message: 'forks' }); },
        merge: notSupported('forks'), rebase: notSupported('forks'), diff: notSupported('forks'),
      },
    }),
  });
}
