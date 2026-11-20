// A read-only storagesdk adapter for files behind a plain public URL, such
// as a Cloudflare R2 bucket with public access, an S3 static website or any
// static file server.
//
// Guests get read access only: every write method throws `NotSupported`,
// and the real protection is that the bucket's public URL is read-only.
// Only the owner holds write credentials, on their own machine (see
// scripts/publish.mjs).
//
// A public bucket URL cannot list its contents, so list() and head() use an
// index file (default "index.json"). scripts/publish.mjs writes a full one:
//
//   { "version": 1, "generated": "...", "items": [
//       { "path": "posts/hello.md", "size": 123, "contentType": "...",
//         "etag": "...", "lastModified": "...", "metadata": { ... } } ] }
//
// but a hand-written list of paths is enough, so files uploaded straight to
// the bucket can be listed by editing index.json alone:
//
//   ["posts/hello.md", "posts/second-post.md"]
//
// A missing index.json just lists nothing; download() works without it.
//
// Other top-level fields (such as the blog's "site" settings) are kept and
// available through `adapter.raw.document()`.
//
//   const storage = new Storage({ adapter: urlAdapter({ baseUrl: 'https://pub-xxxx.r2.dev/' }) });

import { defineAdapter, StorageError } from '@storagesdk/core/adapter';

function readOnly(what) {
  return async () => {
    throw new StorageError({
      code: 'NotSupported',
      message: `${what}: this storage is read-only`,
    });
  };
}

function checkPath(path) {
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new StorageError({ code: 'InvalidArgument', message: `invalid path: ${path}` });
  }
  return path;
}

// Hand-written entries may carry their details at the top level:
//   { "path": "posts/a.md", "title": "A", "date": "2026-10-14", "tags": ["x", "y"] }
const ENTRY_FIELDS = ['title', 'date', 'tags', 'excerpt', 'description', 'author', 'image', 'updated'];

function entryMetadata(entry) {
  if (entry.metadata) return entry.metadata;
  const meta = {};
  for (const k of ENTRY_FIELDS) {
    const v = entry[k];
    if (typeof v === 'string') meta[k] = v;
    else if (k === 'tags' && Array.isArray(v)) meta.tags = v.filter((t) => typeof t === 'string').join(', ');
  }
  return Object.keys(meta).length ? meta : undefined;
}

function toMeta(entry) {
  const metadata = entryMetadata(entry);
  return {
    path: entry.path,
    size: entry.size ?? 0,
    contentType: entry.contentType ?? 'application/octet-stream',
    etag: entry.etag ?? '',
    lastModified: new Date(entry.lastModified ?? 0),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * @param {{ baseUrl?: string|URL, indexPath?: string, fetch?: typeof fetch }} [opts]
 *        `baseUrl` defaults to the directory of the current page.
 */
export function urlAdapter(opts = {}) {
  const base = new URL(
    opts.baseUrl ?? './',
    globalThis.location?.href ?? 'http://localhost/'
  );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const indexPath = opts.indexPath ?? 'index.json';
  const doFetch = opts.fetch ?? ((...a) => fetch(...a));
  let indexPromise;
  let indexDocument = {};

  const fileUrl = (path) =>
    new URL(checkPath(path).split('/').map(encodeURIComponent).join('/'), base).href;

  async function get(path, signal) {
    const res = await doFetch(fileUrl(path), { signal, cache: 'no-cache' });
    if (res.status === 404 || res.status === 403) {
      // Public buckets answer 403 or 404 for missing keys.
      throw new StorageError({ code: 'NotFound', message: `${path} not found` });
    }
    if (!res.ok) {
      throw new StorageError({ code: 'Provider', message: `${path}: HTTP ${res.status}` });
    }
    return res;
  }

  /** The published index, fetched once per adapter (call refresh() to reload). */
  function loadIndex(signal) {
    indexPromise ??= get(indexPath, signal)
      .then((res) => res.json())
      .then((idx) => {
        indexDocument = Array.isArray(idx) ? { items: idx } : (idx ?? {});
        const items = Array.isArray(idx) ? idx : (idx.items ?? []);
        const entries = items
          .map((e) => (typeof e === 'string' ? { path: e } : e))
          .filter((e) => typeof e?.path === 'string')
          .map((e) => ({ ...e, path: e.path.replace(/^\/+/, '') }));
        return new Map(entries.map((e) => [e.path, e]));
      })
      .catch((err) => {
        if (err instanceof StorageError && err.code === 'NotFound') return new Map();
        throw err;
      })
      .catch((err) => {
        indexPromise = undefined;
        throw err;
      });
    return indexPromise;
  }

  const adapter = defineAdapter({
    name: 'url',
    raw: {
      baseUrl: base.href,
      refresh: () => { indexPromise = undefined; },
      /** The whole parsed index.json ({} when there is none). */
      document: async (signal) => {
        await loadIndex(signal);
        return indexDocument;
      },
    },

    async download(path, o) {
      const res = await get(path, o?.signal);
      let body = new Uint8Array(await res.arrayBuffer());
      if (o?.range) body = body.slice(o.range.offset, o.range.offset + o.range.length);
      const entry = (await loadIndex(o?.signal).catch(() => new Map())).get(path);
      return {
        ...toMeta({
          path,
          contentType: res.headers.get('content-type') ?? undefined,
          etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
          lastModified: res.headers.get('last-modified') ?? undefined,
          ...entry,
        }),
        size: body.byteLength,
        body,
      };
    },

    async head(path, o) {
      const entry = (await loadIndex(o?.signal)).get(checkPath(path));
      if (!entry) throw new StorageError({ code: 'NotFound', message: `${path} not found` });
      return toMeta(entry);
    },

    async list(o) {
      const prefix = o?.prefix ?? '';
      const limit = o?.limit ?? 1000;
      const all = [...(await loadIndex(o?.signal)).values()]
        .filter((e) => e.path.startsWith(prefix) && (o?.cursor === undefined || e.path > o.cursor))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const items = all.slice(0, limit).map(toMeta);
      return all.length > limit ? { items, cursor: items[items.length - 1].path } : { items };
    },

    async url(path) {
      return fileUrl(path);
    },

    upload: readOnly('upload'),
    delete: readOnly('delete'),
    copy: readOnly('copy'),
    move: readOnly('move'),
    uploadUrl: readOnly('uploadUrl'),
    snapshots: {
      create: readOnly('snapshots'),
      list: async () => [],
      head: readOnly('snapshots'),
      delete: readOnly('snapshots'),
      get: () => ({
        download: readOnly('snapshots'),
        head: readOnly('snapshots'),
        list: readOnly('snapshots'),
        url: readOnly('snapshots'),
      }),
    },
    forks: {
      create: readOnly('forks'),
      list: async () => [],
      head: readOnly('forks'),
      delete: readOnly('forks'),
      get: () => {
        throw new StorageError({ code: 'NotSupported', message: 'forks: this storage is read-only' });
      },
      merge: readOnly('forks'),
      rebase: readOnly('forks'),
      diff: readOnly('forks'),
    },
  });
  return adapter;
}
