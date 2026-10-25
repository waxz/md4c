// Talks to the admin Worker's /api. (admin-storage.js puts a storagesdk
// adapter over it for the site build; it loads only when a build runs.)
//
// The draft store "local" ("This browser", local-store.js) is not on the
// Worker: its calls are answered in the browser, with the same results and
// errors, so the views treat it like any other store. Moves and copies
// between it and the Worker's stores are done here, file by file.

import { LOCAL_ID, LOCAL_STORE, localStore } from './local-store.js';
import { postSlug } from './paths.js';

import { ApiError } from './errors.js';

export { ApiError };

export const OFFLINE_MESSAGE = 'The admin server cannot be reached: Cloudflare Access may have signed you out, or you are offline. '
  + 'Drafts kept in “This browser” can still be written and saved.';

async function request(method, path, { body, headers = {}, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(method === 'GET' ? {} : { 'x-admin-request': '1' }), ...headers },
      body,
    });
  } catch {
    // Signed out, Access redirects to its login page on another origin,
    // which fetch cannot follow: that looks the same as being offline.
    window.dispatchEvent(new CustomEvent('admin-offline'));
    throw new ApiError(0, { error: OFFLINE_MESSAGE, code: 'offline' });
  }
  if (res.redirected && new URL(res.url).origin !== location.origin) {
    window.dispatchEvent(new CustomEvent('admin-offline'));
    throw new ApiError(0, { error: OFFLINE_MESSAGE, code: 'offline' });
  }
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

const isLocal = (store) => store === LOCAL_ID;

/** Posts in this browser, as the Worker lists posts. */
async function localPosts() {
  return (await localStore.listAll('posts/')).filter((i) => postSlug(i.key)).map(({ summary, ...i }) => ({
    ...i, status: 'draft',
    title: String(summary?.title || postSlug(i.key)), date: summary?.date ?? '', tags: summary?.tags ?? '', url: '',
  }));
}

