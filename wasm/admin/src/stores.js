// Storage the admin can read and write ("stores"):
//
//   site            the public blog bucket (R2 binding SITE)
//   draft stores    one or more private stores for drafts and their images
//
// Draft stores come from three places:
//
//   1. The deploy: the DRAFTS R2 binding, or DRAFT_STORES (JSON) in
//      wrangler.toml, whose credentials name Worker secrets
//      ("passwordSecret": "NAS_PASSWORD"), never values.
//   2. The admin's Storage page, saved in Cloudflare KV (the SETTINGS
//      namespace): usable from every device.
//   3. The admin's Storage page, kept in that browser only (localStorage,
//      sent to the Worker in cookies with each request; never stored here).
//
// Types for 2 and 3: "webdav" (Nextcloud, ownCloud, a NAS...), "s3" (any
// S3-compatible service: AWS S3, another R2 bucket, Backblaze B2, MinIO,
// Wasabi, DigitalOcean Spaces...) and "github" (a repository).
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

/**
 * A WebDAV share, over storagesdk's WebDAV adapter (`storage`) and its
 * client (`storage.raw`). Servers differ in small ways, so a file is never
 * declared missing on one request's word:
 *   - a single-file PROPFIND ("stat") that fails, or says "folder", is
 *     checked against the folder listing (PROPFIND Depth 1), which is what
 *     the explorer shows;
 *   - the file is then read, replaced and deleted at the path the server
 *     itself reported, not only at the path we computed;
 *   - after an upload or a delete, the result is checked, and an error
 *     names the exact server path if the server disagrees.
 */
