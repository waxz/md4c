// Reading an article aloud (the reader's 🔊): its title, headings,
// paragraphs, list items, quotes and captions, in sentences, the one read
// highlighted and kept in view. Code blocks, math, tables, embedded
// illustrations, the contents box and a paper's PDF are not read; the
// references only when asked ("the references too"). The speech, the
// voices and the player: tts.js.
//
// attachArticleReader({ article, button }): `article` holds the header and
// the .prose; `button` toggles the player (docked at the bottom of the
// window, as for a PDF).

import { createReader, sentences, speakable, SPEAK_ICON } from './tts.js';

export { SPEAK_ICON };

const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, dt, dd, figcaption';
// Containers whose text is not read (the references are read last, if asked).
const SKIP = 'pre, .code-block, .toc, .embed, .paper, table, .table-wrap, .post-banner, .references, .footnotes, nav, aside, button, select, figure img, .byline, .keywords';
// Within what is read: what is left out of the sentence.
const QUIET = '.katex, .katex-display, sup.footnote-ref, .heading-anchor, .cite-tools, .ref-back, .footnote-backref, button, svg, script, style';

const HIGHLIGHT = 'tts-reading';

export function attachArticleReader({ article, button = null, mount = null }) {
  const lang = document.documentElement.lang || 'en';
  let units = null;

  /** A block's text, from its text nodes: { text, nodes: [{ node, start }] }. */
  function blockText(block) {
    const nodes = [];
    let text = '';
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest(QUIET) && block.contains(n.parentElement.closest(QUIET)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    return { text, nodes };
  }

  function readUnits() {
    const list = [];
    let referencesAt = null;
    const blocks = (root, skip) => [...root.querySelectorAll(BLOCKS)].filter((b) => !b.querySelector(BLOCKS) && !b.closest(skip) && b.offsetParent !== null);
    const add = (block) => {
      const { text, nodes } = blockText(block);
      for (const s of sentences(text, lang)) {
        const say = speakable(s.text);
        if ((say.match(/\p{L}/gu) ?? []).length < 2) continue;
        list.push({ block, nodes, start: s.start, end: s.end, text: s.text, say });
      }
    };
    for (const b of blocks(article, SKIP)) add(b);
    const refs = article.querySelector('.references');
    if (refs) {
      referencesAt = list.length;
      for (const b of blocks(refs, 'pre, .embed')) add(b);
      if (referencesAt === list.length) referencesAt = null;
    }
    source.referencesAt = referencesAt;
    return list;
  }

  /** A Range over characters [start, end) of a unit's block. */
  function rangeOf(u) {
    const at = (i) => {
      let k = u.nodes.length - 1;
      while (k > 0 && u.nodes[k].start > i) k--;
      const { node, start } = u.nodes[k];
      return [node, Math.min(node.data.length, Math.max(0, i - start))];
    };
    const r = document.createRange();
    try {
      r.setStart(...at(u.start));
      r.setEnd(...at(u.end));
    } catch {
      r.selectNodeContents(u.block);
    }
    return r;
  }

  const canHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  function clear() {
    if (canHighlight) CSS.highlights.delete(HIGHLIGHT);
    for (const b of article.querySelectorAll('.tts-block')) b.classList.remove('tts-block');
  }
  function mark(u) {
    clear();
    const range = rangeOf(u);
    if (canHighlight) CSS.highlights.set(HIGHLIGHT, new Highlight(range));
    else u.block.classList.add('tts-block');
    // Kept in view (not while the reader has text selected), clear of the bars.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && article.contains(sel.anchorNode)) return;
    const box = range.getBoundingClientRect();
    const top = document.querySelector('.reader-bar')?.getBoundingClientRect().bottom ?? 0;
    const bottom = window.innerHeight - (document.querySelector('.tts-dock.is-open')?.offsetHeight ?? 0);
    if (box.top < top + 8 || box.bottom > bottom - 8) {
      window.scrollTo({ top: window.scrollY + box.top - top - (bottom - top) / 3, behavior: 'smooth' });
    }
  }

  /** The unit holding character `offset` of text node `node`, or -1. */
  function indexAt(node, offset) {
    const list = units ?? [];
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const n = u.nodes.find((x) => x.node === node);
      if (!n) continue;
      const at = n.start + offset;
      const here = list.slice(i).filter((v) => v.block === u.block);
      return list.indexOf(here.find((v) => at >= v.start && at < v.end) ?? here.filter((v) => v.start <= at).pop() ?? u);
    }
    // Not in a text read (a heading's number, math): the first unit of its block, or after it.
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const i = list.findIndex((u) => u.block === el?.closest?.(BLOCKS) || u.block.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
    return i;
  }

  const source = {
    async units() {
      units = readUnits();
      return units;
    },
    referencesAt: null,
    mark,
    clear,
    label: (u, i, until) => `${i + 1} / ${until + 1}`,
    async fromView() {
      const top = (document.querySelector('.reader-bar')?.getBoundingClientRect().bottom ?? 0) + 4;
      const i = (units ?? []).findIndex((u) => u.block.getBoundingClientRect().bottom > top);
      return i < 0 ? 0 : i;
    },
    async indexAtSelection(text, range) {
      return range ? Math.max(0, indexAt(range.startContainer, range.startOffset)) : 0;
    },
    selection() {
      const sel = window.getSelection();
      const text = String(sel ?? '').trim();
      if (!text || !sel.rangeCount || !article.contains(sel.anchorNode)) return null;
      return { text, where: sel.getRangeAt(0).cloneRange() };
    },
    empty: 'No text to read in this article.',
  };

  const reader = createReader({ source, button, root: article, mount });
  return {
    ...reader,
    destroy() {
      reader.destroy();
      clear();
    },
  };
}
