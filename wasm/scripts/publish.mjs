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
//   --indexnow       after publishing, notify Bing, Yandex and other
//                    IndexNow search engines of the pages (needs site.url
//                    and site.indexNowKey in index.json)
//   --dry-run        print what would change, change nothing
//
// Posts with `draft: true` in their front matter are not published (and are
// removed from storage if they were published before).
//
// Every run then rebuilds, from the posts actually in storage:
//   index.json, index.html, posts/<slug>.html, theme.css, robots.txt, and
//   (when site.url is set) sitemap.xml and feed.xml — see scripts/pages.mjs.
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
import { isDraft, parseFrontMatter, postMetadata, SLUG_RE } from '../js/post-format.js';
import { normalizeSite } from '../blog/theme.js';
import { atomFeed, homePage, postPage, robotsTxt, siteRelative, sitemap, themeCss } from './pages.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX = 'index.json';
// Short lifetimes let Cloudflare's edge serve repeat reads (fewer R2
// operations) while new posts still show up within minutes.
const CACHE_FILES = 'public, max-age=300';
const CACHE_INDEX = 'public, max-age=60';

const { values: args } = parseArgs({
  options: {
    to: { type: 'string', default: process.env.STORAGE_ADAPTER ?? 'fs' },
    posts: { type: 'string', default: join(root, 'blog', 'posts') },
    'no-posts': { type: 'boolean', default: false },
    site: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    config: { type: 'string' },
    indexnow: { type: 'boolean', default: false },
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
    await upload(storage, path, source, contentTypeFor(path));
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

/** The "site" section: --config file, else what index.json has, else the sample. */
async function siteSection(storage) {
  if (args.config) return readJsonObject(await readFile(resolve(args.config), 'utf8'), args.config);
  try {
    const current = JSON.parse(await storage.download(INDEX, { as: 'text' }));
    if (current && !Array.isArray(current) && current.site) return current.site;
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'NotFound') && !(err instanceof SyntaxError)) throw err;
  }
  try {
    return await readJsonObject(await readFile(join(root, 'blog', 'site.json'), 'utf8'), 'blog/site.json');
  } catch {
    return undefined;
  }
}

/** Validated site settings; site-own URLs kept relative to the site root. */
function siteSettings(raw) {
  const placeholder = 'https://site.invalid/';
  const site = normalizeSite(raw, placeholder);
  const base = site.url || placeholder;
  const again = site.url ? normalizeSite(raw, base) : site;
  again.backgroundImage = siteRelative(again.backgroundImage, base);
  again.stylesheet = siteRelative(again.stylesheet, base);
  return again;
}

/**
 * Rebuild everything derived from the posts actually in storage:
 * index.json, the static pages, feed, sitemap and robots.txt.
 */
async function build(storage, md4c) {
  const rawSite = await siteSection(storage);
  const site = siteSettings(rawSite);
  if (!site.url) {
    console.warn('note: set "url" in index.json\'s "site" section (e.g. "https://blog.example.com/")\n' +
      '      to get canonical links, social previews, sitemap.xml and feed.xml.');
  }
  const render = (md) => md4c.toHtml(md, { parserFlags: PARSER_FLAGS });
  const stored = await listAll(storage, 'posts/');
  const items = [];
  const posts = [];
  const htmlBySlug = new Map();

  for (const item of stored) {
    const m = /^posts\/(.+)\.md$/.exec(item.path);
    if (!m || !SLUG_RE.test(m[1])) continue;
    const slug = m[1];
    const full = await storage.download(item.path);
    const source = new TextDecoder().decode(full.body);
    const { meta, body } = parseFrontMatter(source);
    if (isDraft(meta)) {
      console.warn(`warning: ${item.path} is a draft but publicly readable in storage`);
      continue;
    }
    const metadata = postMetadata(source, render, slug);
    const page = `posts/${slug}.html`;
    const html = linkPostsForStaticPage(render(body));
    htmlBySlug.set(slug, html);
    posts.push({ slug, page, ...metadata });
    items.push({
      path: item.path,
      page,
      size: full.size,
      contentType: 'text/markdown; charset=utf-8',
      etag: full.etag,
      lastModified: full.lastModified.toISOString(),
      metadata,
    });
    await upload(storage, page, postPage(site, posts.at(-1), html), 'text/html; charset=utf-8');
  }

  // Pages whose Markdown is gone (deleted, pruned or turned into a draft).
  for (const item of stored) {
    const m = /^posts\/(.+)\.html$/.exec(item.path);
    if (m && !htmlBySlug.has(m[1])) await remove(storage, item.path);
  }

  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  const index = {
    version: 1,
    generated: new Date().toISOString(),
    ...(rawSite ? { site: rawSite } : {}),
    items,
  };
  await upload(storage, INDEX, `${JSON.stringify(index, null, 2)}\n`, 'application/json', CACHE_INDEX);
  await upload(storage, 'index.html', homePage(site, posts), 'text/html; charset=utf-8', CACHE_INDEX);
  await upload(storage, 'theme.css', themeCss(site), 'text/css; charset=utf-8');
  await upload(storage, 'robots.txt', robotsTxt(site), 'text/plain; charset=utf-8');
  if (site.url) {
    await upload(storage, 'sitemap.xml', sitemap(site, posts), 'application/xml', CACHE_INDEX);
    await upload(storage, 'feed.xml', atomFeed(site, posts, htmlBySlug), 'application/atom+xml', CACHE_INDEX);
  }
  return { site, posts };
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

const storage = await openStorage(args.to);
const md4c = await loadMd4c(pathToFileURL(join(root, 'dist', 'md4c.wasm')));
console.log(`Publishing to ${args.to}${args.to === 'fs' ? ` (${resolve(process.env.FS_ROOT, process.env.FS_FOLDER)})` : ''}`);

if (args.site) await uploadSite(storage);
if (!args['no-posts']) await uploadPosts(storage, resolve(args.posts));
if (dry) {
  console.log('Done (dry run): index.json and pages would be rebuilt.');
} else {
  const { site, posts } = await build(storage, md4c);
  if (args.indexnow) await indexNow(storage, site, posts);
  console.log(`Done: ${posts.length} published post(s) in ${INDEX}.`);
}
