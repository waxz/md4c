// Article typesetting shared by pre-rendered pages (posts/<slug>.html) and
// posts rendered live in the browser.

import DOMPurify from './vendor/dompurify/purify.es.js';
import { SLUG_RE } from './lib/post-format.js';
import { PARSER_FLAGS, slugify, SOURCE_POS_FLAGS, wikiHref } from './lib/blog-render.js';
import { citationTokens, citeStyle, createBibliography, parseBibtex } from './lib/cite.js';

export { slugify };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function parseDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso, month = 'long') {
  const d = parseDate(iso);
  return d ? d.toLocaleDateString('en-GB', { year: 'numeric', month, day: 'numeric' }) : iso;
}

/* ---------- Live rendering (posts not yet pre-rendered) ---------- */

// DOMPurify drops scripts, event handlers and javascript: URLs. External
// links additionally lose the referrer and window.opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    if (!node.getAttribute('href').startsWith('#')) node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (node.tagName === 'INPUT') {
    if (node.getAttribute('type') !== 'checkbox') node.remove();
    else node.setAttribute('disabled', '');
  }
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['x-wikilink', 'x-equation'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'meta', 'base'],
  FORBID_ATTR: ['style'],
};

/**
 * Relative URLs in a live-rendered post point next to the post in storage:
 * `![](photo.png)` in posts/trip.md loads posts/photo.png, and a link to
 * another post's .md file opens that post.
 */
function resolveUrls(frag, postUrl, storageBase, postHref) {
  const postsRoot = new URL('posts/', storageBase).href;
  const isRelative = (v) => v && !v.startsWith('#') && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v);
  for (const [sel, attr] of [['a', 'href'], ['img', 'src'], ['video', 'src'], ['audio', 'src'],
                             ['source', 'src'], ['video', 'poster']]) {
    for (const el of frag.querySelectorAll(`${sel}[${attr}]`)) {
      const value = el.getAttribute(attr);
      if (!isRelative(value)) continue;
      const url = new URL(value, postUrl);
      const slug = url.href.startsWith(postsRoot) && /^([^/]+)\.md$/.exec(url.pathname.slice(new URL(postsRoot).pathname.length));
      if (sel === 'a' && slug && SLUG_RE.test(slug[1])) el.setAttribute(attr, postHref(slug[1]));
      else el.setAttribute(attr, url.href);
    }
  }
}

/**
 * Markdown -> sanitized DOM fragment, for posts rendered in the browser.
 * `sourcePositions`: blocks carry data-src, their offset in `markdown`
 * (the admin's preview uses it to follow the text).
 */
export function renderLive(md4cFs, markdown, { postUrl, storageBase, postHref, sourcePositions = false }) {
  const html = md4cFs.render(markdown, { parserFlags: PARSER_FLAGS, ...(sourcePositions ? { rendererFlags: SOURCE_POS_FLAGS } : {}) });
  return renderLiveHtml(html, { postUrl, storageBase, postHref });
}

/** MD4C's HTML (or a page part made of it, e.g. a paper's) -> sanitized DOM fragment, as renderLive. */
export function renderLiveHtml(html, { postUrl, storageBase, postHref }) {
  const frag = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true });
  resolveUrls(frag, postUrl, storageBase, postHref);
  for (const el of frag.querySelectorAll('x-wikilink')) {
    const a = document.createElement('a');
    // [[post]], [[paper#a-…]] (a highlight there) or [[#a-…]] (one here)
    a.href = wikiHref(el.dataset.target ?? '', postHref) || '#';
    const ref = /#(a-[a-z0-9]{4,16})$/.exec(a.getAttribute('href'));
    if (ref) {
      a.className = 'annotation-ref';
      a.dataset.ref = ref[1];
    }
    a.append(...el.childNodes);
    el.replaceWith(a);
  }
  return frag;
}

/* ---------- Typesetting (both kinds of post) ---------- */

/**
 * Anchor ids keep letters of every script ("sec-安装-g"), so headings in
 * Chinese or Japanese get readable, distinct anchors.
 */
