// A stand-in for a Workers R2 bucket binding, for tests and local
// development, built on storagesdk (fs adapter): the admin Worker runs in
// Node and writes into a plain folder that any static server can serve as
// the "public bucket".
//
// Implements the subset of R2Bucket the Worker uses: head, get, put (with
// onlyIf.etagMatches), delete, list (prefix/cursor/limit).

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
  const head = async (key) => {
    // R2 has no directories; the fs adapter would describe one as an object.
    if (!(await stat(join(root, folder, key)).then((st) => st.isFile(), () => false))) return null;
    try {
      return toObject(await storage.head(key));
    } catch (err) {
      if (err instanceof StorageError && (err.code === 'NotFound' || err.code === 'InvalidArgument')) return null;
      throw err;
    }
  };
  return {
    storage,
    head,
    async get(key) {
      const obj = await head(key);
      if (!obj) return null;
      const bytes = await storage.download(key, { as: 'bytes' });
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
      return head(key);
    },
    async delete(keys) {
      for (const key of [].concat(keys)) await storage.delete(key).catch(() => {});
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const page = await storage.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
      // head() for each, so etags match what head/get report.
      const objects = (await Promise.all(page.items.map((i) => head(i.path)))).filter(Boolean);
      return { objects, truncated: Boolean(page.cursor), ...(page.cursor ? { cursor: page.cursor } : {}), delimitedPrefixes: [] };
    },
  };
}
