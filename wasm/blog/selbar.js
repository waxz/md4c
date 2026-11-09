// The bar by a selection while reading, the same for a paper's PDF and an
// article: Look up · Read · Copy. (The editor's annotator has its own bar,
// with the highlights, and the same three in it.)
//
//   Look up   the dictionary, translation, flash cards (lookup.js)
//   Read      reads aloud from the selected sentence on (tts.js)
//   Copy      copies the selected text
//
// readerSelectionBar({ area, popup, place, contextOf, onLookup, onRead,
// isOwnScroll }) shows it for a selection inside `area`. pagePopups()
// gives popup and place for a page without a PDF viewer (an article).

export const ICONS = {
  book: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5c2-1 4-1 5.5.5v9c-1.5-1.5-3.5-1.5-5.5-.5zM13.5 3.5c-2-1-4-1-5.5.5v9c1.5-1.5 3.5-1.5 5.5-.5z"/></svg>',
  speak: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-1v-8h8v1"/></svg>',
};

/** The buttons, as every selection bar shows them (labels hidden when docked on a phone). */
export const SELECTION_BUTTONS = {
  lookup: `<button type="button" class="pop-btn" data-act="lookup" title="Look it up: meaning, pronunciation, translation">${ICONS.book}<span>Look up</span></button>`,
  read: `<button type="button" class="pop-btn" data-act="read" title="Read aloud from here on">${ICONS.speak}<span>Read</span></button>`,
  copy: `<button type="button" class="pop-btn" data-act="copy" title="Copy">${ICONS.copy}<span>Copy</span></button>`,
};

export function readerSelectionBar({ area, ignore = null, popup, place, contextOf = () => ({}), onLookup, onRead, isOwnScroll = () => false }) {
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const bar = popup('paper-selbar');
  bar.classList.add('paper-readbar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'The selected text');
  bar.innerHTML = `<div class="pop-row">${SELECTION_BUTTONS.lookup}${SELECTION_BUTTONS.read}${SELECTION_BUTTONS.copy}</div>`;
  let selected = null;
  let timer;
  let downAt = 0;
  on(document, 'selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sel = window.getSelection();
      const text = String(sel ?? '').trim();
      const inside = sel?.rangeCount && area.contains(sel.anchorNode) && !(ignore && (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)?.closest(ignore));
      if (!text || !inside) {
        if (Date.now() - downAt > 800) bar.hidden = true;
        return;
      }
      const range = sel.getRangeAt(0);
      selected = { text, rect: range.getBoundingClientRect(), range: range.cloneRange(), context: contextOf(range) };
      place(bar, selected.rect);
    }, 250);
  });
  on(bar, 'pointerdown', (e) => {
    e.preventDefault(); // (keep the selection)
    downAt = Date.now();
  });
  on(bar, 'click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !selected) return;
    bar.hidden = true;
    if (b.dataset.act === 'lookup') onLookup(selected.text, selected.rect, selected.context);
    else if (b.dataset.act === 'read') onRead(selected.range, selected.text);
    else await navigator.clipboard?.writeText(selected.text).catch(() => {});
  });
  const onScroll = () => { if (!bar.classList.contains('is-docked') && !isOwnScroll()) bar.hidden = true; };
  on(area, 'scroll', onScroll, { passive: true });
  if (area !== document.scrollingElement) on(window, 'scroll', onScroll, { passive: true });
  return {
    el: bar,
    destroy() {
      for (const f of cleanups) f();
      bar.remove();
    },
  };
}

/**
 * Pop-ups for a page without a PDF viewer: kept in `root` (the body),
 * placed by a rect (below it, else above), and on a touch screen the
 * selection bar docked at the bottom, as in the PDF viewer.
 */
export function pagePopups(root = document.body) {
  const popup = (cls) => {
    const node = document.createElement('div');
    node.className = `paper-pop ${cls}`;
    node.hidden = true;
    root.append(node);
    return node;
  };
  const place = (node, rect) => {
    node.hidden = false;
    const dock = node.classList.contains('paper-selbar') && window.matchMedia('(pointer: coarse), (max-width: 600px)').matches;
    node.classList.toggle('is-docked', dock);
    if (dock) {
      node.style.left = node.style.top = '';
      return;
    }
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8 && rect.top - h - 8 > 8) top = rect.top - h - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    node.style.top = `${top}px`;
  };
  return { popup, place };
}

/** The sentence a selection is in (for a flash card's context), from its paragraph. */
export function sentenceAround(range) {
  const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  const block = start?.closest?.('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th');
  const text = (block?.textContent ?? '').replace(/\s+/g, ' ');
  const picked = String(range).replace(/\s+/g, ' ').trim();
  const i = text.indexOf(picked.slice(0, 30));
  if (i < 0) return '';
  const stop = Math.max(text.lastIndexOf('. ', i), text.lastIndexOf('? ', i), text.lastIndexOf('! ', i));
  const from = stop < 0 ? 0 : stop + 2;
  const end = text.slice(i + picked.length).search(/[.?!](\s|$)/);
  const to = end < 0 ? text.length : i + picked.length + end + 1;
  return text.slice(from, Math.min(to, from + 400)).trim();
}