/** A new post must not take a slug used in another store (as the Worker checks among its own). */
async function checkNewPost(store, key, ofPublished, ignore) {
  if (!postSlug(key)) return;
  const ignored = (s, k) => ignore && ignore.store === s && ignore.key === k;
  if (!isLocal(store)) {
    if (!ignored(LOCAL_ID, key) && await localStore.head(key)) {
      throw new ApiError(409, { error: `A draft in “This browser” already uses the slug "${postSlug(key)}"; publish or delete it instead`, code: 'draft-exists', store: LOCAL_ID });
    }
    return;
  }
  let server;
  try {
    server = await request('GET', 'posts');
  } catch (err) {
    if (err.code === 'offline') return; // checked again when it is published
    throw err;
  }
  const other = server.posts.find((p) => p.key === key && !(ofPublished && p.store === 'site') && !ignored(p.store, p.key));
  if (other) {
    throw new ApiError(409, other.store === 'site'
      ? { error: `A published post already uses the slug "${postSlug(key)}"`, code: 'published-exists', store: 'site' }
      : { error: `A draft in another store already uses the slug "${postSlug(key)}"; publish or delete it instead`, code: 'draft-exists', store: other.store });
  }
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const api = {
  /** Who is signed in, and the stores: the Worker's, then "This browser". */
  async session() {
    const s = await request('GET', 'session');
    return { ...s, stores: [...s.stores.filter((x) => x.id !== LOCAL_ID), LOCAL_STORE] };
  },

  /**
   * Every post in every store: { posts: [{ store, key, status, title, date, tags, … }], problems }.
   * Without the server (signed out, offline), the posts in this browser, and why.
   */
  async posts() {
    const [server, local] = await Promise.all([
      request('GET', 'posts').then((d) => ({ d }), (err) => ({ err })),
      localPosts().catch((err) => {
        console.warn('This browser:', err);
        return [];
      }),
    ]);
    if (server.err) {
      if (server.err.code !== 'offline') throw server.err;
      return { posts: local, problems: [{ store: 'server', error: server.err.message }], offline: true };
    }
    return { ...server.d, posts: [...server.d.posts, ...local] };
  },

  /** Every object under `prefix`; `.folders` = kept (possibly empty) folders. */
  async listAll(store, prefix = '') {
    if (isLocal(store)) return localStore.listAll(prefix);
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

  /** One folder: { items, folders: ["a/b/"], exists }, listed one level deep. */
  listFolder: (store, prefix = '') => (isLocal(store) ? localStore.listFolder(prefix)
    : request('GET', `list?${q({ store, prefix, shallow: '1' })}`)),

  /** Keep a folder ("assets/talks/"), so it exists before anything is in it. */
  createFolder: (store, prefix) => (isLocal(store) ? localStore.createFolder(prefix) : request('POST', 'folder', {
    body: JSON.stringify({ store, prefix }),
    headers: { 'content-type': 'application/json' },
  })),

  deleteFolder: (store, prefix) => (isLocal(store) ? localStore.deleteFolder(prefix) : request('DELETE', `folder?${q({ store, prefix })}`)),

  /** Copy a draft store's attachment to the site at the same path. */
  async copyToSite(store, key, { overwrite = false, ifMatch } = {}) {
    if (!isLocal(store)) {
      return request('POST', 'copy', {
        body: JSON.stringify({ from: { store, key }, overwrite, ...(ifMatch ? { ifMatch } : {}) }),
        headers: { 'content-type': 'application/json' },
      });
    }
    // From this browser: the same answers as the Worker's /api/copy.
    if (postSlug(key)) throw new ApiError(400, { error: 'Publish posts from the editor or the Posts list', code: 'use-publish' });
    const { bytes } = await localStore.read(key, 'bytes');
    const current = (await api.listAll('site', key)).find((i) => i.key === key);
    if (!current) return { action: 'copy', file: await api.write('site', key, bytes, null) };
    if (sameBytes(bytes, (await api.read('site', key, 'bytes')).bytes)) return { action: 'identical', file: current };
    if (!overwrite) throw new ApiError(409, { error: `A different ${key} is already public`, code: 'exists', current });
    return { action: 'overwrite', file: await api.write('site', key, bytes, ifMatch ?? current.etag) };
  },

  /** { text|bytes, etag } of an object. */
  async read(store, key, as = 'text') {
    if (isLocal(store)) return localStore.read(key, as);
    const res = await request('GET', `file?${q({ store, key })}`, { raw: true });
    const etag = res.headers.get('x-object-etag') ?? '';
    return as === 'bytes'
      ? { bytes: new Uint8Array(await res.arrayBuffer()), etag }
      : { text: await res.text(), etag };
  },

  // This browser's files are served by sw.js at local-files/<key>.
  fileUrl: (store, key) => (isLocal(store) ? api.rawUrl(store, key) : `api/file?${q({ store, key })}`),

  /** Path-style URL: relative links inside a post resolve against it. */
  rawUrl: (store, key) => new URL(`${isLocal(store) ? 'local-files' : `api/raw/${store}`}/${key.split('/').map(encodeURIComponent).join('/')}`,
    location.href).href,

  /** Create (etag null) or update (etag of the version being replaced).
   *  `ofPublished`: the new file is the draft of the published post at `key`. */
  async write(store, key, body, etag, { ofPublished = false, ignore } = {}) {
    if (etag === null) await checkNewPost(store, key, ofPublished, ignore);
    if (isLocal(store)) return localStore.write(key, body, etag);
    return request('PUT', `file?${q({ store, key, ...(ofPublished ? { ofPublished: '1' } : {}) })}`, {
      body,
      headers: etag === undefined ? {} : etag === null ? { 'if-none-match': '*' } : { 'if-match': `"${etag}"` },
    });
  },

  remove(store, key, etag) {
    if (isLocal(store)) return localStore.remove(key, etag);
    return request('DELETE', `file?${q({ store, key })}`, { headers: etag ? { 'if-match': `"${etag}"` } : {} });
  },

  async move(from, to, etag) {
    if (isLocal(from.store) || isLocal(to.store)) {
      // Between this browser and the Worker (or within this browser): copy, then delete.
      if (postSlug(to.key) && to.store === 'site' && from.store !== 'site') {
        throw new ApiError(400, { error: 'Publish drafts with Publish, which also copies their files', code: 'use-publish' });
      }
      if (Boolean(postSlug(from.key)) !== Boolean(postSlug(to.key))) {
        throw new ApiError(400, { error: 'A post (posts/<slug>.md) can only move to another post path', code: 'bad-path' });
      }
      const { bytes, etag: current } = await api.read(from.store, from.key, 'bytes');
      if (etag && etag !== current) {
        const now = (await api.listAll(from.store, from.key)).find((i) => i.key === from.key) ?? null;
        throw new ApiError(412, { error: `${from.key} was changed elsewhere since you opened it`, code: 'changed', current: now });
      }
      const written = await api.write(to.store, to.key, bytes, null, { ofPublished: to.store !== 'site', ignore: from });
      await api.remove(from.store, from.key, current);
      return written;
    }
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

  /** Move published Markdown out of the public bucket (where it used to be). */
  privateSources: () => request('POST', 'site/private-sources'),

  indexNow: (urls) => request('POST', 'indexnow', {
    body: JSON.stringify({ urls }),
    headers: { 'content-type': 'application/json' },
  }),
};
