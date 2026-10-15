// Storage the admin can read and write ("stores"):
//
//   site            the public blog bucket (R2 binding SITE)
//   draft stores    one or more private stores for drafts and their images
//
// Draft stores come from two places:
//
//   1. The admin's Storage page (the usual way). Stores added there are
//      saved, with their passwords and keys, in the private DRAFTS bucket at
//      .admin/stores.json. No redeploy and no Worker secrets are needed.
//      Types: "webdav" (Nextcloud, ownCloud, a NAS...), "s3" (any
//      S3-compatible service: AWS S3, another R2 bucket, Backblaze B2,
//      MinIO, Wasabi, DigitalOcean Spaces...) and "github" (a repository).
//   2. Optionally DRAFT_STORES (JSON) in wrangler.toml, for R2 bindings or
//      stores you want fixed in the deploy. Credentials there name Worker
//      secrets ("passwordSecret": "NAS_PASSWORD"), never values.
//
// Without DRAFT_STORES, a DRAFTS binding (if any) is the first draft store.
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
 * A store over any storagesdk Storage (WebDAV, S3, GitHub, ...). storagesdk
 * has no conditional write, so ifMatch is checked just before writing: safe
 * for one admin, not a lock between simultaneous writers.
 *
 * `prefix` keeps the store's files under a folder ("blog-drafts/").
 * `isFile(path)` (optional) tells files from folders where the backend has
 * real folders: storagesdk's head() also succeeds for a WebDAV collection.
 */
