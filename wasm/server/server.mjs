#!/usr/bin/env node
// Blog server: serves the static site (dist/blog) and the posts API.
//
//   node server/server.mjs
//
// Environment:
//   PORT             listen port (default 8080)
//   HOST             listen address (default 127.0.0.1)
//   BLOG_DATA_DIR    where posts and the admin password live (default ./data)
//   BLOG_STATIC_DIR  the assembled site (default ./dist/blog)
//   COOKIE_SECURE=1  mark the session cookie Secure (set this behind HTTPS)
//   TRUST_PROXY=1    use X-Forwarded-For for login rate limiting
//
// Set the admin password first:  node scripts/set-admin-password.mjs

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Storage } from '@storagesdk/core';
import { fs as fsAdapter } from '@storagesdk/adapters/fs';
import { Dialect, loadMd4c } from '../js/md4c.js';
import { postMetadata } from '../js/post-format.js';
import { createApp } from './app.mjs';
import { readAdminRecord } from './auth.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = resolve(process.env.BLOG_DATA_DIR ?? join(root, 'data'));
const staticDir = resolve(process.env.BLOG_STATIC_DIR ?? join(root, 'dist', 'blog'));
const adminFile = join(dataDir, 'admin.json');

export function openStorage(dir) {
  return new Storage({ adapter: fsAdapter({ root: dir, folder: 'content' }) });
}

/** Import blog/posts/*.md as published posts when the store is empty. */
export async function seedSamplePosts(storage, samplesDir, md4c) {
  const existing = await storage.list({ limit: 1 });
  if (existing.items.length > 0) return 0;
  let count = 0;
  for (const name of await readdir(samplesDir)) {
    if (!name.endsWith('.md')) continue;
    const source = await readFile(join(samplesDir, name), 'utf8');
    const slug = name.slice(0, -3);
    await storage.upload(`posts/${slug}.md`, source, {
      contentType: 'text/markdown; charset=utf-8',
      metadata: postMetadata(source, (md) => md4c.toHtml(md, { parserFlags: Dialect.GITHUB }), slug),
    });
    count++;
  }
  return count;
}

async function main() {
  await mkdir(join(dataDir, 'content'), { recursive: true });
  const storage = openStorage(dataDir);
  const md4c = await loadMd4c(pathToFileURL(join(root, 'dist', 'md4c.wasm')));
  const seeded = await seedSamplePosts(storage, join(root, 'blog', 'posts'), md4c);
  if (seeded) console.log(`Imported ${seeded} sample posts.`);

  if (!(await readAdminRecord(adminFile)))
    console.warn('No admin password set: the blog is read-only until you run\n' +
      '  node scripts/set-admin-password.mjs');

  const handler = createApp({
    storage,
    staticDir,
    adminFile: () => readAdminRecord(adminFile),
    secureCookies: process.env.COOKIE_SECURE === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
  });

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  createServer(handler).listen(port, host, () =>
    console.log(`Blog at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (data: ${dataDir})`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
