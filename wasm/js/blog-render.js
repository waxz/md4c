// Markdown -> HTML rules shared by the browser and the publish script, so a
// post pre-rendered at publish time and one rendered live look the same.

import { Dialect, Flags, HtmlFlags } from './md4c.js';
import { SLUG_RE } from './post-format.js';
import { isPaper, paperHtml, splitAnnotations } from './paper.js';

export const PARSER_FLAGS =
  Dialect.GITHUB | Flags.WIKILINKS | Flags.HIGHLIGHT | Flags.LATEXMATHSPANS;

/** Renderer flags for the admin's preview: blocks carry data-src (md4c_wasm.c). */
export const SOURCE_POS_FLAGS = HtmlFlags.SKIP_UTF8_BOM | HtmlFlags.SOURCE_POS;

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * Where a [[wiki link]] goes: "Some post" -> page of some-post;
 * "some-paper#a-k3j9x2" -> that highlight in a paper post; "#a-k3j9x2" ->
 * that highlight on this page. `pageOf(slug)` makes a post's address.
 */
export function wikiHref(target, pageOf) {
  const at = target.indexOf('#');
  const slug = slugify(at === -1 ? target : target.slice(0, at));
  const frag = at === -1 ? '' : target.slice(at + 1).replace(/[^A-Za-z0-9_-]/g, '');
  if (!slug) return frag ? `#${frag}` : '';
  const page = pageOf(slug);
  return frag ? `${page.replace(/#.*$/, '')}#${frag}` : page;
}

/**
 * The HTML of a post's article from its front matter and body: Markdown
 * through md4c (`toHtml(markdown)`), made ready for a static page; a paper
 * post (type: paper) as its PDF, highlights with comments, and notes.
 */
export function articleHtml(meta, body, toHtml) {
  const renderMd = (md) => linkPostsForStaticPage(toHtml(md));
  if (!isPaper(meta)) return renderMd(body);
  const { body: notes, annotations } = splitAnnotations(body);
  return paperHtml(meta, notes, annotations, renderMd);
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
      const href = wikiHref(target.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), (slug) => `${slug}.html`);
      // A link to a paper's highlight ([[paper#a-…]]) is a reference chip.
      const ref = /#(a-[a-z0-9]{4,16})$/.exec(href);
      return href ? `<a href="${escAttr(href)}"${ref ? ` class="annotation-ref" data-ref="${ref[1]}"` : ''}>${label}</a>` : label;
    })
    .replace(/href="([^"/:#?]+)\.md(#[^"]*)?"/g, (whole, slug, frag = '') =>
      SLUG_RE.test(slug) ? `href="${slug}.html${frag}"` : whole);
}

const unescAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const BASE = 'https://site.invalid/';

/**
 * The post an href in a post page points at ("other.html", "other.md",
 * "../posts/other.html", "../index.html#/post/other", or the same as an
 * absolute URL on `own`, the site's URL), or ''.
 */
function slugFromHref(raw, own) {
  let url;
  try {
    url = new URL(unescAttr(raw), `${BASE}posts/`);
  } catch {
    return '';
  }
  let path;
  if (url.origin === new URL(BASE).origin) path = url.pathname.slice(1);
  else if (own && url.origin === own.origin && url.pathname.startsWith(own.pathname)) path = url.pathname.slice(own.pathname.length);
  else return '';
  const page = /^posts\/([^/]+)\.(?:html|md)$/.exec(path);
  const live = /^(?:index\.html)?$/.test(path) && /^#\/post\/([^/?#]+)/.exec(url.hash);
  const slug = page?.[1] ?? live?.[1] ?? '';
  return SLUG_RE.test(slug) ? slug : '';
}

function siteUrlOf(siteUrl) {
  try {
    return siteUrl ? new URL(siteUrl) : null;
  } catch {
    return null;
  }
}

const HREF_RE = /<a\s[^>]*?href="([^"]*)"/gi;

/**
 * Slugs of the posts an article links to, from its static-page HTML (see
 * linkPostsForStaticPage). Sorted, without duplicates; may name posts that
 * do not exist (yet).
 */
export function postLinks(html, siteUrl = '') {
  const own = siteUrlOf(siteUrl);
  const out = new Set();
  for (const [, raw] of html.matchAll(HREF_RE)) {
    const slug = slugFromHref(raw, own);
    if (slug) out.add(slug);
  }
  return [...out].sort();
}

const BLOCK_RE = /<(p|li|h[2-6]|td|th|dt|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ANCHOR_RE = /<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const plain = (h) => unescAttr(h.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ');
const CONTEXT = 90;

/**
 * Where each linked post is mentioned: { slug: [before, label, after] },
 * the text around the first link to it (as Obsidian shows backlinks in
 * context), cut to about CONTEXT characters on each side.
 */
export function linkContexts(html, siteUrl = '') {
  const own = siteUrlOf(siteUrl);
  const out = {};
  for (const [, , block] of html.matchAll(BLOCK_RE)) {
    for (const m of block.matchAll(ANCHOR_RE)) {
      const slug = slugFromHref(m[1], own);
      if (!slug || out[slug]) continue;
      let before = plain(block.slice(0, m.index)).trimStart();
      let after = plain(block.slice(m.index + m[0].length)).trimEnd();
      if (before.length > CONTEXT) before = `…${before.slice(-CONTEXT).replace(/^\S*\s/, '')}`;
      if (after.length > CONTEXT) after = `${after.slice(0, CONTEXT).replace(/\s\S*$/, '')}…`;
      out[slug] = [before, plain(m[2]).trim(), after];
    }
  }
  return out;
}
