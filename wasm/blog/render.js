// Article typesetting shared by pre-rendered pages (posts/<slug>.html) and
// posts rendered live in the browser.

import DOMPurify from './vendor/dompurify/purify.es.js';
import { SLUG_RE } from './lib/post-format.js';
import { PARSER_FLAGS, slugify } from './lib/blog-render.js';

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

/** Markdown -> sanitized DOM fragment, for posts rendered in the browser. */
export function renderLive(md4cFs, markdown, { postUrl, storageBase, postHref }) {
  const html = md4cFs.render(markdown, { parserFlags: PARSER_FLAGS });
  const frag = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true });
  resolveUrls(frag, postUrl, storageBase, postHref);
  for (const el of frag.querySelectorAll('x-wikilink')) {
    const a = document.createElement('a');
    a.href = postHref(slugify(el.dataset.target ?? ''));
    a.append(...el.childNodes);
    el.replaceWith(a);
  }
  return frag;
}

/* ---------- Typesetting (both kinds of post) ---------- */

/** Figures from lone images, scrollable tables, heading anchors, lazy images. */
export function typeset(root) {
  for (const p of root.querySelectorAll('p')) {
    const img = p.firstElementChild;
    if (p.children.length !== 1 || img.tagName !== 'IMG' || p.textContent.trim()) continue;
    const figure = document.createElement('figure');
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
  }
  const used = new Set();
  for (const h of root.querySelectorAll('h1, h2, h3, h4')) {
    let id = `sec-${slugify(h.textContent) || 'section'}`;
    for (let i = 2; used.has(id); i++) id = id.replace(/(-\d+)?$/, `-${i}`);
    used.add(id);
    h.id = id;
  }
  for (const img of root.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.decoding = 'async';
  }
}

export function buildToc(prose, site) {
  const heads = [...prose.querySelectorAll(':scope > h2, :scope > h3')];
  if (!site.toc || prose.querySelectorAll(':scope > h2').length < 3) return null;
  const nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'Contents');
  nav.innerHTML = '<h2 class="sc">Contents</h2>';
  const top = document.createElement('ol');
  let sub = null;
  for (const h of heads) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent;
    li.append(a);
    if (h.tagName === 'H2') {
      top.append(li);
      sub = null;
    } else {
      if (!sub) {
        sub = document.createElement('ol');
        (top.lastElementChild ?? top).append(sub);
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

/** Everything an article needs once its .prose is in the page. */
export async function finishArticle(article, site, info) {
  const prose = article.querySelector('.prose');
  typeset(prose);
  // Authors who number their own headings keep their numbers, unduplicated.
  const manual = [...prose.querySelectorAll(':scope > h2')].some((h) => /^\s*\d+(\.\d+)*[.)]?\s/.test(h.textContent));
  prose.classList.toggle('manual-numbers', manual);
  const toc = buildToc(prose, site);
  if (toc) {
    toc.classList.toggle('manual-numbers', manual);
    prose.before(toc);
  }
  if (site.citation && !article.querySelector('.cite')) article.append(citation(site, info));
  await Promise.all([renderMath(prose, site), enhanceCode(prose)]);
}
