// A read-only blog. Posts are Markdown files in public, read-only storage
// (an R2 bucket, any static host). The browser reads them through storagesdk
// (Md4cFs over url-adapter.js) and renders them with MD4C as WebAssembly.
//
// There is nothing to log in to: visitors can only read. The owner publishes
// by writing to the storage with their own credentials (scripts/publish.mjs)
// or by uploading files directly.
//
// Rendered HTML still goes through DOMPurify, so even a bad post cannot run
// script in a reader's browser.
//
// Storage layout:
//   index.json         "site" settings (title, theme, ... see theme.js) and
//                      "items": full entries from the publish script, or
//                      just ["posts/a.md", ...] written by hand
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
import { applySite, DEFAULT_SITE, normalizeSite } from './theme.js';

const PARSER_FLAGS =
  Dialect.GITHUB | Flags.WIKILINKS | Flags.HIGHLIGHT | Flags.LATEXMATHSPANS;

const app = document.getElementById('app');
let fs;
let site = { ...DEFAULT_SITE };

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

function parseDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(iso, month = 'long') {
  const d = parseDate(iso);
  return d ? d.toLocaleDateString('en-GB', { year: 'numeric', month, day: 'numeric' }) : iso;
}

function setTitle(part) {
  document.title = part ? `${part} · ${site.title}` : site.title;
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
  ADD_TAGS: ['x-wikilink', 'x-equation'],
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

/** Journal typesetting on the sanitized DOM: figures, tables, anchors. */
function typeset(frag) {
  // A paragraph holding just an image becomes a figure; alt text is its caption.
  for (const p of frag.querySelectorAll('p')) {
    const img = p.firstElementChild;
    if (p.children.length !== 1 || img.tagName !== 'IMG' || p.textContent.trim()) continue;
    const figure = document.createElement('figure');
    figure.append(img);
    const caption = img.getAttribute('title') || img.getAttribute('alt');
    if (caption) {
      const fc = document.createElement('figcaption');
      fc.textContent = caption;
      figure.append(fc);
    }
    p.replaceWith(figure);
  }
  for (const table of frag.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  const used = new Set();
  for (const h of frag.querySelectorAll('h1, h2, h3, h4')) {
    let id = `sec-${slugify(h.textContent) || 'section'}`;
    for (let i = 2; used.has(id); i++) id = id.replace(/(-\d+)?$/, `-${i}`);
    used.add(id);
    h.id = id;
  }
  for (const el of frag.querySelectorAll('img')) {
    el.loading = 'lazy';
    el.decoding = 'async';
  }
}

/** Markdown -> sanitized, typeset DOM fragment. */
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
  typeset(frag);
  return frag;
}

/* ---------- Math (KaTeX, loaded only when a post has equations) ---------- */

let katexPromise;
function loadKatex() {
  katexPromise ??= (async () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./vendor/katex/katex.min.css', import.meta.url).href;
    document.head.append(link);
    return (await import('./vendor/katex/katex.mjs')).default;
  })();
  return katexPromise;
}

async function renderMath(container) {
  const eqs = container.querySelectorAll('x-equation');
  if (!site.math || eqs.length === 0) return;
  const katex = await loadKatex();
  for (const eq of eqs) {
    const display = eq.getAttribute('type') === 'display';
    const out = document.createElement(display ? 'div' : 'span');
    // KaTeX builds DOM nodes and styles them through CSSOM, which the CSP
    // allows; trust:false keeps \href, \url etc. disabled.
    katex.render(eq.textContent, out, {
      displayMode: display, throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000,
    });
    eq.replaceWith(out);
  }
}

/* ---------- Posts ---------- */

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

/* ---------- Views ---------- */

