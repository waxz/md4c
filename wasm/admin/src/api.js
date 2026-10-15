// The admin file API. Every route needs a verified Access identity (see
// worker.js); every write is checked here, on the server. Stores are the
// public site and one or more private draft stores (stores.js).
//
//   GET    /api/session                         who is signed in; the stores
//   GET    /api/posts                           posts in every store, with title/date/tags
//   GET    /api/list?store=&prefix=&cursor=     objects (flat; the UI builds folders),
//                                               plus `folders`: kept empty folders
//   POST   /api/folder {store, prefix}          keep an (empty) folder: posts/… or assets/…
//   DELETE /api/folder?store=&prefix=           forget an empty folder
//   GET    /api/file?store=&key=                object body
//   GET    /api/raw/<store>/<key>               same, by path (previews resolve relative
//                                               URLs); draft stores fall back to the site
//   PUT    /api/file?store=&key=[&ofPublished=1]
//                                               write; If-None-Match: * creates,
//                                               If-Match: <etag> updates; ofPublished
//                                               starts the draft of a published post
//   DELETE /api/file?store=&key=                delete; If-Match optional
//   POST   /api/move    {from, to, ifMatch}     rename, move, unpublish
//   POST   /api/publish {from, ifMatch, siteIfMatch, overwrite, skip, dryRun, postBody}
//                                               copy a draft to the site, with the files
//                                               it uses (except `skip`); the draft stays
//                                               (working copy). dryRun: only the plan.
//                                               postBody: the encrypted form of a post
//                                               with a password (made in the browser)
//   POST   /api/copy {from, overwrite, ifMatch} copy a draft store's attachment to the
//                                               site (same path); ifMatch = public copy
//   POST   /api/indexnow {urls}                 notify IndexNow search engines
//   GET    /api/storage                         draft stores: deployed and saved in KV
//                                               (settings only, never secrets)
//   PUT    /api/storage {version, stores}       save the Storage page's KV stores
//   POST   /api/storage/test {store, location, check}
//                                               try a store's settings (check: only
//                                               validate a browser store)
//
// Stores kept in the admin's browser arrive with each request, in cookies
// (stores.js browserConfigs); the Worker never saves them.
//
// Conflicts are refused with 409 (code in the JSON body):
//   exists            the destination already exists
//   folder-exists     a "folder" (key prefix) already uses that name
//   file-in-path      a file already uses one of the parent folder names
//   published-exists  a new draft would take the slug of a published post
//                     (unless it is that post's draft: ofPublished=1)
//   draft-exists      the slug is already a draft (in any draft store)
//   asset-conflict    publishing would replace different public files
// with 412 "changed" when If-Match no longer matches, 428 when a content
// write does not say whether it creates or updates.

import {
  cacheControlFor, classify, contentTypeFor, FOLDER_MARKER, folderProblem, keyProblem, postSlug, referencedKeys,
} from './paths.js';
import {
  normalizeStore, openStore, openStores, publicStore, readSaved, STORE_TYPES,
  StoreAccessError, StoreConfigError, writeSaved,
} from './stores.js';
import { parseFrontMatter } from '../../js/post-format.js';
import { PROTECTED_MARK, readProtected, wantsPassword } from '../../js/protect.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

