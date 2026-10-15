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

export const api = {
  session: () => request('GET', 'session'),

  /** Every post in every store: { posts: [{ store, key, status, title, date, tags, … }] }. */
  posts: () => request('GET', 'posts'),

  async listAll(store, prefix = '') {
    const items = [];
    let cursor;
    do {
      const page = await request('GET', `list?${q({ store, prefix, ...(cursor ? { cursor } : {}) })}`);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return items;
  },

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

  /** Create (etag null) or update (etag of the version being replaced). */
  write(store, key, body, etag) {
    return request('PUT', `file?${q({ store, key })}`, {
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

  /** Publish a draft with the files it uses; `overwrite` lists public files to replace. */
  publish(from, etag, overwrite = []) {
    return request('POST', 'publish', {
      body: JSON.stringify({ from, ...(etag ? { ifMatch: etag } : {}), overwrite }),
      headers: { 'content-type': 'application/json' },
    });
  },

  /** Draft stores: deployed ones, and the ones saved from the Storage page. */
  storage: () => request('GET', 'storage'),

  saveStorage: (etag, stores) => request('PUT', 'storage', {
    body: JSON.stringify({ etag, stores }),
    headers: { 'content-type': 'application/json' },
  }),

  testStorage: (store) => request('POST', 'storage/test', {
    body: JSON.stringify({ store }),
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
