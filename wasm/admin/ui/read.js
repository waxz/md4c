// The reader: every post, drafts included, read in the admin as the blog
// shows it (theme, contents, math, citations, paper notes with their PDF).
// Drafts are private, so this is the private blog: nothing is copied or
// built; a draft is read from its store as it is now. Publishing it (the
// editor, or Posts) makes it public; unpublishing makes it private again.
//
//   read                               the library: drafts and published posts,
//                                      as articles, their comments, or a graph,
//                                      filtered by tag keywords (of both)
//   read?store=drafts&key=posts/a.md   one post (store optional: its
//                                            draft if it has one, else the site)

import { api } from './client.js';
import { getMd4c, init, publicUrl, state } from './shared.js';
import { parseFrontMatter, parseTags } from './lib/post-format.js';
import { readProtected } from './lib/protect.js';
import {
  annotationSummary, isPaper, mathText, referencedIds, sortAnnotations, splitAnnotations,
} from './lib/paper.js';
import { articleHtml, PARSER_FLAGS, postLinks } from './lib/blog-render.js';
import { esc, formatDate, renderMath } from './render.js';
import { applyLook, renderPostInto } from './post-view.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const readHref = (key, store) => `read?${new URLSearchParams({ ...(store ? { store } : {}), key })}`;
const editHref = (store, key) => `./#/edit/${store}/${key}`;
const isDraft = (p) => p.status === 'draft';

/** The posts, one entry per post: its draft if it has one (with `published` noted), else the public copy. */
function library({ posts }) {
  const live = new Map(posts.filter((p) => p.status === 'published').map((p) => [p.key, p]));
  const drafts = posts.filter(isDraft);
  const drafted = new Set(drafts.map((p) => p.key));
  return [
    ...drafts.map((p) => {
      const pub = live.get(p.key) ?? null;
      // (A draft's summary may lack what its published copy has.)
      return { ...p, tags: p.tags || pub?.tags || '', title: p.title || pub?.title || p.key, published: pub };
    }),
    ...[...live.values()].filter((p) => !drafted.has(p.key)).map((p) => ({ ...p, published: p })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}

/* ---------- What each post links to and its comments (for the graph and the comments) ---------- */

const CACHE = 'md4c-reader-1:'; // (versioned: what is kept changed)
/**
 * { links, refs, highlights } of a post, as the site build records them
 * (index.json): from index.json for a published post without a draft;
 * read and worked out here for a draft, kept in this browser per version.
 */
async function postFacts(p, index) {
  if (!isDraft(p)) {
    const e = index.get(p.key);
    if (e) return { links: e.links ?? [], refs: e.refs ?? [], highlights: e.highlights ?? [] };
  }
  const id = `${CACHE}${p.store}:${p.key}`;
  try {
    const hit = JSON.parse(localStorage.getItem(id) ?? 'null');
    if (hit?.etag === p.etag) return hit.facts;
  } catch {}
  const [{ text }, md4c] = await Promise.all([api.read(p.store, p.key), getMd4c()]);
  const { meta, body } = parseFrontMatter(text);
  const split = isPaper(meta) ? splitAnnotations(body) : { body, annotations: [] };
  const html = readProtected(text) ? '' : articleHtml(meta, body, (m) => md4c.toHtml(m, { parserFlags: PARSER_FLAGS }));
  const facts = {
    // (Its own title and tags: a list entry may lack them.)
    title: String(meta.title ?? '').trim(), tags: parseTags(meta.tags).join(', '),
    links: postLinks(html).filter((s) => s !== p.key.slice(6, -3)),
    refs: referencedIds(split.body),
    highlights: sortAnnotations(split.annotations).map(annotationSummary),
  };
  try {
    localStorage.setItem(id, JSON.stringify({ etag: p.etag, facts }));
  } catch {}
  return facts;
}

async function allFacts(posts) {
  // (index.json as init() read it; md4c only for a draft not kept here.)
  const index = new Map((state.siteIndex?.items ?? []).filter((e) => e?.path).map((e) => [e.path, e]));
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < posts.length) {
      const p = posts[next++];
      p.facts = await postFacts(p, index).catch(() => ({ links: [], refs: [], highlights: [] }));
      if (p.facts.title) p.title = p.facts.title;
      if (p.facts.tags && !p.tags) p.tags = p.facts.tags;
    }
  }));
}