function stripQuotes(etag) {
  return String(etag ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function info(entry, meta) {
  return {
    store: entry.id,
    key: meta.key,
    size: meta.size,
    etag: meta.etag,
    uploaded: meta.uploaded instanceof Date ? meta.uploaded.toISOString() : meta.uploaded,
    contentType: meta.contentType || contentTypeFor(meta.key),
    kind: classify(entry.role, meta.key),
  };
}

function requireKey(key) {
  const problem = keyProblem(key);
  if (problem) throw new ApiError(400, problem, { code: 'bad-path' });
  return key;
}

function requireWritable(entry, key) {
  const kind = classify(entry.role, requireKey(key));
  if (kind === 'locked') {
    throw new ApiError(403, entry.role === 'drafts'
      ? `${key}: draft stores hold posts (posts/<slug>.md) and their files (posts/, assets/)`
      : `${key} is not editable here: posts go in posts/<slug>.md, files in posts/ or assets/; the site's code is deployed with publish.mjs --site`,
    { code: 'locked' });
  }
  return kind;
}

/** All objects under `prefix` (a missing folder is just empty). */
/** Hidden files (e.g. connection checks) are never listed. */
const visible = (meta) => !meta.key.split('/').some((s) => s.startsWith('.'));

async function listAll(entry, prefix) {
  const items = [];
  let cursor;
  do {
    const page = await entry.store.list(prefix, cursor);
    items.push(...page.items.filter(visible));
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/** The kept folders (from their markers) among `items`, as "a/b/" prefixes. */
function keptFolders(items) {
  const out = [];
  for (const m of items) {
    if (!m.key.endsWith(`/${FOLDER_MARKER}`)) continue;
    const prefix = m.key.slice(0, -FOLDER_MARKER.length);
    if (!folderProblem(prefix)) out.push(prefix);
  }
  return out;
}

async function createFolder(request, stores) {
  const body = await request.json().catch(() => ({}));
  const entry = storeOf(stores, body.store);
  const prefix = String(body.prefix ?? '');
  const problem = folderProblem(prefix);
  if (problem) throw new ApiError(400, problem, { code: 'bad-path' });
  // A file may not use the folder's name, or the name of a folder above it.
  const parts = prefix.slice(0, -1).split('/');
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    if (await entry.store.head(path)) throw new ApiError(409, `${path} is a file, so it cannot be a folder`, { code: 'file-in-path' });
  }
  const marker = `${prefix}${FOLDER_MARKER}`;
  if (!(await entry.store.head(marker))) {
    await entry.store.put(marker, new ArrayBuffer(0), { contentType: 'text/plain; charset=utf-8' });
  }
  return json({ store: entry.id, prefix }, 201);
}

async function deleteFolder(entry, prefix) {
  const problem = folderProblem(prefix ?? '');
  if (problem) throw new ApiError(400, problem, { code: 'bad-path' });
  if ((await listAll(entry, prefix)).length) {
    throw new ApiError(409, 'Only an empty folder can be removed; delete or move its files first', { code: 'not-empty' });
  }
  for (const m of (await entry.store.list(prefix)).items) {
    if (m.key.endsWith(`/${FOLDER_MARKER}`)) await entry.store.delete(m.key);
  }
  return new Response(null, { status: 204 });
}

/** Refuse a new object whose path clashes with a file or folder. */
async function checkPathShape(entry, key) {
  if (await entry.store.head(key)) throw new ApiError(409, `${key} already exists`, { code: 'exists' });
  const below = await entry.store.list(`${key}/`).catch(() => ({ items: [] }));
  if (below.items.length) throw new ApiError(409, `A folder named ${key} already exists`, { code: 'folder-exists' });
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (await entry.store.head(parent)) {
      throw new ApiError(409, `${parent} is a file, so it cannot be a folder`, { code: 'file-in-path' });
    }
  }
}

/**
 * Refuse a new object at `key` in `entry` that would clash: path shape in
 * that store, and for posts the slug in every other store. `ignore` =
 * { store, key } being moved away, which may share the slug.
 */
async function checkNewKey(stores, entry, key, ignore) {
  await checkPathShape(entry, key);
  const slug = postSlug(key);
  if (!slug) return;
  for (const other of stores.values()) {
    if (other === entry || (ignore && ignore.store === other.id && ignore.key === key)) continue;
    if (await other.store.head(key)) {
      throw new ApiError(409, other.role === 'site'
        ? `A published post already uses the slug "${slug}"`
        : `A draft in "${other.label}" already uses the slug "${slug}"; publish or delete it instead`,
      { code: other.role === 'site' ? 'published-exists' : 'draft-exists', store: other.id });
    }
  }
}

async function readBody(request, env) {
  const mb = Number(env.MAX_UPLOAD_MB ?? 25);
  const limit = mb * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, `Files are limited to ${mb} MB`);
  const body = await request.arrayBuffer();
  if (body.byteLength > limit) throw new ApiError(413, `Files are limited to ${mb} MB`);
  return body;
}

const putOpts = (key, ifMatch) => ({
  contentType: contentTypeFor(key),
  cacheControl: cacheControlFor(key),
  ...(ifMatch ? { ifMatch } : {}),
});

function storeOf(stores, id) {
  const entry = stores.get(id ?? 'site');
  if (!entry) throw new ApiError(404, `No store "${id}"`, { code: 'no-store' });
  return entry;
}

/**
 * A post with a password may only reach the site encrypted: refuse its
 * plain text (it would be public), and anything posing as an envelope that
 * still carries the password.
 */
function checkNotPlainProtected(text) {
  const { meta } = parseFrontMatter(text);
  if (wantsPassword(meta)) {
    throw new ApiError(400, 'This post has a password: it must be published encrypted (publish it from the editor)', { code: 'needs-encryption' });
  }
  if (/^(true|yes|1)$/i.test(meta.protected ?? '') && !readProtected(text)) {
    throw new ApiError(400, 'Not a valid encrypted post', { code: 'bad-envelope' });
  }
}

async function writeFile(request, env, stores, entry, key, ofPublished) {
  const kind = requireWritable(entry, key);
  const ifMatch = request.headers.get('if-match');
  const ifNoneMatch = request.headers.get('if-none-match');
  const body = await readBody(request, env);
  if (entry.role === 'site' && kind === 'content') checkNotPlainProtected(new TextDecoder().decode(body));

  if (ifNoneMatch === '*') {
    // The draft of a published post shares its slug with the public copy.
    const own = ofPublished && entry.role === 'drafts' && postSlug(key) ? { store: 'site', key } : undefined;
    await checkNewKey(stores, entry, key, own);
    return json(info(entry, await entry.store.put(key, body, putOpts(key))), 201);
  }
  if (ifMatch) {
    const meta = await entry.store.put(key, body, putOpts(key, stripQuotes(ifMatch)));
    if (!meta) {
      const current = await entry.store.head(key);
      throw new ApiError(412, current
        ? `${key} was changed elsewhere since you opened it`
        : `${key} was deleted elsewhere since you opened it`,
      { code: 'changed', current: current ? info(entry, current) : null });
    }
    return json(info(entry, meta));
  }
  if (kind !== 'generated') {
    throw new ApiError(428, 'Say whether this creates (If-None-Match: *) or updates (If-Match: <etag>) the file',
      { code: 'precondition-required' });
  }
  return json(info(entry, await entry.store.put(key, body, putOpts(key))));
}

async function deleteFile(request, entry, key) {
  requireWritable(entry, key);
  const current = await entry.store.head(key);
  if (!current) throw new ApiError(404, `${key} not found`, { code: 'not-found' });
  const ifMatch = request.headers.get('if-match');
  if (ifMatch && stripQuotes(ifMatch) !== current.etag) {
    throw new ApiError(412, `${key} was changed elsewhere since you opened it`,
      { code: 'changed', current: info(entry, current) });
  }
  await entry.store.delete(key);
  return new Response(null, { status: 204 });
}

function endpoints(body) {
  const { from, to } = body ?? {};
  const norm = (x) => x && typeof x.key === 'string' ? { store: x.store ?? x.bucket ?? 'site', key: x.key } : null;
  return { from: norm(from), to: norm(to) };
}

async function moveFile(request, stores) {
  const body = await request.json().catch(() => ({}));
  const { from, to } = endpoints(body);
  if (!from || !to) throw new ApiError(400, 'Body must be { from: {store, key}, to: {store, key} }');
  const src = storeOf(stores, from.store);
  const dst = storeOf(stores, to.store);
  const fromKind = requireWritable(src, from.key);
  const toKind = requireWritable(dst, to.key);
  if (fromKind === 'generated' || toKind === 'generated') {
    throw new ApiError(403, 'Generated files are rebuilt, not moved', { code: 'locked' });
  }
  if ((postSlug(from.key) !== null) !== (postSlug(to.key) !== null)) {
    throw new ApiError(400, 'A post (posts/<slug>.md) can only move to another post path', { code: 'bad-path' });
  }
  if (postSlug(to.key) && dst.role === 'site' && src.role !== 'site') {
    throw new ApiError(400, 'Publish drafts with /api/publish, which also copies their files', { code: 'use-publish' });
  }
  if (src === dst && from.key === to.key) throw new ApiError(400, 'Source and destination are the same');

  const obj = await src.store.get(from.key);
  if (!obj) throw new ApiError(404, `${from.key} not found`, { code: 'not-found' });
  if (body.ifMatch && stripQuotes(body.ifMatch) !== obj.meta.etag) {
    throw new ApiError(412, `${from.key} was changed elsewhere since you opened it`,
      { code: 'changed', current: info(src, obj.meta) });
  }
  await checkNewKey(stores, dst, to.key, from);
  const written = await dst.store.put(to.key, obj.body, putOpts(to.key));
  await src.store.delete(from.key);
  return json(info(dst, written));
}

async function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', a), crypto.subtle.digest('SHA-256', b)]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  return u.every((n, i) => n === v[i]);
}

