// Markdown -> HTML rules shared by the browser and the publish script, so a
// post pre-rendered at publish time and one rendered live look the same.

import { Dialect, Flags } from './md4c.js';
import { SLUG_RE } from './post-format.js';

export const PARSER_FLAGS =
  Dialect.GITHUB | Flags.WIKILINKS | Flags.HIGHLIGHT | Flags.LATEXMATHSPANS;

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * The article title is the page's one <h1>, so "# Section" headings in the
 * body become <h2> (and "##" <h3>, ...): Markdown from elsewhere often uses
 * "#" for its sections, and the contents box and numbering work on h2/h3.
 */
export function demoteHeadings(html) {
  if (!/<h1[\s>]/i.test(html)) return html;
  return html.replace(/<(\/?)h([1-6])(?=[\s>])/gi, (_, close, n) => `<${close}h${Math.min(6, Number(n) + 1)}`);
}

/**
 * Turn MD4C's HTML into what a static post page (posts/<slug>.html) needs:
 * [[Wiki links]] and links to sibling .md posts point at their .html pages,
 * and body headings start at <h2>.
 */
export function linkPostsForStaticPage(html) {
  return demoteHeadings(html)
    .replace(/<x-wikilink data-target="([^"]*)">([\s\S]*?)<\/x-wikilink>/g, (_, target, label) => {
      const slug = slugify(target.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      return slug ? `<a href="${escAttr(slug)}.html">${label}</a>` : label;
    })
    .replace(/href="([^"/:#?]+)\.md(#[^"]*)?"/g, (whole, slug, frag = '') =>
      SLUG_RE.test(slug) ? `href="${slug}.html${frag}"` : whole);
}

const HREF_RE = /<a\s[^>]*?href="([^"]*)"/gi;
const unescAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Slugs of the posts an article links to, from its static-page HTML (see
 * linkPostsForStaticPage): "other.html", "other.md", "../posts/other.html",
 * "../index.html#/post/other", or absolute links to the same on `siteUrl`.
 * Sorted, without duplicates; may name posts that do not exist (yet).
 */
export function postLinks(html, siteUrl = '') {
  const base = 'https://site.invalid/';
  let own = null;
  try {
    if (siteUrl) own = new URL(siteUrl);
  } catch {}
  const out = new Set();
  for (const [, raw] of html.matchAll(HREF_RE)) {
    let url;
    try {
      url = new URL(unescAttr(raw), `${base}posts/`);
    } catch {
      continue;
    }
    let path;
    if (url.origin === new URL(base).origin) path = url.pathname.slice(1);
    else if (own && url.origin === own.origin && url.pathname.startsWith(own.pathname)) path = url.pathname.slice(own.pathname.length);
    else continue;
    const page = /^posts\/([^/]+)\.(?:html|md)$/.exec(path);
    const live = /^(?:index\.html)?$/.test(path) && /^#\/post\/([^/?#]+)/.exec(url.hash);
    const slug = page?.[1] ?? live?.[1] ?? '';
    if (SLUG_RE.test(slug)) out.add(slug);
  }
  return [...out].sort();
}
