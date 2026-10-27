// Posts: the admin's home. Drafts (from every draft store) and published
// posts in separate sections, one card per post. A published post's draft
// (its working copy) is shown on the published card, which opens it.
//
// Each card's ⋯ menu publishes, updates, unpublishes or deletes the post.
// That work runs in the background (post-actions.js, tasks.js): the card
// shows what is running, and the list refreshes when it is done.

import { api } from './client.js';
import { askDelete, askMoveTarget, deletePost, moveDraft, publishPost, unpublishPost } from './post-actions.js';
import { draftStores, esc, formatTime, publicUrl, reportError, state, storeLabel } from './shared.js';
import { Cancelled, running } from './tasks.js';

const editHref = (store, key) => `#/edit/${store}/${key}`;

// The posts on screen, by card index: { draft, published, title }.
let cards = [];

function card(p, draft) {
  const index = cards.length;
  cards.push({
    draft: p.status === 'draft' ? { store: p.store, key: p.key, etag: p.etag } : draft ? { store: draft.store, key: draft.key, etag: draft.etag } : null,
    published: p.status === 'published' ? { key: p.key, etag: p.etag } : null,
    title: (draft ?? p).title,
  });
  const busy = running().find((t) => t.key === p.key);
  const live = p.status === 'published' ? publicUrl(p.key.replace(/\.md$/, '.html')) : '';
  const tags = p.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const open = draft ?? p;
  // Publishing copies the draft, so a draft saved later has changes not yet live.
  const pending = draft && draft.uploaded > p.uploaded;
  return `<li class="post-card">
    <a class="post-card-main" href="${esc(editHref(open.store, open.key))}">
      <span class="post-title">${esc((draft ?? p).title)}</span>
      <span class="post-meta">
        ${busy ? `<span class="chip chip-busy"><span class="spinner" aria-hidden="true"></span>${esc(busy.title.split(' “')[0])}…</span>` : ''}
        ${pending ? '<span class="chip chip-warn">changes not live</span>' : ''}
        ${open.status === 'draft' && draftStores().length > 1 ? `<span class="chip">${esc(storeLabel(open.store))}</span>` : ''}
        <span>${esc(p.date || formatTime(p.uploaded))}</span>
        ${tags.length ? `<span class="post-tags">${tags.map(esc).join(' · ')}</span>` : ''}
      </span>
    </a>
    ${live ? `<a class="post-card-link" href="${esc(live)}" target="_blank" rel="noopener" aria-label="View “${esc(p.title)}” on the blog">↗</a>` : ''}
    <button type="button" class="post-card-link post-card-more" data-card="${index}" aria-haspopup="menu" aria-label="Actions for “${esc((draft ?? p).title)}”"${busy ? ' disabled' : ''}>⋯</button>
  </li>`;
}

function section(title, posts, empty, drafts = new Map()) {
  return `<section class="post-section">
    <h2>${title} <span class="count">${posts.length}</span></h2>
    ${posts.length ? `<ul class="post-cards">${posts.map((p) => card(p, drafts.get(p.key))).join('')}</ul>` : `<p class="muted empty">${empty}</p>`}
  </section>`;
}