export function webdavStore(storage, { baseUrl, folderPath }) {
  const client = storage.raw;
  const base = `/${folderPath.split('/').filter(Boolean).join('/')}`.replace(/^\/$/, '');
  const pathOf = (key) => `${base}/${key}`;
  const where = (key) => `${String(baseUrl).replace(/\/+$/, '')}${pathOf(key)}`;
  const status = (err) => err?.status ?? err?.response?.status;
  const etagOf = (e) => String(e ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
  const meta = (key, st) => ({
    key,
    size: Number(st.size) || 0,
    etag: etagOf(st.etag) || `${Number(st.size) || 0}-${st.lastmod ?? ''}`,
    uploaded: st.lastmod ? new Date(st.lastmod) : new Date(0),
    contentType: st.mime ?? '',
    path: st.filename ?? pathOf(key), // where the server says it is
  });

  /** The file at `key` as the server reports it, or null. */
  const locate = async (key) => {
    const path = pathOf(key);
    try {
      const st = await client.stat(path);
      if (st?.type === 'file') return meta(key, st);
    } catch (err) {
      // 404 is "missing"; other answers (403, 405, 409, odd servers) are
      // double-checked below rather than trusted.
      if (status(err) === 401) throw err;
    }
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const name = path.slice(path.lastIndexOf('/') + 1);
    let entries;
    try {
      entries = await client.getDirectoryContents(dir);
    } catch (err) {
      if ([404, 403, 405, 409].includes(status(err))) return null;
      throw err;
    }
    const found = (Array.isArray(entries) ? entries : [])
      .find((e) => e.type === 'file' && (e.basename === name || decodeURIComponent(e.basename ?? '') === name));
    return found ? meta(key, found) : null;
  };
  const strip = ({ path, ...rest }) => rest;
  const head = async (key) => {
    const m = await locate(key);
    return m ? strip(m) : null;
  };

  return {
    head,
    async get(key) {
      const m = await locate(key);
      if (!m) return null;
      const data = await client.getFileContents(m.path, { format: 'binary' });
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return { meta: strip(m), body: bytes.slice().buffer };
    },
    async put(key, body, { contentType, cacheControl, ifMatch } = {}) {
      if (ifMatch) {
        const current = await head(key);
        if (!current || current.etag !== ifMatch) return null;
      }
      await storage.upload(key, new Uint8Array(body), { contentType, ...(cacheControl ? { cacheControl } : {}) });
      const written = await head(key);
      if (!written) {
        throw new Error(`the upload to ${where(key)} was accepted, but the server does not list the file there afterwards. Check the server URL, base folder and drafts folder in Storage`);
      }
      return written;
    },
    async delete(key) {
      const m = await locate(key);
      if (!m) return;
      try {
        await client.deleteFile(m.path);
      } catch (err) {
        if (status(err) !== 404) throw err;
      }
      if (await locate(key)) throw new Error(`the server did not delete ${where(key)}`);
    },
    async list(sub = '', cursor) {
      let page;
      try {
        page = await storage.list({ prefix: sub, limit: 1000, ...(cursor ? { cursor } : {}) });
      } catch (err) {
        if (err instanceof StorageError && (err.code === 'NotFound' || err.code === 'InvalidArgument')) return { items: [] };
        throw err;
      }
      return {
        items: page.items.map((m) => ({
          key: m.path, size: m.size, etag: etagOf(m.etag), uploaded: m.lastModified, contentType: m.contentType ?? '',
        })),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    },
    where,
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
    if (name === 'where') {
      out.where = fn;
      continue;
    }
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
    return webdavStore(storage, { baseUrl: cfg.baseUrl, folderPath: `${root}/${folder}` });
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

/* ---------- Stores saved in Cloudflare KV ---------- */

// The SETTINGS KV namespace holds { version, stores } under this key. KV is
// eventually consistent: another Cloudflare location may see a change up
// to a minute late.
export const KV_KEY = 'draft-stores';

/** { version, stores } saved in KV ({ version: 0 } when none or no KV). */
export async function readSaved(env) {
  const text = env.SETTINGS ? await env.SETTINGS.get(KV_KEY) : null;
  return parseSaved(text);
}

function parseSaved(text) {
  let doc = {};
  try {
    doc = text ? JSON.parse(text) : {};
  } catch {}
  return { version: Number(doc.version) || 0, stores: Array.isArray(doc.stores) ? doc.stores : [] };
}

/** Save the KV stores; false when `version` is no longer the current one. */
export async function writeSaved(env, stores, version) {
  if (!env.SETTINGS) throw new StoreConfigError('saving to KV needs the SETTINGS KV namespace binding');
  const current = await readSaved(env);
  if (current.version !== Number(version)) return false;
  await env.SETTINGS.put(KV_KEY, JSON.stringify({ version: current.version + 1, stores }));
  return true;
}

/* ---------- Stores kept in the admin's browser ---------- */

// The admin app keeps "this browser only" stores in localStorage and
// mirrors them into cookies scoped to /api (see ui/client.js), so every API
// request, including image requests from previews, carries them. The Worker
// uses them for that request only and never stores them.
export const COOKIE_PREFIX = 'md4c_stores_';
const MAX_COOKIES = 12;

/** The browser's store settings from the request cookies ([] when none). */
export function browserConfigs(request) {
  const header = request?.headers?.get('cookie') ?? '';
  const parts = [];
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    if (!name.startsWith(COOKIE_PREFIX)) continue;
    const n = Number(name.slice(COOKIE_PREFIX.length));
    if (Number.isInteger(n) && n >= 0 && n < MAX_COOKIES) parts[n] = pair.slice(eq + 1);
  }
  if (!parts.length) return [];
  try {
    const b64 = parts.join('').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(list) ? list : [];
  } catch {
    return [{ id: '', error: 'The storage saved in this browser could not be read; open Storage and save it again' }];
  }
}

/* ---------- All stores ---------- */

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

/** Open user-added stores into `stores`; ones that fail go to `problems`. */
async function addStores(stores, problems, configs, location, env, check) {
  for (const raw of configs) {
    try {
      if (raw?.error) throw new StoreConfigError(raw.error);
      const cfg = check ? normalizeStore(raw) : raw;
      if (stores.has(cfg?.id)) throw new StoreConfigError(`the id "${cfg.id}" is already used`);
      const label = String(cfg.label ?? cfg.id).slice(0, 60);
      stores.set(cfg.id, { id: cfg.id, label, role: 'drafts', type: cfg.type, location, store: await openStore(cfg, env) });
    } catch (err) {
      problems.push({ store: String(raw?.id ?? ''), location, error: err.message });
    }
  }
}

const serverCache = new WeakMap(); // env -> { text, promise }
const browserCache = new Map(); // cookie text -> opened stores (a few, per isolate)

/** Site, deployed and KV stores; cached per isolate until the KV value changes. */
async function serverStores(env) {
  const text = env.SETTINGS ? (await env.SETTINGS.get(KV_KEY)) ?? '' : '';
  const hit = serverCache.get(env);
  if (hit && hit.text === text) return hit.promise;
  const promise = (async () => {
    if (!env.SITE?.put) throw new StoreConfigError('the SITE R2 binding is missing');
    const stores = new Map([['site', { id: 'site', label: 'Published site', role: 'site', type: 'r2', location: 'deploy', store: r2Store(env.SITE) }]]);
    const problems = [];
    for (const cfg of deployedConfigs(env)) {
      if (!ID_RE.test(cfg?.id ?? '') || cfg.id === 'site') {
        throw new StoreConfigError(`draft store id "${cfg?.id}" must be lowercase letters, digits and dashes, and not "site"`);
      }
      if (stores.has(cfg.id)) throw new StoreConfigError(`duplicate draft store id "${cfg.id}"`);
      const label = String(cfg.label ?? cfg.id).slice(0, 60);
      stores.set(cfg.id, { id: cfg.id, label, role: 'drafts', type: cfg.type, location: 'deploy', store: guarded(await openOne(cfg, env), label) });
    }
    await addStores(stores, problems, parseSaved(text).stores, 'kv', env, false);
    return { stores, problems };
  })();
  serverCache.set(env, { text, promise });
  promise.catch(() => serverCache.delete(env));
  return promise;
}

/**
 * All stores for a request: Map(id -> { id, label, role, type, location,
 * store }), "site" first, then the deployed draft stores, then those saved
 * in KV, then those sent by the admin's browser. `map.problems` lists
 * added stores that could not be opened (left out rather than breaking
 * the admin).
 */
export async function openStores(env, request) {
  const { stores: base, problems: baseProblems } = await serverStores(env);
  const stores = new Map(base);
  const problems = [...baseProblems];
  const configs = browserConfigs(request);
  if (configs.length) {
    const key = JSON.stringify(configs);
    let opened = browserCache.get(key);
    if (!opened) {
      opened = { stores: new Map(), problems: [] };
      await addStores(opened.stores, opened.problems, configs, 'browser', env, true);
      if (browserCache.size >= 8) browserCache.delete(browserCache.keys().next().value);
      browserCache.set(key, opened);
    }
    for (const [id, entry] of opened.stores) {
      if (stores.has(id)) problems.push({ store: id, location: 'browser', error: `the id "${id}" is already used` });
      else stores.set(id, entry);
    }
    problems.push(...opened.problems);
  }
  stores.problems = problems;
  return stores;
}
