// A post as the admin shows it, in the blog's look, rendered in the browser
// (md4c, then citations, math, code, contents): the reader (read.js) and
// the editor's preview (editor.js) both draw it with renderPostInto(), so
// what the preview shows is what the reader shows.
//
// The post's own files resolve through the Worker, in the store it is in:
// a name ("banner.jpg") next to the post, "/x" at the store's top; a
// .bib file outside posts/ is the site's.

import { api } from './client.js';
import { state } from './shared.js';
import { parseTags } from './lib/post-format.js';
import { isPaper, paperHtml, paperPdf, splitAnnotations } from './lib/paper.js';
import { PARSER_FLAGS } from './lib/blog-render.js';
import { esc, finishArticle, formatDate, renderLive, renderLiveHtml } from './render.js';

/** The site's look, with the post's own choices (numbered sections), on `doc`'s page. */
export function applyLook(doc, site, meta = {}) {
  const root = doc.documentElement;
  if (site.language) root.lang = site.language;
  root.dataset.theme = site.theme;
  root.dataset.scheme = site.colorScheme;
  root.dataset.font = site.font || (site.theme === 'modern' ? 'sans' : 'serif');
  root.dataset.numbered = meta.numbered === 'true' || meta.numbered === true ? 'true'
    : meta.numbered === 'false' || meta.numbered === false ? 'false' : String(site.numberedHeadings);
  if (site.accent) root.style.setProperty('--accent-base', site.accent);
}

/** The address of a file a post names (banner, background, PDF): next to it, or at its store's top. */
export function postFileUrl(store, key, ref) {
  const v = String(ref ?? '').trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v)) return v;
  if (v.startsWith('/')) return api.rawUrl(store, v.replace(/^\/+/, ''));
  return new URL(v, api.rawUrl(store, key)).href;
}

/** The .bib files a post cites from: its own (front matter), then the site's. */
export function bibliographyFor(store, key, value) {
  const keys = String(value ?? '').split(/[,\s]+/).filter((p) => /\.bib$/i.test(p) && !/^[a-z]+:|^\/\//i.test(p))
    .map((p) => decodeURIComponent(new URL(p, `https://x/${key}`).pathname.slice(1)));
  const site = String(state.rawSite?.bibliography ?? '');
  if (/\.bib$/i.test(site) && !/^[a-z]+:|^\/\//i.test(site)) keys.push(site.replace(/^\/+/, ''));
  return keys.map((k) => (k.startsWith('posts/') ? api.rawUrl(store, k) : api.rawUrl('site', k)));
}

/**
 * Draw a post into `article` (its header and .prose, made if missing):
 * title, byline, keywords, banner, page background, the body (a paper's
 * notes and comments too), then citations, math, code and contents.
 *
 *   store, key     where the post is (key "posts/<slug>.md")
 *   meta, body     its front matter and Markdown
 *   annotations    a paper's comments, if kept apart from the body (editor)
 *   md4c           the Markdown engine
 *   postHref       slug -> link for [[other post]]
 *   sourcePositions  mark source lines (the editor's scroll sync)
 *   paperViewer    a paper's PDF viewer under its notes (the reader)
 */
export async function renderPostInto(article, {
  store, key, meta, body, annotations, md4c, postHref = () => '#', sourcePositions = false, paperViewer = true,
}) {
  const doc = article.ownerDocument;
  const site = state.site;
  applyLook(doc, site, meta);
  const slug = key.slice(6, -3);
  const title = String(meta.title ?? '').trim() || slug;
  const author = String(meta.author ?? '').trim() || site.author;
  const date = meta.date ? String(meta.date).slice(0, 10) : '';
  const tags = parseTags(meta.tags);

  let header = article.querySelector('.article-header');
  if (!header) {
    header = doc.createElement('header');
    header.className = 'article-header';
    article.prepend(header);
  }
  header.innerHTML = `<h1 class="article-title">${esc(title)}</h1>
    <p class="byline sc">${author ? `<span class="author">${esc(author)}</span>${date ? ' · ' : ''}` : ''}${date ? `<time datetime="${esc(date)}">${esc(formatDate(date))}</time>` : ''}</p>
    ${tags.length ? `<p class="keywords sc">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}`;
  let prose = article.querySelector('.prose');
  if (!prose) {
    prose = doc.createElement('div');
    article.append(prose);
  }
  prose.className = 'prose';

  // Banner and background, as the published page shows them.
  article.querySelector('.post-banner')?.remove();
  const bannerUrl = postFileUrl(store, key, meta.banner || meta.cover);
  if (bannerUrl) {
    const fig = doc.createElement('figure');
    fig.className = 'post-banner';
    const img = doc.createElement('img');
    img.src = bannerUrl;
    img.alt = '';
    fig.append(img);
    article.prepend(fig);
  }
  const root = doc.documentElement;
  const bgUrl = postFileUrl(store, key, meta.background);
  if (bgUrl) {
    root.style.setProperty('--bg-image', `url(${JSON.stringify(bgUrl)})`);
    root.dataset.bg = 'page';
  } else {
    root.style.removeProperty('--bg-image');
    delete root.dataset.bg;
  }

  // Links and images resolve through the Worker, next to the post: its
  // store first, then the site.
  const where = { postUrl: api.rawUrl(store, key), storageBase: api.rawUrl(store, ''), postHref };
  if (isPaper(meta)) {
    const split = annotations ? { body, annotations } : splitAnnotations(body);
    prose.replaceChildren(renderLiveHtml(paperHtml(meta, split.body, split.annotations,
      (m) => md4c.toHtml(m, { parserFlags: PARSER_FLAGS })), where));
    const paper = prose.querySelector('.paper');
    const pdf = paperPdf(meta);
    if (paper && pdf) paper.dataset.pdf = postFileUrl(store, key, pdf); // the viewer reads it from here
  } else {
    prose.replaceChildren(renderLive({ render: (m, o) => md4c.toHtml(m, o) }, body, { ...where, sourcePositions }));
  }
  await finishArticle(article, { ...site, citation: false }, {
    title, date, slug, url: '', toc: meta.toc, paperViewer,
    bibliography: bibliographyFor(store, key, meta.bibliography),
    citeStyle: meta.citestyle || meta['cite-style'] || site.citeStyle,
    nocite: meta.nocite,
  });
}
