// Post file format shared by the blog (browser) and the publish script
// (Node): Markdown with a small front matter block.
//
//   ---
//   title: Hello
//   date: 2026-10-14
//   tags: a, b
//   description: One or two sentences for search results (optional;
//                defaults to the first paragraph)
//   author: Someone Else    (optional; defaults to the site author)
//   image: cover.jpg        (optional; social-media preview image)
//   updated: 2026-11-02     (optional; last substantial revision)
//   draft: true             (optional: the publish script skips drafts)
//   ---
//
//   Markdown body...

/** Post file names: posts/<slug>.md, lowercase letters, digits and dashes. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isDraft(meta) {
  return /^(true|yes|1)$/i.test(meta.draft ?? '');
}

/** Split "---\nkey: value\n---\nbody" into { meta, body }. */
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
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
  if (isIsoDate(updated)) out.updated = updated;
  return out;
}