/**
 * Publish a draft: copy the files it uses (images, PDFs, …) from its draft
 * store to the site, then copy the post. The draft and its files stay in the
 * draft store as the working copy; publishing again updates the public copy
 * (`siteIfMatch` = the public copy's etag the editor last saw, if any).
 * Nothing is written unless every check passes. A file that is already
 * public is kept when identical; a different one is a conflict unless
 * listed in `overwrite`.
 */
async function publish(request, stores) {
  const body = await request.json().catch(() => ({}));
  const { from } = endpoints(body);
  if (!from) throw new ApiError(400, 'Body must be { from: {store, key}, ifMatch?, overwrite? }');
  const src = storeOf(stores, from.store);
  const site = stores.get('site');
  if (src.role !== 'drafts') throw new ApiError(400, 'Only drafts can be published', { code: 'bad-path' });
  if (!['undefined', 'string'].includes(typeof body.siteIfMatch)) throw new ApiError(400, 'siteIfMatch must be a string');
  if (!postSlug(from.key)) throw new ApiError(400, 'Only posts (posts/<slug>.md) can be published', { code: 'bad-path' });
  const overwrite = new Set(Array.isArray(body.overwrite) ? body.overwrite : []);
  const skip = new Set(Array.isArray(body.skip) ? body.skip : []);

  const post = await src.store.get(from.key);
  if (!post) throw new ApiError(404, `${from.key} not found`, { code: 'not-found' });
  // A post with a password goes public only in the encrypted form the
  // editor made from this very draft (postBody); anything else as is.
  let publicBody = post.body;
  const protectedPost = wantsPassword(parseFrontMatter(new TextDecoder().decode(post.body)).meta);
  if (body.dryRun) {
    // Only planning: nothing is written, so no encrypted form is needed yet.
  } else if (protectedPost) {
    if (typeof body.postBody !== 'string' || !body.postBody.includes(PROTECTED_MARK)) {
      throw new ApiError(400, 'This post has a password: send its encrypted form (postBody)', { code: 'needs-encryption' });
    }
    publicBody = new TextEncoder().encode(body.postBody).buffer;
  } else if (body.postBody !== undefined) {
    throw new ApiError(400, 'postBody is only for posts with a password', { code: 'bad-envelope' });
  }
  if (!body.dryRun) checkNotPlainProtected(new TextDecoder().decode(publicBody));
  if (body.ifMatch && stripQuotes(body.ifMatch) !== post.meta.etag) {
    throw new ApiError(412, `${from.key} was changed elsewhere since you opened it`,
      { code: 'changed', current: info(src, post.meta) });
  }
  const live = await site.store.head(from.key);
  if (!live) {
    await checkNewKey(stores, site, from.key, from);
  } else if (body.siteIfMatch && stripQuotes(body.siteIfMatch) !== live.etag) {
    throw new ApiError(412, `The published ${from.key} was changed elsewhere since you opened it`,
      { code: 'changed', current: info(site, live), published: true });
  }

  // Plan the files: copy, keep (identical), or conflict.
  const plan = [];
  const conflicts = [];
  for (const key of referencedKeys(new TextDecoder().decode(post.body), from.key)) {
    if (classify('drafts', key) !== 'asset') continue;
    const draftFile = await src.store.get(key);
    if (!draftFile) continue; // already public, or simply missing
    if (skip.has(key)) {
      plan.push({ key, action: 'skip', size: draftFile.meta.size });
      continue;
    }
    const publicMeta = await site.store.head(key);
    if (!publicMeta) {
      try {
        await checkPathShape(site, key);
      } catch (err) {
        conflicts.push({ key, reason: err.message });
        continue;
      }
      plan.push({ key, action: 'copy', size: draftFile.meta.size, body: draftFile.body });
    } else if (await sameBytes(draftFile.body, (await site.store.get(key)).body)) {
      plan.push({ key, action: 'identical', size: draftFile.meta.size });
    } else if (overwrite.has(key)) {
      plan.push({ key, action: 'overwrite', size: draftFile.meta.size, body: draftFile.body, ifMatch: publicMeta.etag });
    } else {
      conflicts.push({ key, size: draftFile.meta.size, reason: 'a different file with this name is already public' });
    }
  }
  if (body.dryRun) {
    // What publishing would do, so the admin can choose which files go public.
    return json({
      dryRun: true,
      updated: Boolean(live),
      protected: protectedPost,
      files: [
        ...plan.map(({ key, action, size }) => ({ key, action, size })),
        ...conflicts.map(({ key, size, reason }) => ({ key, action: 'conflict', size, reason })),
      ],
    });
  }
  if (conflicts.length) {
    throw new ApiError(409, `Publishing would replace ${conflicts.length} public file(s) that differ from the draft's`,
      { code: 'asset-conflict', assets: conflicts });
  }

  // Files first, so the post never goes live with missing images.
  for (const step of plan) {
    if (!step.body) continue;
    const written = await site.store.put(step.key, step.body, putOpts(step.key, step.ifMatch));
    if (!written) throw new ApiError(412, `${step.key} changed on the site during publishing; try again`, { code: 'changed' });
  }
  const published = await site.store.put(from.key, publicBody, putOpts(from.key, live && body.siteIfMatch ? live.etag : undefined));
  if (!published) throw new ApiError(412, `The published ${from.key} changed during publishing; try again`, { code: 'changed', published: true });
  return json({
    post: info(site, published),
    draft: info(src, post.meta),
    updated: Boolean(live),
    files: Object.fromEntries(['copy', 'identical', 'overwrite', 'skip'].map((a) => [a, plan.filter((p) => p.action === a).map((p) => p.key)])),
  });
}