export function storagesdkStore(storage, { isFile, prefix = '' } = {}) {
  const meta = (m) => ({
    key: m.path.slice(prefix.length),
    size: m.size,
    etag: String(m.etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, ''),
    uploaded: m.lastModified,
    contentType: m.contentType ?? '',
  });
  const notFound = (err) => err instanceof StorageError && (err.code === 'NotFound' || err.code === 'InvalidArgument');
  const head = async (key) => {
    try {
      const m = meta(await storage.head(prefix + key));
      return isFile && !(await isFile(prefix + key)) ? null : m;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  };
  return {
    head,
    async get(key) {
      try {
        const item = await storage.download(prefix + key);
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
      await storage.upload(prefix + key, new Uint8Array(body), { contentType, ...(cacheControl ? { cacheControl } : {}) });
      // Report the etag head() will report later (an upload's may differ).
      return head(key);
    },
    async delete(key) {
      await storage.delete(prefix + key).catch((err) => {
        if (!notFound(err)) throw err;
      });
    },
    async list(sub = '', cursor) {
      let page;
      try {
        page = await storage.list({ prefix: prefix + sub, limit: 1000, ...(cursor ? { cursor } : {}) });
      } catch (err) {
        if (notFound(err)) return { items: [] }; // a folder that does not exist yet
        throw err;
      }
      return {
        items: page.items.filter((m) => m.path.startsWith(prefix)).map(meta),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    },
  };
}

/** A store's I/O failed (unreachable server, wrong password...). */
export class StoreAccessError extends Error {}

/** storagesdk errors carry only their code as message; the cause says more. */
function describe(err) {
  const msg = String(err?.message ?? err);
  const cause = err?.cause?.message;
  return cause && cause !== msg ? `${msg === err?.code ? '' : `${msg}: `}${cause}` : msg;
}

/** Name the store in I/O errors, so the admin can tell which one is failing. */
function guarded(store, label) {
  const out = {};
  for (const [name, fn] of Object.entries(store)) {
    out[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        throw new StoreAccessError(`"${label}" failed: ${describe(err)}`);
      }
    };
  }
  return out;
}

/* ---------- Store settings ---------- */

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const FOLDER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;

export class StoreConfigError extends Error {}

/**
 * The settings of each type the Storage page can add. `secrets` are kept on
 * the server and never sent back to the browser.
 */
export const STORE_TYPES = {
  webdav: { label: 'WebDAV', settings: ['baseUrl', 'root', 'folder', 'username'], secrets: ['password', 'token'] },
  s3: { label: 'S3-compatible', settings: ['provider', 'endpoint', 'region', 'bucket', 'accessKeyId', 'folder', 'forcePathStyle'], secrets: ['secretAccessKey'] },
  github: { label: 'GitHub repository', settings: ['owner', 'repo', 'branch', 'folder'], secrets: ['token'] },
};

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function httpUrl(id, name, v, required) {
  const s = str(v, 500);
  if (!s && !required) return '';
  let u;
  try {
    u = new URL(s);
  } catch {}
  if (!u || !/^https?:$/.test(u.protocol)) throw new StoreConfigError(`"${id}": ${name} must be an http(s) URL`);
  return s.replace(/\/+$/, '');
}

/** "a/b/" from "/a//b": a folder path, each part a safe name. */
function folderPath(id, v) {
  const parts = str(v).split('/').filter(Boolean);
  for (const p of parts) {
    if (!FOLDER_RE.test(p) || p.endsWith('.')) throw new StoreConfigError(`"${id}": folder "${str(v)}" may use letters, digits, ".", "_" and "-"`);
  }
  return parts.length ? `${parts.join('/')}/` : '';
}

/**
 * Checked, normalized settings for a store from the Storage page.
 * `previous` is the saved version of the same store: secrets left empty in
 * `input` keep their saved values.
 */
export function normalizeStore(input, previous) {
  if (!input || typeof input !== 'object') throw new StoreConfigError('each store must be an object');
  const id = str(input.id, 31);
  if (!ID_RE.test(id) || id === 'site') {
    throw new StoreConfigError(`store id "${id}" must start with a letter and use lowercase letters, digits and dashes, and not be "site"`);
  }
  const type = str(input.type, 20);
  const spec = STORE_TYPES[type];
  if (!spec) throw new StoreConfigError(`"${id}": type must be one of ${Object.keys(STORE_TYPES).join(', ')}`);
  const keep = previous?.type === type ? previous.secrets ?? {} : {};
  const secrets = {};
  for (const name of spec.secrets) {
    const v = typeof input.secrets?.[name] === 'string' ? input.secrets[name] : '';
    if (v) secrets[name] = v.slice(0, 4000);
    else if (keep[name] && input.secrets?.[name] !== null) secrets[name] = keep[name]; // null clears
  }
  const out = { id, label: str(input.label, 60) || id, type, secrets };
  if (type === 'webdav') {
    out.baseUrl = httpUrl(id, 'the server URL', input.baseUrl, true);
    out.root = `/${folderPath(id, input.root)}`;
    out.folder = folderPath(id, input.folder ?? 'blog-drafts') || 'blog-drafts/';
    out.username = str(input.username, 200);
  } else if (type === 's3') {
    out.provider = /^[a-z0-9-]{1,20}$/.test(str(input.provider)) ? str(input.provider) : 'other';
    out.endpoint = httpUrl(id, 'the endpoint', input.endpoint, false);
    out.region = str(input.region, 40) || (out.endpoint ? 'auto' : 'us-east-1');
    out.bucket = str(input.bucket, 63);
    if (!BUCKET_RE.test(out.bucket)) throw new StoreConfigError(`"${id}": bucket "${out.bucket}" is not a valid bucket name`);
    out.accessKeyId = str(input.accessKeyId, 200);
    if (!out.accessKeyId) throw new StoreConfigError(`"${id}": the access key ID is required`);
    if (!secrets.secretAccessKey) throw new StoreConfigError(`"${id}": the secret access key is required`);
    out.folder = folderPath(id, input.folder);
    out.forcePathStyle = input.forcePathStyle === true;
  } else if (type === 'github') {
    out.owner = str(input.owner, 100);
    out.repo = str(input.repo, 100);
    if (!NAME_RE.test(out.owner) || !NAME_RE.test(out.repo)) throw new StoreConfigError(`"${id}": owner and repository names are required`);
    out.branch = str(input.branch, 200);
    if (out.branch && !/^[A-Za-z0-9._/-]+$/.test(out.branch)) throw new StoreConfigError(`"${id}": invalid branch name`);
    out.folder = folderPath(id, input.folder ?? 'blog-drafts') || '';
    if (!secrets.token) throw new StoreConfigError(`"${id}": a GitHub token with write access to the repository is required`);
  }
  return out;
}

/** What the browser may see of a saved store: settings, never secret values. */
export function publicStore(cfg) {
  const { secrets = {}, ...rest } = cfg;
  return { ...rest, secretsSet: Object.fromEntries(Object.keys(secrets).filter((k) => secrets[k]).map((k) => [k, true])) };
}

/** Open a store from its settings. `secret(name)` resolves a credential. */
async function openOne(cfg, env) {
  if (!cfg || typeof cfg !== 'object') throw new StoreConfigError('each draft store must be an object');
  // Saved stores carry their credentials; DRAFT_STORES names Worker secrets.
  const secret = (name) => {
    if (cfg.secrets) return cfg.secrets[name] || undefined;
    const ref = cfg[`${name}Secret`];
    if (!ref) return undefined;
    const v = env[ref];
    if (typeof v !== 'string' || !v) throw new StoreConfigError(`secret ${ref} (for draft store "${cfg.id}") is not set`);
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
    const password = secret('password');
    const token = secret('token');
    const storage = new Storage({
      adapter: webdav({
        baseUrl: cfg.baseUrl,
        root,
        folder,
        ...(cfg.username ? { username: cfg.username } : {}),
        ...(password ? { password } : {}),
        ...(token ? { token } : {}),
      }),
    });
    const prefix = `/${`${root}/${folder}`.split('/').filter(Boolean).join('/')}`;
    return storagesdkStore(storage, {
      isFile: async (key) => (await storage.raw.stat(`${prefix}/${key}`)).type === 'file',
    });
  }
  if (cfg.type === 's3') {
    const { s3 } = await import('@storagesdk/adapters/s3');
    const storage = new Storage({
      adapter: s3({
        bucket: cfg.bucket,
        region: cfg.region || 'auto',
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        ...(cfg.forcePathStyle ? { forcePathStyle: true } : {}),
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: secret('secretAccessKey') ?? '' },
        requestChecksumCalculation: 'WHEN_REQUIRED',
      }),
    });
    return storagesdkStore(storage, { prefix: cfg.folder ?? '' });
  }
  if (cfg.type === 'github') {
    const { github } = await import('@storagesdk/adapters/github');
    const storage = new Storage({
      adapter: github({
        owner: cfg.owner,
        repo: cfg.repo,
        ...(cfg.branch ? { branch: cfg.branch } : {}),
        token: secret('token'),
        commitMessage: (op, paths) => `blog admin: ${op} ${paths.map((p) => p.slice((cfg.folder ?? '').length)).join(', ')}`,
      }),
    });
    return storagesdkStore(storage, { prefix: cfg.folder ?? '' });
  }
  throw new StoreConfigError(`draft store "${cfg.id}": unsupported type "${cfg.type}"`);
}

/** Open one store from (unsaved) settings, e.g. to test a connection. */
export async function openStore(cfg, env) {
  return guarded(await openOne(cfg, env), cfg.label ?? cfg.id);
}

/* ---------- Saved stores (.admin/stores.json in the DRAFTS bucket) ---------- */

export const SAVED_KEY = '.admin/stores.json';

/** The private bucket that keeps the Storage page's settings, if any. */
export const settingsBucket = (env) => (env.DRAFTS?.put ? env.DRAFTS : null);

/** { etag, stores } as saved by the Storage page ({ etag: '' } when none). */
export async function readSaved(env) {
  const bucket = settingsBucket(env);
  const obj = bucket ? await bucket.get(SAVED_KEY) : null;
  if (!obj) return { etag: '', stores: [] };
  let doc;
  try {
    doc = JSON.parse(await obj.text());
  } catch {
    doc = {};
  }
  return { etag: obj.etag, stores: Array.isArray(doc.stores) ? doc.stores : [] };
}

/** Save the Storage page's stores; false when `etag` is no longer current. */
export async function writeSaved(env, stores, etag) {
  const bucket = settingsBucket(env);
  if (!bucket) throw new StoreConfigError('stores can only be saved when the DRAFTS bucket is bound');
  const current = await bucket.head(SAVED_KEY);
  if ((current?.etag ?? '') !== (etag ?? '')) return false;
  const body = JSON.stringify({ version: 1, stores }, null, 2);
  const res = await bucket.put(SAVED_KEY, body, {
    httpMetadata: { contentType: 'application/json' },
    ...(current ? { onlyIf: { etagMatches: current.etag } } : {}),
  });
  return Boolean(res);
}

/** The stores fixed by the deploy (DRAFT_STORES, or the DRAFTS binding). */
function deployedConfigs(env) {
  if (!env.DRAFT_STORES) return env.DRAFTS ? [{ id: 'drafts', label: 'Drafts', type: 'r2', binding: 'DRAFTS' }] : [];
  let configs;
  try {
    configs = typeof env.DRAFT_STORES === 'string' ? JSON.parse(env.DRAFT_STORES) : env.DRAFT_STORES;
  } catch (err) {
    throw new StoreConfigError(`DRAFT_STORES is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(configs)) throw new StoreConfigError('DRAFT_STORES must be a JSON array');
  return configs;
}

const cache = new WeakMap();

/**
 * All stores for this environment: Map(id -> { id, label, role, type,
 * saved, store }), "site" first, then the deployed draft stores, then the
 * saved ones. `map.problems` lists saved stores that could not be opened
 * (they are left out rather than breaking the admin).
 *
 * Cached per env object (i.e. per Worker isolate) until the saved settings
 * change, which costs one R2 head request per API call.
 */
export async function openStores(env) {
  const bucket = settingsBucket(env);
  const tag = bucket ? (await bucket.head(SAVED_KEY))?.etag ?? '' : '';
  const hit = cache.get(env);
  if (hit && hit.tag === tag) return hit.promise;
  const promise = (async () => {
    if (!env.SITE?.put) throw new StoreConfigError('the SITE R2 binding is missing');
    const stores = new Map([['site', { id: 'site', label: 'Published site', role: 'site', type: 'r2', saved: false, store: r2Store(env.SITE) }]]);
    stores.problems = [];
    for (const cfg of deployedConfigs(env)) {
      if (!ID_RE.test(cfg?.id ?? '') || cfg.id === 'site') {
        throw new StoreConfigError(`draft store id "${cfg?.id}" must be lowercase letters, digits and dashes, and not "site"`);
      }
      if (stores.has(cfg.id)) throw new StoreConfigError(`duplicate draft store id "${cfg.id}"`);
      const label = String(cfg.label ?? cfg.id).slice(0, 60);
      stores.set(cfg.id, { id: cfg.id, label, role: 'drafts', type: cfg.type, saved: false, store: guarded(await openOne(cfg, env), label) });
    }
    for (const cfg of (await readSaved(env)).stores) {
      try {
        if (stores.has(cfg?.id)) throw new StoreConfigError(`the id "${cfg.id}" is already used`);
        const label = String(cfg.label ?? cfg.id).slice(0, 60);
        stores.set(cfg.id, { id: cfg.id, label, role: 'drafts', type: cfg.type, saved: true, store: await openStore(cfg, env) });
      } catch (err) {
        stores.problems.push({ store: String(cfg?.id ?? ''), error: err.message });
      }
    }
    return stores;
  })();
  cache.set(env, { tag, promise });
  promise.catch(() => cache.delete(env));
  return promise;
}
