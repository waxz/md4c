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

  async listAll(bucket, prefix = '') {
    const items = [];
    let cursor;
    do {
      const page = await request('GET', `list?${q({ bucket, prefix, ...(cursor ? { cursor } : {}) })}`);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return items;
  },

  /** { text|bytes, etag } of an object. */
  async read(bucket, key, as = 'text') {
    const res = await request('GET', `file?${q({ bucket, key })}`, { raw: true });
    const etag = res.headers.get('x-object-etag') ?? '';
    return as === 'bytes'
      ? { bytes: new Uint8Array(await res.arrayBuffer()), etag }
      : { text: await res.text(), etag };
  },

  fileUrl: (bucket, key) => `api/file?${q({ bucket, key })}`,

  /** Create (etag null) or update (etag of the version being replaced). */
  write(bucket, key, body, etag) {
    return request('PUT', `file?${q({ bucket, key })}`, {
      body,
      headers: etag === undefined ? {} : etag === null ? { 'if-none-match': '*' } : { 'if-match': `"${etag}"` },
    });
  },

  remove(bucket, key, etag) {
    return request('DELETE', `file?${q({ bucket, key })}`, { headers: etag ? { 'if-match': `"${etag}"` } : {} });
  },

  move(from, to, etag) {
    return request('POST', 'move', {
      body: JSON.stringify({ from, to, ...(etag ? { ifMatch: etag } : {}) }),
      headers: { 'content-type': 'application/json' },
    });
  },

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

/** A storagesdk Storage over one bucket of the admin API (used by the site build). */
export function adminStorage(bucket) {
  const meta = (i) => ({
    path: i.key, size: i.size, contentType: i.contentType, etag: i.etag, lastModified: new Date(i.uploaded),
  });
  return new Storage({
    adapter: defineAdapter({
      name: 'admin-api',
      raw: { bucket },
      download: wrap(async (path) => {
        const { bytes, etag } = await api.read(bucket, path, 'bytes');
        return { path, size: bytes.byteLength, contentType: '', etag, lastModified: new Date(), body: bytes };
      }),
      head: wrap(async (path) => {
        const found = (await api.listAll(bucket, path)).find((i) => i.key === path);
        if (!found) throw new ApiError(404, { error: `${path} not found` });
        return meta(found);
      }),
      list: wrap(async (o) => {
        const items = (await api.listAll(bucket, o?.prefix ?? '')).map(meta);
        return { items };
      }),
      url: async (path) => api.fileUrl(bucket, path),
      upload: wrap(async (path, body) => {
        const info = await api.write(bucket, path, body);
        return meta(info);
      }),
      delete: wrap(async (path) => {
        await api.remove(bucket, path);
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
