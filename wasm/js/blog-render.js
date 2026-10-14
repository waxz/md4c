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
 * Turn MD4C's HTML into what a static post page (posts/<slug>.html) needs:
 * [[Wiki links]] and links to sibling .md posts point at their .html pages.
 */
export function linkPostsForStaticPage(html) {
  return html
    .replace(/<x-wikilink data-target="([^"]*)">([\s\S]*?)<\/x-wikilink>/g, (_, target, label) => {
      const slug = slugify(target.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      return slug ? `<a href="${escAttr(slug)}.html">${label}</a>` : label;
    })
    .replace(/href="([^"/:#?]+)\.md(#[^"]*)?"/g, (whole, slug, frag = '') =>
      SLUG_RE.test(slug) ? `href="${slug}.html${frag}"` : whole);
}