function keywordLinks(tags) {
  return tags
    .map((t) => `<a href="#/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');
}

async function showList(tag) {
  let posts = await listPosts();
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  setTitle(tag ? `Articles tagged “${tag}”` : '');

  const label = tag
    ? `<p class="section-label sc">Tagged “${esc(tag)}” · <a href="#/">all articles</a></p>`
    : '<p class="section-label sc">Latest articles</p>';
  if (posts.length === 0) {
    app.innerHTML = `${label}<p class="muted">No articles yet.</p>`;
    return;
  }
  app.innerHTML = `${label}<ol class="entries" reversed>${posts
    .map(
      (p) => `<li class="entry">
        <time class="sc" datetime="${esc(p.date)}">${esc(formatDate(p.date, 'short'))}</time>
        <div>
          <h2><a href="#/post/${encodeURIComponent(p.slug)}">${esc(p.title)}</a></h2>
          ${p.excerpt ? `<p class="abstract">${esc(p.excerpt)}</p>` : ''}
          ${p.tags.length ? `<p class="keywords sc">${keywordLinks(p.tags)}</p>` : ''}
        </div>
      </li>`
    )
    .join('')}</ol>`;
}

function buildToc(prose) {
  const heads = [...prose.querySelectorAll(':scope > h2, :scope > h3')];
  if (!site.toc || prose.querySelectorAll(':scope > h2').length < 3) return null;
  const nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'Contents');
  nav.innerHTML = '<h2 class="sc">Contents</h2>';
  const top = document.createElement('ol');
  let sub = null;
  for (const h of heads) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent;
    li.append(a);
    if (h.tagName === 'H2') {
      top.append(li);
      sub = null;
    } else {
      if (!sub) {
        sub = document.createElement('ol');
        (top.lastElementChild ?? top).append(sub);
      }
      sub.append(li);
    }
  }
  nav.append(top);
  return nav;
}

function citation(meta, slug) {
  const url = `${location.origin}${location.pathname}#/post/${slug}`;
  const d = parseDate(meta.date ?? '');
  const year = d ? d.getFullYear() : 'n.d.';
  const author = meta.author || site.author;
  const box = document.createElement('section');
  box.className = 'cite';
  box.innerHTML = '<h2 class="sc">How to cite</h2><p></p><details><summary>BibTeX</summary><pre></pre></details>';
  const when = d ? `${year}, ${d.toLocaleDateString('en-GB', { month: 'long', day: 'numeric' })}` : year;
  box.querySelector('p').textContent =
    `${author ? `${author} ` : ''}(${when}). ${meta.title}. ${site.title}. ${url}`;
  const clean = (s) => String(s).replace(/[{}\\]/g, '');
  const key = `${slugify(author.split(/\s+/).pop() || site.title)}${year}${slug.split('-')[0]}`;
  box.querySelector('pre').textContent = [
    `@online{${key},`,
    ...(author ? [`  author       = {${clean(author)}},`] : []),
    `  title        = {${clean(meta.title)}},`,
    `  year         = {${year}},`,
    ...(d ? [`  date         = {${meta.date}},`] : []),
    `  organization = {${clean(site.title)}},`,
    `  url          = {${url}},`,
    `  urldate      = {${new Date().toISOString().slice(0, 10)}}`,
    '}',
  ].join('\n');
  return box;
}

async function showPost(slug) {
  const path = `posts/${slug}.md`;
  const missing = () => {
    setTitle('Not found');
    app.innerHTML = `<p>No article called <code>${esc(slug ?? '')}</code>. <a href="#/">All articles</a></p>`;
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
  meta.title ||= slug;
  setTitle(meta.title);

  const words = body.split(/\s+/).filter(Boolean).length;
  const author = meta.author || site.author;
  const tags = parseTags(meta.tags);
  app.innerHTML = `<a class="back-link sc" href="#/">← All articles</a>
  <article>
    <header class="article-header">
      <h1 class="article-title">${esc(meta.title)}</h1>
      <p class="byline sc">${author ? `<span class="author">${esc(author)}</span> · ` : ''}<time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time> · ${Math.max(1, Math.round(words / 230))} min read</p>
      ${tags.length ? `<p class="keywords sc">${keywordLinks(tags)}</p>` : ''}
    </header>
    <div class="prose"></div>
  </article>`;
  const prose = app.querySelector('.prose');
  prose.append(renderSafe(body, await fs.storage.url(path)));
  // Authors who number their own headings keep their numbers, unduplicated.
  const manual = [...prose.querySelectorAll(':scope > h2')].some((h) => /^\s*\d+(\.\d+)*[.)]?\s/.test(h.textContent));
  prose.classList.toggle('manual-numbers', manual);
  const toc = buildToc(prose);
  if (toc) {
    toc.classList.toggle('manual-numbers', manual);
    prose.before(toc);
  }
  if (site.citation) app.querySelector('article').append(citation(meta, slug));
  await renderMath(prose);
}

/* ---------- Router ---------- */

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  try {
    if (parts[0] === 'post') await showPost(parts[1]);
    else if (parts[0] === 'tag') await showList(parts[1]);
    else await showList();
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not load: ${esc(err.message ?? err)}</p>`;
  }
}

// In-page anchors (contents, footnotes) must not be mistaken for routes.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').startsWith('#/')) return;
  e.preventDefault();
  const id = decodeURIComponent(a.getAttribute('href').slice(1));
  if (id === 'app') return app.focus();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
});

async function main() {
  try {
    const baseUrl = new URL(STORAGE_URL, location.href);
    fs = await Md4cFs.open({ baseUrl, wasmUrl: new URL('./lib/md4c.wasm', import.meta.url) });
    fs.baseUrl = baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`;
    const doc = await fs.storage.raw.document().catch((err) => {
      console.error('index.json:', err);
      return {};
    });
    site = normalizeSite(doc.site, fs.baseUrl);
    applySite(site);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not start the blog: ${esc(err.message ?? err)}</p>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

main();
