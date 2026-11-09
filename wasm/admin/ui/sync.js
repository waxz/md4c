// The editor's text and its preview, kept together.
//
// The preview is rendered with md4c.wasm's SOURCE_POS flag: every block
// element (paragraph, heading, list item, code block, table cell, ...)
// carries data-src, the byte offset in the Markdown where its text starts.
// From that:
//
//   scroll sync      scrolling either side scrolls the other to the same
//                    place, interpolating between blocks (side by side only)
//   click to locate  clicking a block in the preview selects its lines in
//                    the text (on a phone: switches to Write first) and
//                    flashes the block
//   cursor follow    the block the cursor is in is marked in the preview
//
// The text box stays a plain <textarea>. Its wrapped lines are measured with
// a hidden copy ("mirror") laid out the same way.

const FLASH_MS = 1200;

/** UTF-16 index in `text` of each UTF-8 byte offset in `offsets` (sorted). */
function charIndexes(text, offsets) {
  const out = new Map();
  let byte = 0;
  let k = 0;
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  for (let i = 0; i <= text.length && k < sorted.length; ) {
    while (k < sorted.length && sorted[k] <= byte) out.set(sorted[k++], i);
    if (i === text.length) break;
    const cp = text.codePointAt(i);
    byte += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  while (k < sorted.length) out.set(sorted[k++], text.length);
  return out;
}

const lineStart = (text, i) => text.lastIndexOf('\n', i - 1) + 1;

/**
 * @param {{ textarea: HTMLTextAreaElement, iframe: HTMLIFrameElement,
 *           sideBySide: () => boolean, showWrite: () => void }} opts
 * @returns {{ refresh(): void, destroy(): void }}
 */
export function attachSourceSync({ textarea, iframe, sideBySide, showWrite }) {
  let blocks = []; // { el, start, end } in document order; start/end: indexes in the text
  let pairs = []; // [editorY, previewY], increasing: the scroll map
  let marked = null;
  let driver = null; // which side the reader is scrolling: 'text' | 'preview'
  let driverUntil = 0;
  let mirror = null;

  const doc = () => iframe.contentDocument;
  const win = () => iframe.contentWindow;

  /* ---------- Where each block's text is ---------- */

  function readBlocks() {
    const d = doc();
    const prose = d?.querySelector('.prose');
    if (!prose) return [];
    const els = [...prose.querySelectorAll('[data-src]')];
    const text = textarea.value;
    const idx = charIndexes(text, els.map((el) => Number(el.dataset.src)));
    const list = els.map((el) => {
      let start = lineStart(text, idx.get(Number(el.dataset.src)));
      if (el.tagName === 'PRE' && start > 0) {
        // A fenced code block's text starts below its opening fence.
        const prev = lineStart(text, start - 1);
        if (/^ {0,3}(`{3,}|~{3,})/.test(text.slice(prev, start))) start = prev;
      }
      return { el, start };
    });
    // A block ends where the next block that is not inside it starts.
    for (let i = 0; i < list.length; i++) {
      let end = text.length;
      for (let j = i + 1; j < list.length; j++) {
        if (!list[i].el.contains(list[j].el) && list[j].start > list[i].start) {
          end = list[j].start;
          break;
        }
      }
      list[i].end = text.slice(0, end).replace(/\s+$/, '').length;
    }
    return list;
  }

  /* ---------- The text box's wrapped lines: a hidden mirror ---------- */

  function measureText(indexes) {
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.className = 'textarea-mirror';
      document.body.append(mirror);
    }
    const cs = getComputedStyle(textarea);
    for (const p of ['font', 'letterSpacing', 'wordSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom',
      'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'lineHeight']) {
      mirror.style[p] = cs[p];
    }
    mirror.style.width = `${textarea.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
    const text = textarea.value;
    const marks = [...new Set(indexes)].sort((a, b) => a - b);
    mirror.replaceChildren();
    let at = 0;
    const spans = new Map();
    for (const i of marks) {
      mirror.append(text.slice(at, i));
      const span = document.createElement('span');
      mirror.append(span);
      spans.set(i, span);
      at = i;
    }
    mirror.append(text.slice(at), '​');
    const top = mirror.getBoundingClientRect().top;
    return new Map([...spans].map(([i, s]) => [i, s.getBoundingClientRect().top - top]));
  }

  /* ---------- Scroll sync ---------- */

  function buildPairs() {
    pairs = [];
    if (!sideBySide() || !blocks.length) return;
    const d = doc();
    const ys = measureText(blocks.map((b) => b.start));
    const scrollY = win().scrollY;
    let lastE = -1;
    let lastP = -1;
    pairs.push([0, 0]);
    for (const b of blocks) {
      const e = ys.get(b.start);
      const p = b.el.getBoundingClientRect().top + scrollY;
      // Keep the map increasing: nested blocks and same-line blocks add nothing.
      if (e > lastE + 2 && p > lastP + 2) {
        pairs.push([e, p]);
        lastE = e;
        lastP = p;
      }
    }
    const eMax = textarea.scrollHeight - textarea.clientHeight;
    const pMax = d.documentElement.scrollHeight - win().innerHeight;
    pairs.push([Math.max(eMax, lastE + 1), Math.max(pMax, lastP + 1)]);
  }

  function interpolate(y, from, to) {
    if (pairs.length < 2) return null;
    let i = 1;
    while (i < pairs.length - 1 && pairs[i][from] < y) i++;
    const [a, b] = [pairs[i - 1], pairs[i]];
    const span = b[from] - a[from];
    const t = span > 0 ? Math.min(1, Math.max(0, (y - a[from]) / span)) : 0;
    return a[to] + t * (b[to] - a[to]);
  }

  const claim = (side) => {
    driver = side;
    driverUntil = performance.now() + 150;
  };
  const drives = (side) => driver === side || performance.now() > driverUntil;

  function onTextScroll() {
    if (!sideBySide() || !drives('text')) return;
    claim('text');
    // Line up the top of the visible text with the preview.
    const y = interpolate(textarea.scrollTop, 0, 1);
    if (y !== null) win().scrollTo({ top: y, behavior: 'instant' });
  }
  function onPreviewScroll() {
    if (!sideBySide() || !drives('preview')) return;
    claim('preview');
    const y = interpolate(win().scrollY, 1, 0);
    if (y !== null) textarea.scrollTop = y;
  }
  // The side the reader touches drives; the other only follows.
  const takeText = () => claim('text');
  const takePreview = () => claim('preview');

  /* ---------- Cursor follow and click to locate ---------- */

  /** The innermost block whose text holds index `i`. */
  function blockAt(i) {
    let best = null;
    for (const b of blocks) {
      if (b.start <= i && i <= b.end && (!best || best.el.contains(b.el))) best = b;
    }
    return best;
  }

  function mark(block) {
    if (marked?.el === block?.el) return;
    if (marked) {
      marked.el.style.removeProperty('box-shadow');
      marked.el.style.removeProperty('background-color');
    }
    marked = block;
    if (!block) return;
    // CSSOM, not inline markup: the preview's CSP allows it.
    block.el.style.setProperty('box-shadow', '-0.6rem 0 0 -0.35rem var(--accent)');
    block.el.style.setProperty('background-color', 'color-mix(in srgb, var(--accent) 6%, transparent)');
  }

  function followCursor() {
    if (document.activeElement !== textarea) return;
    mark(blockAt(textarea.selectionStart));
  }

  function flash(el) {
    el.animate?.([
      { outline: '2px solid var(--accent)', outlineOffset: '3px', backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
      { outline: '2px solid transparent', outlineOffset: '3px', backgroundColor: 'transparent' },
    ], { duration: FLASH_MS, easing: 'ease-out' });
  }

  /** Scroll the text box so index `i` sits about a third of the way down. */
  function revealText(i) {
    const y = measureText([i]).get(i) ?? 0;
    textarea.scrollTop = Math.max(0, y - textarea.clientHeight / 3);
  }

  function onPreviewClick(e) {
    const sel = win().getSelection();
    if (sel && !sel.isCollapsed) return; // selecting text to copy
    const el = e.target.closest?.('[data-src]');
    if (!el) return;
    const block = blocks.find((b) => b.el === el);
    if (!block) return;
    if (e.target.closest('a[href]')) e.preventDefault();
    flash(el);
    if (!sideBySide()) showWrite();
    claim('text');
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(block.start, block.end);
    revealText(block.start);
    mark(block);
  }

  /* ---------- Wiring ---------- */

  let previewDoc = null;
  function wirePreview() {
    const d = doc();
    if (!d || d === previewDoc) return;
    previewDoc = d;
    d.addEventListener('click', onPreviewClick);
    win().addEventListener('scroll', onPreviewScroll, { passive: true });
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) d.addEventListener(ev, takePreview, { passive: true });
  }

  textarea.addEventListener('scroll', onTextScroll, { passive: true });
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'input']) textarea.addEventListener(ev, takeText, { passive: true });
  for (const ev of ['keyup', 'click', 'select', 'focus']) textarea.addEventListener(ev, followCursor);
  const onResize = () => buildPairs();
  window.addEventListener('resize', onResize);

  return {
    /** After every preview render: re-read the blocks and the scroll map. */
    refresh() {
      wirePreview();
      marked = null;
      blocks = readBlocks();
      buildPairs();
      followCursor();
      // The preview was rebuilt: bring it back in line with the text.
      if (sideBySide() && drives('text')) {
        const y = interpolate(textarea.scrollTop, 0, 1);
        if (y !== null) win().scrollTo({ top: y, behavior: 'instant' });
      }
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      mirror?.remove();
    },
  };
}
