// The PDF of a paper-notes post (js/paper.js), drawn with pdf.js, with its
// highlights on the pages and their comments beside it, linked both ways:
// a highlight shows its comment, a comment scrolls the PDF to its highlight,
// a reference chip ([[#a-…]], in the notes or a comment) jumps to both, and
// an address ending in #a-… (also from another post: [[that-paper#a-…]])
// opens at that highlight.
//
//   mountPaper(el, opts)   el = the .paper element of the article
//     opts.pdfUrl          the PDF's address (default: data-pdf, next to the page)
//     opts.editable        the admin: select text (or draw a box with the Area
//                          tool), pick a colour and shape in the bar that pops
//                          up, and write the comment in a pop-up
//     opts.annotations     (editable) the annotations; else read from the page
//     opts.onChange(list)  (editable) after any change
//     opts.renderComment(md)   (editable) a comment's preview HTML
//     opts.linkFor(id, a)  (editable) the cross-reference to copy, e.g. [[slug#a-…]]
//     opts.notes()         (editable) the notes' Markdown (for "Referenced in")
//     opts.confirmDelete(a)    (editable) resolves true to delete
//     opts.typeset(element)    (editable) typeset the math ($…$) of comments
//
// pdf.js is self-hosted under vendor/pdfjs/ (the pages' CSP allows only the
// blog's own scripts), loaded on first use, with eval off.

import {
  COLORS, SHAPES, annotationLabel, backlinks, backlinksHtml, cleanTags, markAnnotationRefs, mathText, namedByQuote, newAnnotationId,
  sortAnnotations, tagsHtml,
} from './lib/paper.js';

const PDFJS = new URL('./vendor/pdfjs/', import.meta.url);
let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.js').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

let cssAdded = false;
function addCss() {
  if (cssAdded || document.querySelector('link[data-paper-css]')) return;
  cssAdded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./paper.css', import.meta.url).href;
  link.dataset.paperCss = '';
  document.head.append(link);
}

// Small line icons (stroke = the text colour).
const svg = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  edit: svg('<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/>'),
  link: svg('<path d="M7 9a3 3 0 004.2.2l2-2a3 3 0 00-4.2-4.2l-1 1"/><path d="M9 7a3 3 0 00-4.2-.2l-2 2a3 3 0 004.2 4.2l1-1"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  area: svg('<path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11"/>'),
  comment: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
};
const SHAPE_NAMES = { highlight: 'Highlight', underline: 'Underline', strike: 'Strike out', box: 'Box' };
const shapeOf = (a) => (SHAPES.includes(a.shape) ? a.shape : SHAPES[0]);
const colorOf = (a) => (COLORS.includes(a.color) ? a.color : COLORS[0]);
const capital = (s) => s[0].toUpperCase() + s.slice(1);

/** The colour and shape used last (in this browser). */
const STYLE_KEY = 'md4c-paper-style';
function lastStyle() {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    return { color: COLORS.includes(v.color) ? v.color : COLORS[0], shape: SHAPES.includes(v.shape) ? v.shape : SHAPES[0] };
  } catch {
    return { color: COLORS[0], shape: SHAPES[0] };
  }
}
function keepStyle(style) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {}
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The annotations of a published page, from its comment list. */
function readAnnotations(el) {
  return [...el.querySelectorAll('li.annotation')].map((li) => {
    let rects = [];
    try {
      rects = JSON.parse(li.dataset.rects || '[]');
    } catch {}
    return {
      id: li.id, page: Number(li.dataset.page), rects, color: li.dataset.color, shape: li.dataset.shape, li,
      title: li.querySelector('.annotation-at')?.textContent ?? '',
      quote: li.querySelector('.annotation-quote')?.textContent ?? '',
      tags: (li.dataset.tags ?? '').split(' ').filter(Boolean),
    };
  });
}

