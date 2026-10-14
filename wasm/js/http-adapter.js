// A storagesdk adapter that reads and writes files through the blog
// server's /api/files endpoints (see server/app.mjs).
//
// The server decides who may do what: guests get read-only access to
// published posts, and writes need the admin session cookie plus the CSRF
// token passed in here. Snapshots and forks are not offered over HTTP.

import { bodyToBytes, defineAdapter, StorageError } from '@storagesdk/core/adapter';

function errorCode(status) {
  if (status === 404) return 'NotFound';
  if (status === 401 || status === 403) return 'Unauthorized';
  if (status === 409) return 'Conflict';
  if (status === 400 || status === 413 || status === 415) return 'InvalidArgument';
  return 'Provider';
}

async function check(res) {
  if (res.ok) return res;
  let message = `${res.status} ${res.statusText}`;
  try {
    message = (await res.json()).error ?? message;
  } catch {}
  throw new StorageError({ code: errorCode(res.status), message });
}

function fromJsonMeta(m) {
  return { ...m, lastModified: new Date(m.lastModified) };
}

function notSupported(what) {
  return async () => {
    throw new StorageError({ code: 'NotSupported', message: `${what} is not available over HTTP` });
  };
}

/**
 * @param {{ baseUrl?: string, csrfToken?: () => string|undefined,
 *           fetch?: typeof fetch }} [opts]
 */
export function httpAdapter(opts = {}) {
  const base = (opts.baseUrl ?? '/api').replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((...a) => fetch(...a));
  const fileUrl = (path) => `${base}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  const writeHeaders = (extra = {}) => {
    const token = opts.csrfToken?.();
    return { ...(token ? { 'x-csrf-token': token } : {}), ...extra };
  };
  const send = (url, init) =>
    doFetch(url, { credentials: 'same-origin', ...init }).then(check);

  return defineAdapter({
    name: 'http',
    raw: { baseUrl: base },

    async download(path, o) {
      const res = await send(fileUrl(path), { signal: o?.signal });
      let body = new Uint8Array(await res.arrayBuffer());
      if (o?.range) body = body.slice(o.range.offset, o.range.offset + o.range.length);
      const meta = res.headers.get('x-storage-metadata');
      return {
        path,
        size: body.byteLength,
        contentType: 'text/markdown; charset=utf-8',
        etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
        lastModified: new Date(res.headers.get('last-modified') ?? 0),
        ...(meta ? { metadata: JSON.parse(decodeURIComponent(meta)) } : {}),
        body,
      };
    },

    async head(path, o) {
      const res = await send(`${fileUrl(path)}?meta`, { signal: o?.signal });
      return fromJsonMeta(await res.json());
    },

    async list(o) {
      const q = new URLSearchParams();
      if (o?.prefix) q.set('prefix', o.prefix);
      if (o?.cursor) q.set('cursor', o.cursor);
      if (o?.limit) q.set('limit', String(o.limit));
      const res = await send(`${base}/files?${q}`, { signal: o?.signal });
      const page = await res.json();
      return { items: page.items.map(fromJsonMeta), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    async url(path) {
      return new URL(fileUrl(path), globalThis.location?.href ?? 'http://localhost/').href;
    },

    async upload(path, body, o) {
      const headers = writeHeaders({ 'content-type': 'text/markdown; charset=utf-8' });
      if (o?.metadata) headers['x-storage-metadata'] = encodeURIComponent(JSON.stringify(o.metadata));
      const res = await send(fileUrl(path), {
        method: 'PUT',
        headers,
        body: await bodyToBytes(body),
        signal: o?.signal,
      });
      return fromJsonMeta(await res.json());
    },

    async delete(path, o) {
      await send(fileUrl(path), { method: 'DELETE', headers: writeHeaders(), signal: o?.signal });
    },

    async move(from, to, o) {
      await send(`${base}/move`, {
        method: 'POST',
        headers: writeHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ from, to }),
        signal: o?.signal,
      });
    },

    copy: notSupported('copy'),
    uploadUrl: notSupported('uploadUrl'),
    snapshots: {
      create: notSupported('snapshots'),
      list: notSupported('snapshots'),
      head: notSupported('snapshots'),
      delete: notSupported('snapshots'),
      get: () => ({
        download: notSupported('snapshots'),
        head: notSupported('snapshots'),
        list: notSupported('snapshots'),
        url: notSupported('snapshots'),
      }),
    },
    forks: {
      create: notSupported('forks'),
      list: notSupported('forks'),
      head: notSupported('forks'),
      delete: notSupported('forks'),
      get: () => {
        throw new StorageError({ code: 'NotSupported', message: 'forks are not available over HTTP' });
      },
      merge: notSupported('forks'),
      rebase: notSupported('forks'),
      diff: notSupported('forks'),
    },
  });
}
