// highlights.html: the highlights of every paper-notes post with their
// comments (index.json keeps a short form of each: js/paper.js
// annotationSummary), to filter by tag and search. A tag can be given in
// the address: highlights.html#tag=method.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const tagFromHash = () => {
  const m = /^#tag=(.*)$/.exec(location.hash);
  try {
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
};

/**
 * Draw the overview in `view`. `items` = index.json's items; `hrefOfPost(slug,
 * item)` = a post's address.
 */
export function showHighlights(view, items, hrefOfPost) {
  const papers = items
    .filter((e) => e && Array.isArray(e.highlights) && e.highlights.length && /^posts\/[^/]+\.md$/.test(e.path ?? ''))
    .map((e) => {
      const slug = e.path.slice('posts/'.length, -'.md'.length);
      return { slug, title: e.metadata?.title || slug, date: e.metadata?.date ?? '', href: hrefOfPost(slug, e), list: e.highlights };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  if (!papers.length) {
    view.innerHTML = '<p class="muted">No highlights yet. <a href="index.html">All articles</a></p>';
    return;
  }
  const counts = new Map();
  for (const p of papers) for (const h of p.list) for (const t of h.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));

  view.innerHTML = `<div class="hl-controls">
      <input type="search" class="hl-search" placeholder="Search the highlights and comments" aria-label="Search the highlights">
      <span class="hl-count muted" aria-live="polite"></span>
    </div>
    ${tags.length ? `<div class="paper-tagbar hl-tags" role="toolbar" aria-label="Show the highlights with a tag">
      <button type="button" class="annotation-tag" data-tag="">All</button>
      ${tags.map(([t, n]) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}<span class="n">${n}</span></button>`).join('')}
    </div>` : ''}
    <div class="hl-papers"></div>`;
  const out = view.querySelector('.hl-papers');
  const search = view.querySelector('.hl-search');
  let tag = counts.has(tagFromHash()) ? tagFromHash() : '';

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const match = (h) => (!tag || (h.tags ?? []).includes(tag))
      && (!q || [h.label, h.quote, h.comment, ...(h.tags ?? [])].some((v) => String(v ?? '').toLowerCase().includes(q)));
    let shown = 0;
    out.innerHTML = papers.map((p) => {
      const list = p.list.filter(match);
      shown += list.length;
      if (!list.length) return '';
      return `<section class="hl-paper">
        <h2 class="hl-paper-title"><a href="${esc(p.href)}">${esc(p.title)}</a> <span class="count">${list.length}</span></h2>
        <ol class="annotations hl-list">${list.map((h) => `<li class="annotation${!h.comment && h.label.startsWith('“') ? ' is-quote-label' : ''}" data-color="${esc(h.color)}">
          <a class="annotation-at" href="${esc(`${p.href}#${h.id}`)}" title="Page ${h.page}">${esc(h.label)}</a>
          ${h.tags?.length ? `<div class="annotation-tags">${h.tags.map((t) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
          ${h.quote ? `<blockquote class="annotation-quote">${esc(h.quote)}</blockquote>` : ''}
          ${h.comment && h.comment !== h.label ? `<p class="annotation-comment">${esc(h.comment)}</p>` : ''}
        </li>`).join('')}</ol>
      </section>`;
    }).join('') || '<p class="muted">No highlight matches.</p>';
    view.querySelector('.hl-count').textContent = `${shown} highlight${shown === 1 ? '' : 's'}`;
    for (const b of view.querySelectorAll('.hl-tags [data-tag]')) b.setAttribute('aria-pressed', String(b.dataset.tag === tag));
  };

  view.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tag]');
    if (!b) return;
    tag = b.closest('.annotation') && tag === b.dataset.tag ? '' : b.dataset.tag;
    history.replaceState(null, '', tag ? `#tag=${encodeURIComponent(tag)}` : location.pathname + location.search);
    render();
  });
  search.addEventListener('input', render);
  window.addEventListener('hashchange', () => {
    tag = counts.has(tagFromHash()) ? tagFromHash() : '';
    render();
  });
  render();
}
