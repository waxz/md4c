// Post file format shared by the blog (browser) and its server (Node):
// Markdown with a small front matter block.
//
//   ---
//   title: Hello
//   date: 2026-10-14
//   tags: a, b
//   ---
//
//   Markdown body...

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

export function serializePost({ title, date, tags }, body) {
  const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  return `---\ntitle: ${clean(title)}\ndate: ${clean(date)}\ntags: ${clean(tags)}\n---\n\n${body.replace(/^\s+/, '')}`;
}

export function parseTags(s) {
  return (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

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

/** The metadata stored next to each post (title, date, tags, excerpt). */
export function postMetadata(source, renderHtml, fallbackTitle) {
  const { meta, body } = parseFrontMatter(source);
  return {
    title: (meta.title || fallbackTitle).slice(0, 200),
    date: (meta.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    tags: (meta.tags ?? '').slice(0, 300),
    excerpt: excerptFromHtml(renderHtml(body)),
  };
}
