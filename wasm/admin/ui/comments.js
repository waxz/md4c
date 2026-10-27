// Comments: the highlights and comments of every paper-notes post in one
// list, drafts included, to search and filter by tag (blog/highlights.js
// draws it, as on the blog's highlights.html). Published papers come from
// index.json; drafts are read from their stores (a draft of a published
// paper replaces it here). A highlight opens in the editor, at its place.

import { api } from './client.js';
import { esc, reportError, state } from './shared.js';
import { parseFrontMatter } from './lib/post-format.js';
import { annotationSummary, isPaper, referencedIds, sortAnnotations, splitAnnotations } from './lib/paper.js';
import { renderHighlights } from './highlights.js';
import { renderMath } from './render.js';

/** The editor shows this highlight when it opens the post (editor.js). */
export const SHOW_KEY = 'md4c-admin:show-annotation';

const editHref = (store, key) => `#/edit/${store}/${key}`;

/** Run `fn` on each item, `n` at a time. */
async function eachLimited(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function showComments(view) {
  if (!document.querySelector('link[data-paper-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'paper.css';
    link.dataset.paperCss = '';
    document.head.append(link);
  }
  view.innerHTML = `<div class="hl-admin">
    <h1>Comments</h1>
    <p class="muted hl-intro">Every highlight and comment of your papers, drafts included. Search, or choose a tag; a highlight opens in the editor.</p>
    <div class="hl-body"><p class="muted">Loading…</p></div>
  </div>`;
  const body = view.querySelector('.hl-body');
  const readIndex = (blog) => api.read(blog, 'index.json').then((r) => JSON.parse(r.text)).catch(() => null);
  const [{ posts }, publicIndex, privateIndex] = await Promise.all([
    api.posts(), readIndex('site'), state.session.privateBlog ? readIndex('private') : null,
  ]);
  // Both blogs' papers (a post is on one of them), each item knowing its blog.
  const index = { items: [
    ...(publicIndex?.items ?? []).map((e) => ({ ...e, blog: 'site' })),
    ...(privateIndex?.items ?? []).map((e) => ({ ...e, blog: 'private' })),
  ] };
  const drafts = posts.filter((p) => p.status === 'draft');
  const drafted = new Set(drafts.map((p) => p.key));
  const papers = [];
  // The graph's posts: the published ones, with each draft in place of its
  // published copy (store = where the editor opens it).
  const graphItems = new Map((index?.items ?? []).filter((e) => e?.path).map((e) => [e.path, { ...e, store: e.blog }]));
  for (const e of index?.items ?? []) {
    if (!Array.isArray(e?.highlights) || !e.highlights.length || drafted.has(e.path)) continue;
    const slug = e.path.slice('posts/'.length, -'.md'.length);
    papers.push({
      title: e.metadata?.title || slug, date: e.metadata?.date ?? '', href: editHref(e.blog, e.path), list: e.highlights,
      ...(e.blog === 'private' ? { badge: 'private' } : {}),
    });
  }
  const live = new Set((index?.items ?? []).map((e) => e?.path));
  const failed = [];
  await eachLimited(drafts, 6, async (p) => {
    try {
      const text = (await api.read(p.store, p.key)).text;
      const { meta, body: md } = parseFrontMatter(text);
      const { body: notes, annotations } = isPaper(meta) ? splitAnnotations(md) : { body: md, annotations: [] };
      const list = sortAnnotations(annotations).map(annotationSummary);
      graphItems.set(p.key, {
        ...(graphItems.get(p.key) ?? {}), path: p.key, store: p.store,
        metadata: { ...(graphItems.get(p.key)?.metadata ?? {}), title: meta.title || p.title || p.key },
        highlights: list, refs: referencedIds(notes),
      });
      if (!annotations.length) return;
      papers.push({
        title: meta.title || p.title || p.key, date: String(meta.date ?? p.date ?? ''),
        href: editHref(p.store, p.key), list,
        ...(live.has(p.key) ? {} : { badge: 'draft' }), // (a published paper keeps its draft)
      });
    } catch (err) {
      failed.push(`${p.key}: ${err.message ?? err}`);
    }
  });
  papers.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  if (failed.length) reportError(new Error(`Some drafts could not be read: ${failed.join('; ')}`));
  if (!papers.length) {
    body.innerHTML = '<p class="muted">No highlights yet. Make a post of the kind <b>Paper notes</b> and highlight its PDF.</p>';
    return;
  }
  const open = (href, id) => {
    try {
      if (id) sessionStorage.setItem(SHOW_KEY, id);
    } catch {}
    location.hash = href;
  };
  renderHighlights(body, papers, {
    hash: false,
    typeset: (el) => renderMath(el, { math: true }),
    graph: {
      items: [...graphItems.values()],
      postHref: (slug, e) => editHref(e.store ?? 'site', e.path),
      onOpen: (node) => open(node.paperHref ?? node.href, node.highlight),
    },
    linkOf: (p) => p.href,
    onOpen: (p, h, e) => {
      e.preventDefault();
      open(p.href, h.id);
    },
  });
  body.insertAdjacentHTML('afterbegin', `<p class="muted hl-summary">${esc(String(papers.length))} paper${papers.length === 1 ? '' : 's'}</p>`);
}