function headingId(text) {
  return String(text).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * Body headings start at <h2>: the title is the page's <h1>. Pages built
 * since demoteHeadings() already are; this covers live posts and older pages.
 */
function demoteHeadingElements(root) {
  if (!root.querySelector('h1')) return;
  for (const h of [...root.querySelectorAll('h1, h2, h3, h4, h5')].reverse()) {
    if (h.classList.contains('references-title')) continue; // made an h2 already
    const next = document.createElement(`h${Number(h.tagName[1]) + 1}`);
    for (const a of h.attributes) next.setAttribute(a.name, a.value);
    next.append(...h.childNodes);
    h.replaceWith(next);
  }
}

/* ---------- Citations and a bibliography (js/cite.js) ---------- */

const bibFiles = new Map(); // url -> { at, text: Promise<string> }
/** A .bib file's text ('' when it cannot be read); kept 15 s (the admin's preview asks often). */
function bibFile(url) {
  const hit = bibFiles.get(url);
  if (hit && Date.now() - hit.at < 15_000) return hit.text;
  const text = fetch(url, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((err) => {
      console.warn(`bibliography ${url}:`, err.message ?? err);
      return '';
    });
  bibFiles.set(url, { at: Date.now(), text });
  return text;
}

/** The .bib files a post names (front matter "bibliography: a.bib, ../assets/b.bib"), as URLs. */
export const bibliographyUrls = (value, base) => String(value ?? '').split(/[,\s]+/)
  .filter((p) => /\.bib$/i.test(p) && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(p))
  .map((p) => new URL(p, base).href);

const fragment = (html) => document.createRange().createContextualFragment(html);

/**
 * Citations in an article: [@key], @key, [-@key] become citations in the
 * post's style, and the entries cited are listed under "References" at
 * its end. Entries: info.bibliography (.bib URLs: the post's, the site's)
 * and ```bibtex blocks in the post (taken out of the page). Also marks the
 * cross-references (@fig:x, {#fig:x}, …) for typeset() to number.
 */
export async function applyCitations(prose, site, info = {}) {
  let inline = '';
  for (const code of prose.querySelectorAll('pre > code.language-bibtex, pre > code.language-bib')) {
    inline += `\n${code.textContent}`;
    code.parentElement.remove();
  }
  const texts = await Promise.all((info.bibliography ?? []).map(bibFile));
  const entries = new Map();
  for (const text of [...texts, inline]) for (const [k, e] of parseBibtex(text)) entries.set(k, e);

  const skip = 'code, pre, kbd, script, style, textarea, x-equation, .katex, a, .references';
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!/[@{]/.test(n.data) || n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const found = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const tokens = citationTokens(n.data, (k) => entries.has(k));
    if (tokens.some((t) => t.text === undefined)) found.push([n, tokens]);
  }
  const bib = createBibliography(entries, { style: citeStyle(info.citeStyle || site.citeStyle), nocite: info.nocite });
  for (const [, tokens] of found) for (const t of tokens) if (t.cite) bib.use(t.cite.map((c) => c.key));
  for (const [node, tokens] of found) {
    const out = document.createDocumentFragment();
    for (const t of tokens) {
      if (t.text !== undefined) out.append(t.text);
      else if (t.cite) out.append(fragment(bib.citationHtml(t)));
      else if (t.xref) {
        const a = document.createElement('a');
        a.className = 'xref';
        a.href = `#${t.xref}`;
        a.dataset.xref = t.xref;
        a.textContent = t.xref; // typeset() writes "Figure 2"
        out.append(a);
      } else if (t.label) {
        const span = document.createElement('span');
        span.className = 'xref-label';
        span.dataset.label = t.label;
        out.append(span);
      }
    }
    node.replaceWith(out);
  }
  const refs = bib.referencesHtml();
  if (refs) prose.append(fragment(refs));
}

/**
 * Cross-references, as in a paper: {#fig:x}, {#tbl:x}, {#eq:x}, {#sec:x}
 * label a figure (after its image), a table (in its "Table: …" caption),
 * a display equation (after it: numbered) or a heading; @fig:x (or
 * [@fig:x]) becomes "Figure 2", "Table 1", "Equation (3)", "Section 2.1".
 */
function crossReferences(root) {
  for (const s of root.querySelectorAll('span.xref-label')) {
    const label = s.dataset.label;
    let prev = s.previousSibling;
    while (prev && prev.nodeType === 3 && !prev.data.trim()) prev = prev.previousSibling;
    if (prev?.nodeType === 1 && prev.matches('x-equation[type="display"]')) {
      prev.id = label;
      prev.dataset.label = label;
    } else {
      const target = s.closest('figure, .table-wrap, h2, h3, h4, h5, h6, p, li, blockquote');
      if (target && !target.id.includes(':')) target.id = label;
    }
    s.remove();
  }
  let eq = 0;
  for (const e of root.querySelectorAll('x-equation[data-label]')) e.dataset.number = String(++eq);
  const figures = [...root.querySelectorAll('figure')];
  const tables = [...root.querySelectorAll('.table-wrap')];
  const sections = new Map();
  const n = [0, 0, 0];
  for (const h of root.querySelectorAll('h2, h3, h4')) {
    if (h.classList.contains('references-title') || h.closest('.paper-comments, .toc')) continue;
    const level = Number(h.tagName[1]) - 2;
    n[level]++;
    for (let i = level + 1; i < n.length; i++) n[i] = 0;
    sections.set(h, n.slice(0, level + 1).join('.'));
  }
  for (const a of root.querySelectorAll('a.xref[data-xref]')) {
    const el = root.querySelector(`#${CSS.escape(a.dataset.xref)}`);
    let text = '';
    if (el?.matches('figure')) text = `Figure ${figures.indexOf(el) + 1}`;
    else if (el?.matches('.table-wrap')) text = `Table ${tables.indexOf(el) + 1}`;
    else if (el?.matches('x-equation') && el.dataset.number) text = `Equation (${el.dataset.number})`;
    else if (el && sections.has(el)) text = `Section ${sections.get(el)}`;
    a.textContent = text || `${a.dataset.xref}??`;
    a.classList.toggle('xref-missing', !text);
  }
}

/** Figures from lone images, scrollable tables, heading anchors, lazy images, cross-references. */
export function typeset(root) {
  for (const p of root.querySelectorAll('p')) {
    const labels = [...p.querySelectorAll(':scope > span.xref-label')];
    const kids = [...p.children].filter((c) => !labels.includes(c));
    const img = kids[0];
    if (kids.length !== 1 || img.tagName !== 'IMG' || p.textContent.trim()) continue;
    const figure = document.createElement('figure');
    if (p.dataset.src) figure.dataset.src = p.dataset.src;
    if (labels[0]) figure.id = labels[0].dataset.label;
    figure.append(img);
    const caption = img.getAttribute('title') || img.getAttribute('alt');
    if (caption) {
      const fc = document.createElement('figcaption');
      fc.textContent = caption;
      figure.append(fc);
    }
    p.replaceWith(figure);
  }
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
    // A caption, as Pandoc writes it: "Table: …" (or ": …") just before or after the table.
    for (const p of [wrap.previousElementSibling, wrap.nextElementSibling]) {
      if (p?.tagName !== 'P' || !/^\s*(table)?\s*:\s/i.test(p.textContent) || table.caption) continue;
      const caption = table.createCaption();
      caption.append(...p.childNodes);
      const first = caption.firstChild;
      if (first?.nodeType === 3) first.data = first.data.replace(/^\s*(table)?\s*:\s*/i, '');
      const label = caption.querySelector('span.xref-label');
      if (label) {
        wrap.id = label.dataset.label;
        label.remove();
      }
      p.remove();
    }
  }
  demoteHeadingElements(root);
  const used = new Set();
  for (const h of root.querySelectorAll('h2, h3, h4, h5, h6')) {
    const label = h.querySelector('span.xref-label');
    if (label) { // {#sec:intro}
      h.id = label.dataset.label;
      label.remove();
      used.add(h.id);
      continue;
    }
    let id = `sec-${headingId(h.textContent) || 'section'}`;
    for (let i = 2; used.has(id); i++) id = id.replace(/(-\d+)?$/, `-${i}`);
    used.add(id);
    h.id = id;
  }
  for (const img of root.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.decoding = 'async';
  }
  crossReferences(root);
}

/**
 * The "Contents" box: the article's two highest heading levels present
 * (usually h2 and h3), once it has two such headings (one, when the post
 * asks for it with "toc: true"). Headings inside quotes, lists or details
 * are left out. `toc`: the post's own "true"/"false", else the site's.
 */
export function buildToc(prose, site, toc = '') {
  if (toc === 'false' || (!site.toc && toc !== 'true')) return null;
  const all = [...prose.querySelectorAll(':scope > h2, :scope > h3, :scope > h4, :scope > .references > h2')].filter((h) => h.id);
  const levels = [...new Set(all.map((h) => Number(h.tagName[1])))].sort();
  const [topLevel, subLevel] = levels;
  const heads = all.filter((h) => Number(h.tagName[1]) <= (subLevel ?? topLevel));
  if (heads.length < (toc === 'true' ? 1 : 2)) return null;
  const nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'Contents');
  nav.innerHTML = '<h2 class="sc">Contents</h2>';
  const top = document.createElement('ol');
  let sub = null;
  for (const h of heads) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${encodeURIComponent(h.id)}`;
    a.textContent = h.textContent;
    li.append(a);
    if (h.classList.contains('references-title')) li.className = 'toc-unnumbered';
    if (Number(h.tagName[1]) === topLevel) {
      top.append(li);
      sub = null;
    } else {
      if (!sub) {
        sub = document.createElement('ol');
        let parent = top.lastElementChild;
        if (!parent) {
          // Sub-headings before the first heading of the top level.
          parent = document.createElement('li');
          top.append(parent);
        }
        parent.append(sub);
      }
      sub.append(li);
    }
  }
  nav.append(top);
  return nav;
}

export function citation(site, { title, date, author, slug, url }) {
  const d = parseDate(date ?? '');
  const year = d ? d.getFullYear() : 'n.d.';
  const who = author || site.author;
  const box = document.createElement('section');
  box.className = 'cite';
  box.innerHTML = '<h2 class="sc">How to cite</h2><p></p><details><summary>BibTeX</summary><pre></pre></details>';
  const when = d ? `${year}, ${d.toLocaleDateString('en-GB', { month: 'long', day: 'numeric' })}` : year;
  box.querySelector('p').textContent = `${who ? `${who} ` : ''}(${when}). ${title}. ${site.title}. ${url}`;
  const clean = (s) => String(s).replace(/[{}\\]/g, '');
  const key = `${slugify(who.split(/\s+/).pop() || site.title)}${year}${slug.split('-')[0]}`;
  box.querySelector('pre').textContent = [
    `@online{${key},`,
    ...(who ? [`  author       = {${clean(who)}},`] : []),
    `  title        = {${clean(title)}},`,
    `  year         = {${year}},`,
    ...(d ? [`  date         = {${date}},`] : []),
    `  organization = {${clean(site.title)}},`,
    `  url          = {${url}},`,
    `  urldate      = {${new Date().toISOString().slice(0, 10)}}`,
    '}',
  ].join('\n');
  return box;
}

let katexPromise;
function loadKatex() {
  katexPromise ??= (async () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./vendor/katex/katex.min.css', import.meta.url).href;
    document.head.append(link);
    return (await import('./vendor/katex/katex.mjs')).default;
  })();
  return katexPromise;
}

/** Typeset $...$ / $$...$$ with KaTeX, loaded only when a post has math. */
export async function renderMath(container, site) {
  const eqs = container.querySelectorAll('x-equation');
  if (!site.math || eqs.length === 0) return;
  const katex = await loadKatex();
  for (const eq of eqs) {
    const display = eq.getAttribute('type') === 'display';
    const out = document.createElement(display ? 'div' : 'span');
    // KaTeX styles its nodes through CSSOM, which the CSP allows;
    // trust:false keeps \href, \url etc. disabled.
    katex.render(eq.textContent, out, {
      displayMode: display, throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000,
    });
    if (display && eq.dataset.number) {
      // A labelled equation ({#eq:x}): numbered on the right, as in a paper.
      const box = document.createElement('div');
      box.className = 'eq-numbered';
      box.id = eq.id;
      const num = document.createElement('span');
      num.className = 'eq-number';
      num.textContent = `(${eq.dataset.number})`;
      box.append(out, num);
      eq.replaceWith(box);
      continue;
    }
    eq.replaceWith(out);
  }
}

/* ---------- Code blocks: syntax colours and a Copy button ---------- */

let hljsPromise;
function loadHighlight() {
  // highlight.js (common languages), self-hosted so the CSP stays 'self'.
  hljsPromise ??= import('./vendor/highlight/highlight.min.js').then((m) => {
    const hljs = m.default;
    hljs.configure({ ignoreUnescapedHTML: true });
    return hljs;
  });
  return hljsPromise;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page not served over https.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'copy-buffer';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * Give each fenced code block a Copy button, and colour the ones whose
 * language is named (```cpp). highlight.js is loaded only when a post has
 * such a block; blocks without a language stay plain.
 */
export async function enhanceCode(container) {
  const blocks = [...container.querySelectorAll('pre > code')].filter((c) => !c.closest('.code-block'));
  if (!blocks.length) return;
  for (const code of blocks) {
    const pre = code.parentElement;
    const lang = /\blanguage-([\w+#.-]+)/.exec(code.className)?.[1] ?? '';
    const box = document.createElement('div');
    box.className = 'code-block';
    pre.replaceWith(box);
    const bar = document.createElement('div');
    bar.className = 'code-bar';
    if (lang) {
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang;
      bar.append(label);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', `Copy ${lang ? `${lang} ` : ''}code`);
    button.addEventListener('click', async () => {
      const ok = await copyText(code.textContent.replace(/\n$/, ''));
      button.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(button.reset);
      button.reset = setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    });
    bar.append(button);
    box.append(bar, pre);
  }
  const named = blocks.filter((c) => /\blanguage-/.test(c.className));
  if (!named.length) return;
  let hljs;
  try {
    hljs = await loadHighlight();
  } catch (err) {
    console.warn('highlight.js:', err);
    return;
  }
  for (const code of named) {
    const lang = /\blanguage-([\w+#.-]+)/.exec(code.className)[1];
    if (!hljs.getLanguage(lang)) continue; // unknown: leave it plain
    // highlight() escapes the text itself; named explicitly, as the class
    // parser would read "language-c++" as C.
    code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
    code.classList.add('hljs');
  }
}

/* ---------- Illustrations: ```embed blocks ---------- */

// A fenced ```embed block holds HTML for an illustration: a chart, a 3D
// scene, a small interactive (three.js, Chart.js, D3… from a CDN). It is
// shown in a sandboxed frame (sandbox="allow-scripts", no same origin):
// embed.html, whose own policy lets the illustration's scripts run there,
// cut off from this page, its cookies and storage. Without JavaScript the
// block stays as code. "<!-- height: 420 -->" in it fixes the height;
// otherwise the frame takes the height of what it shows.
const EMBED_MAX = 2400; // px
const embedHtml = new WeakMap(); // frame -> { html, base }
const embedListening = new WeakSet(); // windows
const isDark = (win) => {
  const scheme = win.document.documentElement.dataset.scheme;
  return scheme === 'dark' || (scheme !== 'light' && win.matchMedia('(prefers-color-scheme: dark)').matches);
};
function listenToEmbeds(win) {
  if (embedListening.has(win)) return;
  embedListening.add(win);
  win.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d.type !== 'string' || !d.type.startsWith('md4c-embed')) return;
    const frame = [...win.document.querySelectorAll('iframe.embed-frame')].find((f) => f.contentWindow === e.source);
    const sent = frame && embedHtml.get(frame);
    if (!sent) return;
    if (d.type === 'md4c-embed-ready') {
      const dark = isDark(win);
      frame.style.colorScheme = dark ? 'dark' : 'light'; // (as the frame's: else it is drawn opaque)
      const cs = win.getComputedStyle(frame.parentElement);
      e.source.postMessage({
        type: 'md4c-embed', html: sent.html, base: sent.base, dark,
        ink: cs.color, accent: cs.getPropertyValue('--accent').trim(),
      }, '*'); // (the frame's origin is opaque: "null")
    } else if (d.type === 'md4c-embed-size' && !frame.dataset.height && Number.isFinite(d.height)) {
      frame.style.height = `${Math.min(EMBED_MAX, Math.max(40, Math.round(d.height)))}px`;
    }
  });
}

/** Frame the ```embed blocks of `container` (before code blocks are dressed up). */
export function mountEmbeds(container, base = location.href) {
  const doc = container.ownerDocument;
  const blocks = [...container.querySelectorAll('pre > code.language-embed')];
  if (!blocks.length) return;
  listenToEmbeds(doc.defaultView);
  const src = new URL('./embed.html', import.meta.url).href;
  for (const code of blocks) {
    const html = code.textContent;
    const fixed = /<!--\s*height\s*[:=]\s*(\d{2,4})\s*(?:px)?\s*-->/i.exec(html)?.[1];
    const fig = doc.createElement('div'); // (not a <figure>: figures are numbered)
    fig.className = 'embed';
    const frame = doc.createElement('iframe');
    frame.className = 'embed-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', /<title>([^<]{1,120})<\/title>/i.exec(html)?.[1].trim() || 'Illustration');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    if (fixed) frame.dataset.height = fixed;
    frame.style.height = `${Math.min(EMBED_MAX, Number(fixed) || 320)}px`;
    frame.style.colorScheme = isDark(doc.defaultView) ? 'dark' : 'light';
    embedHtml.set(frame, { html, base });
    frame.src = src;
    fig.append(frame);
    code.parentElement.replaceWith(fig);
  }
}

/** Everything an article needs once its .prose is in the page. */
export async function finishArticle(article, site, info) {
  const prose = article.querySelector('.prose');
  // (First: the illustrations' code is not text for citations or math.)
  mountEmbeds(prose, info.embedBase ?? location.href);
  await applyCitations(prose, site, {
    // A list of URLs, or the front matter's value (the page's data-bibliography).
    bibliography: Array.isArray(info.bibliography) ? info.bibliography : [
      ...bibliographyUrls(info.bibliography ?? article.dataset.bibliography, info.base ?? location.href),
      ...(site.bibliography ? [site.bibliography] : []),
    ],
    citeStyle: info.citeStyle ?? article.dataset.citeStyle,
    nocite: info.nocite ?? article.dataset.nocite,
  }).catch((err) => console.warn('citations:', err));
  typeset(prose);
  article.querySelector('.toc')?.remove(); // finishing again (the editor's preview)
  // Authors who number their own headings keep their numbers, unduplicated.
  const manual = [...prose.querySelectorAll(':scope > h2')].some((h) => /^\s*\d+(\.\d+)*[.)]?\s/.test(h.textContent));
  prose.classList.toggle('manual-numbers', manual);
  const toc = buildToc(prose, site, info.toc ?? article.dataset.toc ?? '');
  if (toc) {
    toc.classList.toggle('manual-numbers', manual);
    prose.before(toc);
  }
  if (site.citation && !article.querySelector('.cite')) article.append(citation(site, info));
  await Promise.all([renderMath(prose, site), enhanceCode(prose)]);
  // A paper post: its PDF beside the comments (the admin's preview shows
  // the comments only; its own annotator edits them).
  const paper = prose.querySelector('.paper');
  if (paper && info.paperViewer !== false) {
    import('./paper.js').then((m) => m.mountPaper(paper)).catch((err) => console.warn('paper:', err));
  }
}
