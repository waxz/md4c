// What the admin may write where, and with which content type.
//
// Two buckets:
//   site    the public blog bucket (readers' URL)
//   drafts  a private bucket, never publicly exposed (optional)
//
// Every key falls into one class:
//   content    posts/<slug>.md — the source of a post
//   asset      images, PDFs, media, stylesheets: posts/<file>, assets/**
//   generated  written by the site build: index.json, index.html,
//              posts/<slug>.html, theme.css, robots.txt, sitemap.xml,
//              feed.xml, <indexnow-key>.txt
//   locked     everything else (app.js, lib/, vendor/, ...): the site's code,
//              deployed with `publish.mjs --site`, never from the admin
//
// Content and asset writes must say whether they create (If-None-Match: *)
// or update a known version (If-Match: <etag>); generated files may be
// overwritten freely.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
export const MAX_KEY_LENGTH = 512;

const TYPES = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  csv: 'text/csv; charset=utf-8',
  bib: 'text/plain; charset=utf-8',
};

const ASSET_EXT = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'pdf',
  'mp4', 'webm', 'mp3', 'ogg', 'csv', 'bib', 'txt', 'css', 'json']);
const GENERATED_ROOT = new Set(['index.json', 'index.html', 'theme.css', 'robots.txt', 'sitemap.xml', 'feed.xml']);
const INDEXNOW_KEY_FILE = /^[A-Za-z0-9-]{8,128}\.txt$/;

export function extension(key) {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Content type from the extension; the client's claim is never trusted. */
export function contentTypeFor(key) {
  return TYPES[extension(key)] ?? 'application/octet-stream';
}

/** Short cache lifetimes so Cloudflare's edge serves repeat reads. */
export function cacheControlFor(key) {
  return /^(index\.(json|html)|sitemap\.xml|feed\.xml)$/.test(key) ? 'public, max-age=60' : 'public, max-age=300';
}

/** Error message if `key` is not a well-formed object key, else ''. */
export function keyProblem(key) {
  if (typeof key !== 'string' || !key) return 'missing key';
  if (key.length > MAX_KEY_LENGTH) return 'key too long';
  const segments = key.split('/');
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s.endsWith('.')) {
      return `invalid path segment "${s}": use letters, digits, ".", "_" and "-"`;
    }
  }
  if (!extension(key)) return 'file name needs an extension';
  return '';
}

/** The class of `key` in `bucket`: content | asset | generated | locked. */
export function classify(bucket, key) {
  if (keyProblem(key)) return 'locked';
  const parts = key.split('/');
  const ext = extension(key);
  if (bucket === 'drafts') {
    return parts.length === 2 && parts[0] === 'posts' && ext === 'md' && SLUG_RE.test(parts[1].slice(0, -3))
      ? 'content' : 'locked';
  }
  if (parts.length === 1) {
    if (GENERATED_ROOT.has(key) || INDEXNOW_KEY_FILE.test(key)) return 'generated';
    return 'locked';
  }
  if (parts[0] === 'posts' && parts.length === 2) {
    const base = parts[1].slice(0, parts[1].lastIndexOf('.'));
    if (ext === 'md') return SLUG_RE.test(base) ? 'content' : 'locked';
    if (ext === 'html') return SLUG_RE.test(base) ? 'generated' : 'locked';
    return ASSET_EXT.has(ext) ? 'asset' : 'locked';
  }
  if (parts[0] === 'assets') return ASSET_EXT.has(ext) || ext === 'md' ? 'asset' : 'locked';
  return 'locked';
}

/** For posts/<slug>.md, the slug; else null. */
export function postSlug(key) {
  const m = /^posts\/([a-z0-9][a-z0-9-]{0,79})\.md$/.exec(key);
  return m ? m[1] : null;
}
