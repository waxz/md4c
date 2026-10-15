// The blog's browser code. Pages are pre-rendered by scripts/publish.mjs so
// search engines and link previews see real content; this script upgrades
// whichever page it runs on:
//
//   index.html          search, year and tag filters over index.json
//                       (state in the URL: ?tag=…&year=…&q=…)
//   posts/<slug>.html   contents box, figures, citation, math; for a
//                       password-protected post, the unlock form first
//   index.html#/post/x  old links: go to posts/x.html, or render x.md live
//                       if it was uploaded but not built yet
//
// Posts are read through storagesdk (Md4cFs over url-adapter.js) from
// read-only storage; MD4C renders them as WebAssembly. There is nothing to
// log in to: visitors can only read.

import { STORAGE_URL } from './config.js';
import { Md4cFs } from './lib/md4c-fs.js';
import { PARSER_FLAGS } from './lib/blog-render.js';
import { isDraft, parseFrontMatter, parseTags, postMetadata, SLUG_RE } from './lib/post-format.js';
import { decryptText, readProtected, WrongPasswordError } from './lib/protect.js';
import { esc, finishArticle, formatDate, renderLive } from './render.js';
import { applySite, normalizeSite } from './theme.js';

const SITE_ROOT = new URL('./', import.meta.url).href;
const app = document.getElementById('app');
const HOME_TITLE = document.title;
let fs;
let site;

/* ---------- Data ---------- */

/** Title, date, tags, excerpt: from the index, or read from the post itself. */
async function postInfo(file) {
  const slug = file.path.slice('posts/'.length, -'.md'.length);
  let meta = file.metadata;
  if (!meta?.title || !meta?.date) {
    // Hand-written index entry: fetch the post for the missing details.
    try {
      const source = await fs.readFile(file.path);
      if (isDraft(parseFrontMatter(source).meta)) return null;
      const locked = readProtected(source);
      meta = locked
        ? { ...postMetadata(source, () => '', slug), protected: 'true', ...meta }
        : { ...postMetadata(source, (md) => fs.render(md, { parserFlags: PARSER_FLAGS }), slug), ...meta };
    } catch {
      return null; // listed in index.json but not uploaded (yet)
    }
  }
  return {
    slug,
    title: meta.title ?? slug,
    date: meta.date ?? '',
    tags: parseTags(meta.tags),
    excerpt: meta.protected === 'true' ? '' : meta.description || meta.excerpt || '',
    protected: meta.protected === 'true',
    href: file.page ? new URL(file.page, SITE_ROOT).href : `${SITE_ROOT}index.html#/post/${slug}`,
  };
}

