// Posts: the admin's home. Drafts (from every draft store) and published
// posts in separate sections, one card per post. A published post's draft
// (its working copy) is shown on the published card, which opens it.

import { api } from './client.js';
import { draftStores, esc, formatTime, publicUrl, state, storeLabel } from './shared.js';

const editHref = (store, key) => `#/edit/${store}/${key}`;

function card(p, draft) {
  const live = p.status === 'published' ? publicUrl(p.key.replace(/\.md$/, '.html')) : '';
  const tags = p.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const open = draft ?? p;
  // Publishing copies the draft, so a draft saved later has changes not yet live.
  const pending = draft && draft.uploaded > p.uploaded;
  return `<li class="post-card">
    <a class="post-card-main" href="${esc(editHref(open.store, open.key))}">
      <span class="post-title">${esc((draft ?? p).title)}</span>
      <span class="post-meta">
        ${pending ? '<span class="chip chip-warn">changes not live</span>' : ''}
        ${open.status === 'draft' && draftStores().length > 1 ? `<span class="chip">${esc(storeLabel(open.store))}</span>` : ''}
        <span>${esc(p.date || formatTime(p.uploaded))}</span>
        ${tags.length ? `<span class="post-tags">${tags.map(esc).join(' · ')}</span>` : ''}
      </span>
    </a>
    ${live ? `<a class="post-card-link" href="${esc(live)}" target="_blank" rel="noopener" aria-label="View “${esc(p.title)}” on the blog">↗</a>` : ''}
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
    ${problems.map((p) => `<p class="notice error">${esc(p.error)} <a href="#/storage">Check storage</a></p>`).join('')}
    <input type="search" class="search" placeholder="Search posts" aria-label="Search posts">
    <div class="post-sections"></div>
  </div>`;
  const target = view.querySelector('.post-sections');
  const render = (q = '') => {
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
}
