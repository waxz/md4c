// Paper notes: a post about a PDF (front matter `type: paper`, `pdf:`),
// with highlights in the PDF and a comment for each, side by side.
//
//   ---
//   title: Attention is all you need — notes
//   type: paper
//   pdf: attention.pdf          (next to the post, in posts/; relative only)
//   ---
//
//   General notes (Markdown). [[other-paper#a-k3j9x2]] links to a highlight
//   in another paper; [[#a-k3j9x2]] to one in this paper.
//
//   ```md4c-annotations
//   [{"id":"a-k3j9x2","page":3,"rects":[[0.12,0.31,0.62,0.02]],
//     "title":"Model-free RL","quote":"…","comment":"Markdown","tags":["definition"],
//     "color":"yellow","shape":"underline","at":"2026-10-25"}]
//   ```
//
// The highlights live in the post's own Markdown (one file to save, sync,
// publish and encrypt), in a fenced block the admin's editor keeps out of
// sight. Rects are fractions of the page (x, y, width, height), so they fit
// the page at any zoom.
//
// Shared by the site build (Node or browser), the blog and the admin: no DOM.

export const ANNOTATIONS_MARK = 'md4c-annotations';
export const COLORS = ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'green', 'gray'];
/** How a highlight is drawn: filled, underlined, struck out, or a box (an area: a figure, a formula). */
export const SHAPES = ['highlight', 'underline', 'strike', 'box'];
const BLOCK_RE = new RegExp(`(?:^|\\n)\`\`\`${ANNOTATIONS_MARK}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*(?=\\r?\\n|$)`);
export const ID_RE = /^a-[a-z0-9]{4,16}$/;

export const isPaper = (meta) => String(meta?.type ?? '').trim().toLowerCase() === 'paper';

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Tags of a comment, cleaned: lower case, no "#", spaces as dashes, at most
 * 12 of 32 letters. From a list or a comma-separated text.
 */
export function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  const out = [];
  for (const t of list) {
    const tag = String(t ?? '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 12);
}

/** One annotation, checked: { id, page, rects, title?, quote, comment, tags?, color, shape?, at? }, or null. */
export function cleanAnnotation(a) {
  if (!a || typeof a !== 'object' || !ID_RE.test(a.id ?? '')) return null;
  const page = Math.trunc(Number(a.page));
  if (!(page >= 1 && page <= 100000)) return null;
  const rects = (Array.isArray(a.rects) ? a.rects : [])
    .filter((r) => Array.isArray(r) && r.length === 4)
    .map((r) => r.map(clamp01).map((v) => Math.round(v * 10000) / 10000))
    .slice(0, 200);
  return {
    id: a.id,
    page,
    rects,
    ...(String(a.title ?? '').trim() ? { title: String(a.title).trim().slice(0, 120) } : {}),
    quote: String(a.quote ?? '').slice(0, 2000),
    comment: String(a.comment ?? '').slice(0, 20000),
    ...(cleanTags(a.tags).length ? { tags: cleanTags(a.tags) } : {}),
    color: COLORS.includes(a.color) ? a.color : COLORS[0],
    ...(SHAPES.includes(a.shape) && a.shape !== SHAPES[0] ? { shape: a.shape } : {}),
    ...(a.at ? { at: String(a.at).slice(0, 30) } : {}),
  };
}

/** Split a paper post's body: { body (the notes), annotations }. */
export function splitAnnotations(body) {
  const m = BLOCK_RE.exec(body);
  if (!m) return { body, annotations: [] };
  let list = [];
  try {
    const parsed = JSON.parse(m[1]);
    list = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const annotations = list.map(cleanAnnotation).filter(Boolean);
  return { body: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).replace(/\s+$/, '\n'), annotations };
}

/** The body with the annotations block put back (at the end), as saved. */
export function joinAnnotations(body, annotations) {
  const notes = body.replace(/\s+$/, '');
  if (!annotations.length) return notes ? `${notes}\n` : '';
  const lines = annotations.map((a) => JSON.stringify(cleanAnnotation(a)));
  return `${notes}\n\n\`\`\`${ANNOTATIONS_MARK}\n[\n${lines.join(',\n')}\n]\n\`\`\`\n`;
}

/** Annotations in reading order: page, then top to bottom. */
export function sortAnnotations(list) {
  const top = (a) => (a.rects[0] ? a.rects[0][1] : 0);
  return [...list].sort((a, b) => a.page - b.page || top(a) - top(b));
}

/** A new annotation id ("a-" and 6 letters or digits). */
export function newAnnotationId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `a-${Array.from(b, (x) => '0123456789abcdefghijklmnopqrstuvwxyz'[x % 36]).join('')}`;
}

