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
//     "quote":"…","comment":"Markdown","color":"yellow","at":"2026-10-25"}]
//   ```
//
// The highlights live in the post's own Markdown (one file to save, sync,
// publish and encrypt), in a fenced block the admin's editor keeps out of
// sight. Rects are fractions of the page (x, y, width, height), so they fit
// the page at any zoom.
//
// Shared by the site build (Node or browser), the blog and the admin: no DOM.

export const ANNOTATIONS_MARK = 'md4c-annotations';
export const COLORS = ['yellow', 'green', 'blue', 'pink'];
const BLOCK_RE = new RegExp(`(?:^|\\n)\`\`\`${ANNOTATIONS_MARK}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*(?=\\r?\\n|$)`);
export const ID_RE = /^a-[a-z0-9]{4,16}$/;

export const isPaper = (meta) => String(meta?.type ?? '').trim().toLowerCase() === 'paper';

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/** One annotation, checked: { id, page, rects, quote, comment, color, at }, or null. */
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
    quote: String(a.quote ?? '').slice(0, 2000),
    comment: String(a.comment ?? '').slice(0, 20000),
    color: COLORS.includes(a.color) ? a.color : COLORS[0],
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

/**
 * The article HTML of a paper post: the PDF viewer's place (blog/paper.js
 * draws the PDF there), the comments beside it, then the notes. Readable
 * without JavaScript too: the comments and notes are plain HTML, with a
 * link to the PDF. `renderMd(markdown)` = the blog's Markdown renderer.
 */
export function paperHtml(meta, body, annotations, renderMd) {
  const pdf = paperPdf(meta);
  const list = sortAnnotations(annotations);
  const items = list.map((a) => `<li class="annotation" id="${esc(a.id)}" data-page="${a.page}" data-color="${esc(a.color)}" data-rects="${esc(JSON.stringify(a.rects))}">
<a class="annotation-at sc" href="#${esc(a.id)}">p.&nbsp;${a.page}</a>
${a.quote ? `<blockquote class="annotation-quote">${esc(a.quote)}</blockquote>\n` : ''}<div class="annotation-comment">
${a.comment.trim() ? renderMd(a.comment) : ''}</div>
</li>`).join('\n');
  return `<div class="paper"${pdf ? ` data-pdf="${esc(pdf)}"` : ''}>
<div class="paper-viewer">${pdf
    ? `<p class="paper-fallback"><a href="${esc(pdf)}">Open the PDF</a></p>`
    : '<p class="paper-fallback">No PDF: name one in the front matter (<code>pdf: paper.pdf</code>).</p>'}</div>
<aside class="paper-comments" aria-label="Comments">
<h2 class="sc">Comments <span class="count">${list.length}</span></h2>
${list.length ? `<ol class="annotations">\n${items}\n</ol>` : '<p class="muted">No highlights yet.</p>'}
</aside>
</div>
<div class="paper-notes">
${renderMd(body)}</div>
`;
}