/**
 * Copy one attachment from a draft store to the site, at the same path.
 * An identical public file is left alone; a different one needs
 * `overwrite` (and `ifMatch`, the public copy's etag, when known).
 */
async function copyToSite(request, stores) {
  const body = await request.json().catch(() => ({}));
  const { from } = endpoints(body);
  if (!from) throw new ApiError(400, 'Body must be { from: {store, key}, overwrite?, ifMatch? }');
  const src = storeOf(stores, from.store);
  const site = stores.get('site');
  if (src.role !== 'drafts') throw new ApiError(400, 'Copy from a draft store', { code: 'bad-path' });
  requireKey(from.key);
  if (classify('site', from.key) !== 'asset') {
    throw new ApiError(400, postSlug(from.key) ? 'Publish posts from the editor' : `${from.key} cannot be public`,
      { code: postSlug(from.key) ? 'use-publish' : 'bad-path' });
  }
  const file = await src.store.get(from.key);
  if (!file) throw new ApiError(404, `${from.key} not found`, { code: 'not-found' });
  const current = await site.store.head(from.key);
  if (!current) {
    await checkPathShape(site, from.key);
    return json({ action: 'copy', file: info(site, await site.store.put(from.key, file.body, putOpts(from.key))) }, 201);
  }
  if (await sameBytes(file.body, (await site.store.get(from.key)).body)) return json({ action: 'identical', file: info(site, current) });
  if (!body.overwrite) {
    throw new ApiError(409, `A different ${from.key} is already public`, { code: 'exists', current: info(site, current) });
  }
  const ifMatch = body.ifMatch ? stripQuotes(body.ifMatch) : current.etag;
  const written = await site.store.put(from.key, file.body, putOpts(from.key, ifMatch));
  if (!written) throw new ApiError(412, `The public ${from.key} was changed elsewhere`, { code: 'changed', current: info(site, current) });
  return json({ action: 'overwrite', file: info(site, written) });
}

