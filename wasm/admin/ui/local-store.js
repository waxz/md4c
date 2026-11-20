// "This browser": a draft store in the browser's own database (IndexedDB).
//
// Drafts and their files can be kept here like in any other draft store
// (posts/<slug>.md, files in posts/ and assets/), with the same rules and
// the same answers to conflicts (client.js routes the store id "local"
// here instead of to the Worker). Nothing leaves the browser until the
// post is published, and saving needs no network and no sign-in: it keeps
// working when Cloudflare Access has signed the admin out.
//
// sw.js reads the same database to serve these files to previews, at
// local-files/<key> (see rawUrl/fileUrl in client.js).

import { ApiError } from './errors.js';
import { parseFrontMatter } from './lib/post-format.js';
import { classify, contentTypeFor, FOLDER_MARKER, folderProblem, keyProblem, postSlug } from './paths.js';

export const LOCAL_ID = 'local';
export const LOCAL_STORE = { id: LOCAL_ID, label: 'This browser', role: 'drafts', type: 'indexeddb', location: 'local' };
// Shared with sw.js: keep in step.
export const DB_NAME = 'md4c-admin-local';
const FILES = 'files';

let opening;
function db() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FILES, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => { opening = null; });
  return opening;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Run `fn(store)` in one transaction; resolves with its result once committed. */
async function transact(mode, fn) {
  const t = (await db()).transaction(FILES, mode);
  const committed = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('aborted'));
  });
  let result;
  try {
    result = await fn(t.objectStore(FILES));
  } catch (err) {
    try { t.abort(); } catch {}
    throw err;
  }
  await committed;
  return result;
}

const under = (prefix) => (prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined);
const visible = (key) => !key.split('/').some((s) => s.startsWith('.'));

function newEtag() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function info(r) {
  return {
    store: LOCAL_ID, key: r.key, size: r.size, etag: r.etag, uploaded: r.uploaded,
    contentType: r.contentType, kind: classify('drafts', r.key),
    ...(r.summary ? { summary: r.summary } : {}),
  };
}

const fail = (status, error, extra = {}) => new ApiError(status, { error, ...extra });

async function asBlob(body, type) {
  if (body instanceof Blob) return body.type === type ? body : new Blob([body], { type });
  return new Blob([body ?? ''], { type });
}

function summaryOf(key, text) {
  if (!postSlug(key)) return null;
  const { meta } = parseFrontMatter(text);
  return {
    title: String(meta.title ?? '').slice(0, 200),
    date: /^\d{4}-\d{2}-\d{2}/.test(meta.date ?? '') ? meta.date.slice(0, 10) : '',
    tags: String(meta.tags ?? '').slice(0, 300),
  };
}

/** Ask the browser to keep this data (not evict it when space runs low). */
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