async function loadPosts() {
  const files = (await fs.readdir('posts/')).filter((f) =>
    /^posts\/[^/]+\.md$/.test(f.path) && SLUG_RE.test(f.path.slice(6, -3)));
  const pages = new Map(((await fs.storage.raw.document()).items ?? [])
    .filter((e) => e && typeof e === 'object' && typeof e.page === 'string')
    .map((e) => [e.path, e.page]));
  for (const f of files) f.page = pages.get(f.path);
  return (await Promise.all(files.map(postInfo)))
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/* ---------- Home: filters ---------- */

function readFilters() {
  const q = new URLSearchParams(location.search);
  const f = { tag: q.get('tag') ?? '', year: q.get('year') ?? '', q: q.get('q') ?? '' };
  const legacyTag = /^#\/tag\/(.+)$/.exec(location.hash);
  if (legacyTag) f.tag = decodeURIComponent(legacyTag[1]);
  return f;
}

function writeFilters(f) {
  const q = new URLSearchParams();
  for (const k of ['tag', 'year', 'q']) if (f[k]) q.set(k, f[k]);
  const query = q.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

function matches(p, f) {
  if (f.tag && !p.tags.includes(f.tag)) return false;
  if (f.year && !p.date.startsWith(f.year)) return false;
  if (f.q) {
    const hay = `${p.title} ${p.excerpt} ${p.tags.join(' ')}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function entryHtml(p) {
  return `<li class="entry">
    <time class="sc" datetime="${esc(p.date)}">${esc(formatDate(p.date, 'short'))}</time>
    <div>
      <h2><a href="${esc(p.href)}">${esc(p.title)}</a></h2>
      ${p.protected ? '<p class="abstract protected-note">🔒 Password-protected</p>' : p.excerpt ? `<p class="abstract">${esc(p.excerpt)}</p>` : ''}
      ${p.tags.length ? `<p class="keywords sc">${p.tags.map((t) => `<a href="?tag=${encodeURIComponent(t)}" data-tag="${esc(t)}">${esc(t)}</a>`).join('')}</p>` : ''}
    </div>
  </li>`;
}

function renderEntries(posts, f) {
  const shown = posts.filter((p) => matches(p, f));
  const groups = new Map();
  for (const p of shown) {
    const y = p.date.slice(0, 4) || '—';
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(p);
  }
  document.getElementById('entries').innerHTML = shown.length
    ? [...groups].map(([y, ps]) => `<section class="year-group"><h2 class="year-heading sc">${esc(y)}</h2><ol class="entries">${ps.map(entryHtml).join('')}</ol></section>`).join('')
    : '<p class="muted empty">No articles match these filters.</p>';
  const active = f.tag || f.year || f.q;
  const status = document.querySelector('.filter-status');
  status.innerHTML = active
    ? `${shown.length} of ${posts.length} article${posts.length === 1 ? '' : 's'} · <a href="index.html" class="clear">Clear filters</a>`
    : `${posts.length} article${posts.length === 1 ? '' : 's'}`;
  for (const chip of document.querySelectorAll('.tag-chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.tag === f.tag));
  }
  const tagLabel = f.tag ? ` tagged “${f.tag}”` : '';
  document.title = active ? `Articles${tagLabel}${f.year ? ` from ${f.year}` : ''} · ${site.title}` : HOME_TITLE;
}

async function showHome() {
  const posts = await loadPosts();
  const f = readFilters();
  const years = [...new Set(posts.map((p) => p.date.slice(0, 4)).filter(Boolean))].sort().reverse();
  const tagCounts = new Map();
  for (const p of posts) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  document.getElementById('filters').innerHTML = `<div class="filters" role="search">
    <div class="filter-row">
      <input type="search" id="filter-q" placeholder="Search titles, abstracts, keywords" aria-label="Search articles" value="${esc(f.q)}">
      <select id="filter-year" aria-label="Year">
        <option value="">All years</option>
        ${years.map((y) => `<option value="${esc(y)}"${y === f.year ? ' selected' : ''}>${esc(y)}</option>`).join('')}
      </select>
    </div>
    ${tags.length ? `<div class="tag-chips" role="group" aria-label="Filter by keyword">${tags.map(([t, n]) =>
      `<button type="button" class="tag-chip sc" data-tag="${esc(t)}" aria-pressed="false">${esc(t)} <span class="count">${n}</span></button>`).join('')}</div>` : ''}
    <p class="filter-status sc" aria-live="polite"></p>
  </div>`;

  const update = () => {
    writeFilters(f);
    renderEntries(posts, f);
  };
  document.getElementById('filter-q').addEventListener('input', (e) => { f.q = e.target.value.trim(); update(); });
  document.getElementById('filter-year').addEventListener('change', (e) => { f.year = e.target.value; update(); });
  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tag]');
    if (!t) return;
    e.preventDefault();
    f.tag = f.tag === t.dataset.tag ? '' : t.dataset.tag;
    update();
    document.getElementById('filters').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  update();
}

/* ---------- Posts not yet pre-rendered: index.html#/post/<slug> ---------- */

async function showLivePost(slug) {
  const path = `posts/${slug}.md`;
  const missing = () => {
    app.innerHTML = `<p>No article called <code>${esc(slug)}</code>. <a href="index.html">All articles</a></p>`;
  };
  if (!SLUG_RE.test(slug)) return missing();
  const entry = ((await fs.storage.raw.document()).items ?? []).find((e) => e?.path === path && e.page);
  if (entry) {
    location.replace(new URL(entry.page, SITE_ROOT).href);
    return;
  }
  let source;
  try {
    source = await fs.readFile(path);
  } catch (err) {
    if (err.code === 'NotFound') return missing();
    throw err;
  }
  const { meta, body } = parseFrontMatter(source);
  if (isDraft(meta) || readProtected(source)) return missing();
  meta.title ||= slug;
  document.title = `${meta.title} · ${site.title}`;
  const author = meta.author || site.author;
  const tags = parseTags(meta.tags);
  app.innerHTML = `<a class="back-link sc" href="index.html">← All articles</a>
  <article>
    <header class="article-header">
      <h1 class="article-title">${esc(meta.title)}</h1>
      <p class="byline sc">${author ? `<span class="author">${esc(author)}</span> · ` : ''}<time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time></p>
      ${tags.length ? `<p class="keywords sc">${tags.map((t) => `<a href="index.html?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</p>` : ''}
    </header>
    <div class="prose"></div>
  </article>`;
  const article = app.querySelector('article');
  article.querySelector('.prose').append(renderLive(fs, body, {
    postUrl: await fs.storage.url(path),
    storageBase: fs.baseUrl,
    postHref: (s) => `index.html#/post/${s}`,
  }));
  await finishArticle(article, site, {
    title: meta.title, date: meta.date, author: meta.author, slug,
    url: `${SITE_ROOT}index.html#/post/${slug}`,
  });
}

/* ---------- Password-protected posts ---------- */

/**
 * Resolves once the article is decrypted and shown in place of the form.
 * The password is asked for on every visit and never stored.
 */
async function unlock(article) {
  const box = article.querySelector('.protected');
  const envelope = JSON.parse(box.dataset.envelope);
  const show = (html) => {
    const prose = article.querySelector('.prose');
    prose.innerHTML = html; // the owner's own article, as on any other page
    box.remove();
  };
  const form = box.querySelector('form');
  const input = form.querySelector('input');
  const status = form.querySelector('.unlock-status');
  input.focus();
  await new Promise((done) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      status.textContent = 'Unlocking…';
      try {
        // Spaces at the ends are not part of a password (phone keyboards add them).
        const html = await decryptText(envelope, input.value.trim());
        input.value = '';
        show(html);
        done();
      } catch (err) {
        status.textContent = err instanceof WrongPasswordError ? 'Wrong password. Try again.' : `Could not unlock: ${err.message}`;
        input.select();
        button.disabled = false;
      }
    });
  });
}

