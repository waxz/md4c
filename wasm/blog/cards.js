// Flash cards: the words and phrases saved from the PDF viewer's "Look up"
// (paper-tools.js), and their review. Kept in this browser (localStorage):
// the blog and the admin are separate sites, so each has its own deck;
// Export and Import move cards between them (or to Anki, as CSV).
//
//   deck                      the cards: all(), add(), update(), remove(), has()
//   speak(text, lang, audio)  say it: the recording if there is one, else the browser's voice
//   openCards()               the manager in a dialog (the viewer's Cards button)
//   mountCards(container)     the manager in a page (the admin's Cards)

import { cardKey, cleanCard, GRADES, isDue, mergeCards, newCard, nextLabel, parseCards, review, spanLabel, toCsv } from './lib/cards.js';

const KEY = 'md4c-cards-1';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let cssAdded = false;
/** cards.css on this page (the manager, and the look-up card's IPA). */
export function useCardsCss() {
  addCss();
}
function addCss() {
  if (cssAdded || document.querySelector('link[data-cards-css]')) return;
  cssAdded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./cards.css', import.meta.url).href;
  link.dataset.cardsCss = '';
  document.head.append(link);
}

/* ---------- The deck ---------- */

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.map(cleanCard).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function store(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('cards:', err);
    throw new Error('The cards could not be kept in this browser (its storage is full or turned off).');
  }
  window.dispatchEvent(new CustomEvent('cards-changed'));
}
// (Another tab changed them.)
window.addEventListener('storage', (e) => { if (e.key === KEY) window.dispatchEvent(new CustomEvent('cards-changed')); });

export const deck = {
  all: load,
  /** The card for this word or phrase, if saved. */
  has(fields) {
    const k = cardKey({ lang: 'en', ...fields });
    return load().find((c) => cardKey(c) === k) ?? null;
  },
  /** Save a word or phrase (its card is updated if it is there already). */
  add(fields) {
    const list = load();
    const k = cardKey({ lang: 'en', ...fields });
    const had = list.find((c) => cardKey(c) === k);
    const card = had ? cleanCard({ ...had, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v != null)) }) : newCard(fields);
    store(had ? list.map((c) => (c === had ? card : c)) : [...list, card]);
    return card;
  },
  update(card) {
    store(load().map((c) => (c.id === card.id ? cleanCard(card) : c)));
  },
  remove(id) {
    store(load().filter((c) => c.id !== id));
  },
  replace(list) {
    store(list);
  },
  dueCount: (now = Date.now()) => load().filter((c) => isDue(c, now)).length,
};

/* ---------- Saying it ---------- */

let playing = null;
/** The recording at `audio` if it plays, else the browser's voice in `lang`. */
export async function speak(text, lang = 'en', audio = '') {
  playing?.pause();
  window.speechSynthesis?.cancel();
  if (audio) {
    try {
      playing = new Audio(audio);
      await playing.play();
      return;
    } catch {}
  }
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = { en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN' }[lang] ?? lang;
  if (audio && /-uk\.mp3/.test(audio)) u.lang = 'en-GB';
  u.rate = text.length > 40 ? 0.95 : 0.85;
  window.speechSynthesis.speak(u);
}

/** IPA with a play button for each accent; a button for the browser's voice when none has a recording. */
export function ipaHtml(card) {
  // A play button by each recording; without any, one for the browser's voice.
  const recorded = card.ipa.some((p) => p.audio);
  const parts = card.ipa.map((p, i) => `<span class="ipa">${p.region ? `<span class="ipa-region">${esc(p.region)}</span>` : ''}${esc(p.text)}${
    p.audio ? `<button type="button" class="say" data-say="${i}" aria-label="Say it${p.region ? ` (${esc(p.region)})` : ''}" title="Say it">▶</button>` : ''}</span>`);
  if (!recorded) parts.push(`<button type="button" class="say" data-say="voice" aria-label="Say it" title="Say it (this browser's voice)">▶</button>`);
  return `<span class="ipas">${parts.join('')}</span>`;
}
/** Wire the play buttons made by ipaHtml in `root` to `card`. */
export function wireSay(root, card) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-say]');
    if (!b || !root.contains(b)) return;
    e.stopPropagation();
    const p = card.ipa[Number(b.dataset.say)];
    speak(card.term, card.lang, p?.audio ?? '');
  });
}

/* ---------- The manager ---------- */

