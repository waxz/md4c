// The PDF of a paper-notes post (js/paper.js), drawn with pdf.js, with its
// highlights on the pages and their comments beside it, linked both ways:
// a highlight scrolls its comment into view, a comment scrolls the PDF to
// its highlight, and an address ending in #a-… (also from another post:
// [[that-paper#a-…]]) opens at that highlight.
//
//   mountPaper(el, opts)   el = the .paper element of the article
//     opts.pdfUrl          the PDF's address (default: data-pdf, next to the page)
//     opts.editable        the admin: select text, then "Highlight" makes an
//                          annotation; comments are edited in the side panel
//     opts.annotations     (editable) the annotations; else read from the page
//     opts.onChange(list)  (editable) after any change
//     opts.renderComment(md)   (editable) a comment's preview HTML
//     opts.linkFor(id, a)  (editable) the cross-reference to copy, e.g. [[slug#a-…]]
//
// pdf.js is self-hosted under vendor/pdfjs/ (the pages' CSP allows only the
// blog's own scripts), loaded on first use, with eval off.

import { COLORS, newAnnotationId, sortAnnotations } from './lib/paper.js';

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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The annotations of a published page, from its comment list. */
function readAnnotations(el) {
  return [...el.querySelectorAll('li.annotation')].map((li) => {
    let rects = [];
    try {
      rects = JSON.parse(li.dataset.rects || '[]');
    } catch {}
    return { id: li.id, page: Number(li.dataset.page), rects, color: li.dataset.color, li };
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
      <a class="paper-download" href="${esc(pdfUrl)}" target="_blank" rel="noopener">PDF ↗</a>
    </div>
    <div class="paper-pages" tabindex="0" aria-label="PDF pages"><p class="paper-loading muted">Loading the PDF…</p></div>
    ${editable ? '<button type="button" class="paper-highlight-btn" hidden>Highlight</button>' : ''}`;
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
          r.className = `paper-hl hl-${COLORS.includes(a.color) ? a.color : 'yellow'}`;
          r.dataset.id = a.id;
          r.style.left = `${x * 100}%`;
          r.style.top = `${y * 100}%`;
          r.style.width = `${w * 100}%`;
          r.style.height = `${h * 100}%`;
          r.title = 'Show the comment';
          layer.append(r);
        }
      }
    }
  }

  const flash = (node) => node?.animate?.([{ outline: '3px solid var(--accent, #8b1e2d)' }, { outline: '3px solid transparent' }], { duration: 1400 });
  const commentOf = (id) => side.querySelector(`[data-annotation="${CSS.escape(id)}"], li#${CSS.escape(id)}`);

  /** Scroll the PDF to annotation `id` and flash it. */
  function showInPdf(id) {
    const a = list.find((x) => x.id === id);
    const p = a && pages[a.page - 1];
    if (!p) return;
    const top = p.el.offsetTop + (a.rects[0]?.[1] ?? 0) * p.el.offsetHeight - pagesEl.clientHeight / 3;
    pagesEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    render(p).then(() => {
      for (const r of p.el.querySelectorAll(`.paper-hl[data-id="${CSS.escape(id)}"]`)) flash(r);
    });
    setActive(id);
  }

  /** Scroll the side panel to the comment of `id`. */
  function showComment(id) {
    const c = commentOf(id);
    if (!c) return;
    c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    flash(c);
    setActive(id);
  }

  function setActive(id) {
    for (const c of side.querySelectorAll('.is-active')) c.classList.remove('is-active');
    for (const r of viewer.querySelectorAll('.paper-hl.is-active')) r.classList.remove('is-active');
    commentOf(id)?.classList.add('is-active');
    for (const r of viewer.querySelectorAll(`.paper-hl[data-id="${CSS.escape(id)}"]`)) r.classList.add('is-active');
  }

  // Highlights lie under the text (so it can still be selected): a click
  // that selects nothing finds the highlight under it by position.
  pagesEl.addEventListener('click', (e) => {
    if (window.getSelection()?.isCollapsed === false) return;
    const pageEl = e.target.closest('.paper-page');
    if (!pageEl) return;
    const box = pageEl.getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width;
    const fy = (e.clientY - box.top) / box.height;
    const hit = list.find((a) => a.page === Number(pageEl.dataset.page)
      && a.rects.some(([x, y, w, h]) => fx >= x && fx <= x + w && fy >= y - 0.003 && fy <= y + h + 0.003));
    if (hit) showComment(hit.id);
  });
  side.addEventListener('click', (e) => {
    const at = e.target.closest('.annotation-at');
    const item = e.target.closest('[data-annotation], li.annotation');
    if (!item || (e.target.closest('a, button, textarea, select, input') && !at)) return;
    if (at) e.preventDefault();
    const id = item.dataset.annotation ?? item.id;
    if (at && !editable) history.replaceState(null, '', `#${id}`);
    showInPdf(id);
  });

  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (/^a-[a-z0-9]{4,16}$/.test(id) && list.some((a) => a.id === id)) {
      showInPdf(id);
      showComment(id);
    }
  };
  if (!editable) {
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  /* ---------- Editing (the admin) ---------- */

  if (editable) {
    const btn = viewer.querySelector('.paper-highlight-btn');
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

    const placeButton = () => {
      pending = selectionHighlight();
      if (!pending) {
        btn.hidden = true;
        return;
      }
      const v = viewer.getBoundingClientRect();
      btn.style.left = `${Math.min(v.width - 110, Math.max(0, pending.at.left - v.left))}px`;
      btn.style.top = `${Math.max(0, pending.at.bottom - v.top + 6)}px`;
      btn.hidden = false;
    };
    pagesEl.addEventListener('pointerup', () => setTimeout(placeButton, 0));
    pagesEl.addEventListener('keyup', placeButton);
    pagesEl.addEventListener('scroll', () => { btn.hidden = true; }, { passive: true });
    btn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
    btn.addEventListener('click', () => {
      if (!pending) return;
      const a = {
        id: newAnnotationId(), page: pending.page, rects: pending.rects, quote: pending.quote,
        comment: '', color: COLORS[0], at: new Date().toISOString().slice(0, 10),
      };
      list = sortAnnotations([...list, a]);
      window.getSelection()?.removeAllRanges();
      btn.hidden = true;
      pending = null;
      changed();
      renderSide();
      drawHighlights();
      const ta = side.querySelector(`[data-annotation="${a.id}"] textarea`);
      ta?.focus();
      showComment(a.id);
    });

    const changed = () => opts.onChange?.(list.map(({ li, ...a }) => a));

    function renderSide() {
      side.innerHTML = `<h2 class="sc">Comments <span class="count">${list.length}</span></h2>
        ${list.length ? '' : '<p class="muted">Select text in the PDF, then click <b>Highlight</b>.</p>'}
        <ol class="annotations">${list.map((a) => `<li class="annotation" data-annotation="${esc(a.id)}">
          <div class="annotation-head">
            <a class="annotation-at sc" href="#${esc(a.id)}">p.&nbsp;${a.page}</a>
            <select aria-label="Colour" data-act="color">${COLORS.map((c) => `<option value="${c}"${c === a.color ? ' selected' : ''}>${c}</option>`).join('')}</select>
            <button type="button" class="btn btn-small" data-act="link" title="Copy a link to this highlight, to paste in other notes">Copy link</button>
            <button type="button" class="btn btn-small btn-danger-text" data-act="delete">Delete</button>
          </div>
          ${a.quote ? `<blockquote class="annotation-quote">${esc(a.quote)}</blockquote>` : ''}
          <textarea rows="3" placeholder="Comment (Markdown; [[other-paper#a-…]] links to another highlight)" aria-label="Comment">${esc(a.comment)}</textarea>
          <div class="annotation-comment"></div>
        </li>`).join('')}</ol>`;
      for (const li of side.querySelectorAll('[data-annotation]')) {
        const a = list.find((x) => x.id === li.dataset.annotation);
        li.querySelector('.annotation-comment').innerHTML = a.comment.trim() && opts.renderComment ? opts.renderComment(a.comment) : '';
      }
    }

    side.addEventListener('input', (e) => {
      const li = e.target.closest('[data-annotation]');
      const a = li && list.find((x) => x.id === li.dataset.annotation);
      if (!a || e.target.tagName !== 'TEXTAREA') return;
      a.comment = e.target.value;
      li.querySelector('.annotation-comment').innerHTML = a.comment.trim() && opts.renderComment ? opts.renderComment(a.comment) : '';
      changed();
    });
    side.addEventListener('change', (e) => {
      const li = e.target.closest('[data-annotation]');
      const a = li && list.find((x) => x.id === li.dataset.annotation);
      if (!a || e.target.dataset.act !== 'color') return;
      a.color = e.target.value;
      drawHighlights();
      changed();
    });
    side.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      const li = b?.closest('[data-annotation]');
      const a = li && list.find((x) => x.id === li.dataset.annotation);
      if (!a) return;
      if (b.dataset.act === 'delete') {
        if (opts.confirmDelete && !(await opts.confirmDelete(a))) return;
        list = list.filter((x) => x !== a);
        changed();
        renderSide();
        drawHighlights();
      } else if (b.dataset.act === 'link') {
        const link = opts.linkFor ? opts.linkFor(a.id, a) : `[[#${a.id}]]`;
        await navigator.clipboard?.writeText(link).catch(() => {});
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
      }
    });
    renderSide();
  }

  layout();
  return {
    /** Replace the annotations (the editor reloaded the post). */
    setAnnotations(next) {
      list = sortAnnotations(next);
      drawHighlights();
    },
    destroy() {
      seen.disconnect();
      doc.destroy();
    },
  };
}
