// A small single-page blog. Posts are Markdown files stored on the blog
// server through storagesdk (wrapped by Md4cFs) and rendered to HTML in the
// browser by MD4C running as WebAssembly.
//
// Guests can only read published posts. The owner logs in as admin to write,
// publish, unpublish and delete. The server enforces those rules; this file
// only hides controls a visitor cannot use.
//
// Every piece of rendered HTML goes through DOMPurify before it reaches the
// page, so a post cannot run script even though Markdown allows raw HTML.
//
// Storage layout (on the server):
//   posts/<slug>.md    published posts, readable by everyone
//   drafts/<slug>.md   drafts, visible to the admin only
//
// Routes: #/  #/tag/<tag>  #/post/<slug>  #/drafts  #/draft/<slug>
//         #/new  #/edit/<posts|drafts>/<slug>  #/login

import { Storage } from './vendor/storagesdk-core/index.js';
import DOMPurify from './vendor/dompurify/purify.es.mjs';
import { httpAdapter } from './lib/http-adapter.js';
import { Md4cFs } from './lib/md4c-fs.js';
import { Dialect, Flags } from './lib/md4c.js';
import { parseFrontMatter, parseTags, postMetadata, serializePost } from './lib/post-format.js';

const PARSER_FLAGS =
  Dialect.GITHUB | Flags.WIKILINKS | Flags.HIGHLIGHT | Flags.LATEXMATHSPANS;

const app = document.getElementById('app');
let session = { admin: false };
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

const pathOf = (kind, slug) => `${kind}/${slug}.md`;

/* ---------- Safe rendering ---------- */

// Links keep only safe schemes (DOMPurify drops javascript: and friends);
// external links do not leak the referrer or get window.opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href');
    if (!href.startsWith('#')) node.setAttribute('rel', 'noopener noreferrer nofollow');
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

/* ---------- Session ---------- */

async function api(path, init = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(session.csrfToken ? { 'x-csrf-token': session.csrfToken } : {}),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

function renderChrome() {
  const nav = document.getElementById('nav');
  nav.innerHTML = session.admin
    ? `<a href="#/">Posts</a><a href="#/drafts">Drafts</a>
       <button type="button" class="link" id="logout">Log out</button>
       <a href="#/new" class="button">New post</a>`
    : '<a href="#/">Posts</a>';
  document.getElementById('footer-auth').innerHTML = session.admin
    ? '<span class="badge">Admin</span>'
    : '<a href="#/login">Admin login</a>';
  nav.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    session = { admin: false };
    renderChrome();
    location.hash = '#/';
    route();
  });
}

function requireAdmin() {
  if (session.admin) return true;
  app.innerHTML = '<p>Only the blog owner can do that. <a href="#/login">Log in as admin</a>.</p>';
  return false;
}

/* ---------- Storage ---------- */

