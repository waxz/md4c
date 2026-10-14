// Storage the admin can read and write ("stores"):
//
//   site            the public blog bucket (R2 binding SITE)
//   draft stores    one or more private stores for drafts and their images:
//                   R2 buckets (bindings) or any storagesdk adapter, e.g. a
//                   WebDAV share on a NAS or Nextcloud
//
// Draft stores are configured with DRAFT_STORES (JSON). Credentials never
// go in it; it names Worker secrets instead:
//
//   DRAFT_STORES = '''[
//     { "id": "drafts", "label": "Drafts (R2)", "type": "r2", "binding": "DRAFTS" },
//     { "id": "nas", "label": "Home NAS", "type": "webdav",
//       "baseUrl": "https://dav.example.com/remote.php/dav/files/me",
//       "root": "/blog", "folder": "drafts",
//       "username": "me", "passwordSecret": "NAS_PASSWORD" }
//   ]'''
//   npx wrangler secret put NAS_PASSWORD
//
// Without DRAFT_STORES, a DRAFTS binding (if any) is the one draft store.
//
// Every store has the same small interface (keys are "posts/a.md" etc.):
//   head(key)                     -> Meta | null
//   get(key)                      -> { meta, body: ArrayBuffer } | null
//   put(key, body, { contentType, cacheControl, ifMatch })
//                                 -> Meta, or null when ifMatch no longer matches
//   delete(key)
//   list(prefix, cursor)          -> { items: Meta[], cursor? }
// with Meta = { key, size, etag, uploaded: Date, contentType }.

import { Storage, StorageError } from '@storagesdk/core';

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

export class StoreConfigError extends Error {}

/** A store over a Workers R2 binding; conditional writes are native. */
export function r2Store(bucket) {
  const meta = (o) => ({
    key: o.key,
    size: o.size,
    etag: o.etag,
    uploaded: o.uploaded,
    contentType: o.httpMetadata?.contentType ?? '',
  });
  return {
    async head(key) {
      const o = await bucket.head(key);
      return o ? meta(o) : null;
    },
    async get(key) {
      const o = await bucket.get(key);
      return o ? { meta: meta(o), body: await o.arrayBuffer() } : null;
    },
    async put(key, body, { contentType, cacheControl, ifMatch } = {}) {
      const o = await bucket.put(key, body, {
        httpMetadata: { contentType, ...(cacheControl ? { cacheControl } : {}) },
        ...(ifMatch ? { onlyIf: { etagMatches: ifMatch } } : {}),
      });
      return o ? meta(o) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix = '', cursor) {
      const page = await bucket.list({ prefix, cursor, limit: 1000, include: ['httpMetadata'] });
      return { items: page.objects.map(meta), ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) };
    },
  };
}

/**
 * A store over any storagesdk Storage (WebDAV, S3, ...). storagesdk has no
 * conditional write, so ifMatch is checked just before writing: safe for one
 * admin, not a lock between simultaneous writers.
 *
 * `isFile(key)` (optional) tells files from folders where the backend has
 * real folders: storagesdk's head() also succeeds for a WebDAV collection.
 */
