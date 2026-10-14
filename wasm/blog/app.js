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
//   index.json         list of published posts with their metadata
//   posts/<slug>.md    Markdown source with a small front matter block
//
// Routes: #/  #/tag/<tag>  #/post/<slug>

import DOMPurify from './vendor/dompurify/purify.es.mjs';
import { STORAGE_URL } from './config.js';
import { Md4cFs } from './lib/md4c-fs.js';
import { Dialect, Flags } from './lib/md4c.js';
import { parseFrontMatter, parseTags, SLUG_RE } from './lib/post-format.js';

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

/** Markdown -> sanitized DOM fragment, with [[wiki links]] turned into links. */
function renderSafe(markdown) {
  const html = fs.render(markdown, { parserFlags: PARSER_FLAGS });
  const frag = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true });
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

async function listPosts() {
  return (await fs.readdir('posts/'))
    .map((f) => ({
      slug: f.path.slice('posts/'.length, -'.md'.length),
      title: f.metadata?.title ?? f.path,
      date: f.metadata?.date ?? '',
      tags: parseTags(f.metadata?.tags),
      excerpt: f.metadata?.excerpt ?? '',
    }))
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
  if (!SLUG_RE.test(slug ?? '') || !(await fs.exists(path))) {
    app.innerHTML = `<p>No post called <code>${esc(slug ?? '')}</code>. <a href="#/">All posts</a></p>`;
    return;
  }
  const { meta, body } = parseFrontMatter(await fs.readFile(path));
  const title = meta.title || slug;
  document.title = `${title} · MD4C Blog`;
  app.innerHTML = `<article>
    <header class="post-head">
      <h1>${esc(title)}</h1>
      <div class="meta"><time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time>${tagLinks(parseTags(meta.tags))}</div>
    </header>
    <div class="prose"></div>
  </article>`;
  app.querySelector('.prose').append(renderSafe(body));
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
    fs = await Md4cFs.open({
      baseUrl: new URL(STORAGE_URL, location.href),
      wasmUrl: new URL('./lib/md4c.wasm', import.meta.url),
    });
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not start the blog: ${esc(err.message ?? err)}</p>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

main();
