// A storagesdk adapter backed by the browser's IndexedDB.
//
// storagesdk ships adapters for cloud object stores (S3, R2, GCS, ...) and a
// Node-only `fs` adapter. None of them can keep files *inside* a browser, so
// this module provides one. It implements the full storagesdk `Adapter`
// contract, including snapshots and forks:
//
//   import { Storage } from '@storagesdk/core';
//   import { indexedDbAdapter } from './idb-adapter.js';
//   const storage = new Storage({ adapter: indexedDbAdapter({ name: 'blog' }) });
//
// Layout: one IndexedDB database with three object stores.
//   objects    key [ns, path]   -> { ns, path, body, contentType, etag, ... }
//   snapshots  key [ns, id]     -> SnapshotInfo + { ns }
//   forks      key [ns, name]   -> ForkInfo + { ns }
// `ns` is a namespace string: "live" for the root, "<parent>@<snapId>" for a
// snapshot's frozen copy, and "<parent>/<forkName>" for a fork.

import {
  bodyToBytes,
  defaultDiff,
  defaultMerge,
  defaultRebase,
  defineAdapter,
  StorageError,
} from '@storagesdk/core/adapter';

const DB_VERSION = 1;
const ROOT_NS = 'live';
const MAX_KEY_CHAR = '￿';

