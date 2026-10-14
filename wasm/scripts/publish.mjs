#!/usr/bin/env node
// Publish the blog to any storagesdk backend. This is the owner's tool: it
// runs on the owner's machine with write credentials, while visitors only
// ever read the result through a public, read-only URL.
//
//   node scripts/publish.mjs [options]
//
//   --to <adapter>   storagesdk adapter: r2, s3, fs, gcs, ... (default:
//                    $STORAGE_ADAPTER, else "fs"). Configured with the
//                    adapter's env vars, e.g. R2_BUCKET, R2_ACCOUNT_ID,
//                    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. For "fs",
//                    FS_ROOT/FS_FOLDER default to dist/ and "public".
//   --posts <dir>    upload the Markdown posts in <dir> (default blog/posts)
//   --no-posts       do not upload posts; only rebuild index.json
//   --site           also upload the site itself (dist/blog; run the build first)
//   --prune          delete published posts that are not in <dir>
//   --dry-run        print what would change, change nothing
//
// Posts with `draft: true` in their front matter are not published (and are
// removed from storage if they were published before).
//
// Writing files straight into the bucket (dashboard, rclone, the storagesdk
// CLI, ...) works too; run with --no-posts afterwards to refresh index.json,
// which is how visitors' browsers find the posts.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Storage, StorageError } from '@storagesdk/core';
import { ADAPTERS, buildAdapter, getAdapterEnvVars } from '@storagesdk/adapters';
import { contentTypeFor } from '../js/md4c-fs.js';
import { Dialect, loadMd4c } from '../js/md4c.js';
import { isDraft, parseFrontMatter, postMetadata, SLUG_RE } from '../js/post-format.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX = 'index.json';
const NO_CACHE = 'no-cache';

const { values: args } = parseArgs({
  options: {
    to: { type: 'string', default: process.env.STORAGE_ADAPTER ?? 'fs' },
    posts: { type: 'string', default: join(root, 'blog', 'posts') },
    'no-posts': { type: 'boolean', default: false },
    site: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const dry = args['dry-run'];
const log = (msg) => console.log(dry ? `[dry-run] ${msg}` : msg);

async function openStorage(name) {
  if (!ADAPTERS.includes(name)) throw new Error(`unknown adapter "${name}"; one of: ${ADAPTERS.join(', ')}`);
  if (name === 'fs') {
    process.env.FS_ROOT ??= join(root, 'dist');
    process.env.FS_FOLDER ??= 'public';
  }
  const missing = getAdapterEnvVars(name).filter((v) => v.required && !process.env[v.name]);
  if (missing.length) throw new Error(`set ${missing.map((v) => v.name).join(', ')} for the ${name} adapter`);
  return new Storage({ adapter: await buildAdapter(name) });
}

async function listAll(storage, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await storage.list({ prefix, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function upload(storage, path, body, contentType) {
  log(`upload ${path}`);
  if (!dry) await storage.upload(path, body, { contentType, cacheControl: NO_CACHE });
}

async function remove(storage, path) {
  log(`delete ${path}`);
  if (!dry) await storage.delete(path);
}

async function uploadSite(storage) {
  const site = join(root, 'dist', 'blog');
  for await (const file of walk(site)) {
    const key = relative(site, file).split(sep).join('/');
    await upload(storage, key, await readFile(file), contentTypeFor(key));
  }
}

async function uploadPosts(storage, dir) {
  const published = new Set();
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    if (!SLUG_RE.test(slug)) {
      console.warn(`skip ${name}: file names must be lowercase letters, digits and dashes`);
      continue;
    }
    const source = await readFile(join(dir, name), 'utf8');
    const path = `posts/${slug}.md`;
    if (isDraft(parseFrontMatter(source).meta)) {
      if (await exists(storage, path)) await remove(storage, path);
      else log(`skip draft ${name}`);
      continue;
    }
    published.add(path);
    await upload(storage, path, source, contentTypeFor(path));
  }
  if (args.prune) {
    for (const item of await listAll(storage, 'posts/')) {
      if (!published.has(item.path)) await remove(storage, item.path);
    }
  }
}

async function exists(storage, path) {
  try {
    await storage.head(path);
    return true;
  } catch (err) {
    if (err instanceof StorageError && err.code === 'NotFound') return false;
    throw err;
  }
}

/** Rebuild index.json from the posts that are actually in storage. */
async function writeIndex(storage, md4c) {
  const render = (md) => md4c.toHtml(md, { parserFlags: Dialect.GITHUB });
  const items = [];
  for (const item of await listAll(storage, 'posts/')) {
    const m = /^posts\/(.+)\.md$/.exec(item.path);
    if (!m || !SLUG_RE.test(m[1])) continue;
    const full = await storage.download(item.path);
    const source = new TextDecoder().decode(full.body);
    if (isDraft(parseFrontMatter(source).meta)) {
      console.warn(`warning: ${item.path} is a draft but publicly readable in storage`);
      continue;
    }
    items.push({
      path: item.path,
      size: full.size,
      contentType: 'text/markdown; charset=utf-8',
      etag: full.etag,
      lastModified: full.lastModified.toISOString(),
      metadata: postMetadata(source, render, m[1]),
    });
  }
  const index = { version: 1, generated: new Date().toISOString(), items };
  await upload(storage, INDEX, `${JSON.stringify(index, null, 2)}\n`, 'application/json');
  return items.length;
}

const storage = await openStorage(args.to);
const md4c = await loadMd4c(pathToFileURL(join(root, 'dist', 'md4c.wasm')));
console.log(`Publishing to ${args.to}${args.to === 'fs' ? ` (${resolve(process.env.FS_ROOT, process.env.FS_FOLDER)})` : ''}`);

if (args.site) await uploadSite(storage);
if (!args['no-posts']) await uploadPosts(storage, resolve(args.posts));
const n = dry ? '?' : await writeIndex(storage, md4c);
console.log(`Done: ${n} published post(s) in ${INDEX}.`);
