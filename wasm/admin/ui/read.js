// The reader: every post, drafts included, read in the admin as the blog
// shows it (theme, contents, math, citations, paper notes with their PDF).
// Drafts are private, so this is the private blog: nothing is copied or
// built; a draft is read from its store as it is now. Publishing it (the
// editor, or Posts) makes it public; unpublishing makes it private again.
//
//   read                               the library: drafts and published posts
//   read?store=drafts&key=posts/a.md   one post (store optional: its
//                                            draft if it has one, else the site)

import { api } from './client.js';
import { getMd4c, init, publicUrl, state } from './shared.js';
import { parseFrontMatter, parseTags } from './lib/post-format.js';
import { readProtected } from './lib/protect.js';
import { isPaper, paperHtml, paperPdf, splitAnnotations } from './lib/paper.js';
import { PARSER_FLAGS } from './lib/blog-render.js';
import { bibliographyUrls, esc, finishArticle, formatDate, renderLive, renderLiveHtml } from './render.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const readHref = (key, store) => `read?${new URLSearchParams({ ...(store ? { store } : {}), key })}`;
const editHref = (store, key) => `./#/edit/${store}/${key}`;
const isDraft = (p) => p.status === 'draft';

/** The site's look on this page (as the blog's theme.js, for the parts the reader has). */
function applyLook(site, meta = {}) {
  const root = document.documentElement;
  root.lang = site.language;
  root.dataset.theme = site.theme;
  root.dataset.scheme = site.colorScheme;
  root.dataset.font = site.font || (site.theme === 'modern' ? 'sans' : 'serif');
  root.dataset.numbered = meta.numbered === 'true' || meta.numbered === true ? 'true'
    : meta.numbered === 'false' || meta.numbered === false ? 'false' : String(site.numberedHeadings);
  if (site.accent) root.style.setProperty('--accent-base', site.accent);
}

