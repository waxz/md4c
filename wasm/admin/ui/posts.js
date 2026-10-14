// Posts: the admin's home. Drafts (from every draft store) and published
// posts in separate sections, one card per post.

import { api } from './client.js';
import { draftStores, esc, formatTime, publicUrl, state, storeLabel } from './shared.js';

const editHref = (store, key) => `#/edit/${store}/${key}`;

function card(p) {
  const live = p.status === 'published' ? publicUrl(p.key.replace(/\.md$/, '.html')) : '';
  const tags = p.tags.split(',').map((t) => t.trim()).filter(Boolean);
  return `<li class="post-card">
    <a class="post-card-main" href="${esc(editHref(p.store, p.key))}">
      <span class="post-title">${esc(p.title)}</span>
      <span class="post-meta">
        ${p.status === 'draft' && draftStores().length > 1 ? `<span class="chip">${esc(storeLabel(p.store))}</span>` : ''}
        <span>${esc(p.date || formatTime(p.uploaded))}</span>
        ${tags.length ? `<span class="post-tags">${tags.map(esc).join(' · ')}</span>` : ''}
      </span>
    </a>
    ${live ? `<a class="post-card-link" href="${esc(live)}" target="_blank" rel="noopener" aria-label="View “${esc(p.title)}” on the blog">↗</a>` : ''}
  </li>`;
}

function section(title, posts, empty) {
  return `<section class="post-section">
    <h2>${title} <span class="count">${posts.length}</span></h2>
    ${posts.length ? `<ul class="post-cards">${posts.map(card).join('')}</ul>` : `<p class="muted empty">${empty}</p>`}
  </section>`;
}

export async function showPosts(view) {
  view.innerHTML = '<p class="muted">Loading posts…</p>';
  const { posts } = await api.posts();
  const order = (a, b) => (b.date || b.uploaded).localeCompare(a.date || a.uploaded);
  const drafts = posts.filter((p) => p.status === 'draft').sort(order);
  const published = posts.filter((p) => p.status === 'published').sort(order);

  view.innerHTML = `<div class="posts-view">
    <div class="view-head">
      <h1>Posts</h1>
      <a class="btn btn-primary" href="#/new">New post</a>
    </div>
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
      section('Published', published.filter(match), 'Nothing published yet.');
  };
  view.querySelector('.search').addEventListener('input', (e) => render(e.target.value));
  render();
}