export async function mountPaper(el, opts = {}) {
  addCss();
  const editable = Boolean(opts.editable);
  let list = editable ? sortAnnotations(opts.annotations ?? []) : readAnnotations(el);
  const viewer = el.querySelector('.paper-viewer');
  const side = el.querySelector('.paper-comments');
  const pdfUrl = opts.pdfUrl ?? (el.dataset.pdf ? new URL(el.dataset.pdf, document.baseURI).href : '');
  if (!pdfUrl) return null;

  viewer.innerHTML = `<div class="paper-toolbar">
      <button type="button" data-zoom="-1" aria-label="Zoom out">−</button>
      <button type="button" data-zoom="0" class="paper-zoom-label" aria-label="Fit the width">100%</button>
      <button type="button" data-zoom="1" aria-label="Zoom in">+</button>
      <span class="paper-pageinfo muted"></span>
      ${editable ? `<button type="button" class="paper-area-btn" aria-pressed="false" title="Draw a box around a figure, table or formula">${ICON.area}<span>Area</span></button>` : ''}
      <a class="paper-download" href="${esc(pdfUrl)}" target="_blank" rel="noopener">PDF ↗</a>
    </div>
    <div class="paper-pages" tabindex="0" aria-label="PDF pages"><p class="paper-loading muted">Loading the PDF…</p></div>`;
  const pagesEl = viewer.querySelector('.paper-pages');

  let pdfjs;
  let doc;
  try {
    pdfjs = await loadPdfjs();
    doc = await pdfjs.getDocument({
      url: pdfUrl,
      isEvalSupported: false,
      enableXfa: false,
      cMapUrl: new URL('cmaps/', PDFJS).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', PDFJS).href,
      wasmUrl: new URL('wasm/', PDFJS).href,
      iccUrl: new URL('iccs/', PDFJS).href,
    }).promise;
  } catch (err) {
    pagesEl.innerHTML = `<p class="error">The PDF could not be opened: ${esc(err.message ?? err)}. <a href="${esc(pdfUrl)}">Open it directly</a></p>`;
    return null;
  }

  /* ---------- Pages ---------- */

  const cleanups = [];
  let activeId = ''; // the highlight shown
  let quietUntil = 0; // a click that ends drawing a box is not a click on it
  let filterTag = ''; // the comments shown: those with this tag ('' all)
  let floatEl = null; // the comment shown by its highlight (reader)

  let zoom = 1;
  const pages = []; // { n, el, base: viewport at scale 1, rendered: scale, task }
  const scale = () => Math.max(0.2, ((pagesEl.clientWidth - 24) / pages[0].base.width) * zoom);
  pagesEl.replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const box = document.createElement('div');
    box.className = 'paper-page';
    box.dataset.page = String(n);
    box.innerHTML = '<canvas aria-hidden="true"></canvas><div class="textLayer"></div><div class="paper-highlights"></div>';
    pagesEl.append(box);
    pages.push({ n, page, el: box, base: page.getViewport({ scale: 1 }), rendered: 0 });
    if (n === 1) layout(); // the first page shows while the others load
  }

  function layout() {
    const s = scale();
    for (const p of pages) {
      p.el.style.width = `${Math.floor(p.base.width * s)}px`;
      p.el.style.height = `${Math.floor(p.base.height * s)}px`;
      p.el.style.setProperty('--scale-factor', String(s));
    }
    viewer.querySelector('.paper-zoom-label').textContent = `${Math.round(zoom * 100)}%`;
    if (floatEl) closeFloat(); // placed for the old size
    drawHighlights();
  }

  async function render(p) {
    const s = scale();
    if (p.rendered === s || p.task) return;
    const viewport = p.page.getViewport({ scale: s });
    const canvas = p.el.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    p.task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
    try {
      await p.task.promise;
      const text = p.el.querySelector('.textLayer');
      text.replaceChildren();
      await new pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: text, viewport }).render();
      p.rendered = s;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('pdf page', p.n, err);
    } finally {
      p.task = null;
      if (p.rendered !== scale() && p.visible) render(p); // zoomed meanwhile
    }
  }

  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pages.find((x) => x.el === e.target);
      p.visible = e.isIntersecting;
      if (e.isIntersecting) render(p);
    }
    const first = pages.find((p) => p.visible);
    if (first) viewer.querySelector('.paper-pageinfo').textContent = `${first.n} / ${pages.length}`;
  }, { root: pagesEl, rootMargin: '200% 0px' });
  for (const p of pages) seen.observe(p.el);

  viewer.querySelector('.paper-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    const anchor = pagesEl.scrollTop / Math.max(1, pagesEl.scrollHeight);
    zoom = b.dataset.zoom === '0' ? 1 : Math.min(4, Math.max(0.4, zoom * (b.dataset.zoom === '1' ? 1.25 : 0.8)));
    layout();
    pagesEl.scrollTop = anchor * pagesEl.scrollHeight;
    for (const p of pages) if (p.visible) render(p);
  });
  let lastWidth = pagesEl.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(pagesEl.clientWidth - lastWidth) < 2) return;
    lastWidth = pagesEl.clientWidth;
    layout();
    for (const p of pages) if (p.visible) render(p);
  }).observe(pagesEl);

  /* ---------- Highlights ---------- */

  function drawHighlights() {
    for (const p of pages) {
      const layer = p.el.querySelector('.paper-highlights');
      layer.replaceChildren();
      for (const a of list.filter((x) => x.page === p.n)) {
        for (const [x, y, w, h] of a.rects) {
          const r = document.createElement('div');
          r.className = `paper-hl hl-${colorOf(a)} shape-${shapeOf(a)}`;
          r.dataset.id = a.id;
          r.style.left = `${x * 100}%`;
          r.style.top = `${y * 100}%`;
          r.style.width = `${w * 100}%`;
          r.style.height = `${h * 100}%`;
          layer.append(r);
        }
      }
    }
    if (activeId) setActive(activeId);
    if (filterTag) applyFilter();
  }

  const flash = (node) => node?.animate?.([{ outline: '3px solid var(--accent, #8b1e2d)' }, { outline: '3px solid transparent' }], { duration: 1400 });
  // A highlight blinks, without covering the text.
  const blink = (node) => node?.animate?.([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], { duration: 1100 });
  const commentOf = (id) => side.querySelector(`[data-annotation="${CSS.escape(id)}"], li#${CSS.escape(id)}`);
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  const byId = (id) => list.find((x) => x.id === id);

  /** Scroll the PDF to annotation `id` and flash it. */
  function showInPdf(id) {
    const a = byId(id);
    const p = a && pages[a.page - 1];
    if (!p) return;
    const top = p.el.offsetTop + (a.rects[0]?.[1] ?? 0) * p.el.offsetHeight - pagesEl.clientHeight / 3;
    pagesEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    render(p).then(() => {
      for (const r of p.el.querySelectorAll(`.paper-hl[data-id="${CSS.escape(id)}"]`)) blink(r);
      if (!editable) floatNote(id);
    });
    setActive(id);
  }

  /* The comment of a highlight in a card by it, on the page (it scrolls
     with the PDF): the reader's view of a highlight. */
  function closeFloat() {
    floatEl?.remove();
    floatEl = null;
  }
  function floatNote(id) {
    closeFloat();
    const a = byId(id);
    const p = a && pages[a.page - 1];
    if (!p || !a.rects.length) return;
    const first = a.rects[0];
    const last = a.rects.reduce((m, r) => (r[1] + r[3] > m[1] + m[3] ? r : m));
    const node = document.createElement('div');
    node.className = 'paper-float';
    node.dataset.color = colorOf(a);
    node.dataset.id = id;
    node.innerHTML = `<div class="pop-head"><span class="pop-label" title="Page ${a.page}"></span>
        <button type="button" class="pop-icon" data-act="close-float" aria-label="Close">×</button></div>
      <button type="button" class="pop-link" data-go="${esc(id)}">Show in the comments</button>`;
    // Copies of the comment's nodes (typeset math keeps its styles: the
    // pages' CSP refuses style attributes parsed from HTML).
    const from = (sel) => a.li?.querySelector(sel);
    const label = node.querySelector('.pop-label');
    if (from('.annotation-at')) label.append(...from('.annotation-at').cloneNode(true).childNodes);
    else label.textContent = annotationLabel(a, 60);
    const go = node.querySelector('.pop-link');
    if (from('.annotation-tags')) go.before(from('.annotation-tags').cloneNode(true));
    if (from('.annotation-comment')?.textContent.trim()) go.before(from('.annotation-comment').cloneNode(true));
    p.el.append(node);
    const pw = p.el.clientWidth;
    const ph = p.el.clientHeight;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = first[0] * pw;
    if (x + w > pw - 6) x = Math.max(6, pw - w - 6);
    let y = (last[1] + last[3]) * ph + 6;
    if (y + h > ph - 6) y = Math.max(6, first[1] * ph - h - 6); // no room below: above it
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    floatEl = node;
  }
  pagesEl.addEventListener('click', (e) => {
    const f = e.target.closest('.paper-float');
    if (!f) return;
    if (e.target.closest('[data-act="close-float"]')) closeFloat();
    else if (e.target.closest('[data-go]')) showComment(f.dataset.id, true);
  });

  /**
   * Bring the comment of `id` into view: within the side panel when it
   * scrolls on its own (beside the PDF), else the page itself when `page`.
   */
  function showComment(id, page = false) {
    const c = commentOf(id);
    if (!c) return;
    if (side.scrollHeight > side.clientHeight + 1) {
      const top = c.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop - 8;
      side.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else if (page) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(c);
    setActive(id);
  }

  /** A reference chip was followed: the highlight in the PDF, and its comment. */
  function jumpTo(id) {
    closePeek();
    if (narrow()) showComment(id, true); // stacked: the comment, under the PDF
    else {
      const r = el.getBoundingClientRect();
      if (r.top < -10 || r.top > window.innerHeight * 0.4) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showComment(id);
    }
    showInPdf(id);
  }

  function setActive(id) {
    activeId = id;
    for (const c of side.querySelectorAll('.is-active')) c.classList.remove('is-active');
    for (const r of viewer.querySelectorAll('.paper-hl.is-active')) r.classList.remove('is-active');
    commentOf(id)?.classList.add('is-active');
    for (const r of viewer.querySelectorAll(`.paper-hl[data-id="${CSS.escape(id)}"]`)) r.classList.add('is-active');
  }

  /* ---------- Pop-ups: a peek at a comment, the selection bar, the comment editor ---------- */

  const popup = (cls) => {
    const node = document.createElement('div');
    node.className = `paper-pop ${cls}`;
    node.hidden = true;
    el.append(node); // fixed: out of the grid's flow
    return node;
  };
  /** Put a pop-up by `rect` (client coordinates): below it, else above, kept on screen. */
  function place(node, rect) {
    node.hidden = false;
    if (node.classList.contains('paper-editor') && window.matchMedia('(max-width: 600px)').matches) {
      node.style.left = node.style.top = ''; // a sheet at the bottom (CSS)
      return;
    }
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8 && rect.top - h - 8 > 8) top = rect.top - h - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  const peekEl = popup('paper-peek');
  let peekFor = '';
  /** The comment of `id` in a small card by `rect`. */
  function peek(id, rect, withGo = false) {
    const a = byId(id);
    if (!a) return;
    peekFor = id;
    const comment = a.li ? '' : commentHtml(a); // (published: copied as nodes, below)
    peekEl.innerHTML = `<div class="pop-head"><span class="pop-label hl-${colorOf(a)}" title="Page ${a.page}">${a.li ? '' : mathText(annotationLabel(a, 60))}</span>${withGo ? `<button type="button" class="pop-link" data-go="${esc(id)}">Show comment ↓</button>` : ''}</div>
      ${a.quote ? `<blockquote class="annotation-quote">${esc(a.quote)}</blockquote>` : ''}
      ${comment ? `<div class="annotation-comment">${comment}</div>` : a.li ? '' : '<p class="muted pop-empty">No comment.</p>'}`;
    if (a.li) {
      const at = a.li.querySelector('.annotation-at');
      if (at) peekEl.querySelector('.pop-label').append(...at.cloneNode(true).childNodes);
      const c = a.li.querySelector('.annotation-comment');
      if (c?.textContent.trim()) peekEl.append(c.cloneNode(true));
      else peekEl.insertAdjacentHTML('beforeend', '<p class="muted pop-empty">No comment.</p>');
    }
    if (editable) opts.typeset?.(peekEl);
    place(peekEl, rect);
  }
  function closePeek() {
    peekEl.hidden = true;
    peekFor = '';
  }
  peekEl.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      closePeek();
      showComment(go.dataset.go, true);
    }
  });

  /** A comment's HTML: from the page as published, or rendered (editing). */
  function commentHtml(a) {
    if (a.li) return a.li.querySelector('.annotation-comment')?.innerHTML.trim() ?? '';
    return a.comment?.trim() && opts.renderComment ? markAnnotationRefs(opts.renderComment(a.comment), list) : '';
  }

  // Highlights lie under the text (so it can still be selected): a click
  // that selects nothing finds the highlight under it by position.
  const hitAt = (pageEl, clientX, clientY) => {
    const box = pageEl.getBoundingClientRect();
    const fx = (clientX - box.left) / box.width;
    const fy = (clientY - box.top) / box.height;
    return list.find((a) => a.page === Number(pageEl.dataset.page)
      && a.rects.some(([x, y, w, h]) => fx >= x - 0.003 && fx <= x + w + 0.003 && fy >= y - 0.004 && fy <= y + h + 0.004));
  };
  pagesEl.addEventListener('click', (e) => {
    if (e.target.closest('.paper-float')) return;
    if (window.getSelection()?.isCollapsed === false || pagesEl.classList.contains('is-area') || Date.now() < quietUntil) return;
    const pageEl = e.target.closest('.paper-page');
    const hit = pageEl && hitAt(pageEl, e.clientX, e.clientY);
    if (!hit) {
      closeFloat();
      return;
    }
    if (editable) {
      openEditor(hit);
      setActive(hit.id);
      return;
    }
    showComment(hit.id); // (in the side panel only: the page stays)
    floatNote(hit.id);
  });

  side.addEventListener('click', (e) => {
    if (e.target.closest('a.annotation-ref, .annotation-backlinks a, button, textarea, select, input')) return; // below
    const at = e.target.closest('.annotation-at');
    const item = e.target.closest('[data-annotation], li.annotation');
    if (!item || (e.target.closest('a') && !at)) return;
    if (at) e.preventDefault();
    const id = item.dataset.annotation ?? item.id;
    if (at && !editable) history.replaceState(null, '', `#${id}`);
    showInPdf(id);
  });

  /* ---------- Tags: filter the comments (and dim the other highlights) ---------- */

  const tagsOf = (a) => a.tags ?? [];
  /** The bar of the tags in use, under the comments' header. */
  function renderTagbar() {
    side.querySelector('.paper-tagbar')?.remove();
    const counts = new Map();
    for (const a of list) for (const t of tagsOf(a)) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (filterTag && !counts.has(filterTag)) filterTag = '';
    if (counts.size) {
      const bar = document.createElement('div');
      bar.className = 'paper-tagbar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Show the comments with a tag');
      bar.innerHTML = `<button type="button" class="annotation-tag" data-tag="">All</button>${[...counts]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([t, n]) => `<button type="button" class="annotation-tag" data-tag="${esc(t)}">#${esc(t)}<span class="n">${n}</span></button>`).join('')}`;
      side.querySelector('.paper-comments-head')?.after(bar);
    }
    applyFilter();
  }
  function applyFilter() {
    const shown = (a) => !filterTag || tagsOf(a).includes(filterTag);
    for (const a of list) {
      const li = commentOf(a.id);
      if (li) li.hidden = !shown(a);
    }
    for (const r of viewer.querySelectorAll('.paper-hl[data-id]')) {
      const a = byId(r.dataset.id);
      r.classList.toggle('is-dim', Boolean(a) && !shown(a));
    }
    for (const b of side.querySelectorAll('.paper-tagbar [data-tag]')) b.setAttribute('aria-pressed', String(b.dataset.tag === filterTag));
    const all = side.querySelector('.paper-all');
    if (all) all.href = all.getAttribute('href').split('#')[0] + (filterTag ? `#tag=${encodeURIComponent(filterTag)}` : '');
  }
  side.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tag]');
    if (!b) return;
    // A tag on a card shows the comments with it; again, all of them.
    filterTag = b.closest('.annotation') && filterTag === b.dataset.tag ? '' : b.dataset.tag;
    applyFilter();
    side.querySelector('.paper-tagbar')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // Reference chips: in the notes (the page) or in a comment.
  const scope = editable ? el : document;
  const onRefClick = (e) => {
    const link = e.target.closest?.('a[href^="#"]');
    if (!link || !scope.contains(link)) return;
    const id = link.getAttribute('href').slice(1);
    if (id === 'paper-notes' && editable) return e.preventDefault();
    if (!byId(id)) return;
    e.preventDefault();
    if (!editable) history.pushState(null, '', `#${id}`);
    jumpTo(id);
  };
  document.addEventListener('click', onRefClick);
  if (editable) {
    // Other links in a comment would leave the editor.
    side.addEventListener('click', (e) => {
      if (e.target.closest('.annotation-comment a:not([href^="#"])')) e.preventDefault();
    });
  }

  // Hovering a chip peeks at its comment (with a mouse).
  let peekTimer;
  const onOver = (e) => {
    const link = e.target.closest?.('a.annotation-ref[data-ref]');
    if (!link || !scope.contains(link) || !byId(link.dataset.ref) || !window.matchMedia('(hover: hover)').matches) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => peek(link.dataset.ref, link.getBoundingClientRect()), 300);
  };
  const onOut = (e) => {
    if (!e.target.closest?.('a.annotation-ref')) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => { if (!peekEl.matches(':hover')) closePeek(); }, 200);
  };
  document.addEventListener('pointerover', onOver);
  document.addEventListener('pointerout', onOut);
  peekEl.addEventListener('pointerleave', () => { if (peekFor && window.matchMedia('(hover: hover)').matches) closePeek(); });

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    closePeek();
    closeFloat();
    if (editable) {
      closeSelbar();
      stopMoveKey();
    }
  };
  const onDown = (e) => {
    if (!peekEl.hidden && !peekEl.contains(e.target)) closePeek();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown);
  pagesEl.addEventListener('scroll', closePeek, { passive: true });

  /** A copy-link button on each published comment: its address, to share. */
  if (!editable) {
    for (const a of list) {
      const tools = document.createElement('span');
      tools.className = 'annotation-tools';
      tools.innerHTML = `<button type="button" data-act="copy" title="Copy the link to this highlight" aria-label="Copy link">${ICON.link}</button>`;
      a.li.querySelector('.annotation-at')?.after(tools);
    }
    side.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act="copy"]');
      if (!b) return;
      const id = b.closest('li.annotation').id;
      await navigator.clipboard?.writeText(new URL(`#${id}`, location.href).href).catch(() => {});
      b.classList.add('is-done');
      setTimeout(() => b.classList.remove('is-done'), 1200);
    });
  }

  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (/^a-[a-z0-9]{4,16}$/.test(id) && byId(id)) {
      showInPdf(id);
      showComment(id);
    }
  };
  if (!editable) {
    renderTagbar();
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  /* ---------- Editing (the admin) ---------- */

  let closeSelbar = () => {};
  let stopMoveKey = () => {};
  let openEditor = () => {};
  let renderSide = () => {};

  if (editable) {
    const style = lastStyle();
    const changed = () => opts.onChange?.(list.map(({ li, ...a }) => a));
    const swatches = (current, act) => COLORS.map((c) => `<button type="button" class="swatch hl-${c}" data-${act}="${c}" title="${capital(c)}" aria-label="${capital(c)}" aria-pressed="${c === current}"></button>`).join('');
    const shapes = (current) => SHAPES.map((s) => `<button type="button" class="shape-btn" data-shape="${s}" title="${SHAPE_NAMES[s]}" aria-label="${SHAPE_NAMES[s]}" aria-pressed="${s === current}"><span class="shape-icon shape-${s}">Ab</span></button>`).join('');
    const setPressed = (root, attr, value) => {
      for (const b of root.querySelectorAll(`[data-${attr}]`)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
    };
    const tint = (root, color) => { root.dataset.color = color; };

    function add(a) {
      list = sortAnnotations([...list, a]);
      changed();
      renderSide();
      drawHighlights();
    }
    const fresh = (page, rects, quote, s = style) => ({
      id: newAnnotationId(), page, rects, quote, comment: '', color: s.color,
      ...(s.shape !== SHAPES[0] ? { shape: s.shape } : {}), at: new Date().toISOString().slice(0, 10),
    });

    /* The bar over a selection: a colour makes the highlight at once, in
       the chosen shape; "Comment" opens the editor. */
    const selbar = popup('paper-selbar');
    selbar.setAttribute('role', 'toolbar');
    selbar.setAttribute('aria-label', 'Highlight the selection');
    selbar.innerHTML = `<div class="pop-row pop-new">${shapes(style.shape)}<span class="pop-sep"></span>${swatches(style.color, 'color')}<span class="pop-sep"></span>
      <button type="button" class="pop-btn" data-act="comment">${ICON.comment}<span>Comment</span></button></div>
      <div class="pop-row pop-move"><button type="button" class="pop-btn pop-primary" data-act="move-here">Move the highlight here</button></div>`;
    tint(selbar, style.color);
    let pending = null;
    const pageOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.paper-page');

    function selectionHighlight() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      const pageEl = pageOf(range.startContainer);
      if (!pageEl || !pagesEl.contains(pageEl)) return null;
      const box = pageEl.getBoundingClientRect();
      const rects = [];
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < box.top || r.top > box.bottom) continue; // other pages
        const x = (Math.max(r.left, box.left) - box.left) / box.width;
        const y = (Math.max(r.top, box.top) - box.top) / box.height;
        const w = (Math.min(r.right, box.right) - Math.max(r.left, box.left)) / box.width;
        const h = (Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) / box.height;
        // Spans on one line come as several rects: join them.
        const same = rects.find((q) => Math.abs(q[1] - y) < h * 0.5 && x <= q[0] + q[2] + 0.01);
        if (same) {
          const right = Math.max(same[0] + same[2], x + w);
          same[0] = Math.min(same[0], x);
          same[2] = right - same[0];
          same[3] = Math.max(same[3], h);
        } else rects.push([x, y, w, h]);
      }
      if (!rects.length) return null;
      const quote = sel.toString().replace(/\s+/g, ' ').trim();
      return { page: Number(pageEl.dataset.page), rects, quote, at: range.getBoundingClientRect() };
    }

    closeSelbar = () => {
      selbar.hidden = true;
      pending = null;
    };
    const placeSelbar = () => {
      if (!editorEl.hidden) return;
      pending = selectionHighlight();
      if (!pending) return closeSelbar();
      place(selbar, pending.at);
    };
    pagesEl.addEventListener('pointerup', () => setTimeout(placeSelbar, 0));
    pagesEl.addEventListener('keyup', placeSelbar);
    let selTimer;
    // Touch screens adjust a selection with handles, without a pointerup here.
    const onSelection = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (sel?.rangeCount && pagesEl.contains(sel.anchorNode)) placeSelbar();
        else if (!selbar.hidden && (!sel || sel.isCollapsed)) closeSelbar();
      }, 250);
    };
    document.addEventListener('selectionchange', onSelection);
    pagesEl.addEventListener('scroll', closeSelbar, { passive: true });
    selbar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
    selbar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !pending) return;
      if (b.dataset.shape) {
        style.shape = b.dataset.shape;
        keepStyle(style);
        setPressed(selbar, 'shape', style.shape);
        return;
      }
      const sel = pending;
      if (b.dataset.act === 'move-here') {
        window.getSelection()?.removeAllRanges();
        closeSelbar();
        moveTo(sel.page, sel.rects, sel.quote);
        return;
      }
      if (b.dataset.color) {
        style.color = b.dataset.color;
        keepStyle(style);
        setPressed(selbar, 'color', style.color);
        tint(selbar, style.color);
      }
      const a = fresh(sel.page, sel.rects, sel.quote);
      window.getSelection()?.removeAllRanges();
      closeSelbar();
      add(a);
      setActive(a.id);
      if (b.dataset.act === 'comment') openEditor(a, { isNew: true, rect: sel.at });
      else showComment(a.id);
    });

    /* The Area tool: draw a box around a figure, a table or a formula. */
    const areaBtn = viewer.querySelector('.paper-area-btn');
    const setArea = (on) => {
      pagesEl.classList.toggle('is-area', on);
      areaBtn.setAttribute('aria-pressed', String(on));
    };
    areaBtn.addEventListener('click', () => setArea(!pagesEl.classList.contains('is-area')));
    let drag = null;
    pagesEl.addEventListener('pointerdown', (e) => {
      if (!pagesEl.classList.contains('is-area') || e.button > 0) return;
      const pageEl = e.target.closest('.paper-page');
      if (!pageEl) return;
      e.preventDefault();
      const box = pageEl.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.className = `paper-hl paper-drawing hl-${style.color} shape-box`;
      pageEl.querySelector('.paper-highlights').append(ghost);
      drag = { pageEl, box, x0: e.clientX, y0: e.clientY, ghost, rect: [0, 0, 0, 0] };
      pagesEl.setPointerCapture(e.pointerId);
    });
    pagesEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { box, x0, y0 } = drag;
      const cx = (v) => Math.min(Math.max(v, box.left), box.right);
      const cy = (v) => Math.min(Math.max(v, box.top), box.bottom);
      const l = Math.min(cx(x0), cx(e.clientX));
      const t = Math.min(cy(y0), cy(e.clientY));
      const r = [(l - box.left) / box.width, (t - box.top) / box.height,
        Math.abs(cx(e.clientX) - cx(x0)) / box.width, Math.abs(cy(e.clientY) - cy(y0)) / box.height];
      drag.rect = r;
      Object.assign(drag.ghost.style, { left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` });
    });
    const endDrag = () => {
      if (!drag) return;
      const { pageEl, rect, ghost } = drag;
      drag = null;
      ghost.remove();
      quietUntil = Date.now() + 400;
      if (rect[2] < 0.01 || rect[3] < 0.005) return;
      setArea(false);
      if (moving) {
        moveTo(Number(pageEl.dataset.page), [rect], textIn(pageEl, rect));
        return;
      }
      const a = fresh(Number(pageEl.dataset.page), [rect], textIn(pageEl, rect), { color: style.color, shape: 'box' });
      add(a);
      setActive(a.id);
      const b = pageEl.getBoundingClientRect();
      openEditor(a, { isNew: true, rect: { left: b.left + rect[0] * b.width, right: b.left + (rect[0] + rect[2]) * b.width, top: b.top + rect[1] * b.height, bottom: b.top + (rect[1] + rect[3]) * b.height } });
    };
    pagesEl.addEventListener('pointerup', endDrag);
    pagesEl.addEventListener('pointercancel', endDrag);

    /** The PDF's text inside a box of a page (for an area's quote). */
    function textIn(pageEl, [x, y, w, h]) {
      const box = pageEl.getBoundingClientRect();
      const words = [];
      for (const span of pageEl.querySelectorAll('.textLayer span')) {
        if (span.children.length) continue;
        const r = span.getBoundingClientRect();
        const cx = (r.left + r.width / 2 - box.left) / box.width;
        const cy = (r.top + r.height / 2 - box.top) / box.height;
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) words.push(span.textContent);
      }
      const text = words.join(' ').replace(/\s+/g, ' ').trim();
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    }

    /* Moving a highlight that sits in the wrong place (a selection that
       came out misaligned): select the right text, or draw a box. */
    let moving = null;
    const movingBar = document.createElement('div');
    movingBar.className = 'paper-moving';
    movingBar.hidden = true;
    viewer.querySelector('.paper-toolbar').after(movingBar);
    function startMove(a) {
      moving = a;
      movingBar.innerHTML = `<span>Select the right text in the PDF for <b>${esc(annotationLabel(a, 40))}</b>, or draw a box with ${ICON.area}Area.</span>
        <button type="button" class="pop-btn" data-act="stop-move">Cancel</button>`;
      movingBar.hidden = false;
      selbar.classList.add('is-moving');
      showInPdf(a.id);
    }
    function stopMove() {
      const a = moving;
      moving = null;
      movingBar.hidden = true;
      selbar.classList.remove('is-moving');
      return a;
    }
    function moveTo(page, rects, quote) {
      const a = stopMove();
      if (!a) return;
      Object.assign(a, { page, rects, quote: quote || a.quote });
      list = sortAnnotations(list);
      changed();
      renderSide();
      drawHighlights();
      setActive(a.id);
      openEditor(a);
    }
    stopMoveKey = () => {
      const a = stopMove();
      if (a) openEditor(a);
    };
    movingBar.addEventListener('click', (e) => {
      if (!e.target.closest('[data-act="stop-move"]')) return;
      const a = stopMove();
      if (a) openEditor(a);
    });

    /* The comment editor: a pop-up by the highlight (a sheet on a phone). */
    const editorEl = popup('paper-editor');
    editorEl.setAttribute('role', 'dialog');
    editorEl.setAttribute('aria-label', 'Comment');
    let editing = null; // { a, before, isNew }
    const listId = `paper-tags-${Math.random().toString(36).slice(2, 8)}`;
    /** The pop-up's fields into the annotation. */
    function readFields(a) {
      const v = (k) => editorEl.querySelector(`[data-field="${k}"]`).value;
      const title = v('title').trim();
      if (title) a.title = title.slice(0, 120);
      else delete a.title;
      a.quote = v('quote').replace(/\s+/g, ' ').trim();
      a.comment = v('comment');
      const tags = cleanTags(v('tags'));
      if (tags.length) a.tags = tags;
      else delete a.tags;
    }

    openEditor = (a, { isNew = false, rect } = {}) => {
      if (editing) saveEditor();
      closeSelbar();
      closePeek();
      editing = { a, isNew, before: { title: a.title, quote: a.quote, comment: a.comment, tags: a.tags, color: a.color, shape: a.shape } };
      const others = list.filter((x) => x.id !== a.id);
      const known = [...new Set([...list.flatMap(tagsOf), ...(opts.knownTags?.() ?? [])])].sort();
      editorEl.innerHTML = `<input class="pop-title" data-field="title" maxlength="120" aria-label="Short name"
          placeholder="${esc(annotationLabel({ ...a, title: '' }, 60))}" value="${esc(a.title ?? '')}">
        <label class="pop-quote-edit" title="The text quoted from the PDF (page ${a.page}): correct it if the selection came out wrong">
          <textarea data-field="quote" rows="2" aria-label="Quote" placeholder="Quote from the PDF">${esc(a.quote)}</textarea></label>
        <textarea data-field="comment" rows="4" placeholder="Write a comment… (Markdown)" aria-label="Comment">${esc(a.comment)}</textarea>
        <input class="pop-tags" data-field="tags" list="${listId}" autocapitalize="off" spellcheck="false" aria-label="Tags"
          placeholder="Tags, e.g. definition, method" value="${esc(tagsOf(a).join(', '))}">
        <datalist id="${listId}">${known.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
        <div class="pop-row">${shapes(shapeOf(a))}<span class="pop-sep"></span>${swatches(colorOf(a), 'color')}</div>
        <div class="pop-foot">
          ${others.length ? `<select data-act="ref" aria-label="Link to another highlight"><option value="">Link a highlight…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(annotationLabel(o, 40))}</option>`).join('')}</select>` : ''}
          <button type="button" class="pop-icon" data-act="move" title="Move the highlight: select the right text in the PDF" aria-label="Move">${ICON.area}</button>
          <button type="button" class="pop-icon" data-act="link" title="Copy a cross-reference to paste in other notes" aria-label="Copy link">${ICON.link}</button>
          <button type="button" class="pop-icon pop-danger" data-act="delete" title="Delete the highlight" aria-label="Delete">${ICON.trash}</button>
          <span class="pop-spacer"></span>
          <button type="button" class="pop-btn" data-act="cancel">Cancel</button>
          <button type="button" class="pop-btn pop-primary" data-act="save" title="Save (Ctrl+Enter)">Save</button>
        </div>`;
      tint(editorEl, colorOf(a));
      const hl = viewer.querySelector(`.paper-hl[data-id="${CSS.escape(a.id)}"]`);
      place(editorEl, rect ?? hl?.getBoundingClientRect() ?? commentOf(a.id)?.getBoundingClientRect() ?? viewer.getBoundingClientRect());
      const ta = editorEl.querySelector('[data-field="comment"]');
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };

    function closeEditor() {
      editing = null;
      editorEl.hidden = true;
    }
    function saveEditor() {
      if (!editing) return;
      const { a } = editing;
      readFields(a);
      closeEditor();
      changed();
      renderSide();
      drawHighlights();
    }
    function cancelEditor() {
      if (!editing) return;
      const { a, before, isNew } = editing;
      closeEditor();
      if (isNew) { // not wanted after all
        list = list.filter((x) => x !== a);
        changed();
      }
      Object.assign(a, before);
      for (const k of ['title', 'tags', 'shape']) if (a[k] === undefined) delete a[k];
      drawHighlights();
      renderSide();
    }
    async function deleteAnnotation(a) {
      if (opts.confirmDelete && !(await opts.confirmDelete(a))) return false;
      list = list.filter((x) => x !== a);
      changed();
      renderSide();
      drawHighlights();
      return true;
    }
    async function copyLink(a, b) {
      const link = opts.linkFor ? opts.linkFor(a.id, a) : `[[#${a.id}]]`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      b.classList.add('is-done');
      b.title = 'Copied';
      setTimeout(() => b.classList.remove('is-done'), 1200);
    }

    editorEl.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || !editing) return;
      const { a } = editing;
      if (b.dataset.color || b.dataset.shape) {
        if (b.dataset.color) a.color = b.dataset.color;
        if (b.dataset.shape) {
          if (b.dataset.shape === SHAPES[0]) delete a.shape;
          else a.shape = b.dataset.shape;
        }
        style.color = colorOf(a);
        if (a.rects.length !== 1 || shapeOf(a) !== 'box') style.shape = shapeOf(a);
        keepStyle(style);
        setPressed(editorEl, 'color', colorOf(a));
        setPressed(editorEl, 'shape', shapeOf(a));
        tint(editorEl, colorOf(a));
        drawHighlights();
      } else if (b.dataset.act === 'save') saveEditor();
      else if (b.dataset.act === 'cancel') cancelEditor();
      else if (b.dataset.act === 'link') copyLink(a, b);
      else if (b.dataset.act === 'move') {
        readFields(a);
        closeEditor();
        changed();
        renderSide();
        startMove(a);
      } else if (b.dataset.act === 'delete') {
        editorEl.hidden = true; // out of the way of the confirmation
        if (await deleteAnnotation(a)) closeEditor();
        else editorEl.hidden = false;
      }
    });
    editorEl.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'ref' || !e.target.value) return;
      const ta = editorEl.querySelector('[data-field="comment"]');
      const ref = `[[#${e.target.value}]]`;
      const at = ta.selectionStart ?? ta.value.length;
      ta.setRangeText((at && !/\s$/.test(ta.value.slice(0, at)) ? ' ' : '') + ref, at, ta.selectionEnd ?? at, 'end');
      e.target.value = '';
      ta.focus();
    });
    editorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.matches('input'))) {
        e.preventDefault();
        saveEditor();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelEditor();
      }
    });
    // A click elsewhere keeps what was written (as Notion does).
    const onDownEdit = (e) => {
      if (editing && !editorEl.contains(e.target) && !e.target.closest?.('dialog')) saveEditor();
    };
    document.addEventListener('pointerdown', onDownEdit, true);

    /* The comments beside the PDF: cards, with tools on hover. */
    renderSide = () => {
      const back = backlinks(list, opts.notes?.() ?? '');
      side.innerHTML = `<div class="paper-comments-head"><span>Comments</span><span class="count">${list.length}</span></div>
        ${list.length ? '' : `<p class="muted paper-hint">Select text in the PDF to highlight it, or draw a box with ${ICON.area}<b>Area</b>.</p>`}
        <ol class="annotations">${list.map((a) => `<li class="annotation${namedByQuote(a) ? ' is-quote-label' : ''}" data-annotation="${esc(a.id)}" data-color="${colorOf(a)}" data-shape="${shapeOf(a)}">
          <a class="annotation-at" href="#${esc(a.id)}" title="Page ${a.page}">${mathText(annotationLabel(a, 60))}</a>
          <span class="annotation-tools">
            <button type="button" data-act="edit" title="Edit the comment" aria-label="Edit">${ICON.edit}</button>
            <button type="button" data-act="link" title="Copy a cross-reference to paste in other notes" aria-label="Copy link">${ICON.link}</button>
            <button type="button" data-act="delete" title="Delete" aria-label="Delete">${ICON.trash}</button>
          </span>
          ${tagsHtml(a.tags)}${a.quote ? `<blockquote class="annotation-quote">${esc(a.quote)}</blockquote>` : ''}
          ${a.comment.trim() ? `<div class="annotation-comment">${commentHtml(a)}</div>` : '<button type="button" class="annotation-add" data-act="edit">Add a comment…</button>'}
          ${backlinksHtml(back.get(a.id) ?? [], list)}
        </li>`).join('')}</ol>`;
      if (activeId) commentOf(activeId)?.classList.add('is-active');
      renderTagbar();
      opts.typeset?.(side);
    };
    side.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      const li = b?.closest('[data-annotation]');
      const a = li && byId(li.dataset.annotation);
      if (!a) return;
      if (b.dataset.act === 'edit') {
        setActive(a.id);
        showInPdf(a.id);
        openEditor(a, { rect: li.getBoundingClientRect() });
      } else if (b.dataset.act === 'delete') deleteAnnotation(a);
      else if (b.dataset.act === 'link') copyLink(a, b);
    });
    side.addEventListener('dblclick', (e) => {
      const li = e.target.closest('[data-annotation]');
      const a = li && byId(li.dataset.annotation);
      if (a && !e.target.closest('a, button')) openEditor(a, { rect: li.getBoundingClientRect() });
    });
    renderSide();

    cleanups.push(() => {
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('pointerdown', onDownEdit, true);
    });
  }

  layout();
  return {
    /** Replace the annotations (the editor reloaded the post). */
    setAnnotations(next) {
      list = sortAnnotations(next);
      drawHighlights();
      renderSide();
    },
    /** Show highlight `id`: the PDF at it, its comment. */
    show(id) {
      if (!byId(id)) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showInPdf(id);
      showComment(id);
      return true;
    },
    /** Redraw the comments (the notes changed: "Referenced in"). */
    refresh() {
      renderSide();
    },
    destroy() {
      seen.disconnect();
      doc.destroy();
      document.removeEventListener('click', onRefClick);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      for (const f of cleanups) f();
      for (const n of el.querySelectorAll(':scope > .paper-pop')) n.remove();
    },
  };
}
