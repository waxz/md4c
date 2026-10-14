// A read-only blog. Posts are Markdown files in public, read-only storage
// (an R2 bucket, any static host). The browser reads them through storagesdk
// (Md4cFs over url-adapter.js) and renders them with MD4C as WebAssembly.
//
// There is nothing to log in to: visitors can only read. The owner publishes
// by writing to the storage with their own credentials (scripts/publish.mjs).
//
// Rendered HTML still goes through DOMPurify, so even a bad post cannot run
// script in a reader's browser.
//
// Storage layout:
//   index.json         list of posts: full entries from the publish script,
//                      or just ["posts/a.md", ...] written by hand
//   posts/<slug>.md    Markdown source with a small front matter block
//   anything else      images and other assets; relative links in a post
//                      resolve against the post's own location
//
// Routes: #/  #/tag/<tag>  #/post/<slug>

import DOMPurify from './vendor/dompurify/purify.es.js';
import { STORAGE_URL } from './config.js';
import { Md4cFs } from './lib/md4c-fs.js';
import { Dialect, Flags } from './lib/md4c.js';
import { isDraft, parseFrontMatter, parseTags, postMetadata, SLUG_RE } from './lib/post-format.js';

const PARSER_FLAGS =
  Dialect.GITHUB | Flags.WIKILINKS | Flags.HIGHLIGHT | Flags.LATEXMATHSPANS;

const app = document.getElementById('app');
let fs;

/* ---------- Helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/* ---------- Safe rendering ---------- */

// DOMPurify drops scripts, event handlers and javascript: URLs. External
// links additionally lose the referrer and window.opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    if (!node.getAttribute('href').startsWith('#')) node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (node.tagName === 'INPUT') {
    if (node.getAttribute('type') !== 'checkbox') node.remove();
    else node.setAttribute('disabled', '');
  }
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['x-wikilink'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  FORBID_ATTR: ['style'],
};

/**
 * Make relative URLs in a post point where the author meant: next to the
 * post in storage. `![](photo.png)` in posts/trip.md loads posts/photo.png,
 * and a link to another post's .md file opens that post in the blog.
 */
function resolveUrls(frag, postUrl) {
  const postsRoot = new URL('posts/', fs.baseUrl).href;
  const isRelative = (v) => v && !v.startsWith('#') && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v);
  for (const [sel, attr] of [['a', 'href'], ['img', 'src'], ['video', 'src'], ['audio', 'src'],
                             ['source', 'src'], ['video', 'poster']]) {
    for (const el of frag.querySelectorAll(`${sel}[${attr}]`)) {
      const value = el.getAttribute(attr);
      if (!isRelative(value)) continue;
      const url = new URL(value, postUrl);
      const slug = url.href.startsWith(postsRoot) && /^([^/]+)\.md$/.exec(url.pathname.slice(new URL(postsRoot).pathname.length));
      if (sel === 'a' && slug && SLUG_RE.test(slug[1])) el.setAttribute(attr, `#/post/${slug[1]}`);
      else el.setAttribute(attr, url.href);
    }
  }
}

/** Markdown -> sanitized DOM fragment, with [[wiki links]] turned into links. */
function renderSafe(markdown, postUrl) {
  const html = fs.render(markdown, { parserFlags: PARSER_FLAGS });
  const frag = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true });
  resolveUrls(frag, postUrl);
  for (const el of frag.querySelectorAll('x-wikilink')) {
    const a = document.createElement('a');
    a.href = `#/post/${encodeURIComponent(slugify(el.dataset.target ?? ''))}`;
    a.append(...el.childNodes);
    el.replaceWith(a);
  }
  return frag;
}

/* ---------- Views ---------- */

function tagLinks(tags) {
  return tags
    .map((t) => `<a class="tag" href="#/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');
}

/** Title, date, tags, excerpt: from the index, or read from the post itself. */
async function postInfo(file) {
  const slug = file.path.slice('posts/'.length, -'.md'.length);
  let meta = file.metadata;
  if (!meta?.title) {
    // Hand-written index entry: just a path. Fetch the post for its details.
    try {
      const source = await fs.readFile(file.path);
      if (isDraft(parseFrontMatter(source).meta)) return null;
      meta = postMetadata(source, (md) => fs.render(md, { parserFlags: PARSER_FLAGS }), slug);
    } catch {
      return null; // listed in index.json but not uploaded (yet)
    }
  }
  return {
    slug,
    title: meta.title ?? slug,
    date: meta.date ?? '',
    tags: parseTags(meta.tags),
    excerpt: meta.excerpt ?? '',
  };
}

async function listPosts() {
  const files = (await fs.readdir('posts/')).filter((f) =>
    /^posts\/[^/]+\.md$/.test(f.path) && SLUG_RE.test(f.path.slice(6, -3)));
  return (await Promise.all(files.map(postInfo)))
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function showList(tag) {
  let posts = await listPosts();
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  document.title = tag ? `#${tag} · MD4C Blog` : 'MD4C Blog';

  const heading = tag
    ? `<p class="filter muted">Posts tagged <strong>${esc(tag)}</strong> · <a href="#/">show all</a></p>`
    : '';
  if (posts.length === 0) {
    app.innerHTML = `${heading}<p class="muted">No posts yet.</p>`;
    return;
  }
  app.innerHTML = `${heading}<ul class="post-list">${posts
    .map(
      (p) => `<li class="post-card">
        <h2><a href="#/post/${encodeURIComponent(p.slug)}">${esc(p.title)}</a></h2>
        <div class="meta"><time datetime="${esc(p.date)}">${esc(formatDate(p.date))}</time>${tagLinks(p.tags)}</div>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
      </li>`
    )
    .join('')}</ul>`;
}

async function showPost(slug) {
  const path = `posts/${slug}.md`;
  const missing = () => {
    app.innerHTML = `<p>No post called <code>${esc(slug ?? '')}</code>. <a href="#/">All posts</a></p>`;
  };
  if (!SLUG_RE.test(slug ?? '')) return missing();
  // Read the file directly, so a post uploaded to the bucket opens by its
  // URL even before it is added to index.json.
  let source;
  try {
    source = await fs.readFile(path);
  } catch (err) {
    if (err.code === 'NotFound') return missing();
    throw err;
  }
  const { meta, body } = parseFrontMatter(source);
  if (isDraft(meta)) return missing();
  const title = meta.title || slug;
  document.title = `${title} · MD4C Blog`;
  app.innerHTML = `<article>
    <header class="post-head">
      <h1>${esc(title)}</h1>
      <div class="meta"><time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time>${tagLinks(parseTags(meta.tags))}</div>
    </header>
    <div class="prose"></div>
  </article>`;
  app.querySelector('.prose').append(renderSafe(body, await fs.storage.url(path)));
}

/* ---------- Router ---------- */

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  try {
    if (parts[0] === 'post') return await showPost(parts[1]);
    if (parts[0] === 'tag') return await showList(parts[1]);
    return await showList();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not load posts: ${esc(err.message ?? err)}</p>`;
  }
}

// In-page anchors (footnotes etc.) must not be mistaken for routes.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').startsWith('#/')) return;
  e.preventDefault();
  const id = decodeURIComponent(a.getAttribute('href').slice(1));
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
});

async function main() {
  try {
    const baseUrl = new URL(STORAGE_URL, location.href);
    fs = await Md4cFs.open({ baseUrl, wasmUrl: new URL('./lib/md4c.wasm', import.meta.url) });
    fs.baseUrl = baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`;
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not start the blog: ${esc(err.message ?? err)}</p>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

main();
