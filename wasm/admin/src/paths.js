// What the admin may write where, and with which content type.
//
// Two roles of store (see stores.js):
//   site    the public blog bucket (readers' URL)
//   drafts  private draft stores (R2, WebDAV, ...): posts and their files
//
// Every key falls into one class:
//   content    posts/<slug>.md — the source of a post, the only file
//              rendered to a page
//   asset      attachments of any type (images, audio, video, PDFs, HTML,
//              archives...): posts/<file> (except posts/<slug>.html),
//              posts/<folder>/**, assets/**
//   generated  written by the site build: index.json, index.html,
//              posts/<slug>.html, theme.css, robots.txt, sitemap.xml,
//              feed.xml, <indexnow-key>.txt
//   locked     everything else (app.js, lib/, vendor/, ...): the site's code,
//              deployed with `publish.mjs --site`, never from the admin
//
// Content and asset writes must say whether they create (If-None-Match: *)
// or update a known version (If-Match: <etag>); generated files may be
// overwritten freely.
//
// Folders are key prefixes. An empty folder is kept by a hidden marker,
// <folder>/.keep, which the file API never lists or serves as a file.

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
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  tex: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ipynb: 'application/json',
  woff2: 'font/woff2',
};

export const FOLDER_MARKER = '.keep';
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
  // Pages, posts and indexes are revalidated on every visit (see
  // js/site-build.js CACHE_PAGES); attachments may be reused for minutes.
  return /^(index\.(json|html)|sitemap\.xml|feed\.xml|posts\/[^/]+\.(md|html))$/.test(key)
    ? 'public, no-cache' : 'public, max-age=300';
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

/**
 * The class of `key` in a store with `role` ("site" or "drafts"):
 * content | asset | generated | locked. Draft stores hold posts and their
 * files (posts/<file>, assets/**), never generated files or site code.
 */
export function classify(role, key) {
  if (keyProblem(key)) return 'locked';
  const parts = key.split('/');
  const ext = extension(key);
  if (role !== 'site') {
    const kind = classify('site', key);
    return kind === 'content' || kind === 'asset' ? kind : 'locked';
  }
  if (parts.length === 1) {
    if (GENERATED_ROOT.has(key) || INDEXNOW_KEY_FILE.test(key)) return 'generated';
    return 'locked';
  }
  if (parts[0] === 'posts' && parts.length === 2) {
    const base = parts[1].slice(0, parts[1].lastIndexOf('.'));
    // Only posts/<slug>.md is a post (rendered to posts/<slug>.html).
    if (ext === 'md') return SLUG_RE.test(base) ? 'content' : 'locked';
    if (ext === 'html' && SLUG_RE.test(base)) return 'generated';
    return 'asset';
  }
  // Any other file under posts/ or assets/ is an attachment, kept as is.
  if (parts[0] === 'posts' || parts[0] === 'assets') return 'asset';
  return 'locked';
}

/** Error message if `prefix` ("assets/a/b/") can't be a folder, else ''. */
export function folderProblem(prefix) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) return 'a folder path ends with "/"';
  const parts = prefix.slice(0, -1).split('/');
  if (parts[0] !== 'posts' && parts[0] !== 'assets') return 'folders go in posts/ or assets/';
  if (parts.length < 2) return 'posts/ and assets/ always exist';
  for (const p of parts) if (!SEGMENT_RE.test(p) || p.endsWith('.')) return `invalid folder name "${p}"`;
  return prefix.length > MAX_KEY_LENGTH - 10 ? 'folder path too long' : '';
}

/** For posts/<slug>.md, the slug; else null. */
export function postSlug(key) {
  const m = /^posts\/([a-z0-9][a-z0-9-]{0,79})\.md$/.exec(key);
  return m ? m[1] : null;
}

/**
 * Keys of the local files a post refers to: Markdown links and images,
 * reference definitions, HTML src/href/poster attributes and the front
 * matter `image:`. Relative paths resolve against the post's folder
 * (posts/); "/x" is the store root. External URLs and anchors are ignored.
 */
export function referencedKeys(markdown, postKey) {
  const found = new Set();
  const refs = [];
  const add = (v) => refs.push(String(v).trim().replace(/^<|>$/g, ''));
  for (const m of markdown.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g)) add(m[1]);
  for (const m of markdown.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm)) add(m[1]);
  for (const m of markdown.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const img = fm && /^image\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
  if (img) add(img[1]);

  const base = postKey.slice(0, postKey.lastIndexOf('/') + 1);
  for (let ref of refs) {
    if (!ref || ref.startsWith('#') || ref.startsWith('?') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    ref = ref.replace(/[?#].*$/, '');
    try {
      ref = decodeURIComponent(ref);
    } catch {
      continue;
    }
    const parts = [];
    for (const seg of (ref.startsWith('/') ? ref.slice(1) : base + ref).split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (!parts.length) { parts.length = 0; parts.push('\u0000'); break; }
        parts.pop();
      } else parts.push(seg);
    }
    const key = parts.join('/');
    if (key && !key.includes('\u0000') && !keyProblem(key)) found.add(key);
  }
  return [...found];
}