/* ---------- Start ---------- */

// In-page anchors (contents, footnotes) scroll instead of navigating.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').startsWith('#/')) return;
  e.preventDefault();
  const id = decodeURIComponent(a.getAttribute('href').slice(1));
  if (id === 'app') return app.focus();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
});

async function main() {
  const page = document.body.dataset.page;
  try {
    const baseUrl = new URL(STORAGE_URL, SITE_ROOT);
    fs = await Md4cFs.open({ baseUrl, wasmUrl: new URL('./lib/md4c.wasm', import.meta.url) });
    fs.baseUrl = baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`;
    const doc = await fs.storage.raw.document().catch((err) => {
      console.error('index.json:', err);
      return {};
    });
    site = normalizeSite(doc.site, fs.baseUrl);
    applySite(site);

    if (page === 'post') {
      const article = document.querySelector('article');
      if (article.querySelector('.protected')) await unlock(article);
      const canonical = document.querySelector('link[rel="canonical"]')?.href;
      await finishArticle(article, site, { ...article.dataset, url: canonical || location.href.split('#')[0] });
      return;
    }
    const live = /^#\/post\/([^/?#]+)/.exec(location.hash);
    if (live) {
      await showLivePost(decodeURIComponent(live[1]));
      window.addEventListener('hashchange', () => location.reload());
      return;
    }
    await showHome();
  } catch (err) {
    console.error(err);
    const note = document.createElement('p');
    note.className = 'error';
    note.textContent = `Some features could not load: ${err.message ?? err}`;
    app.prepend(note);
  }
}

main();
