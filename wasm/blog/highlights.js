// highlights.html: the highlights of every paper-notes post with their
// comments (index.json keeps a short form of each: js/paper.js
// annotationSummary), to filter by tag and search. A tag can be given in
// the address: highlights.html#tag=method.
//
//   showHighlights(view, items, hrefOfPost)   the blog's page, from index.json
//   renderHighlights(view, papers, opts)      the list itself (also the admin's
//                                             Comments page, with drafts)

import { mathText } from './lib/paper.js';

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
export function showHighlights(view, items, hrefOfPost, { typeset } = {}) {
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
  renderHighlights(view, papers, { typeset, graph: { items, postHref: hrefOfPost } });
}

/**
 * The highlights of `papers` ([{ title, href, list: [annotationSummary], badge? }]),
 * with a search box and the tags to filter by. opts.hash: keep the tag in
 * the address (#tag=…); opts.linkOf(paper, highlight): a highlight's link;
 * opts.onOpen(paper, highlight, event): a highlight's link was followed.
 * opts.typeset(element): typeset the math ($…$) of the comments shown.
 * opts.graph: { items, postHref, onOpen? }: a graph of the comments, the
 * papers they belong to and what links them (graph.js), above the list.
 */
export function renderHighlights(view, papers, { hash = true, linkOf = (p, h) => `${p.href}#${h.id}`, onOpen, typeset, graph } = {}) {
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
    ${graph ? `<details class="hl-graph"><summary>Graph of the comments and the articles that link them</summary>
      <div class="graph-box hl-graph-box"></div></details>` : ''}
    <div class="hl-papers"></div>`;
  if (graph) {
    const details = view.querySelector('.hl-graph');
    let drawn = null;
    details.addEventListener('toggle', async () => {
      if (!details.open || drawn) return;
      const { graphData, drawGraph } = await import('./graph.js');
      const g = graphData(graph.items, { postHref: graph.postHref, highlights: true, commentsOnly: true });
      drawn = drawGraph(details.querySelector('.graph-box'), g, graph.onOpen ? { onOpen: graph.onOpen } : {});
    });
  }
  const out = view.querySelector('.hl-papers');
  const search = view.querySelector('.hl-search');
  let tag = hash && counts.has(tagFromHash()) ? tagFromHash() : '';

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
        <h2 class="hl-paper-title"><a href="${esc(p.href)}">${esc(p.title)}</a> <span class="count">${list.length}</span>${p.badge ? ` <span class="hl-badge">${esc(p.badge)}</span>` : ''}</h2>
        <ol class="annotations hl-list">${list.map((h) => `<li class="annotation${!h.comment && h.label.startsWith('“') ? ' is-quote-label' : ''}" data-color="${esc(h.color)}">
          <a class="annotation-at" href="${esc(linkOf(p, h))}" data-paper="${papers.indexOf(p)}" data-id="${esc(h.id)}" title="Page ${h.page}">${mathText(h.label)}</a>
          ${h.tags?.length ? `<div class="annotation-tags">${h.tags.map((t) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
          ${h.quote ? `<blockquote class="annotation-quote">${esc(h.quote)}</blockquote>` : ''}
          ${h.comment && h.comment !== h.label ? `<p class="annotation-comment">${mathText(h.comment)}</p>` : ''}
        </li>`).join('')}</ol>
      </section>`;
    }).join('') || '<p class="muted">No highlight matches.</p>';
    view.querySelector('.hl-count').textContent = `${shown} highlight${shown === 1 ? '' : 's'}`;
    typeset?.(out);
    for (const b of view.querySelectorAll('.hl-tags [data-tag]')) b.setAttribute('aria-pressed', String(b.dataset.tag === tag));
  };

  view.addEventListener('click', (e) => {
    const open = e.target.closest('a.annotation-at[data-id]');
    if (open && onOpen) {
      const p = papers[Number(open.dataset.paper)];
      onOpen(p, p.list.find((h) => h.id === open.dataset.id), e);
      return;
    }
    const b = e.target.closest('button[data-tag]');
    if (!b) return;
    tag = b.closest('.annotation') && tag === b.dataset.tag ? '' : b.dataset.tag;
    if (hash) history.replaceState(null, '', tag ? `#tag=${encodeURIComponent(tag)}` : location.pathname + location.search);
    render();
  });
  search.addEventListener('input', render);
  if (hash) {
    window.addEventListener('hashchange', () => {
      tag = counts.has(tagFromHash()) ? tagFromHash() : '';
      render();
    });
  }
  render();
}