async function showLibrary(listing) {
  document.title = `Reader · ${state.site.title}`;
  document.querySelector('.reader-where').textContent = '';
  // The list as this browser kept it, at once; the server's when it comes.
  const kept = await api.lastPosts().catch(() => null);
  let shownList = kept ?? await listing;
  let posts = library(shownList);
  app.innerHTML = `<header class="reader-head">
      <h1>${esc(state.site.title)}</h1>
      <p class="muted">Every post, as the blog shows it. <b>Private</b> ones are drafts: only you read them here.
        Publish one to make it public; unpublish it to make it private again.</p>
      <div class="reader-tabs" role="tablist">
        <button type="button" role="tab" data-tab="articles" aria-selected="true">Articles</button>
        <button type="button" role="tab" data-tab="comments" aria-selected="false">Comments</button>
        <button type="button" role="tab" data-tab="graph" aria-selected="false">Graph</button>
      </div>
      <input type="search" class="reader-search" placeholder="Search" aria-label="Search">
      <div class="reader-filters" role="toolbar" aria-label="Show">
        <button type="button" data-show="all" aria-pressed="true">All</button>
        <button type="button" data-show="private" aria-pressed="false">Private</button>
        <button type="button" data-show="public" aria-pressed="false">Public</button>
        <span class="reader-tagbar"></span>
      </div>
    </header>
    <div class="reader-body"><p class="muted">Loading…</p></div>`;
  const out = app.querySelector('.reader-body');
  const search = app.querySelector('.reader-search');
  let tab = 'articles';
  let show = 'all';
  const picked = new Set(); // tag keywords: a post or a comment with any of them
  let facts = null; // links and comments of every post, loaded for Comments and Graph
  let drawn = null;

  const tagsOfPost = (p) => parseTags(p.tags);
  const tagsOfComment = (h) => h.tags ?? [];
  const words = () => search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (p) => show === 'all' || (show === 'private') === !p.published;
  const tagged = (tags) => !picked.size || tags.some((t) => picked.has(t));
  const postMatch = (p) => visible(p) && tagged(tagsOfPost(p))
    && words().every((w) => `${p.title} ${p.tags} ${p.key}`.toLowerCase().includes(w));
  const commentMatch = (p, h) => visible(p) && tagged(tagsOfComment(h))
    && words().every((w) => [h.label, h.quote, h.comment, ...tagsOfComment(h)].join(' ').toLowerCase().includes(w));

  /** The tag keywords of the articles and of the comments, with how often each is used. */
  function renderTagbar() {
    const counts = new Map();
    for (const p of posts) {
      for (const t of tagsOfPost(p)) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const h of p.facts?.highlights ?? []) for (const t of tagsOfComment(h)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    app.querySelector('.reader-tagbar').innerHTML = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([t, n]) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${picked.has(t)}">#${esc(t)}<span class="n">${n}</span></button>`).join('');
  }

  const chip = (p) => (p.published
    ? (isDraft(p) && p.uploaded > p.published.uploaded ? '<span class="reader-chip">public · changes not live</span>' : '<span class="reader-chip">public</span>')
    : '<span class="reader-chip reader-private">private</span>');

  function renderArticles() {
    const shown = posts.filter(postMatch);
    out.innerHTML = `<ol class="reader-list">${shown.map((p) => `<li>
        <a class="reader-item" href="${esc(readHref(p.key, p.store))}">
          <span class="reader-title">${esc(p.title)}</span>
          <span class="reader-meta">${chip(p)}
            ${p.date ? `<time datetime="${esc(p.date)}">${esc(formatDate(p.date))}</time>` : ''}
            ${tagsOfPost(p).map((t) => `<span class="reader-tag">#${esc(t)}</span>`).join(' ')}</span>
        </a></li>`).join('') || '<li class="muted">No posts match.</li>'}</ol>`;
  }

  function renderComments() {
    const rows = posts.flatMap((p) => (p.facts?.highlights ?? []).filter((h) => commentMatch(p, h)).map((h) => ({ p, h })));
    out.innerHTML = rows.length ? `<ol class="annotations reader-comments">${rows.map(({ p, h }) => `<li class="annotation" data-color="${esc(h.color)}">
        <a class="annotation-at" href="${esc(`${readHref(p.key, p.store)}#${h.id}`)}" title="Page ${h.page}">${mathText(h.label)}</a>
        <span class="reader-of">in <a href="${esc(readHref(p.key, p.store))}">${esc(p.title)}</a> ${chip(p)}</span>
        ${tagsOfComment(h).length ? `<div class="annotation-tags">${tagsOfComment(h).map((t) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
        ${h.quote && !h.label.startsWith('“') ? `<blockquote class="annotation-quote">${esc(h.quote)}</blockquote>` : ''}
        ${h.comment && h.comment !== h.label ? `<p class="annotation-comment">${mathText(h.comment)}</p>` : ''}
      </li>`).join('')}</ol>` : '<p class="muted">No comments match. Comments are the highlights of paper notes.</p>';
    renderMath(out, { math: state.site.math !== false });
  }

  async function renderGraph() {
    const { graphData, drawGraph } = await import('./graph.js');
    // The posts and comments that match, the papers of those comments, and
    // the links among them (nothing else, so a filter narrows the graph).
    const filtering = picked.size || words().length || show !== 'all';
    const kept = posts.map((p) => {
      const hs = (p.facts?.highlights ?? []).filter((h) => !filtering || commentMatch(p, h));
      return postMatch(p) || hs.length ? { p, hs, self: postMatch(p) } : null;
    }).filter(Boolean);
    const slugs = new Set(kept.map(({ p }) => p.key.slice(6, -3)));
    const items = kept.map(({ p, hs }) => ({
      path: p.key, store: p.store,
      metadata: { title: p.title, tags: p.tags },
      links: filtering ? p.facts?.links?.filter((s) => slugs.has(s)) ?? [] : p.facts?.links ?? [],
      refs: p.facts?.refs ?? [],
      highlights: hs,
    }));
    const g = graphData(items, { postHref: (slug, e) => readHref(e.path, e.store), tags: true, highlights: true });
    out.innerHTML = `<p class="muted reader-graph-help">${g.nodes.filter((n) => n.kind === 'post').length} articles, ${g.nodes.filter((n) => n.kind === 'note').length} comments, ${g.nodes.filter((n) => n.kind === 'tag').length} tags.
      Drag to move, scroll to zoom; click an article or a comment to read it, a tag to filter by it.</p>
      <div class="graph-box reader-graph"></div>`;
    drawn?.destroy();
    drawn = drawGraph(out.querySelector('.graph-box'), g, {
      typeset: (el) => renderMath(el, { math: state.site.math !== false }),
      onOpen: (node) => {
        if (node.kind === 'tag') {
          const t = node.label.replace(/^#/, '');
          if (picked.has(t)) picked.delete(t);
          else picked.add(t);
          render();
        } else if (node.href) location.href = node.href;
      },
    });
  }

  async function render() {
    for (const b of app.querySelectorAll('.reader-tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const b of app.querySelectorAll('.reader-filters [data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === show));
    if (tab !== 'articles' && !facts) {
      out.innerHTML = '<p class="muted">Reading the posts for their links and comments…</p>';
      facts = allFacts(posts);
    }
    if (facts) {
      await facts;
      renderTagbar();
    }
    if (tab === 'articles') renderArticles();
    else if (tab === 'comments') renderComments();
    else await renderGraph();
    if (tab !== 'graph') {
      drawn?.destroy();
      drawn = null;
    }
  }

  renderTagbar();
  search.addEventListener('input', () => render());
  app.querySelector('.reader-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  app.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-show], button[data-tag]');
    if (!b) return;
    if (b.dataset.show) show = b.dataset.show;
    else if (picked.has(b.dataset.tag)) picked.delete(b.dataset.tag);
    else picked.add(b.dataset.tag);
    render();
  });
  render();
  // Load the comments in the background once the list is up: their tags
  // join the tag keywords. (Kept per version in this browser, so a later
  // visit reads only the drafts changed since.)
  const loadFacts = () => {
    facts ??= allFacts(posts);
    facts.then(() => { if (tab === 'articles') renderTagbar(); });
  };
  let factsTimer = setTimeout(loadFacts, 300);
  if (kept) {
    // Started from the kept list: the server's, if it differs.
    const fresh = await listing.catch(() => null);
    if (fresh && JSON.stringify(fresh.posts) !== JSON.stringify(shownList.posts)) {
      shownList = fresh;
      await facts?.catch(() => {});
      posts = library(fresh);
      facts = null;
      clearTimeout(factsTimer);
      await render();
      factsTimer = setTimeout(loadFacts, 300);
    }
  }
}

async function showPost(key, storeParam, listing, reading) {
  // The post in the store the link names (as the library links), else its
  // draft when there is one (what you are writing), else the public copy.
  // Published or not, as the site's index has it: no list of every post.
  let store = storeParam;
  let published = store === 'site' || (state.siteIndex?.items ?? []).some((e) => e?.path === key);
  if (!store) {
    const posts = (await listing).posts.filter((p) => p.key === key);
    published = posts.some((p) => p.status === 'published');
    store = (posts.find(isDraft) ?? posts.find((p) => p.status === 'published'))?.store;
    if (!store) throw new Error(`There is no post ${key}.`);
  }
  reading ??= api.read(store, key);
  const kept = await api.lastRead(store, key).catch(() => null);
  if (kept) {
    // As this browser kept it, at once; drawn again if the server's differs.
    await renderPost(key, store, published, kept.text);
    const fresh = await reading.catch(() => null);
    if (fresh && fresh.etag !== kept.etag) await renderPost(key, store, published, fresh.text);
    return;
  }
  await renderPost(key, store, published, (await reading).text);
}

async function renderPost(key, store, published, text) {
  const md4c = await getMd4c();
  const locked = readProtected(text);
  const { meta, body } = parseFrontMatter(text);
  const draft = store !== 'site';
  applyLook(document, state.site, meta);
  const title = meta.title || key.slice(6, -3);
  document.title = `${title} · Reader`;
  document.querySelector('.reader-where').innerHTML = draft && !published
    ? '<span class="reader-chip reader-private">private</span> a draft, read only here'
    : draft ? '<span class="reader-chip">public</span> the draft (it may have changes not yet on the blog)'
      : '<span class="reader-chip">public</span>';
  const pageUrl = published ? publicUrl(`posts/${key.slice(6, -3)}.html`) : '';
  document.querySelector('.reader-actions').innerHTML = `<a href="${esc(editHref(store, key))}">Edit</a>${
    pageUrl ? ` · <a href="${esc(pageUrl)}" target="_blank" rel="noopener">On the blog ↗</a>` : ''}`;

  app.innerHTML = '<article><div class="prose"></div></article>';
  const article = app.querySelector('article');
  if (locked) {
    article.insertAdjacentHTML('afterbegin', `<header class="article-header"><h1 class="article-title">${esc(title)}</h1></header>`);
    article.querySelector('.prose').innerHTML = `<p class="muted">This published copy is encrypted (the post has a password).
      <a href="${esc(editHref(store, key))}">Open it in the editor</a> to read it.</p>`;
    return;
  }
  // As the editor's preview shows it (post-view.js); [[other post]] opens in the reader.
  await renderPostInto(article, { store, key, meta, body, md4c, postHref: (s) => readHref(`posts/${s}.md`) });
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

async function main() {
  // The site's own stylesheet comes from the API: linked from here, not the
  // page, so the page's scripts need not wait for it.
  const theme = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'api/file?bucket=site&key=theme.css' });
  document.querySelector('link[data-paper-css]').before(theme);
  try {
    const key = params.get('key');
    const store = params.get('store') || undefined;
    // The list of posts loads beside the session and settings (when needed).
    // The post (or the list of posts) loads beside the session and settings.
    const listing = key && store ? null : api.posts();
    const reading = key && store ? api.read(store, key) : null;
    for (const p of [listing, reading]) p?.catch(() => {});
    if (key) getMd4c(); // (the Markdown engine, meanwhile)
    await init();
    applyLook(document, state.site);
    if (key) await showPost(key, store, listing, reading);
    else await showLibrary(listing);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">${esc(err.message ?? err)}</p><p><a href="read">All posts</a> · <a href="./#/posts">Admin</a></p>`;
  }
}

main();
