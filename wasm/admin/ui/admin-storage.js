// A storagesdk Storage over one store of the admin API, so the shared site
// build (lib/site-build.js) runs unchanged in the browser, writing through
// the Worker into R2. Loaded only when the site is rebuilt.

import { defineAdapter, Storage, StorageError } from './vendor/storagesdk-core/adapter-kit.js';
import { api, ApiError } from './client.js';

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