function bodyResponse(key, obj) {
  const type = contentTypeFor(key);
  return new Response(obj.body, {
    headers: {
      // HTML and XML are shown as text in the admin, never run in its origin.
      'content-type': /^(text\/html|application\/xml)/.test(type) ? 'text/plain; charset=utf-8' : type,
      etag: `"${obj.meta.etag}"`,
      'x-object-etag': obj.meta.etag,
    },
  });
}

async function readFile(stores, storeId, key, fallbackToSite) {
  requireKey(key);
  const entry = storeOf(stores, storeId);
  let obj = await entry.store.get(key);
  if (!obj && fallbackToSite && entry.role === 'drafts' && classify('drafts', key) === 'asset') {
    obj = await stores.get('site').store.get(key);
  }
  if (!obj) throw new ApiError(404, `${key} not found`, { code: 'not-found' });
  return bodyResponse(key, obj);
}

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

/** Every post in every store, with the front matter the posts list shows. */
async function listPosts(stores) {
  const out = [];
  let siteMeta = new Map();
  const site = stores.get('site');
  const index = await site.store.get('index.json').catch(() => null);
  if (index) {
    try {
      const doc = JSON.parse(new TextDecoder().decode(index.body));
      siteMeta = new Map((doc.items ?? []).filter((e) => e?.path && e.metadata).map((e) => [e.path, e]));
    } catch {}
  }
  const problems = [...stores.problems];
  for (const entry of stores.values()) {
    let items;
    try {
      items = (await listAll(entry, 'posts/')).filter((i) => postSlug(i.key));
    } catch (err) {
      // One unreachable draft store must not hide every other post.
      if (!(err instanceof StoreAccessError) || entry.role === 'site') throw err;
      problems.push({ store: entry.id, error: err.message });
      continue;
    }
    await Promise.all(items.map(async (item) => {
      let meta = entry.role === 'site' && siteMeta.get(item.key)?.etag === item.etag ? siteMeta.get(item.key).metadata : null;
      if (!meta) {
        const obj = await entry.store.get(item.key);
        meta = obj ? frontMatter(new TextDecoder().decode(obj.body)) : {};
      }
      out.push({
        ...info(entry, item),
        status: entry.role === 'site' ? 'published' : 'draft',
        title: String(meta.title || postSlug(item.key)).slice(0, 200),
        date: /^\d{4}-\d{2}-\d{2}/.test(meta.date ?? '') ? meta.date.slice(0, 10) : '',
        tags: String(meta.tags ?? ''),
      });
    }));
  }
  return json({ posts: out, problems });
}