async function listPosts(kind) {
  const files = await fs.readdir(`${kind}/`);
  return files
    .map((f) => ({
      slug: f.path.slice(kind.length + 1, -'.md'.length),
      title: f.metadata?.title ?? f.path,
      date: f.metadata?.date ?? '',
      tags: parseTags(f.metadata?.tags),
      excerpt: f.metadata?.excerpt ?? '',
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function writePost(path, source, slug) {
  const metadata = postMetadata(
    source,
    (md) => fs.render(md, { parserFlags: PARSER_FLAGS }),
    slug
  );
  await fs.writeFile(path, source, { metadata });
}

/* ---------- Views ---------- */

function tagLinks(tags) {
  return tags
    .map((t) => `<a class="tag" href="#/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');
}

async function showList({ tag, kind = 'posts' } = {}) {
  if (kind === 'drafts' && !requireAdmin()) return;
  let posts = await listPosts(kind);
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  document.title = kind === 'drafts' ? 'Drafts · MD4C Blog' : tag ? `#${tag} · MD4C Blog` : 'MD4C Blog';

  const heading = kind === 'drafts'
    ? '<p class="filter muted">Drafts are visible only to you until you publish them.</p>'
    : tag
      ? `<p class="filter muted">Posts tagged <strong>${esc(tag)}</strong> · <a href="#/">show all</a></p>`
      : '';
  if (posts.length === 0) {
    app.innerHTML = `${heading}<p class="muted">Nothing here yet.${session.admin ? ' <a href="#/new">Write a post</a>.' : ''}</p>`;
    return;
  }
  const route = kind === 'drafts' ? 'draft' : 'post';
  app.innerHTML = `${heading}<ul class="post-list">${posts
    .map(
      (p) => `<li class="post-card">
        <h2><a href="#/${route}/${encodeURIComponent(p.slug)}">${esc(p.title)}</a></h2>
        <div class="meta"><time datetime="${esc(p.date)}">${esc(formatDate(p.date))}</time>${tagLinks(p.tags)}</div>
        ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
      </li>`
    )
    .join('')}</ul>`;
}

async function showPost(kind, slug) {
  if (kind === 'drafts' && !requireAdmin()) return;
  const path = pathOf(kind, slug);
  if (!(await fs.exists(path))) {
    app.innerHTML = `<p>No post called <code>${esc(slug)}</code>.</p>`;
    return;
  }
  const { meta, body } = parseFrontMatter(await fs.readFile(path));
  const title = meta.title || slug;
  document.title = `${title} · MD4C Blog`;

  const isDraft = kind === 'drafts';
  const actions = session.admin
    ? `<div class="post-actions">
        <a class="button" href="#/edit/${kind}/${encodeURIComponent(slug)}">Edit</a>
        <button type="button" id="toggle">${isDraft ? 'Publish' : 'Unpublish'}</button>
        <button type="button" class="danger" id="delete">Delete</button>
      </div>`
    : '';
  app.innerHTML = `<article>
    <header class="post-head">
      ${isDraft ? '<span class="badge">Draft</span>' : ''}
      <h1>${esc(title)}</h1>
      <div class="meta"><time datetime="${esc(meta.date ?? '')}">${esc(formatDate(meta.date ?? ''))}</time>${tagLinks(parseTags(meta.tags))}</div>
      ${actions}
    </header>
    <div class="prose"></div>
  </article>`;
  app.querySelector('.prose').append(renderSafe(body));

  app.querySelector('#toggle')?.addEventListener('click', async () => {
    const to = isDraft ? 'posts' : 'drafts';
    await fs.rename(path, pathOf(to, slug));
    location.hash = `#/${isDraft ? 'post' : 'draft'}/${encodeURIComponent(slug)}`;
  });
  app.querySelector('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${title}"?`)) return;
    await fs.unlink(path);
    location.hash = isDraft ? '#/drafts' : '#/';
  });
}

async function showEditor(kind, slug) {
  if (!requireAdmin()) return;
  const isNew = slug === undefined;
  let source = serializePost(
    { title: '', date: today(), tags: '' },
    '# Hello\n\nWrite your post in **Markdown** here.\n'
  );
  if (!isNew) source = await fs.readFile(pathOf(kind, slug));
  const { meta, body } = parseFrontMatter(source);
  document.title = `${isNew ? 'New post' : 'Edit'} · MD4C Blog`;

  const published = kind === 'posts';
  app.innerHTML = `<form class="editor" autocomplete="off">
    <div class="fields">
      <label>Title <input type="text" name="title" required maxlength="200" value="${esc(meta.title ?? '')}"></label>
      <label>Date <input type="date" name="date" required value="${esc(meta.date ?? today())}"></label>
      <label class="full">Tags (comma separated) <input type="text" name="tags" maxlength="300" value="${esc(meta.tags ?? '')}"></label>
    </div>
    <div class="panes">
      <textarea name="body" spellcheck="true" aria-label="Markdown source">${esc(body)}</textarea>
      <div class="preview prose" aria-label="Preview"></div>
    </div>
    <div class="editor-actions">
      ${published
        ? '<button type="submit" class="primary" value="posts">Update</button><button type="submit" value="drafts">Unpublish</button>'
        : '<button type="submit" class="primary" value="posts">Publish</button><button type="submit" value="drafts">Save draft</button>'}
      <a class="button" href="${isNew ? '#/' : `#/${published ? 'post' : 'draft'}/${encodeURIComponent(slug)}`}">Cancel</a>
      <span class="status" aria-live="polite"></span>
    </div>
  </form>`;

  const form = app.querySelector('form');
  const preview = app.querySelector('.preview');
  const status = app.querySelector('.status');
  const update = () => {
    const t0 = performance.now();
    preview.replaceChildren(renderSafe(form.body.value));
    status.textContent = `Rendered in ${(performance.now() - t0).toFixed(1)} ms`;
  };
  form.body.addEventListener('input', update);
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = e.submitter?.value ?? 'drafts';
    const newSlug = isNew ? slugify(form.title.value) : slug;
    const text = serializePost(
      { title: form.title.value, date: form.date.value, tags: form.tags.value },
      form.body.value
    );
    try {
      if (isNew) {
        if ((await fs.exists(pathOf('posts', newSlug))) || (await fs.exists(pathOf('drafts', newSlug))))
          throw new Error(`a post with the slug "${newSlug}" already exists`);
        await writePost(pathOf(target, newSlug), text, newSlug);
      } else {
        await writePost(pathOf(kind, slug), text, slug);
        if (target !== kind) await fs.rename(pathOf(kind, slug), pathOf(target, slug));
      }
      location.hash = `#/${target === 'posts' ? 'post' : 'draft'}/${encodeURIComponent(newSlug)}`;
    } catch (err) {
      status.innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
  });
}

function showLogin() {
  if (session.admin) {
    location.hash = '#/';
    return;
  }
  document.title = 'Admin login · MD4C Blog';
  app.innerHTML = `<form class="login">
    <h1>Admin login</h1>
    <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
    <div class="editor-actions"><button type="submit" class="primary">Log in</button><span class="status" aria-live="polite"></span></div>
  </form>`;
  const form = app.querySelector('form');
  form.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      session = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ password: form.password.value }),
      });
      renderChrome();
      location.hash = '#/';
    } catch (err) {
      form.querySelector('.status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
  });
}

/* ---------- Router ---------- */

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  try {
    switch (parts[0]) {
      case 'post': return await showPost('posts', parts[1]);
      case 'draft': return await showPost('drafts', parts[1]);
      case 'drafts': return await showList({ kind: 'drafts' });
      case 'edit': return await showEditor(parts[1] === 'posts' ? 'posts' : 'drafts', parts[2]);
      case 'new': return await showEditor('drafts', undefined);
      case 'tag': return await showList({ tag: parts[1] });
      case 'login': return showLogin();
      default: return await showList();
    }
  } catch (err) {
    console.error(err);
    if (err.code === 'Unauthorized') {
      // Session expired or server restarted.
      session = { admin: false };
      renderChrome();
    }
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

async function main() {
  try {
    session = await api('/session');
    fs = await Md4cFs.open({
      storage: new Storage({ adapter: httpAdapter({ csrfToken: () => session.csrfToken }) }),
      wasmUrl: new URL('./lib/md4c.wasm', import.meta.url),
    });
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not start the blog: ${esc(err.message ?? err)}</p>`;
    return;
  }
  renderChrome();
  window.addEventListener('hashchange', route);
  route();
}

main();