export const localStore = {
  /** Every visible file under `prefix`; `.folders` = kept folders, as api.listAll. */
  async listAll(prefix = '') {
    const all = await transact('readonly', (s) => done(s.getAll(under(prefix))));
    const items = all.filter((r) => visible(r.key)).map(info);
    items.folders = all.filter((r) => r.key.endsWith(`/${FOLDER_MARKER}`))
      .map((r) => r.key.slice(0, -FOLDER_MARKER.length)).filter((p) => !folderProblem(p));
    return items;
  },

  /** One folder, one level deep: { items, folders, exists }, as api.listFolder. */
  async listFolder(prefix = '') {
    if (prefix && !prefix.endsWith('/')) throw fail(400, 'A folder path ends with "/"', { code: 'bad-path' });
    const all = await transact('readonly', (s) => done(s.getAll(under(prefix))));
    const items = [];
    const folders = new Set();
    let exists = !prefix;
    for (const r of all) {
      const rest = r.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash !== -1) {
        const f = prefix + rest.slice(0, slash + 1);
        if (!rest.slice(0, slash).startsWith('.')) folders.add(f);
      } else if (rest === FOLDER_MARKER) {
        exists = true;
      } else if (visible(r.key)) {
        items.push(info(r));
      }
    }
    if (items.length || folders.size) exists = true;
    return { items, folders: [...folders].sort(), exists };
  },

  async head(key) {
    const r = await transact('readonly', (s) => done(s.get(key)));
    return r ? info(r) : null;
  },

  /** { blob, info } or null. */
  async get(key) {
    const r = await transact('readonly', (s) => done(s.get(key)));
    return r ? { blob: r.blob, info: info(r) } : null;
  },

  async read(key, as = 'text') {
    const got = await this.get(key);
    if (!got) throw fail(404, `${key} not found`, { code: 'not-found' });
    return as === 'bytes'
      ? { bytes: new Uint8Array(await got.blob.arrayBuffer()), etag: got.info.etag }
      : { text: await got.blob.text(), etag: got.info.etag };
  },

  /**
   * Create (etag null), update (etag of the version replaced) or simply
   * write (etag undefined), with the Worker's checks and error codes.
   */
  async write(key, body, etag) {
    const problem = keyProblem(key);
    if (problem) throw fail(400, problem, { code: 'bad-path' });
    if (classify('drafts', key) === 'locked') {
      throw fail(403, `${key}: draft stores hold posts (posts/<slug>.md) and their files (posts/, assets/)`, { code: 'locked' });
    }
    const contentType = contentTypeFor(key);
    const blob = await asBlob(body, contentType);
    const summary = postSlug(key) ? summaryOf(key, await blob.text()) : null;
    askPersist();
    return transact('readwrite', async (s) => {
      const current = await done(s.get(key));
      if (etag === null) {
        if (current) throw fail(409, `${key} already exists`, { code: 'exists' });
        const below = await done(s.getAllKeys(under(`${key}/`), 1));
        if (below.length) throw fail(409, `A folder named ${key} already exists`, { code: 'folder-exists' });
        const parts = key.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          if (await done(s.get(parent))) throw fail(409, `${parent} is a file, so it cannot be a folder`, { code: 'file-in-path' });
        }
      } else if (etag !== undefined && (!current || current.etag !== etag)) {
        throw fail(412, current ? `${key} was changed elsewhere since you opened it` : `${key} was deleted elsewhere since you opened it`,
          { code: 'changed', current: current ? info(current) : null });
      }
      const record = {
        key, blob, contentType, size: blob.size, etag: newEtag(), uploaded: new Date().toISOString(),
        ...(summary ? { summary } : {}),
      };
      await done(s.put(record));
      return info(record);
    });
  },

  async remove(key, etag) {
    return transact('readwrite', async (s) => {
      const current = await done(s.get(key));
      if (!current) throw fail(404, `${key} not found`, { code: 'not-found' });
      if (etag && current.etag !== etag) {
        throw fail(412, `${key} was changed elsewhere since you opened it`, { code: 'changed', current: info(current) });
      }
      await done(s.delete(key));
      return null;
    });
  },

  async createFolder(prefix) {
    const problem = folderProblem(prefix);
    if (problem) throw fail(400, problem, { code: 'bad-path' });
    return transact('readwrite', async (s) => {
      const parts = prefix.slice(0, -1).split('/');
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        if (await done(s.get(path))) throw fail(409, `${path} is a file, so it cannot be a folder`, { code: 'file-in-path' });
      }
      const marker = `${prefix}${FOLDER_MARKER}`;
      if (!(await done(s.get(marker)))) {
        await done(s.put({ key: marker, blob: new Blob([]), contentType: 'text/plain', size: 0, etag: newEtag(), uploaded: new Date().toISOString() }));
      }
      return { store: LOCAL_ID, prefix };
    });
  },

  async deleteFolder(prefix) {
    return transact('readwrite', async (s) => {
      const keys = await done(s.getAllKeys(under(prefix)));
      if (keys.some(visible)) throw fail(409, 'Only an empty folder can be removed; delete or move its files first', { code: 'not-empty' });
      for (const k of keys) await done(s.delete(k));
      return null;
    });
  },

  /** { files, bytes }: what this browser keeps. */
  async usage() {
    const all = await transact('readonly', (s) => done(s.getAll()));
    const files = all.filter((r) => visible(r.key));
    return { files: files.length, posts: files.filter((r) => postSlug(r.key)).length, bytes: files.reduce((n, r) => n + r.size, 0) };
  },
};