async function indexNow(request, stores) {
  const { urls } = await request.json().catch(() => ({}));
  const site = stores.get('site').store;
  const index = await site.get('index.json');
  let cfg = {};
  try {
    cfg = index ? JSON.parse(new TextDecoder().decode(index.body)).site ?? {} : {};
  } catch {}
  const base = String(cfg.url ?? '').replace(/\/?$/, '/');
  const key = String(cfg.indexNowKey ?? '');
  if (!/^https?:\/\//.test(base) || !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new ApiError(400, 'Set "url" and "indexNowKey" in the site settings first');
  }
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u.startsWith(base)).slice(0, 1000);
  if (!list.length) throw new ApiError(400, 'No URLs of this site to submit');
  if (!(await site.head(`${key}.txt`))) {
    await site.put(`${key}.txt`, new TextEncoder().encode(key).buffer, { contentType: 'text/plain; charset=utf-8' });
  }
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(base).host, key, keyLocation: `${base}${key}.txt`, urlList: list }),
  });
  return json({ status: res.status, submitted: list.length }, res.ok ? 200 : 502);
}

/* ---------- Storage page ---------- */

const MAX_SAVED_STORES = 20;

async function storageView(env, stores) {
  const saved = await readSaved(env);
  return {
    kv: Boolean(env.SETTINGS),
    version: saved.version,
    types: STORE_TYPES,
    deployed: [...stores.values()].filter((e) => e.role === 'drafts' && e.location === 'deploy')
      .map(({ id, label, type }) => ({ id, label, type })),
    stores: saved.stores.map(publicStore),
    problems: stores.problems,
  };
}

