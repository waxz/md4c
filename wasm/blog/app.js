// A small single-page blog. Posts are Markdown files kept in the browser
// (IndexedDB via storagesdk, wrapped by Md4cFs) and rendered to HTML by MD4C
// running as WebAssembly. There is no server-side code: any static file
// server can host this directory.
//
// Storage layout:
//   posts/<slug>.md    Markdown source with a small front matter block
//   html/<slug>.html   rendered HTML fragment (regenerated on every save)
//
// Routes: #/  #/tag/<tag>  #/post/<slug>  #/edit/<slug>  #/new

import { Md4cFs } from './lib/md4c-fs.js';
import { Dialect, Flags } from './lib/md4c.js';

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
  return (
    s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) ||
    `post-${Date.now()}`
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Split "---\nkey: value\n---\nbody" into { meta, body }. */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function serializePost({ title, date, tags }, body) {
  const clean = (s) => s.replace(/[\r\n]+/g, ' ').trim();
  return `---\ntitle: ${clean(title)}\ndate: ${clean(date)}\ntags: ${clean(tags)}\n---\n\n${body.replace(/^\s+/, '')}`;
}

function parseTags(s) {
  return (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** Plain-text excerpt: the first paragraph of rendered HTML. */
function excerptFrom(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const p = doc.querySelector('p');
  const text = (p?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function render(markdown) {
  return fs.render(markdown, { parserFlags: PARSER_FLAGS });
}

/** MD4C emits <x-wikilink data-target="..."> for [[links]]; make them real links. */
function linkify(container) {
  for (const el of container.querySelectorAll('x-wikilink')) {
    const a = document.createElement('a');
    a.href = `#/post/${encodeURIComponent(slugify(el.dataset.target ?? ''))}`;
    a.append(...el.childNodes);
    el.replaceWith(a);
  }
}

/* ---------- Storage ---------- */

async function savePost(slug, source) {
  const { meta, body } = parseFrontMatter(source);
  const html = render(body);
  const metadata = {
    title: meta.title || slug,
    date: meta.date || today(),
    tags: meta.tags ?? '',
    excerpt: excerptFrom(html),
  };
  await fs.writeFile(`posts/${slug}.md`, source, { metadata });
  await fs.writeFile(`html/${slug}.html`, html, { metadata });
}

async function deletePost(slug) {
  await fs.unlink(`posts/${slug}.md`);
  await fs.unlink(`html/${slug}.html`);
}

async function listPosts() {
  const files = await fs.readdir('posts/');
  return files
    .filter((f) => f.path.endsWith('.md'))
    .map((f) => ({
      slug: f.path.slice('posts/'.length, -'.md'.length),
      title: f.metadata?.title ?? f.path,
      date: f.metadata?.date ?? '',
      tags: parseTags(f.metadata?.tags),
      excerpt: f.metadata?.excerpt ?? '',
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Import the sample posts shipped next to this page (posts/index.json). */
async function seedSamplePosts() {
  const index = await (await fetch('posts/index.json')).json();
  for (const name of index) {
    const source = await (await fetch(`posts/${encodeURIComponent(name)}`)).text();
    await savePost(name.replace(/\.md$/, ''), source);
  }
}

/* ---------- Views ---------- */

function tagLinks(tags) {
  return tags
    .map((t) => `<a class="tag" href="#/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');
}

async function showList(tag) {
  let posts = await listPosts();
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  document.title = tag ? `#${tag} · MD4C Blog` : 'MD4C Blog';

  const filter = tag
    ? `<p class="filter muted">Posts tagged <strong>${esc(tag)}</strong> · <a href="#/">show all</a></p>`
    : '';
  if (posts.length === 0) {
    app.innerHTML = `${filter}<p class="muted">No posts yet. <a href="#/new">Write the first one</a>.</p>`;
    return;
  }
  app.innerHTML = `${filter}<ul class="post-list">${posts
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
  if (!(await fs.exists(`posts/${slug}.md`))) {
    app.innerHTML = `<p>No post called <code>${esc(slug)}</code>. <a href="#/new">Create it?</a></p>`;
    return;
  }
  const meta = (await fs.stat(`posts/${slug}.md`)).metadata ?? {};
  const html = await fs.readFile(`html/${slug}.html`);
  document.title = `${meta.title ?? slug} · MD4C Blog`;

  app.innerHTML = `<article>
    <header class="post-head">
      <h1>${esc(meta.title ?? slug)}</h1>
      <div class="meta"><time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time>${tagLinks(parseTags(meta.tags))}</div>
      <div class="post-actions">
        <a class="button" href="#/edit/${encodeURIComponent(slug)}">Edit</a>
        <button type="button" class="danger" id="delete">Delete</button>
      </div>
    </header>
    <div class="prose">${html}</div>
  </article>`;
  linkify(app);

  app.querySelector('#delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${meta.title ?? slug}"?`)) return;
    await deletePost(slug);
    location.hash = '#/';
  });
}

async function showEditor(slug) {
  const isNew = slug === undefined;
  let source = serializePost(
    { title: '', date: today(), tags: '' },
    '# Hello\n\nWrite your post in **Markdown** here.\n'
  );
  if (!isNew) {
    if (!(await fs.exists(`posts/${slug}.md`))) return showPost(slug);
    source = await fs.readFile(`posts/${slug}.md`);
  }
  const { meta, body } = parseFrontMatter(source);
  document.title = `${isNew ? 'New post' : 'Edit'} · MD4C Blog`;

  app.innerHTML = `<form class="editor" autocomplete="off">
    <div class="fields">
      <label>Title <input type="text" name="title" required value="${esc(meta.title ?? '')}"></label>
      <label>Date <input type="date" name="date" required value="${esc(meta.date ?? today())}"></label>
      <label class="full">Tags (comma separated) <input type="text" name="tags" value="${esc(meta.tags ?? '')}"></label>
    </div>
    <div class="panes">
      <textarea name="body" spellcheck="true" aria-label="Markdown source">${esc(body)}</textarea>
      <div class="preview prose" aria-label="Preview"></div>
    </div>
    <div class="editor-actions">
      <button type="submit" class="primary">${isNew ? 'Publish' : 'Save'}</button>
      <a class="button" href="${isNew ? '#/' : `#/post/${encodeURIComponent(slug)}`}">Cancel</a>
      <span class="status" aria-live="polite"></span>
    </div>
  </form>`;

  const form = app.querySelector('form');
  const preview = app.querySelector('.preview');
  const status = app.querySelector('.status');
  const update = () => {
    const t0 = performance.now();
    preview.innerHTML = render(form.body.value);
    linkify(preview);
    status.textContent = `Rendered in ${(performance.now() - t0).toFixed(1)} ms`;
  };
  form.body.addEventListener('input', update);
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = form.title.value.trim();
    const newSlug = isNew ? slugify(title) : slug;
    if (isNew && (await fs.exists(`posts/${newSlug}.md`))) {
      status.innerHTML = `<span class="error">A post with the slug “${esc(newSlug)}” already exists.</span>`;
      return;
    }
    const text = serializePost(
      { title, date: form.date.value, tags: form.tags.value },
      form.body.value
    );
    await savePost(newSlug, text);
    location.hash = `#/post/${encodeURIComponent(newSlug)}`;
  });
}

/* ---------- Router ---------- */

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const arg = parts[1] !== undefined ? decodeURIComponent(parts[1]) : undefined;
  try {
    switch (parts[0]) {
      case 'post': return await showPost(arg);
      case 'edit': return await showEditor(arg);
      case 'new': return await showEditor(undefined);
      case 'tag': return await showList(arg);
      default: return await showList();
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Something went wrong: ${esc(err.message ?? err)}</p>`;
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

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Delete all posts stored in this browser and restore the samples?')) return;
  for (const f of await fs.readdir('')) await fs.unlink(f.path);
  await seedSamplePosts();
  location.hash = '#/';
  route();
});

async function main() {
  try {
    fs = await Md4cFs.open({
      name: 'md4c-blog',
      wasmUrl: new URL('./lib/md4c.wasm', import.meta.url),
    });
    if ((await fs.readdir('posts/')).length === 0) await seedSamplePosts();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not start the blog: ${esc(err.message ?? err)}</p>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

main();
