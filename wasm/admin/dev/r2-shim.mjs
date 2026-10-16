// A stand-in for a Workers R2 bucket binding, for tests and local
// development, built on storagesdk (fs adapter): the admin Worker runs in
// Node and writes into a plain folder that any static server can serve as
// the "public bucket".
//
// Implements the subset of R2Bucket the Worker uses: head, get (with
// range), put (with onlyIf.etagMatches and customMetadata), delete, list
// (prefix/cursor/limit/delimiter, include customMetadata). Custom metadata
// is kept in memory, for the object version it was written with.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Storage, StorageError } from '@storagesdk/core';
import { fs as fsAdapter } from '@storagesdk/adapters/fs';

function toObject(meta) {
  return {
    key: meta.path,
    size: meta.size,
    etag: meta.etag,
    httpEtag: `"${meta.etag}"`,
    uploaded: meta.lastModified,
    httpMetadata: { contentType: meta.contentType },
  };
}

export function r2Bucket(root, folder) {
  const storage = new Storage({ adapter: fsAdapter({ root, folder }) });
  const custom = new Map(); // key -> { etag, meta }
  const head = async (key) => {
    // R2 has no directories; the fs adapter would describe one as an object.
    if (!(await stat(join(root, folder, key)).then((st) => st.isFile(), () => false))) return null;
    try {
      const o = toObject(await storage.head(key));
      const c = custom.get(key);
      if (c && c.etag === o.etag) o.customMetadata = c.meta;
      return o;
    } catch (err) {
      if (err instanceof StorageError && (err.code === 'NotFound' || err.code === 'InvalidArgument')) return null;
      throw err;
    }
  };
  return {
    storage,
    head,
    async get(key, opts = {}) {
      const obj = await head(key);
      if (!obj) return null;
      let bytes = await storage.download(key, { as: 'bytes' });
      if (opts.range) bytes = bytes.subarray(opts.range.offset ?? 0, (opts.range.offset ?? 0) + (opts.range.length ?? bytes.length));
      return {
        ...obj,
        get body() {
          return new Blob([bytes]).stream();
        },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    async put(key, value, opts = {}) {
      if (opts.onlyIf?.etagMatches !== undefined) {
        const current = await head(key);
        if (!current || current.etag !== opts.onlyIf.etagMatches) return null;
      }
      const body = typeof value === 'string' ? value : new Uint8Array(value);
      await storage.upload(key, body, { contentType: opts.httpMetadata?.contentType });
      custom.delete(key);
      const written = await head(key);
      if (written && opts.customMetadata) {
        custom.set(key, { etag: written.etag, meta: { ...opts.customMetadata } });
        written.customMetadata = { ...opts.customMetadata };
      }
      return written;
    },
    async delete(keys) {
      for (const key of [].concat(keys)) await storage.delete(key).catch(() => {});
    },
    async list({ prefix = '', cursor, limit = 1000, delimiter } = {}) {
      const page = await storage.list({ prefix, limit: delimiter ? 100000 : limit, ...(cursor ? { cursor } : {}) });
      let items = page.items;
      const delimitedPrefixes = new Set();
      if (delimiter) {
        // Keys below the next "/" collapse into their folder, as R2 does.
        items = items.filter((i) => {
          const rest = i.path.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at === -1) return true;
          delimitedPrefixes.add(prefix + rest.slice(0, at + 1));
          return false;
        });
      }
      // head() for each, so etags match what head/get report.
      const objects = (await Promise.all(items.map((i) => head(i.path)))).filter(Boolean);
      return {
        objects, truncated: !delimiter && Boolean(page.cursor), ...(!delimiter && page.cursor ? { cursor: page.cursor } : {}),
        delimitedPrefixes: [...delimitedPrefixes].sort(),
      };
    },
  };
}