function checkedStore(input, previous) {
  try {
    return normalizeStore(input, previous);
  } catch (err) {
    if (err instanceof StoreConfigError) throw new ApiError(400, err.message, { code: 'bad-store' });
    throw err;
  }
}

async function saveStorage(request, env, stores) {
  if (!env.SETTINGS) throw new ApiError(400, 'This deploy has no SETTINGS KV namespace; keep storage in this browser instead', { code: 'no-kv' });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.stores)) throw new ApiError(400, 'Send { version, stores: [...] }');
  if (body.stores.length > MAX_SAVED_STORES) throw new ApiError(400, `At most ${MAX_SAVED_STORES} stores`);
  const saved = await readSaved(env);
  const changed = () => new ApiError(412, 'The storage settings were changed elsewhere; reload them', { code: 'changed' });
  if (Number(body.version) !== saved.version) throw changed();
  const previous = new Map(saved.stores.map((s) => [s.id, s]));
  const taken = new Set([...stores.values()].filter((e) => e.location === 'deploy').map((e) => e.id));
  const out = [];
  for (const input of body.stores) {
    const cfg = checkedStore(input, previous.get(input?.id));
    if (taken.has(cfg.id)) throw new ApiError(409, `The id "${cfg.id}" is already used`, { code: 'exists' });
    taken.add(cfg.id);
    out.push(cfg);
  }
  if (!(await writeSaved(env, out, saved.version))) throw changed();
  return json(await storageView(env, await openStores(env, request)));
}

/**
 * Try a store's settings: list it and, except for GitHub, write and delete
 * a file. Empty secrets of a store saved in KV keep their saved values;
 * browser stores send their secrets.
 */