// The last posts list, shown at once while a fresh one loads; kept for the
// browser session so a reload is instant too.
const CACHE_KEY = 'md4c-admin-posts';
let lastPosts = null;
function cachedPosts() {
  if (lastPosts) return lastPosts;
  try {
    return JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function rememberPosts(data) {
  lastPosts = data;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

export async function showPosts(view) {
  const route = location.hash;
  const cached = cachedPosts();
  if (cached) renderPosts(view, cached, true);
  else view.innerHTML = '<p class="muted">Loading posts…</p>';
  let fresh;
  try {
    fresh = await api.posts();
  } catch (err) {
    if (!cached) throw err;
    view.querySelector('.refreshing')?.replaceChildren('Could not refresh: showing the last list.');
    return;
  }
  rememberPosts(fresh);
  if (location.hash !== route && !(route === '' && location.hash === '#/posts')) return;
  if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) renderPosts(view, fresh, false);
  else view.querySelector('.refreshing')?.remove();
}

function renderPosts(view, { posts, problems = [] }, stale) {
  const oldSearch = view.querySelector('.posts-view .search');
  const query = oldSearch?.value ?? '';
  const typing = oldSearch && document.activeElement === oldSearch;
  const order = (a, b) => (b.date || b.uploaded).localeCompare(a.date || a.uploaded);
  const published = posts.filter((p) => p.status === 'published').sort(order);
  const live = new Set(published.map((p) => p.key));
  const draftOf = new Map(posts.filter((p) => p.status === 'draft' && live.has(p.key)).map((p) => [p.key, p]));
  const drafts = posts.filter((p) => p.status === 'draft' && !live.has(p.key)).sort(order);

  view.innerHTML = `<div class="posts-view">
    <div class="view-head">
      <h1>Posts</h1>
      ${stale ? '<span class="refreshing muted" aria-live="polite">Updating…</span>' : ''}
      <a class="btn btn-primary" href="#/new">New post</a>
    </div>
    ${problems.map((p) => p.store === 'server'
      ? `<p class="notice">${esc(p.error)} <a href="./?signin${esc(location.hash)}">Sign in again</a></p>`
      : `<p class="notice error">${esc(p.error)} <a href="#/storage">Check storage</a></p>`).join('')}
    <input type="search" class="search" placeholder="Search posts" aria-label="Search posts">
    <div class="post-sections"></div>
  </div>`;
  const target = view.querySelector('.post-sections');
  const render = (q = '') => {
    cards = [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (p) => words.every((w) => `${p.title} ${p.tags} ${p.key}`.toLowerCase().includes(w));
    target.innerHTML =
      (state.session.stores.some((s) => s.role === 'drafts')
        ? section('Drafts', drafts.filter(match), 'No drafts. Start one with “New post”.')
        : '') +
      section('Published', published.filter(match), 'Nothing published yet.', draftOf);
  };
  const search = view.querySelector('.search');
  search.value = query;
  search.addEventListener('input', (e) => render(e.target.value));
  render(query);
  if (typing) search.focus(); // the fresh list arrived while typing
  wireMenus(view, () => render(search.value));
}

/* ---------- The ⋯ menu ---------- */

function actionsFor(post) {
  const { draft, published } = post;
  const editStore = draft?.store ?? 'site';
  const editKey = (draft ?? published).key;
  return [
    { act: 'edit', label: 'Edit', href: editHref(editStore, editKey) },
    draft ? { act: 'publish', label: published ? 'Update site' : 'Publish', primary: true } : null,
    published ? { act: 'unpublish', label: draft ? 'Unpublish (keep the draft)' : 'Unpublish (keep as a draft)', hidden: !draftStores().length } : null,
    draft && draftStores().length > 1 ? { act: 'move', label: 'Move draft to…' } : null,
    { act: 'read', label: draft && !published ? 'Read (private)' : 'Read', href: `read?${new URLSearchParams({ store: editStore, key: editKey })}`, external: true },
    published ? { act: 'view', label: 'View on the blog', href: publicUrl(published.key.replace(/\.md$/, '.html')), external: true } : null,
    { act: 'delete', label: 'Delete…', danger: true },
  ].filter((a) => a && !a.hidden);
}

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

function wireMenus(view, rerender) {
  view.querySelector('.post-sections').addEventListener('click', (e) => {
    const btn = e.target.closest('.post-card-more');
    if (!btn) return;
    e.stopPropagation();
    const wasOpen = openMenu?.dataset.card === btn.dataset.card;
    closeMenu();
    if (wasOpen) return;
    const post = cards[Number(btn.dataset.card)];
    const menu = document.createElement('div');
    menu.className = 'card-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.card = btn.dataset.card;
    menu.innerHTML = actionsFor(post).map((a) => a.href
      ? `<a role="menuitem" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener"' : ''}>${esc(a.label)}</a>`
      : `<button type="button" role="menuitem" data-act="${a.act}" class="${a.danger ? 'danger' : a.primary ? 'primary' : ''}">${esc(a.label)}</button>`).join('');
    btn.closest('.post-card').append(menu);
    openMenu = menu;
    menu.querySelector('[role=menuitem]')?.focus();
    menu.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      closeMenu();
      try {
        if (act === 'publish') await publishPost(post);
        else if (act === 'unpublish') await unpublishPost(post);
        else if (act === 'move') {
          const to = await askMoveTarget(post);
          if (to) await moveDraft(post, to);
        }
        else if (act === 'delete') {
          const what = await askDelete(post);
          if (what) await deletePost(post, what);
        }
      } catch (err) {
        if (!(err instanceof Cancelled)) reportError(err);
      }
    });
    menu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        closeMenu();
        btn.focus();
      }
    });
  });
  shown = { view, rerender };
}

// Cards show what is running; finished work refreshes the list.
let shown = null; // the posts view on screen: { view, rerender }
window.addEventListener('tasks', (e) => {
  if (!shown?.view.querySelector('.posts-view')) return;
  const { task } = e.detail;
  if (task.status === 'running') {
    if (!openMenu) shown.rerender();
  } else if (task.key || /site/i.test(task.title)) {
    refreshSoon(shown.view);
  }
});

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});

let refreshTimer;
function refreshSoon(view) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!view.querySelector('.posts-view')) return;
    try {
      const fresh = await api.posts();
      rememberPosts(fresh);
      if (view.querySelector('.posts-view')) renderPosts(view, fresh, false);
    } catch (err) {
      console.warn('posts refresh:', err);
    }
  }, 300);
}