/**
 * The PDF a paper post names, if usable: a relative path (next to the post,
 * or ../assets/…). Other addresses are refused: the pages' CSP only lets
 * the blog read its own storage.
 */
export function paperPdf(meta) {
  const v = String(meta?.pdf ?? '').trim();
  if (!v || /^[a-z][a-z0-9+.-]*:|^\/\/|[?#\\<>"']/i.test(v) || !/\.pdf$/i.test(v)) return '';
  return v.replace(/^\.\//, '');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The ids of highlights a piece of Markdown links to ([[#a-…]], [[paper#a-…]]). */
export function referencedIds(md) {
  return [...new Set([...String(md ?? '').matchAll(/#(a-[a-z0-9]{4,16})\b/g)].map((m) => m[1]))];
}

/**
 * Who links to each highlight: Map id -> ['notes' | id of another comment].
 * (Ids are random, so a match in a link to another paper is no worry.)
 */
export function backlinks(annotations, notes = '') {
  const map = new Map(annotations.map((a) => [a.id, []]));
  for (const id of referencedIds(notes)) map.get(id)?.push('notes');
  for (const a of annotations) {
    for (const id of referencedIds(a.comment)) if (id !== a.id) map.get(id)?.push(a.id);
  }
  return map;
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '').trimEnd() || s.slice(0, n)}…` : s);

/** A comment's first line as plain text (its Markdown marks taken out). */
export function plainText(md) {
  return String(md ?? '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[target|label]]
    .replace(/\[\[[^\]]*\]\]/g, '') // [[target]]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links, images
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~>#$]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The short name of a highlight: its title, else the first line of its
 * comment, else the start of its quote (“…”), else its page.
 */
export function annotationLabel(a, len = 48) {
  if (String(a?.title ?? '').trim()) return cut(a.title.trim(), len);
  const line = plainText(String(a?.comment ?? '').split(/\n\s*\n/)[0]);
  if (line) return cut(line, len);
  const q = String(a?.quote ?? '').replace(/\s+/g, ' ').trim();
  if (q) return `“${cut(q, len)}”`;
  return `Page ${a?.page ?? '?'}`;
}

/** Whether a highlight is named by its quote (no title, no comment): the quote is not shown twice. */
export const namedByQuote = (a) => !String(a?.title ?? '').trim() && !plainText(String(a?.comment ?? '').split(/\n\s*\n/)[0]) && Boolean(String(a?.quote ?? '').trim());

/** What index.json keeps of a highlight, for the overview of all of them (highlights.html). */
export function annotationSummary(a) {
  return {
    id: a.id,
    page: a.page,
    label: annotationLabel(a, 80),
    ...(a.quote ? { quote: cut(a.quote.replace(/\s+/g, ' ').trim(), 280) } : {}),
    ...(a.comment?.trim() ? { comment: cut(plainText(a.comment), 400) } : {}),
    ...(a.tags?.length ? { tags: a.tags } : {}),
    color: a.color,
  };
}

/**
 * Whether a reference's text was made for it, not written by hand: the
 * bare target ([[#a-…]], [[paper#a-…]]) or the old "p. 3: “…”" labels.
 * Such text is replaced by the highlight's current name.
 */
export function isAutoLabel(text, id) {
  const t = String(text ?? '').replace(/&nbsp;|\u00a0/g, ' ').trim();
  return t === id || t === `#${id}` || t.endsWith(`#${id}`) || /^p\.\s?\d+(\s*[:·][\s\S]*)?$/.test(t);
}

/**
 * Links to highlights in rendered HTML become reference chips
 * (class "annotation-ref", data-ref = the id). A bare [[#a-…]] to one of
 * `annotations` gets that highlight's label as its text.
 */
export function markAnnotationRefs(html, annotations = []) {
  const ownLabel = (id, label) => {
    const own = annotations.find((a) => a.id === id);
    return own && isAutoLabel(label, id) ? esc(annotationLabel(own)) : label;
  };
  return String(html)
    // Not yet links (the browser's live rendering turns these into links later)
    .replace(/(<x-wikilink data-target="#(a-[a-z0-9]{4,16})">)([\s\S]*?)(<\/x-wikilink>)/g,
      (_, open, id, label, close) => `${open}${ownLabel(id, label)}${close}`)
    .replace(/<a href="([^"#]*)#(a-[a-z0-9]{4,16})"([^>]*)>([\s\S]*?)<\/a>/g, (whole, page, id, rest, label) => {
    if (/class="(?!annotation-ref")/.test(rest)) return whole;
    rest = rest.replace(/\s(?:class|data-ref)="[^"]*"/g, '');
    return `<a href="${page}#${id}" class="annotation-ref" data-ref="${id}"${rest}>${ownLabel(id, label)}</a>`;
  });
}

/** A comment's tags, as buttons (they filter the comments). */
export const tagsHtml = (tags) => (tags?.length
  ? `<div class="annotation-tags">${tags.map((t) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>\n`
  : '');

/** The "Referenced in" line of a comment (from = an entry of backlinks()). */
export const backlinksHtml = (from, list) => (from.length
  ? `<div class="annotation-backlinks"><span class="muted">Referenced in</span> ${from.map((f) => (f === 'notes'
    ? '<a href="#paper-notes">the notes</a>'
    : `<a href="#${esc(f)}" class="annotation-ref" data-ref="${esc(f)}">${esc(annotationLabel(list.find((a) => a.id === f), 24))}</a>`)).join(' ')}</div>`
  : '');

/**
 * The article HTML of a paper post: the notes first, then the PDF viewer's
 * place (blog/paper.js draws the PDF there) with the comments beside it.
 * Readable without JavaScript too: the comments and notes are plain HTML,
 * with a link to the PDF. `renderMd(markdown)` = the blog's Markdown renderer.
 */
export function paperHtml(meta, body, annotations, renderMd) {
  const pdf = paperPdf(meta);
  const list = sortAnnotations(annotations);
  const back = backlinks(list, body);
  const md = (m) => markAnnotationRefs(renderMd(m), list);
  const items = list.map((a) => `<li class="annotation${namedByQuote(a) ? ' is-quote-label' : ''}" id="${esc(a.id)}" data-page="${a.page}" data-color="${esc(a.color)}"${a.shape ? ` data-shape="${esc(a.shape)}"` : ''}${a.tags?.length ? ` data-tags="${esc(a.tags.join(' '))}"` : ''} data-rects="${esc(JSON.stringify(a.rects))}">
<a class="annotation-at" href="#${esc(a.id)}" title="Page ${a.page}">${esc(annotationLabel(a, 60))}</a>
${tagsHtml(a.tags)}${a.quote ? `<blockquote class="annotation-quote">${esc(a.quote)}</blockquote>\n` : ''}<div class="annotation-comment">
${a.comment.trim() ? md(a.comment) : ''}</div>
${backlinksHtml(back.get(a.id), list)}</li>`).join('\n');
  const notes = body.trim() ? `<div class="paper-notes" id="paper-notes">
${md(body)}</div>
` : '';
  return `${notes}<div class="paper"${pdf ? ` data-pdf="${esc(pdf)}"` : ''}>
<div class="paper-viewer">${pdf
    ? `<p class="paper-fallback"><a href="${esc(pdf)}">Open the PDF</a></p>`
    : '<p class="paper-fallback">No PDF: name one in the front matter (<code>pdf: paper.pdf</code>).</p>'}</div>
<aside class="paper-comments" aria-label="Comments">
<div class="paper-comments-head"><span>Comments</span><span class="count">${list.length}</span><a class="paper-all" href="../highlights.html">All highlights</a></div>
${list.length ? `<ol class="annotations">\n${items}\n</ol>` : '<p class="muted">No highlights yet.</p>'}
</aside>
</div>
`;
}
