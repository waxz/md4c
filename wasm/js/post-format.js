// Post file format shared by the blog (browser) and the publish script
// (Node): Markdown with a YAML front matter block.
//
//   ---
//   title: "C++ tips: a + b"  (optional; else the first "# Heading", which
//                             is then not repeated in the body, else the
//                             file name)
//   date: 2026-10-14
//   tags: [c++, compilers]   (or "a, b", or a "- a" list)
//   description: One or two sentences for search results (optional;
//                defaults to the first paragraph)
//   author: Someone Else    (optional; defaults to the site author)
//   image: cover.jpg        (optional; social-media preview image)
//   banner: header.jpg      (optional; wide image above the article;
//                            "cover" works too)
//   background: paper.jpg   (optional; this post's page background)
//   backgroundMode: page    (optional; page | hero, as in site settings)
//   updated: 2026-11-02     (optional; last substantial revision)
//   toc: true               (optional; true: always a "Contents" box,
//                            false: never; default: the site setting, for
//                            posts with two or more sections)
//   numbered: true          (optional; number the sections 1, 1.1, ...;
//                            default: the site's "numberedHeadings")
//   draft: true             (optional: the publish script skips drafts)
//   password: …             (optional: published encrypted; readers need
//                            this password, see protect.js)
//   ---
//
//   Markdown body...
//
// The YAML understood is the subset front matter uses: "key: value" with
// plain, 'single' or "double" quoted values, [flow, lists], block lists
// ("- item" lines), | and > multi-line text, and # comment lines. A "#"
// inside a value is kept (titles like "Issue #42" are common). Values come
// back as strings; lists are joined with ", ".

/** Post file names: posts/<slug>.md, lowercase letters, digits and dashes. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isDraft(meta) {
  return /^(true|yes|1)$/i.test(meta.draft ?? '');
}

/** A YAML scalar: 'single' and "double" quoted values are unquoted. */
function yamlScalar(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Items of a [flow, list], respecting quotes. */
function yamlFlowList(inner) {
  const items = [];
  let cur = '';
  let quote = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map(yamlScalar).filter(Boolean);
}

/**
 * Split "---\nkey: value\n---\nbody" into { meta, body }. Keys are
 * lowercased. Without a `title`, a leading "# Heading" becomes the title
 * and is taken out of the body, so the page doesn't show it twice.
 */
export function parseFrontMatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length);
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(#|$)/.test(lines[i])) continue;
      const kv = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/.exec(lines[i]);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const raw = (kv[2] ?? '').trim();
      let value;
      if (raw === '' || /^[|>][+-]?$/.test(raw)) {
        // A block list ("- item" lines) or block text (| keeps newlines).
        const items = [];
        const textLines = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || (raw && !lines[i + 1].trim()))) {
          const next = lines[++i];
          const item = /^\s*-\s+(.*)$/.exec(next);
          if (item && !raw) items.push(yamlScalar(item[1]));
          else textLines.push(next.trim());
        }
        value = items.length ? items.filter(Boolean).join(', ')
          : textLines.join(raw.startsWith('|') ? '\n' : ' ').trim();
      } else if (raw.startsWith('[') && raw.endsWith(']')) {
        value = yamlFlowList(raw.slice(1, -1)).join(', ');
      } else {
        value = yamlScalar(raw);
      }
      meta[key] = value;
    }
  }
  if (!meta.title) {
    // "# Title" as the first line of the body (Markdown files from elsewhere).
    const h1 = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(body);
    if (h1) {
      meta.title = h1[1].replace(/[`*]/g, '').trim();
      body = body.slice(h1[0].length);
    }
  }
  return { meta, body };
}

/** "true" / "false" for a yes/no front matter value, else undefined. */
export function flag(v) {
  if (/^(true|yes|on|1)$/i.test(String(v ?? '').trim())) return 'true';
  if (/^(false|no|off|0)$/i.test(String(v ?? '').trim())) return 'false';
  return undefined;
}

/** Tags from "a, b" (front matter) or ["a", "b"] (hand-written index.json). */
export function parseTags(s) {
  const list = Array.isArray(s) ? s : String(s ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s);

/** Plain-text excerpt: the first paragraph of rendered HTML. */
export function excerptFromHtml(html) {
  const p = /<p>([\s\S]*?)<\/p>/.exec(html);
  const text = (p ? p[1] : '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

/**
 * The metadata index.json keeps for each post. All values are strings
 * (storagesdk object metadata is string-valued); optional ones are omitted.
 */
export function postMetadata(source, renderHtml, fallbackTitle) {
  const { meta, body } = parseFrontMatter(source);
  const date = (meta.date ?? '').slice(0, 10);
  const updated = (meta.updated ?? '').slice(0, 10);
  const out = {
    title: (meta.title || fallbackTitle).slice(0, 200),
    date: isIsoDate(date) ? date : new Date().toISOString().slice(0, 10),
    tags: parseTags(meta.tags).join(', ').slice(0, 300),
    excerpt: excerptFromHtml(renderHtml(body)),
  };
  if (meta.description || meta.summary) out.description = (meta.description || meta.summary).slice(0, 300);
  if (meta.author) out.author = meta.author.slice(0, 120);
  if (meta.image) out.image = meta.image.slice(0, 500);
  if (meta.banner || meta.cover) out.banner = (meta.banner || meta.cover).slice(0, 500);
  if (meta.background) out.background = meta.background.slice(0, 500);
  if (/^(page|hero)$/.test(meta.backgroundmode ?? '')) out.backgroundMode = meta.backgroundmode;
  if (isIsoDate(updated)) out.updated = updated;
  if (String(meta.type ?? '').trim().toLowerCase() === 'paper') out.type = 'paper';
  if (flag(meta.toc)) out.toc = flag(meta.toc);
  if (flag(meta.numbered)) out.numbered = flag(meta.numbered);
  // Citations (js/cite.js): the post's .bib files, style, and entries listed uncited.
  if (meta.bibliography) out.bibliography = String(meta.bibliography).slice(0, 500);
  const style = meta.citestyle || meta['cite-style'];
  if (style) out.citeStyle = /^num/i.test(style) ? 'numeric' : 'author-year';
  if (meta.nocite) out.nocite = String(meta.nocite).slice(0, 2000);
  return out;
}
