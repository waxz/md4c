// The blog's build: from the posts in storage, write index.json, the
// pre-rendered pages (js/pages.js), theme.css, sitemap, feed and robots.txt.
//
// It runs anywhere storagesdk and md4c.wasm run: scripts/publish.mjs uses it
// in Node with an R2/S3/fs adapter, and the admin editor runs the very same
// code in the owner's browser against the admin Worker.
//
// Builds are incremental. index.json records each post's etag and a hash of
// the site settings; only posts whose Markdown changed are re-rendered,
// unless the settings or the page templates (BUILD_VERSION) changed, or a
// full rebuild is requested.

import { StorageError } from '@storagesdk/core';
import { linkPostsForStaticPage, PARSER_FLAGS, postLinks } from './blog-render.js';
import { isDraft, parseFrontMatter, postMetadata, SLUG_RE } from './post-format.js';
import { atomFeed, graphPage, homePage, postPage, protectedArticle, robotsTxt, siteRelative, sitemap, themeCss } from './pages.js';
import { readProtected, wantsPassword } from './protect.js';
import { normalizeSite } from './site-config.js';

/** Bump when js/pages.js output changes, so the next build redoes every page. */
export const BUILD_VERSION = 6;
export const INDEX = 'index.json';
export const CACHE_FILES = 'public, max-age=300';
// Pages, posts and indexes change in place (an edit, a new password), so
// browsers and the edge must check for a new version each time (a cheap
// 304 when unchanged) rather than reuse a stale copy for minutes.
export const CACHE_PAGES = 'public, no-cache';
export const CACHE_INDEX = CACHE_PAGES;
const FEED_ENTRIES = 30;

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function listAll(storage, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await storage.list({ prefix, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** The current index.json as an object, or null when missing/unreadable. */
export async function readIndex(storage) {
  try {
    const doc = JSON.parse(await storage.download(INDEX, { as: 'text' }));
    return doc && typeof doc === 'object' ? (Array.isArray(doc) ? { items: doc } : doc) : null;
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof StorageError && err.code === 'NotFound')) return null;
    throw err;
  }
}

/** Validated site settings; the site's own URLs kept relative to its root. */
export function siteSettings(raw) {
  const placeholder = 'https://site.invalid/';
  const first = normalizeSite(raw, placeholder);
  const base = first.url || placeholder;
  const site = first.url ? normalizeSite(raw, base) : first;
  site.backgroundImage = siteRelative(site.backgroundImage, base);
  site.banner = siteRelative(site.banner, base);
  site.stylesheet = siteRelative(site.stylesheet, base);
  return site;
}

/**
 * Rebuild everything derived from the posts in `storage`.
 *
 * @param {import('@storagesdk/core').Storage} storage
 * @param {{ toHtml: Function }} md4c
 * @param {{ site?: object, defaultSite?: object, full?: boolean,
 *           log?: (msg: string) => void }} [opts]
 *        `site` replaces index.json's "site" section; `defaultSite` is used
 *        when there is none yet.
 * @returns {Promise<{ site, posts, rendered: string[], removed: string[], full: boolean }>}
 */
export async function build(storage, md4c, opts = {}) {
  const log = opts.log ?? (() => {});
  const render = (md) => md4c.toHtml(md, { parserFlags: PARSER_FLAGS });
  const put = (path, body, contentType, cacheControl = CACHE_FILES) => {
    log(`upload ${path}`);
    return storage.upload(path, body, { contentType, cacheControl });
  };

  const previous = await readIndex(storage);
  const rawSite = opts.site ?? previous?.site ?? opts.defaultSite;
  const site = siteSettings(rawSite);
  const siteHash = fnv1a(JSON.stringify(rawSite ?? null));
  const full = Boolean(opts.full) || previous?.build?.version !== BUILD_VERSION || previous?.build?.site !== siteHash;
  const known = new Map((previous?.items ?? [])
    .filter((e) => e && typeof e === 'object' && e.page && e.etag && e.metadata)
    .map((e) => [e.path, e]));

  const stored = await listAll(storage, 'posts/');
  const htmlNames = new Set(stored.filter((i) => i.path.endsWith('.html')).map((i) => i.path));
  const items = [];
  const posts = [];
  const htmlBySlug = new Map();
  const sources = new Map();
  const rendered = [];

  for (const item of stored) {
    const m = /^posts\/(.+)\.md$/.exec(item.path);
    if (!m || !SLUG_RE.test(m[1])) continue;
    const slug = m[1];
    const page = `posts/${slug}.html`;
    const prior = known.get(item.path);
    let metadata;
    let links = [];
    const etag = item.etag;
    let size = item.size;
    let lastModified = item.lastModified;

    if (!full && prior && prior.etag === item.etag && htmlNames.has(page) && Array.isArray(prior.links)) {
      metadata = prior.metadata; // unchanged since the last build
      links = prior.links;
    } else {
      const fileItem = await storage.download(item.path);
      const source = new TextDecoder().decode(fileItem.body);
      const { meta } = parseFrontMatter(source);
      if (isDraft(meta)) {
        log(`warning: ${item.path} is a draft but publicly readable in storage`);
        continue;
      }
      if (wantsPassword(meta)) {
        // Plain text with its password: never render or list it.
        log(`warning: ${item.path} has a password but is NOT encrypted, and is publicly readable in storage. Delete it, then publish it with the admin or publish.mjs, which encrypt it.`);
        continue;
      }
      // Keep the etag `list` reports: later builds compare against list output.
      ({ size, lastModified } = fileItem);
      const locked = readProtected(source);
      if (locked) {
        // Only the clear fields go into index.json and the page; the text
        // stays encrypted until a reader types the password.
        metadata = postMetadata(source, () => '', slug);
        delete metadata.description;
        delete metadata.image;
        delete metadata.banner;
        delete metadata.background;
        delete metadata.backgroundMode;
        metadata.protected = 'true';
        await put(page, postPage(site, { slug, page, ...metadata }, protectedArticle(locked.envelope)), 'text/html; charset=utf-8', CACHE_PAGES);
      } else {
        metadata = postMetadata(source, render, slug);
        const html = linkPostsForStaticPage(render(parseFrontMatter(source).body));
        htmlBySlug.set(slug, html);
        sources.set(slug, source);
        links = postLinks(html, site.url).filter((s) => s !== slug);
        await put(page, postPage(site, { slug, page, ...metadata }, html), 'text/html; charset=utf-8', CACHE_PAGES);
      }
      rendered.push(slug);
    }
    posts.push({ slug, page, ...metadata });
    items.push({
      path: item.path,
      page,
      size,
      contentType: 'text/markdown; charset=utf-8',
      etag,
      lastModified: new Date(lastModified).toISOString(),
      metadata,
      links,
    });
  }

  // Pages whose Markdown is gone (deleted, unpublished, or turned into a draft).
  const removed = [];
  const live = new Set(posts.map((p) => p.page));
  for (const path of htmlNames) {
    if (!live.has(path)) {
      log(`delete ${path}`);
      await storage.delete(path);
      removed.push(path);
    }
  }

  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));

  // The feed carries full text for the newest posts; render any not done above.
  for (const p of posts.slice(0, FEED_ENTRIES)) {
    if (htmlBySlug.has(p.slug) || p.protected) continue;
    const source = sources.get(p.slug) ?? await storage.download(`posts/${p.slug}.md`, { as: 'text' });
    htmlBySlug.set(p.slug, linkPostsForStaticPage(render(parseFrontMatter(source).body)));
  }

  const index = {
    version: 1,
    generated: new Date().toISOString(),
    build: { version: BUILD_VERSION, site: siteHash },
    ...(rawSite ? { site: rawSite } : {}),
    items,
  };
  await put(INDEX, `${JSON.stringify(index, null, 2)}\n`, 'application/json', CACHE_INDEX);
  await put('index.html', homePage(site, posts), 'text/html; charset=utf-8', CACHE_INDEX);
  await put('theme.css', themeCss(site), 'text/css; charset=utf-8');
  await put('robots.txt', robotsTxt(site), 'text/plain; charset=utf-8');
  if (site.graph) {
    await put('graph.html', graphPage(site), 'text/html; charset=utf-8', CACHE_INDEX);
  } else if (await storage.head('graph.html').then(() => true, () => false)) {
    log('delete graph.html');
    await storage.delete('graph.html');
  }
  if (site.url) {
    await put('sitemap.xml', sitemap(site, posts), 'application/xml', CACHE_INDEX);
    await put('feed.xml', atomFeed(site, posts, htmlBySlug), 'application/atom+xml', CACHE_INDEX);
  } else {
    log('note: set "url" in the "site" settings (e.g. "https://blog.example.com/") to get canonical links, social previews, sitemap.xml and feed.xml.');
  }
  return { site, posts, rendered, removed, full };
}