async function testStorage(request, env) {
  const body = await request.json().catch(() => null);
  const saved = body?.location === 'kv' ? (await readSaved(env)).stores.find((s) => s.id === body?.store?.id) : undefined;
  const cfg = checkedStore(body?.store, saved);
  // Browser stores are validated here before the browser keeps them; their
  // secrets came from the browser, so echoing them back reveals nothing.
  if (body?.check && body.location === 'browser') return json({ ok: true, store: cfg });
  const store = await openStore(cfg, env);
  try {
    const posts = (await store.list('posts/')).items.filter((m) => postSlug(m.key)).length;
    // GitHub would record the check as two commits; reading is enough there.
    if (cfg.type !== 'github') {
      const probe = `.md4c-admin-check-${Date.now()}.txt`;
      await store.put(probe, new TextEncoder().encode('ok').buffer, { contentType: 'text/plain; charset=utf-8' });
      await store.delete(probe);
    }
    return json({ ok: true, posts, wrote: cfg.type !== 'github' });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

/** Route an /api request. `user` is the verified Access identity. */
export async function handleApi(request, env, user) {
  const url = new URL(request.url);
  const q = (k) => url.searchParams.get(k);
  const storeParam = q('store') ?? q('bucket') ?? 'site';
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // CSRF: a cross-site page cannot add this header, and browsers mark
      // cross-site requests in Sec-Fetch-Site / Origin.
      const fetchSite = request.headers.get('sec-fetch-site');
      const origin = request.headers.get('origin');
      if (request.headers.get('x-admin-request') !== '1' || (fetchSite && fetchSite !== 'same-origin') ||
          (origin && origin !== url.origin)) {
        throw new ApiError(403, 'Cross-site request refused', { code: 'csrf' });
      }
    }
    const stores = await openStores(env, request);
    const raw = /^\/api\/raw\/([a-z][a-z0-9-]{0,30})\/(.+)$/.exec(url.pathname);
    if (raw && request.method === 'GET') {
      return await readFile(stores, raw[1], decodeURIComponent(raw[2]), true);
    }
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/session':
        return json({
          email: user.email,
          publicUrl: String(env.PUBLIC_URL ?? ''),
          stores: [...stores.values()].map(({ id, label, role, type, location }) => ({ id, label, role, type, location })),
          kv: Boolean(env.SETTINGS),
          problems: stores.problems,
          maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 25),
        });
      case 'GET /api/posts':
        return await listPosts(stores);
      case 'GET /api/list': {
        const entry = storeOf(stores, storeParam);
        const page = await entry.store.list(q('prefix') ?? '', q('cursor') || undefined);
        return json({
          items: page.items.filter(visible).map((m) => info(entry, m)),
          folders: keptFolders(page.items),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        });
      }
      case 'GET /api/file':
        return await readFile(stores, storeParam, q('key'), false);
      case 'PUT /api/file':
        return await writeFile(request, env, stores, storeOf(stores, storeParam), q('key'), q('ofPublished') === '1');
      case 'DELETE /api/file':
        return await deleteFile(request, storeOf(stores, storeParam), q('key'));
      case 'POST /api/move':
        return await moveFile(request, stores);
      case 'POST /api/publish':
        return await publish(request, stores);
      case 'POST /api/copy':
        return await copyToSite(request, stores);
      case 'POST /api/folder':
        return await createFolder(request, stores);
      case 'DELETE /api/folder':
        return await deleteFolder(storeOf(stores, storeParam), q('prefix'));
      case 'POST /api/indexnow':
        return await indexNow(request, stores);
      case 'GET /api/storage':
        return json(await storageView(env, stores));
      case 'PUT /api/storage':
        return await saveStorage(request, env, stores);
      case 'POST /api/storage/test':
        return await testStorage(request, env);
      default:
        throw new ApiError(404, 'No such API route');
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message, ...err.extra }, err.status);
    if (err instanceof StoreAccessError) return json({ error: err.message, code: 'store-unreachable' }, 502);
    if (err instanceof StoreConfigError) return json({ error: `Storage configuration: ${err.message}`, code: 'config' }, 500);
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
}