export function storagesdkStore(storage, { isFile } = {}) {
  const meta = (m) => ({
    key: m.path,
    size: m.size,
    etag: m.etag,
    uploaded: m.lastModified,
    contentType: m.contentType ?? '',
  });
  const notFound = (err) => err instanceof StorageError && (err.code === 'NotFound' || err.code === 'InvalidArgument');
  const head = async (key) => {
    try {
      const m = meta(await storage.head(key));
      return isFile && !(await isFile(key)) ? null : m;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  };
  return {
    head,
    async get(key) {
      try {
        const item = await storage.download(key);
        const m = await head(key); // download's etag may differ from head's
        return { meta: m ?? meta(item), body: item.body.buffer.slice(item.body.byteOffset, item.body.byteOffset + item.body.byteLength) };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async put(key, body, { contentType, cacheControl, ifMatch } = {}) {
      if (ifMatch) {
        const current = await head(key);
        if (!current || current.etag !== ifMatch) return null;
      }
      await storage.upload(key, new Uint8Array(body), { contentType, ...(cacheControl ? { cacheControl } : {}) });
      // Report the etag head() will report later (an upload's may differ).
      return head(key);
    },
    async delete(key) {
      await storage.delete(key).catch((err) => {
        if (!notFound(err)) throw err;
      });
    },
    async list(prefix = '', cursor) {
      const page = await storage.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      return { items: page.items.map(meta), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  };
}

async function openOne(cfg, env) {
  if (!cfg || typeof cfg !== 'object') throw new StoreConfigError('each draft store must be an object');
  if (!ID_RE.test(cfg.id ?? '') || cfg.id === 'site') {
    throw new StoreConfigError(`draft store id "${cfg.id}" must be lowercase letters, digits and dashes, and not "site"`);
  }
  const secret = (name) => {
    if (!name) return undefined;
    const v = env[name];
    if (typeof v !== 'string' || !v) throw new StoreConfigError(`secret ${name} (for draft store "${cfg.id}") is not set`);
    return v;
  };
  if (cfg.type === 'r2') {
    const binding = env[cfg.binding];
    if (!binding?.put) throw new StoreConfigError(`R2 binding ${cfg.binding} (for draft store "${cfg.id}") is missing`);
    return r2Store(binding);
  }
  if (cfg.type === 'webdav') {
    if (!/^https?:\/\//.test(cfg.baseUrl ?? '')) throw new StoreConfigError(`draft store "${cfg.id}": baseUrl must be http(s)`);
    const { webdav } = await import('@storagesdk/adapters/webdav');
    const root = cfg.root ?? '/';
    const folder = cfg.folder ?? 'blog-drafts';
    const storage = new Storage({
      adapter: webdav({
        baseUrl: cfg.baseUrl,
        root,
        folder,
        ...(cfg.username ? { username: cfg.username } : {}),
        ...(cfg.passwordSecret ? { password: secret(cfg.passwordSecret) } : {}),
        ...(cfg.tokenSecret ? { token: secret(cfg.tokenSecret) } : {}),
      }),
    });
    const prefix = `/${`${root}/${folder}`.split('/').filter(Boolean).join('/')}`;
    return storagesdkStore(storage, {
      isFile: async (key) => (await storage.raw.stat(`${prefix}/${key}`)).type === 'file',
    });
  }
  throw new StoreConfigError(`draft store "${cfg.id}": unsupported type "${cfg.type}" (use "r2" or "webdav")`);
}

const cache = new WeakMap();

/**
 * All stores for this environment: Map(id -> { id, label, role, type, store }),
 * "site" first. Cached per env object (i.e. per Worker isolate).
 */
export async function openStores(env) {
  if (cache.has(env)) return cache.get(env);
  const promise = (async () => {
    if (!env.SITE?.put) throw new StoreConfigError('the SITE R2 binding is missing');
    const stores = new Map([['site', { id: 'site', label: 'Published site', role: 'site', type: 'r2', store: r2Store(env.SITE) }]]);
    let configs;
    if (env.DRAFT_STORES) {
      try {
        configs = typeof env.DRAFT_STORES === 'string' ? JSON.parse(env.DRAFT_STORES) : env.DRAFT_STORES;
      } catch (err) {
        throw new StoreConfigError(`DRAFT_STORES is not valid JSON: ${err.message}`);
      }
      if (!Array.isArray(configs)) throw new StoreConfigError('DRAFT_STORES must be a JSON array');
    } else {
      configs = env.DRAFTS ? [{ id: 'drafts', label: 'Drafts', type: 'r2', binding: 'DRAFTS' }] : [];
    }
    for (const cfg of configs) {
      if (!ID_RE.test(cfg?.id ?? '') || cfg.id === 'site') {
        throw new StoreConfigError(`draft store id "${cfg?.id}" must be lowercase letters, digits and dashes, and not "site"`);
      }
      if (stores.has(cfg.id)) throw new StoreConfigError(`duplicate draft store id "${cfg.id}"`);
      stores.set(cfg.id, {
        id: cfg.id,
        label: String(cfg.label ?? cfg.id).slice(0, 60),
        role: 'drafts',
        type: cfg.type,
        store: await openOne(cfg, env),
      });
    }
    return stores;
  })();
  cache.set(env, promise);
  promise.catch(() => cache.delete(env));
  return promise;
}