function notFound(message) {
  return new StorageError({ code: 'NotFound', message });
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function openDb(name, idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('objects', { keyPath: ['ns', 'path'] });
      db.createObjectStore('snapshots', { keyPath: ['ns', 'id'] });
      db.createObjectStore('forks', { keyPath: ['ns', 'name'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn(stores)` in one transaction and resolve with its return value. */
async function withTx(dbPromise, storeNames, mode, fn) {
  const db = await dbPromise;
  const tx = db.transaction(storeNames, mode);
  const stores = Object.fromEntries(
    storeNames.map((n) => [n, tx.objectStore(n)])
  );
  const result = await fn(stores);
  await txDone(tx);
  return result;
}

/** All records in `store` whose key starts with [ns, prefix]. */
function rangeFor(ns, prefix = '') {
  return IDBKeyRange.bound([ns, prefix], [ns, prefix + MAX_KEY_CHAR]);
}

/** Cheap deterministic hash for etags. Not cryptographic. */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

let idCounter = 0;
function nextSnapshotId() {
  idCounter += 1;
  return `snap-${Date.now().toString(36)}-${idCounter}`;
}

function toMeta(rec) {
  const meta = {
    path: rec.path,
    size: rec.body.byteLength,
    contentType: rec.contentType,
    etag: rec.etag,
    lastModified: new Date(rec.lastModified),
  };
  if (rec.metadata !== undefined) meta.metadata = rec.metadata;
  return meta;
}

function toItem(rec, range) {
  let body = new Uint8Array(rec.body);
  if (range) body = body.slice(range.offset, range.offset + range.length);
  return { ...toMeta(rec), body };
}

function stripNs({ ns: _ns, ...info }) {
  return info;
}

/** Copy every object from namespace `from` into namespace `to`. */
async function copyNamespace(dbPromise, from, to) {
  await withTx(dbPromise, ['objects'], 'readwrite', async ({ objects }) => {
    const recs = await promisify(objects.getAll(rangeFor(from)));
    for (const rec of recs) objects.put({ ...rec, ns: to });
  });
}

/** Delete a namespace and everything nested under it (its forks/snapshots). */
async function dropNamespace(dbPromise, ns) {
  await withTx(
    dbPromise,
    ['objects', 'snapshots', 'forks'],
    'readwrite',
    async (stores) => {
      for (const store of Object.values(stores)) {
        // Exact namespace, plus nested "<ns>/..." and "<ns>@..." ones.
        store.delete(IDBKeyRange.bound([ns], [ns, []]));
        store.delete(IDBKeyRange.bound([`${ns}/`], [`${ns}/${MAX_KEY_CHAR}`]));
        store.delete(IDBKeyRange.bound([`${ns}@`], [`${ns}@${MAX_KEY_CHAR}`]));
      }
    }
  );
}

async function getRecord(dbPromise, ns, path) {
  return withTx(dbPromise, ['objects'], 'readonly', ({ objects }) =>
    promisify(objects.get([ns, path]))
  );
}

async function listNs(dbPromise, ns, opts = {}) {
  const prefix = opts.prefix ?? '';
  const limit = opts.limit ?? 1000;
  const cursor = opts.cursor;
  const lower = cursor !== undefined && cursor > prefix ? cursor : prefix;
  const range = IDBKeyRange.bound(
    [ns, lower],
    [ns, prefix + MAX_KEY_CHAR],
    cursor !== undefined && cursor >= prefix,
    false
  );
  const recs = await withTx(dbPromise, ['objects'], 'readonly', ({ objects }) =>
    promisify(objects.getAll(range, limit + 1))
  );
  const page = recs.slice(0, limit).map(toMeta);
  return recs.length > limit
    ? { items: page, cursor: page[page.length - 1].path }
    : { items: page };
}

function blobUrl(rec) {
  return URL.createObjectURL(
    new Blob([rec.body], { type: rec.contentType })
  );
}

function reader(dbPromise, ns, label) {
  return {
    async download(path, opts) {
      const rec = await getRecord(dbPromise, ns, path);
      if (!rec) throw notFound(`${path} not found${label}`);
      return toItem(rec, opts?.range);
    },
    async head(path) {
      const rec = await getRecord(dbPromise, ns, path);
      if (!rec) throw notFound(`${path} not found${label}`);
      return toMeta(rec);
    },
    list: (opts) => listNs(dbPromise, ns, opts),
    async url(path) {
      const rec = await getRecord(dbPromise, ns, path);
      if (!rec) throw notFound(`${path} not found${label}`);
      return blobUrl(rec);
    },
  };
}

function createImpl(dbPromise, ns, dbName) {
  const adapter = {
    name: 'indexeddb',
    raw: { dbName, namespace: ns, db: dbPromise },

    ...reader(dbPromise, ns, ''),

    async upload(path, body, opts) {
      const bytes = await bodyToBytes(body);
      const rec = {
        ns,
        path,
        body: bytes,
        contentType: opts?.contentType ?? 'application/octet-stream',
        etag: fnv1a(bytes),
        lastModified: Date.now(),
      };
      if (opts?.metadata !== undefined) rec.metadata = { ...opts.metadata };
      await withTx(dbPromise, ['objects'], 'readwrite', ({ objects }) =>
        objects.put(rec)
      );
      return toMeta(rec);
    },

    async delete(path) {
      await withTx(dbPromise, ['objects'], 'readwrite', ({ objects }) =>
        objects.delete([ns, path])
      );
    },

    async copy(from, to) {
      await withTx(dbPromise, ['objects'], 'readwrite', async ({ objects }) => {
        const rec = await promisify(objects.get([ns, from]));
        if (!rec) throw notFound(`${from} not found`);
        objects.put({ ...rec, path: to, lastModified: Date.now() });
      });
    },

    async move(from, to) {
      await withTx(dbPromise, ['objects'], 'readwrite', async ({ objects }) => {
        const rec = await promisify(objects.get([ns, from]));
        if (!rec) throw notFound(`${from} not found`);
        objects.put({ ...rec, path: to, lastModified: Date.now() });
        if (from !== to) objects.delete([ns, from]);
      });
    },

    async uploadUrl() {
      throw new StorageError({
        code: 'NotSupported',
        message: 'indexeddb adapter has no upload URLs; call upload() instead',
      });
    },

    snapshots: {
      async create(opts) {
        const id = nextSnapshotId();
        const info = { id, createdAt: new Date() };
        if (opts?.name !== undefined) info.name = opts.name;
        await copyNamespace(dbPromise, ns, `${ns}@${id}`);
        await withTx(dbPromise, ['snapshots'], 'readwrite', ({ snapshots }) =>
          snapshots.put({ ...info, ns })
        );
        return info;
      },
      async list() {
        const recs = await withTx(
          dbPromise,
          ['snapshots'],
          'readonly',
          ({ snapshots }) => promisify(snapshots.getAll(rangeFor(ns)))
        );
        return recs.map(stripNs);
      },
      async head(id) {
        const rec = await withTx(
          dbPromise,
          ['snapshots'],
          'readonly',
          ({ snapshots }) => promisify(snapshots.get([ns, id]))
        );
        if (!rec) throw notFound(`snapshot ${id} not found`);
        return stripNs(rec);
      },
      async delete(id) {
        await withTx(dbPromise, ['snapshots'], 'readwrite', ({ snapshots }) =>
          snapshots.delete([ns, id])
        );
        await dropNamespace(dbPromise, `${ns}@${id}`);
      },
      get(id) {
        // Unknown ids surface as NotFound on first read.
        return reader(dbPromise, `${ns}@${id}`, ` in snapshot ${id}`);
      },
    },

    forks: {
      async create(opts) {
        const existing = await withTx(
          dbPromise,
          ['forks'],
          'readonly',
          ({ forks }) => promisify(forks.get([ns, opts.name]))
        );
        if (existing) {
          throw new StorageError({
            code: 'Conflict',
            message: `fork ${opts.name} already exists`,
          });
        }
        const source =
          opts.fromSnapshot !== undefined ? `${ns}@${opts.fromSnapshot}` : ns;
        if (opts.fromSnapshot !== undefined) await adapter.snapshots.head(opts.fromSnapshot);
        await copyNamespace(dbPromise, source, `${ns}/${opts.name}`);
        const info = { name: opts.name, createdAt: new Date() };
        if (opts.fromSnapshot !== undefined) info.fromSnapshot = opts.fromSnapshot;
        await withTx(dbPromise, ['forks'], 'readwrite', ({ forks }) =>
          forks.put({ ...info, ns })
        );
        return info;
      },
      async list() {
        const recs = await withTx(dbPromise, ['forks'], 'readonly', ({ forks }) =>
          promisify(forks.getAll(rangeFor(ns)))
        );
        return recs.map(stripNs);
      },
      async head(name) {
        const rec = await withTx(dbPromise, ['forks'], 'readonly', ({ forks }) =>
          promisify(forks.get([ns, name]))
        );
        if (!rec) throw notFound(`fork ${name} not found`);
        return stripNs(rec);
      },
      async delete(name) {
        await withTx(dbPromise, ['forks'], 'readwrite', ({ forks }) =>
          forks.delete([ns, name])
        );
        await dropNamespace(dbPromise, `${ns}/${name}`);
      },
      get(name) {
        return createImpl(dbPromise, `${ns}/${name}`, dbName);
      },
      merge: (name, opts) => defaultMerge(adapter, name, opts),
      rebase: (name, opts) => defaultRebase(adapter, name, opts),
      diff: (name, opts) => defaultDiff(adapter, name, opts),
    },
  };
  return adapter;
}

/**
 * Create a storagesdk adapter that persists objects in IndexedDB.
 *
 * @param {{ name?: string, indexedDB?: IDBFactory }} [opts]
 *        `name` is the IndexedDB database name (default "storagesdk").
 *        `indexedDB` overrides the global factory (useful for tests).
 */
export function indexedDbAdapter(opts = {}) {
  const dbName = opts.name ?? 'storagesdk';
  const idb = opts.indexedDB ?? globalThis.indexedDB;
  if (!idb) {
    throw new StorageError({
      code: 'NotSupported',
      message: 'IndexedDB is not available in this environment',
    });
  }
  return defineAdapter(createImpl(openDb(dbName, idb), ROOT_NS, dbName));
}
