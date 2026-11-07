// Reading a paper aloud (the PDF viewer's 🔊, paper-tools.js): the PDF's
// text, page by page, in sentences, the one read marked on its page and
// kept in view. The speech itself, the voices and the player: tts.js.
//
// Start at the page in view (▶), at a sentence clicked after ⌖, or at a
// selection ("From here"); or read just a selection ("Read").
//
// attachReader(ctx): ctx = { el, viewer, bar, pages, pagesEl, ready(p),
// matchesOnPage(p, query), scrollTo(p, y), referencesStart() }.

import { caretAt, createReader, sentences, speakable } from './tts.js';

export { sentences, speakable };

const fold = (s) => s.replace(/\s+/g, ' ').toLowerCase();

export function attachReader(ctx) {
  const { el, viewer, bar, pages, pagesEl, ready, matchesOnPage, scrollTo, referencesStart } = ctx;

  /* ---------- The text, in units to say ---------- */

  let units = null; // [{ page, start, end, text, say }] in reading order
  let referencesAt = null; // the index of the first unit of the references, if found
  async function textUnits() {
    if (units) return units;
    const list = [];
    for (const pg of pages) {
      const c = await pg.page.getTextContent();
      const text = c.items.map((i) => (i.str ?? '') + (i.hasEOL ? ' ' : '')).join('').replace(/\s+/g, ' ');
      pg.readText = text;
      for (const found of sentences(text, document.documentElement.lang || 'en')) {
        let s = found;
        // The authors' block (names and addresses) runs into what follows
        // it: only the text after the last address is read.
        const emails = [...s.text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)];
        if (emails.length >= 2) {
          const last = emails.at(-1);
          const rest = s.text.slice(last.index + last[0].length).replace(/^[\s∗*†‡§¶,;]+/, '').replace(/^Abstract\s+/i, '');
          const start = s.end - rest.length;
          s = { start, end: s.end, text: rest };
        }
        const say = speakable(s.text);
        // Page numbers, running heads, a margin stamp: not read.
        const letters = (say.match(/\p{L}/gu) ?? []).length;
        if (letters < 3 || letters / say.length < 0.5 || /^arXiv:\S+\s*\[[\w.-]+\]/.test(say)) continue;
        list.push({ page: pg.n, start: s.start, end: s.end, text: s.text, say });
      }
    }
    const head = await referencesStart().catch(() => null);
    if (head) {
      const pg = pages[head.page - 1];
      const at = pg.readText.lastIndexOf(head.text);
      const i = list.findIndex((u) => u.page > head.page || (u.page === head.page && at >= 0 && u.end > at));
      referencesAt = i >= 0 ? i : null;
    }
    units = list;
    return units;
  }

  /** The unit at the place a piece of text starts, on page `n` (`probe`: the text from there on). */
  async function unitAt(n, probe) {
    const list = await textUnits();
    const pg = pages[n - 1];
    const folded = fold(pg?.readText ?? '');
    let at = -1;
    for (const len of [40, 24, 12]) {
      const q = fold(probe).trim().slice(0, len);
      if (q.length >= 4 && (at = folded.indexOf(q)) >= 0) break;
    }
    const onPage = list.map((u, i) => [u, i]).filter(([u]) => u.page === n);
    if (!onPage.length) return list.findIndex((u) => u.page >= n);
    if (at < 0) return onPage[0][1];
    return (onPage.find(([u]) => at >= u.start && at < u.end) ?? onPage.filter(([u]) => u.start <= at).pop() ?? onPage[0])[1];
  }

  /* ---------- Marking the sentence read ---------- */

  function clearMark() {
    for (const l of el.querySelectorAll('.paper-reading')) l.replaceChildren();
  }
  async function markUnit(u) {
    const pg = pages[u.page - 1];
    if (!pg) return;
    const view = pagesEl.getBoundingClientRect();
    const box = pg.el.getBoundingClientRect();
    if (box.bottom < view.top || box.top > view.bottom) scrollTo(pg, 0, false);
    await ready(pg);
    // Found whole; else from its first words to its last (it may run over a line or a column).
    const words = fold(u.text).split(' ');
    let rects = matchesOnPage(pg, words.join(' '))[0] ?? [];
    if (!rects.length && words.length > 6) {
      const first = matchesOnPage(pg, words.slice(0, 6).join(' '))[0];
      const last = first && matchesOnPage(pg, words.slice(-6).join(' ')).find((r) => r[0][1] >= first[0][1] - 0.001);
      rects = first ? (last ? spanRects(first, last) : first) : [];
    }
    clearMark();
    if (!rects.length) return;
    let layer = pg.el.querySelector('.paper-reading');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'paper-reading';
      pg.el.append(layer);
    }
    layer.replaceChildren(...rects.map(([x, y, w, h]) => {
      const m = document.createElement('div');
      m.className = 'paper-read-mark';
      Object.assign(m.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      return m;
    }));
    // Kept in view: scrolled to when it is out of the middle of the pages
    // (not while the reader has text selected there).
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && pagesEl.contains(sel.anchorNode)) return;
    const y = rects[0][1];
    const top = pg.el.offsetTop + y * pg.el.offsetHeight;
    if (top < pagesEl.scrollTop + 20 || top > pagesEl.scrollTop + pagesEl.clientHeight * 0.75) scrollTo(pg, y);
  }
  /** The lines from the start of `first` to the end of `last` (fractions of the page). */
  function spanRects(first, last) {
    const [a, b] = [first[0], last[last.length - 1]];
    const lineH = a[3];
    const rows = [];
    const col = (r) => (r[0] < 0.5 ? 0 : 1);
    // Same column: whole lines between; other column: as far as the two ends.
    if (col(a) === col(b) && b[1] - a[1] > lineH * 0.5) {
      const left = Math.min(a[0], b[0]);
      const right = Math.max(...first.map((r) => r[0] + r[2]), ...last.map((r) => r[0] + r[2]));
      rows.push([a[0], a[1], right - a[0], lineH], [left, a[1] + lineH, right - left, Math.max(0, b[1] - a[1] - lineH)], [left, b[1], b[0] + b[2] - left, b[3]]);
    } else return [...first, ...last];
    return rows.filter((r) => r[2] > 0 && r[3] > 0);
  }

  /** The unit at the top of the page in view. */
  async function fromView() {
    const pg = pages.find((x) => x.el.offsetTop + x.el.offsetHeight > pagesEl.scrollTop + 40) ?? pages[0];
    const list = await textUnits();
    const i = list.findIndex((u) => u.page >= pg.n);
    return i < 0 ? 0 : i;
  }

  /** The text from the point (x, y) on: what is under the pointer, and after it. */
  function probeAt(x, y) {
    const c = caretAt(x, y);
    const span = (c?.node?.nodeType === 3 ? c.node.parentElement : c?.node)?.closest?.('.textLayer span');
    if (!span) return '';
    // From the start of its word, on through the next spans.
    let text = span.textContent.slice(0, c.offset).replace(/\S*$/, '').length;
    text = span.textContent.slice(text);
    for (let s = span.nextElementSibling; s && text.length < 60; s = s.nextElementSibling) text += s.tagName === 'BR' ? ' ' : ` ${s.textContent}`;
    return text;
  }

  const source = {
    async units() {
      const list = await textUnits();
      source.referencesAt = referencesAt;
      return list;
    },
    referencesAt: null,
    mark: markUnit,
    clear: clearMark,
    label: (u, i, until) => `Page ${u.page} · ${i + 1} / ${until + 1}`,
    fromView,
    fromViewTitle: 'Read from the page in view',
    pickArea: pagesEl,
    async indexAtPoint(e) {
      const page = Number(e.target.closest('.paper-page')?.dataset.page);
      return page ? unitAt(page, probeAt(e.clientX, e.clientY)) : -1;
    },
    indexAtSelection: (text, page) => unitAt(page, text),
    selection() {
      const sel = window.getSelection();
      const text = String(sel ?? '').trim();
      if (!text || !sel.rangeCount || !pagesEl.contains(sel.anchorNode)) return null;
      const node = sel.getRangeAt(0).startContainer;
      const page = Number((node.nodeType === 3 ? node.parentElement : node).closest('.paper-page')?.dataset.page) || 1;
      return { text, where: page };
    },
    empty: 'No text to read in this PDF (it may be scanned images).',
  };
  return createReader({ source, mount: (player) => (viewer.querySelector('.paper-find') ?? bar).after(player), button: bar.querySelector('[data-tool="tts"]'), root: el });
}