/** The posts, one entry per post: its draft if it has one (with `published` noted), else the public copy. */
async function library() {
  const { posts } = await api.posts();
  const live = new Map(posts.filter((p) => p.status === 'published').map((p) => [p.key, p]));
  const drafts = posts.filter(isDraft);
  const drafted = new Set(drafts.map((p) => p.key));
  return [
    ...drafts.map((p) => ({ ...p, published: live.get(p.key) ?? null })),
    ...[...live.values()].filter((p) => !drafted.has(p.key)).map((p) => ({ ...p, published: p })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}

async function showLibrary() {
  document.title = `Reader · ${state.site.title}`;
  document.querySelector('.reader-where').textContent = '';
  const posts = await library();
  const tags = [...new Set(posts.flatMap((p) => parseTags(p.tags)))].sort();
  app.innerHTML = `<header class="reader-head">
      <h1>${esc(state.site.title)}</h1>
      <p class="muted">Every post, as the blog shows it. <b>Private</b> ones are drafts: only you read them here.
        Publish one to make it public; unpublish it to make it private again.</p>
      <input type="search" class="reader-search" placeholder="Search" aria-label="Search the posts">
      <div class="reader-filters" role="toolbar" aria-label="Show">
        <button type="button" data-show="all" aria-pressed="true">All</button>
        <button type="button" data-show="private" aria-pressed="false">Private</button>
        <button type="button" data-show="public" aria-pressed="false">Public</button>
        ${tags.map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="false">#${esc(t)}</button>`).join('')}
      </div>
    </header>
    <ol class="reader-list"></ol>`;
  const list = app.querySelector('.reader-list');
  let show = 'all';
  let tag = '';
  const render = () => {
    const words = app.querySelector('.reader-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = posts.filter((p) => (show === 'all' || (show === 'private') === !p.published)
      && (!tag || parseTags(p.tags).includes(tag))
      && words.every((w) => `${p.title} ${p.tags} ${p.key}`.toLowerCase().includes(w)));
    list.innerHTML = shown.map((p) => `<li>
        <a class="reader-item" href="${esc(readHref(p.key, p.store))}">
          <span class="reader-title">${esc(p.title)}</span>
          <span class="reader-meta">${p.published ? (isDraft(p) && p.uploaded > p.published.uploaded ? '<span class="reader-chip">public · changes not live</span>' : '<span class="reader-chip">public</span>')
            : '<span class="reader-chip reader-private">private</span>'}
            ${p.date ? `<time datetime="${esc(p.date)}">${esc(formatDate(p.date))}</time>` : ''}
            ${parseTags(p.tags).map((t) => `<span class="reader-tag">#${esc(t)}</span>`).join(' ')}</span>
        </a></li>`).join('') || '<li class="muted">No posts match.</li>';
  };
  app.querySelector('.reader-search').addEventListener('input', render);
  app.querySelector('.reader-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.show) show = b.dataset.show;
    else tag = tag === b.dataset.tag ? '' : b.dataset.tag;
    for (const x of app.querySelectorAll('.reader-filters button')) {
      x.setAttribute('aria-pressed', String(x.dataset.show ? x.dataset.show === show : x.dataset.tag === tag));
    }
    render();
  });
  render();
}

async function showPost(key, storeParam) {
  // The draft when there is one (what you are writing), else the public copy.
  let store = storeParam;
  let published = null;
  const posts = (await api.posts()).posts.filter((p) => p.key === key);
  published = posts.find((p) => p.status === 'published') ?? null;
  store ??= (posts.find(isDraft) ?? published)?.store;
  if (!store) throw new Error(`There is no post ${key}.`);
  const [{ text }, md4c] = await Promise.all([api.read(store, key), getMd4c()]);
  const locked = readProtected(text);
  const { meta, body } = parseFrontMatter(text);
  const draft = store !== 'site';
  applyLook(state.site, meta);
  const title = meta.title || key.slice(6, -3);
  document.title = `${title} · Reader`;
  document.querySelector('.reader-where').innerHTML = draft && !published
    ? '<span class="reader-chip reader-private">private</span> a draft, read only here'
    : draft ? '<span class="reader-chip">public</span> the draft (it may have changes not yet on the blog)'
      : '<span class="reader-chip">public</span>';
  const pageUrl = published ? publicUrl(`posts/${key.slice(6, -3)}.html`) : '';
  document.querySelector('.reader-actions').innerHTML = `<a href="${esc(editHref(store, key))}">Edit</a>${
    pageUrl ? ` · <a href="${esc(pageUrl)}" target="_blank" rel="noopener">On the blog ↗</a>` : ''}`;

  const author = meta.author || state.site.author;
  const tags = parseTags(meta.tags);
  app.innerHTML = `<article>
    <header class="article-header">
      <h1 class="article-title">${esc(title)}</h1>
      <p class="byline sc">${author ? `<span class="author">${esc(author)}</span> · ` : ''}${meta.date ? `<time>${esc(formatDate(String(meta.date).slice(0, 10)))}</time>` : ''}</p>
      ${tags.length ? `<p class="keywords sc">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
    </header>
    <div class="prose"></div>
  </article>`;
  const article = app.querySelector('article');
  const prose = article.querySelector('.prose');
  if (locked) {
    prose.innerHTML = `<p class="muted">This published copy is encrypted (the post has a password).
      <a href="${esc(editHref(store, key))}">Open it in the editor</a> to read it.</p>`;
    return;
  }
  // Links and images resolve through the Worker, next to the post: its
  // store first, then the site; [[other post]] opens in the reader.
  const postUrl = api.rawUrl(store, key);
  const where = { postUrl, storageBase: api.rawUrl(store, ''), postHref: (s) => readHref(`posts/${s}.md`) };
  const banner = meta.banner || meta.cover;
  if (banner) {
    const fig = document.createElement('figure');
    fig.className = 'post-banner';
    fig.innerHTML = `<img src="${esc(new URL(banner, postUrl).href)}" alt="">`;
    article.prepend(fig);
  }
  if (isPaper(meta)) {
    const { body: notes, annotations } = splitAnnotations(body);
    prose.append(renderLiveHtml(paperHtml(meta, notes, annotations, (m) => md4c.toHtml(m, { parserFlags: PARSER_FLAGS })), where));
    const paper = prose.querySelector('.paper');
    const pdf = paperPdf(meta);
    if (paper && pdf) paper.dataset.pdf = new URL(pdf, postUrl).href; // the viewer reads it from here
  } else {
    prose.append(renderLive({ render: (m, o) => md4c.toHtml(m, o) }, body, where));
  }
  const siteBib = String(state.rawSite?.bibliography ?? '');
  await finishArticle(article, { ...state.site, citation: false }, {
    title, date: meta.date, slug: key.slice(6, -3), url: '', toc: meta.toc,
    bibliography: [
      ...bibliographyUrls(meta.bibliography, postUrl),
      ...(/\.bib$/i.test(siteBib) && !/^[a-z]+:|^\/\//i.test(siteBib) ? [api.rawUrl('site', siteBib.replace(/^\/+/, ''))] : []),
    ],
    citeStyle: meta.citestyle || meta['cite-style'], nocite: meta.nocite,
  });
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

async function main() {
  try {
    await init();
    applyLook(state.site);
    const key = params.get('key');
    if (key) await showPost(key, params.get('store') || undefined);
    else await showLibrary();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">${esc(err.message ?? err)}</p><p><a href="read">All posts</a> · <a href="./#/posts">Admin</a></p>`;
  }
}

main();
