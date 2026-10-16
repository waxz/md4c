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
//   --posts <dir>    upload the Markdown posts in <dir> (default blog/posts),
//                    plus any images and other files next to them
//   --no-posts       do not upload posts; only rebuild index.json and pages
//   --site           also upload the site itself (dist/blog; run the build first)
//   --prune          delete published posts that are not in <dir>
//   --config <file>  set index.json's "site" section (title, slogan, theme,
//                    ...) from a JSON file. Without it the existing section
//                    is kept; on first publish blog/site.json is used.
//   --site-url <url> the blog's public address; stored as the "site" url
//                    when the settings have none yet (canonical links,
//                    sitemap, feed). Settings that have a url keep it.
//   --indexnow       after publishing, notify Bing, Yandex and other
//                    IndexNow search engines of the pages (needs site.url
//                    and site.indexNowKey in index.json)
//   --sources-bucket <name>
//                    keep the posts' Markdown out of the public bucket, in
//                    this private bucket (same adapter and credentials) under
//                    .published/, as the admin does with its DRAFTS bucket:
//                    readers get only the pages. Markdown already public is
//                    moved there. Needed to rebuild a site published from
//                    the admin.
//   --full           re-render every page (normally only changed posts are)
//   --dry-run        print what would change, change nothing
//
// Posts with `draft: true` in their front matter are not published (and are
// removed from storage if they were published before).
//
// Every run then rebuilds, from the posts actually in storage:
//   index.json, index.html, posts/<slug>.html, theme.css, robots.txt, and
//   (when site.url is set) sitemap.xml and feed.xml — see js/site-build.js and js/pages.js.
//
// Writing files straight into the bucket (dashboard, rclone, the storagesdk
// CLI, ...) works too; run with --no-posts afterwards to rebuild the above.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Storage, StorageError } from '@storagesdk/core';
import { ADAPTERS, buildAdapter, getAdapterEnvVars } from '@storagesdk/adapters';
import { contentTypeFor } from '../js/md4c-fs.js';
import { loadMd4c } from '../js/md4c.js';
import { linkPostsForStaticPage, PARSER_FLAGS } from '../js/blog-render.js';
import { isDraft, parseFrontMatter, SLUG_RE } from '../js/post-format.js';
import { protectPost, wantsPassword } from '../js/protect.js';
import { build, CACHE_FILES, CACHE_PAGES, listAll, readIndex } from '../js/site-build.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const { values: args } = parseArgs({
  options: {
    to: { type: 'string', default: process.env.STORAGE_ADAPTER ?? 'fs' },
    posts: { type: 'string', default: join(root, 'blog', 'posts') },
    'no-posts': { type: 'boolean', default: false },
    site: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    config: { type: 'string' },
    'site-url': { type: 'string' },
    indexnow: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'sources-bucket': { type: 'string' },
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

async function openStorage(name, bucket) {
  if (!ADAPTERS.includes(name)) throw new Error(`unknown adapter "${name}"; one of: ${ADAPTERS.join(', ')}`);
  if (name === 'fs') {
    process.env.FS_ROOT ??= join(root, 'dist');
    process.env.FS_FOLDER ??= 'public';
  }
  const missing = getAdapterEnvVars(name).filter((v) => v.required && !process.env[v.name]);
  if (missing.length) throw new Error(`set ${missing.map((v) => v.name).join(', ')} for the ${name} adapter`);
  if (!bucket) return new Storage({ adapter: await buildAdapter(name) });
  // The same adapter on another bucket (fs: another folder).
  const vars = getAdapterEnvVars(name).map((v) => v.name).filter((v) => /_(BUCKET|FOLDER)$/.test(v));
  if (!vars.length) throw new Error(`--sources-bucket is not supported for the ${name} adapter`);
  const saved = vars.map((v) => [v, process.env[v]]);
  for (const v of vars) process.env[v] = bucket;
  try {
    return new Storage({ adapter: await buildAdapter(name) });
  } finally {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  }
}

const POST_KEY = /^posts\/[a-z0-9][a-z0-9-]{0,79}\.md$/;
const SOURCES_PREFIX = '.published/';
const notFound = (err) => err instanceof StorageError && err.code === 'NotFound';

/**
 * The site storage with posts/<slug>.md kept in `sources` (under
 * .published/), as the admin Worker does (admin/src/stores.js
 * withPrivateSources): the build and the upload see one storage.
 */
function withPrivateSources(site, sources) {
  const at = (path) => SOURCES_PREFIX + path;
  const strip = (item) => (item && typeof item.path === 'string' ? { ...item, path: item.path.slice(SOURCES_PREFIX.length) } : item);
  const fromSources = async (path, op, fallback) => {
    try {
      return strip(await op(at(path)));
    } catch (err) {
      if (notFound(err)) return fallback();
      throw err;
    }
  };
  return {
    head: (path, o) => (POST_KEY.test(path) ? fromSources(path, (p) => sources.head(p, o), () => site.head(path, o)) : site.head(path, o)),
    download: (path, o) => (POST_KEY.test(path) ? fromSources(path, (p) => sources.download(p, o), () => site.download(path, o)) : site.download(path, o)),
    async upload(path, body, o) {
      if (!POST_KEY.test(path)) return site.upload(path, body, o);
      const written = await sources.upload(at(path), body, o);
      await site.delete(path).catch((err) => { if (!notFound(err)) throw err; });
      return strip(written);
    },
    async delete(path, o) {
      if (POST_KEY.test(path)) await sources.delete(at(path), o).catch((err) => { if (!notFound(err)) throw err; });
      return site.delete(path, o).catch((err) => { if (!(POST_KEY.test(path) && notFound(err))) throw err; });
    },
    async list(o = {}) {
      const page = await site.list(o);
      const prefix = o.prefix ?? '';
      if (o.cursor || !(prefix === '' || prefix.startsWith('posts/'))) return page;
      const own = (await listAll(sources, at('posts/'))).map(strip).filter((i) => POST_KEY.test(i.path) && i.path.startsWith(prefix));
      const mine = new Set(own.map((i) => i.path));
      return { ...page, items: [...page.items.filter((i) => !mine.has(i.path)), ...own].sort((a, b) => (a.path < b.path ? -1 : 1)) };
    },
    /** Move Markdown still in the public bucket to `sources`. */
    async migrate() {
      for (const item of await listAll(site, 'posts/')) {
        if (!POST_KEY.test(item.path)) continue;
        try {
          await sources.head(at(item.path));
        } catch (err) {
          if (!notFound(err)) throw err;
          log(`private ${item.path}`);
          if (!dry) await sources.upload(at(item.path), (await site.download(item.path)).body, { contentType: 'text/markdown; charset=utf-8' });
        }
        await remove(site, item.path);
      }
    },
  };
}


async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function upload(storage, path, body, contentType, cacheControl = CACHE_FILES) {
  log(`upload ${path}`);
  if (!dry) await storage.upload(path, body, { contentType, cacheControl });
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
    if (name.startsWith('.')) continue;
    if (!name.endsWith('.md')) {
      // Images and other assets live next to the posts that use them.
      await upload(storage, `posts/${name}`, await readFile(join(dir, name)), contentTypeFor(name));
      continue;
    }
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
    // A post with `password:` is uploaded encrypted, never as plain text.
    const body = wantsPassword(parseFrontMatter(source).meta)
      ? await protectPost(source, (md) => linkPostsForStaticPage(md4c.toHtml(md, { parserFlags: PARSER_FLAGS })))
      : source;
    if (body !== source) log(`encrypt ${name} (password-protected)`);
    await upload(storage, path, body, contentTypeFor(path), CACHE_PAGES);
  }
  if (args.prune) {
    for (const item of await listAll(storage, 'posts/')) {
      if (item.path.endsWith('.md') && !published.has(item.path)) await remove(storage, item.path);
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

async function readJsonObject(text, what) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

/** --config replaces the "site" section; blog/site.json seeds it on first publish. */
async function siteOptions(storage) {
  if (args.config) return { site: await readJsonObject(await readFile(resolve(args.config), 'utf8'), args.config) };
  let defaultSite;
  try {
    defaultSite = await readJsonObject(await readFile(join(root, 'blog', 'site.json'), 'utf8'), 'blog/site.json');
  } catch {}
  const url = args['site-url'];
  if (url) {
    if (!/^https?:\/\/[^\s"]+$/.test(url)) throw new Error(`--site-url must be an http(s) URL, got "${url}"`);
    const current = (await readIndex(storage))?.site ?? defaultSite ?? {};
    if (!current.url) return { site: { ...current, url: url.replace(/\/?$/, '/') } };
  }
  return defaultSite ? { defaultSite } : {};
}

/** Tell IndexNow engines (Bing, Yandex, Seznam, Naver, ...) about our pages. */
async function indexNow(storage, site, posts) {
  if (!site.url || !site.indexNowKey) {
    throw new Error('--indexnow needs "url" and "indexNowKey" in index.json\'s "site" section');
  }
  const keyFile = `${site.indexNowKey}.txt`;
  await upload(storage, keyFile, site.indexNowKey, 'text/plain; charset=utf-8');
  const urlList = [`${site.url}index.html`, ...posts.map((p) => new URL(p.page, site.url).href)];
  log(`IndexNow: submit ${urlList.length} URL(s)`);
  if (dry) return;
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(site.url).host,
      key: site.indexNowKey,
      keyLocation: new URL(keyFile, site.url).href,
      urlList,
    }),
  });
  console.log(`IndexNow: HTTP ${res.status}${res.ok ? '' : ` ${await res.text()}`}`);
}

const publicStorage = await openStorage(args.to);
const storage = args['sources-bucket']
  ? withPrivateSources(publicStorage, await openStorage(args.to, args['sources-bucket']))
  : publicStorage;
const md4c = await loadMd4c(pathToFileURL(join(root, 'dist', 'md4c.wasm')));
console.log(`Publishing to ${args.to}${args.to === 'fs' ? ` (${resolve(process.env.FS_ROOT, process.env.FS_FOLDER)})` : ''}`);

if (args.site) await uploadSite(publicStorage);
if (storage.migrate) await storage.migrate();
if (!args['no-posts']) await uploadPosts(storage, resolve(args.posts));
if (dry) {
  console.log('Done (dry run): index.json and pages would be rebuilt.');
} else {
  const { site, posts, rendered, removed, full } = await build(storage, md4c, {
    ...(await siteOptions(storage)),
    full: args.full,
    privateSources: Boolean(storage.migrate),
    log: (msg) => (msg.startsWith('upload') || msg.startsWith('delete') ? log(msg) : console.warn(msg)),
  });
  console.log(`${full ? 'Full' : 'Incremental'} build: ${rendered.length} page(s) rendered, ${removed.length} removed.`);
  if (args.indexnow) await indexNow(storage, site, posts);
  console.log(`Done: ${posts.length} published post(s) in index.json.`);
}