const DATE = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** The manager (Review, All) in `container`; `onClose` adds a close button. Returns { destroy }. */
export function mountCards(container, { onClose } = {}) {
  addCss();
  let tab = deck.dueCount() ? 'review' : 'all';
  let query = '';
  let showAll = false; // review cards not yet due ("study ahead")
  let current = null; // the card under review
  let flipped = false;

  container.classList.add('cards');
  container.innerHTML = `<div class="cards-head">
      <h2>Cards</h2><span class="cards-count muted"></span><span class="cards-spacer"></span>
      <div class="cards-tabs" role="tablist">
        <button type="button" role="tab" data-tab="review">Review</button>
        <button type="button" role="tab" data-tab="all">All</button>
      </div>
      <details class="cards-menu"><summary>More</summary><div>
        <button type="button" data-act="export-json">Export (JSON)</button>
        <button type="button" data-act="export-csv">Export for Anki (CSV)</button>
        <label class="cards-import">Import (JSON)<input type="file" accept="application/json,.json" hidden></label>
      </div></details>
      ${onClose ? '<button type="button" class="cards-close" data-act="close" aria-label="Close" title="Close (Esc)">×</button>' : ''}
    </div>
    <div class="cards-body"></div>`;
  const body = container.querySelector('.cards-body');

  function header() {
    const all = deck.all();
    const due = all.filter((c) => isDue(c)).length;
    container.querySelector('.cards-count').textContent = `${all.length} card${all.length === 1 ? '' : 's'} · ${due} due`;
    for (const b of container.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }

  /* Review: the term (and where it was read), then the answer, then a grade. */
  function renderReview() {
    const all = deck.all();
    const now = Date.now();
    const queue = all.filter((c) => showAll || isDue(c, now)).sort((a, b) => a.due - b.due);
    current = queue[0] ?? null;
    flipped = false;
    if (!current) {
      const next = all.filter((c) => !isDue(c, now)).sort((a, b) => a.due - b.due)[0];
      body.innerHTML = all.length
        ? `<div class="cards-done"><p><b>Nothing to review now.</b>${next ? ` The next card is due in ${spanLabel(next.due - now)}.` : ''}</p>
            <button type="button" class="cards-btn" data-act="ahead">Review all ${all.length} anyway</button></div>`
        : `<div class="cards-done"><p><b>No cards yet.</b></p><p class="muted">In a paper's PDF, select a word or a sentence, press <b>Look up</b>, then <b>☆ Save</b>: it comes back here to review.</p></div>`;
      return;
    }
    const c = current;
    const ctx = c.context && c.kind === 'word'
      ? esc(c.context).replace(new RegExp(`(${c.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'), '<mark>$1</mark>') : esc(c.context);
    body.innerHTML = `<div class="flash" tabindex="0">
        <p class="flash-left muted">${queue.length} to review${showAll ? ' (ahead)' : ''}</p>
        <p class="flash-term" lang="${esc(c.lang)}">${esc(c.term)}</p>
        ${ctx && c.context !== c.term ? `<p class="flash-context">${ctx}</p>` : ''}
        <div class="flash-answer" hidden>
          ${c.ipa.length || c.kind === 'word' ? ipaHtml(c) : `<button type="button" class="say" data-say="voice" aria-label="Say it">▶</button>`}
          ${c.meaning ? `<p class="flash-meaning">${esc(c.meaning)}</p>` : ''}
          ${c.translation ? `<p class="flash-translation"${c.to ? ` lang="${esc(c.to)}"` : ''}>${esc(c.translation)}</p>` : ''}
          ${sourceHtml(c)}
        </div>
        <div class="flash-actions">
          <button type="button" class="cards-btn cards-primary" data-act="flip">Show answer <kbd>Space</kbd></button>
          <div class="flash-grades" hidden>${GRADES.map((g, i) => `<button type="button" class="cards-btn grade-${g}" data-grade="${g}">
            <span>${g[0].toUpperCase()}${g.slice(1)}</span><small>${nextLabel(c, g)}</small><kbd>${i + 1}</kbd></button>`).join('')}</div>
        </div>
      </div>`;
    wireSay(body.querySelector('.flash'), c);
    body.querySelector('.flash').focus({ preventScroll: true });
  }
  function flip() {
    if (!current || flipped) return;
    flipped = true;
    body.querySelector('.flash-answer').hidden = false;
    body.querySelector('[data-act="flip"]').hidden = true;
    body.querySelector('.flash-grades').hidden = false;
    if (current.kind === 'word') speak(current.term, current.lang, current.ipa.find((p) => p.audio)?.audio ?? '');
  }
  function grade(g) {
    if (!current || !flipped) return;
    deck.update(review(current, g));
  }

  const sourceHtml = (c) => (c.source?.href || c.source?.title
    ? `<p class="flash-source muted">from ${c.source.href ? `<a href="${esc(c.source.href)}${c.source.page ? `#page=${c.source.page}` : ''}">${esc(c.source.title || 'the paper')}</a>` : esc(c.source.title)}${c.source.page ? `, page ${c.source.page}` : ''} · saved ${DATE(c.added)}</p>` : '');

  /* All: every card, searched; play, delete. */
  function renderAll() {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = deck.all().sort((a, b) => b.added - a.added);
    const shown = all.filter((c) => words.every((w) => [c.term, c.meaning, c.translation, c.context, c.source?.title].join(' ').toLowerCase().includes(w)));
    const now = Date.now();
    body.innerHTML = `<input type="search" class="cards-search" placeholder="Search the cards" aria-label="Search the cards" value="${esc(query)}">
      ${shown.length ? `<ul class="cards-list">${shown.map((c) => `<li data-id="${esc(c.id)}">
        <div class="card-row"><span class="card-term" lang="${esc(c.lang)}">${esc(c.term)}</span>${c.kind === 'word' || c.ipa.length ? ipaHtml(c) : `<button type="button" class="say" data-say="voice" aria-label="Say it">▶</button>`}
          <span class="cards-spacer"></span><span class="card-due muted" title="Next review">${isDue(c, now) ? 'due' : `in ${spanLabel(c.due - now)}`}</span>
          <button type="button" class="card-delete" data-act="delete" aria-label="Delete “${esc(c.term)}”" title="Delete">×</button></div>
        ${c.meaning ? `<p class="card-meaning">${esc(c.meaning)}</p>` : ''}
        ${c.translation ? `<p class="card-translation"${c.to ? ` lang="${esc(c.to)}"` : ''}>${esc(c.translation)}</p>` : ''}
        ${sourceHtml(c)}
      </li>`).join('')}</ul>` : `<p class="muted">${all.length ? 'No cards match.' : 'No cards yet. Save words and sentences from a paper’s Look up.'}</p>`}`;
    for (const li of body.querySelectorAll('.cards-list li')) wireSay(li, all.find((c) => c.id === li.dataset.id));
    const input = body.querySelector('.cards-search');
    input.addEventListener('input', () => {
      query = input.value;
      const at = input.selectionStart;
      renderAll();
      const again = body.querySelector('.cards-search');
      again.focus();
      again.setSelectionRange(at, at);
    });
  }

  function render() {
    header();
    if (tab === 'review') renderReview();
    else renderAll();
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  container.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      showAll = false;
      render();
    } else if (b.dataset.grade) grade(b.dataset.grade);
    else if (b.dataset.act === 'flip') flip();
    else if (b.dataset.act === 'ahead') {
      showAll = true;
      renderReview();
    } else if (b.dataset.act === 'delete') {
      const id = b.closest('[data-id]').dataset.id;
      const c = deck.all().find((x) => x.id === id);
      if (c && window.confirm(`Delete the card “${c.term}”?`)) deck.remove(id);
    } else if (b.dataset.act === 'export-json') {
      download(`cards-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify({ cards: deck.all() }, null, 1)}\n`, 'application/json');
    } else if (b.dataset.act === 'export-csv') {
      download(`cards-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(deck.all()), 'text/csv');
    } else if (b.dataset.act === 'close') onClose?.();
  });
  container.querySelector('.cards-import input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = parseCards(await file.text());
      const before = deck.all();
      const merged = mergeCards(before, incoming);
      deck.replace(merged);
      window.alert(`${merged.length - before.length} new card(s) imported; ${incoming.length - (merged.length - before.length)} already here (the one reviewed more is kept).`);
    } catch (err) {
      window.alert(`That file could not be imported: ${err.message}`);
    }
  });
  const onKey = (e) => {
    if (tab !== 'review' || e.target.closest?.('input, textarea, select') || !container.isConnected) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (!flipped && current) {
        e.preventDefault();
        flip();
      }
    } else if (flipped && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      grade(GRADES[Number(e.key) - 1]);
    }
  };
  const onChange = () => render();
  document.addEventListener('keydown', onKey);
  window.addEventListener('cards-changed', onChange);
  render();
  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('cards-changed', onChange);
    },
  };
}

/** The manager in a dialog over the page (from the PDF viewer). */
export function openCards() {
  addCss();
  const dialog = document.createElement('dialog');
  dialog.className = 'cards-dialog';
  document.body.append(dialog);
  const close = () => dialog.close();
  const view = mountCards(dialog, { onClose: close });
  dialog.addEventListener('close', () => {
    view.destroy();
    dialog.remove();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // (outside the panel)
  dialog.showModal();
}
