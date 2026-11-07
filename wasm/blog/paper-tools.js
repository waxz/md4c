// Reading tools for the PDF viewer (paper.js): the full window, search in
// the whole text, looking up a word, and the paper's reference list.
//
// attachTools(ctx) is called by mountPaper once the pages are set up, with
// what it needs of the viewer:
//   el, viewer, pagesEl   the paper, its viewer and the scrolling pages
//   pages                 [{ n, page (pdf.js), el, rendered, task }]
//   render(p), scale()    draw a page (with its text layer); the current scale
//   popup(cls), place(node, rect)   the viewer's pop-ups
//   editable              the admin's annotator (it has its own selection bar)
//
// Looking up asks the Free Dictionary (English words: meaning, IPA,
// recordings), Wikipedia (terms; Japanese ones on ja.wikipedia.org) and
// MyMemory (translation), only when "Look up" is pressed; the pages' CSP
// allows those hosts and no others. "Save" keeps it as a flash card
// (cards.js).

import { deck, ipaHtml, openCards, speak, useCardsCss } from './cards.js';
import { attachReader } from './paper-tts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Text as searched: one space for any run of spaces, lower case. */
const fold = (s) => s.replace(/\s+/g, ' ').toLowerCase();

export function attachTools(ctx) {
  const { el, viewer, pagesEl, pages, render, scale, popup, place, editable } = ctx;
  const bar = viewer.querySelector('.paper-toolbar');
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  /* ---------- Pages and their text ---------- */

  let texts = null; // per page: its text as searched (from pdf.js, every page)
  const pageTexts = () => (texts ??= Promise.all(pages.map(async (p) => {
    const c = await p.page.getTextContent();
    return fold(c.items.map((i) => (i.str ?? '') + (i.hasEOL ? ' ' : '')).join(''));
  })));

  /** Draw page `p` (its text layer too) and wait until it is there. */
  async function ready(p) {
    render(p);
    for (let t = 0; t < 100 && (p.task || p.rendered !== scale()); t++) await sleep(40);
  }

  // Scrolls made here (search, references, reading aloud) are not the reader's:
  // they do not close the selection bar or the look-up card.
  let ownScroll = 0;
  const readerScrolled = () => Date.now() - ownScroll > 1200;
  /** Scroll the pages so that `y` (a fraction of page `p`) is a third down the view. */
  function scrollTo(p, y, smooth = true) {
    ownScroll = Date.now();
    const top = p.el.offsetTop + y * p.el.offsetHeight - pagesEl.clientHeight / 3;
    pagesEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  /**
   * Where `query` (folded) is on rendered page `p`: per match, its rects as
   * fractions of the page, from the text layer.
   */
  function matchesOnPage(p, query) {
    const layer = p.el.querySelector('.textLayer');
    if (!layer || !query) return [];
    // The layer's text, with each character's place in its text node.
    const nodes = [];
    let raw = '';
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === 3) {
        nodes.push({ node: n, start: raw.length });
        raw += n.data;
      } else if (n.nodeName === 'BR') raw += ' ';
    }
    // Folded as the query is, keeping where each folded character came from.
    let text = '';
    const from = [];
    for (let i = 0; i < raw.length; i++) {
      const c = /\s/.test(raw[i]) ? ' ' : raw[i].toLowerCase();
      if (c === ' ' && text.endsWith(' ')) continue;
      text += c;
      from.push(i);
    }
    const at = (rawIndex) => {
      let k = nodes.length - 1;
      while (k > 0 && nodes[k].start > rawIndex) k--;
      const { node, start } = nodes[k];
      return [node, Math.min(node.data.length, Math.max(0, rawIndex - start))];
    };
    const box = p.el.getBoundingClientRect();
    const out = [];
    for (let i = text.indexOf(query); i !== -1 && nodes.length; i = text.indexOf(query, i + query.length)) {
      const range = document.createRange();
      try {
        range.setStart(...at(from[i]));
        const [endNode, endOff] = at(from[i + query.length - 1]);
        range.setEnd(endNode, endOff + 1);
      } catch {
        continue;
      }
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).map((r) => [
        (r.left - box.left) / box.width, (r.top - box.top) / box.height, r.width / box.width, r.height / box.height]);
      if (rects.length) out.push(rects);
    }
    return out;
  }

  /** Mark matches on page `p` (the one at `current` stronger); the layer survives zooming (fractions). */
  function mark(p, matches, current = -1) {
    let layer = p.el.querySelector('.paper-marks');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'paper-marks';
      p.el.append(layer);
    }
    layer.replaceChildren(...matches.flatMap((rects, k) => rects.map(([x, y, w, h]) => {
      const m = document.createElement('div');
      m.className = `paper-mark${k === current ? ' is-current' : ''}`;
      Object.assign(m.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      return m;
    })));
  }
  const clearMarks = () => { for (const l of el.querySelectorAll('.paper-marks')) l.replaceChildren(); };

  /** Show the `index`-th match of `query` on page `n`: marked, and scrolled to. */
  async function showMatch(n, query, index = 0) {
    const p = pages[n - 1];
    if (!p) return false;
    if (Math.abs(pagesEl.scrollTop - p.el.offsetTop) > pagesEl.clientHeight) scrollTo(p, 0, false);
    await ready(p);
    const found = matchesOnPage(p, query);
    clearMarks();
    if (!found.length) {
      scrollTo(p, 0);
      return false;
    }
    const k = Math.min(index, found.length - 1);
    mark(p, found, k);
    scrollTo(p, found[k][0][1]);
    return true;
  }

  /* ---------- Search ---------- */

  const find = document.createElement('div');
  find.className = 'paper-find';
  find.hidden = true;
  find.setAttribute('role', 'search');
  find.innerHTML = `<input type="search" placeholder="Search the PDF" aria-label="Search the PDF" enterkeyhint="search" autocomplete="off" spellcheck="false">
    <span class="paper-find-count muted" aria-live="polite"></span>
    <button type="button" data-find="-1" aria-label="Previous match" title="Previous (Shift+Enter)">↑</button>
    <button type="button" data-find="1" aria-label="Next match" title="Next (Enter)">↓</button>
    <button type="button" data-find="close" aria-label="Close the search" title="Close (Esc)">×</button>`;
  bar.after(find);
  const input = find.querySelector('input');
  const countEl = find.querySelector('.paper-find-count');
  let query = '';
  let hits = []; // [{ page, i }]
  let current = -1;
  let searchTimer;

  const showCount = (text) => { countEl.textContent = text ?? (query.length < 2 ? '' : hits.length ? `${current + 1} / ${hits.length}` : 'Not found'); };
  async function search(q) {
    query = fold(q).trim();
    hits = [];
    current = -1;
    clearMarks();
    if (query.length < 2) return showCount();
    showCount('Searching…');
    const all = await pageTexts();
    if (fold(input.value).trim() !== query) return; // (typed on meanwhile)
    all.forEach((t, k) => {
      let i = 0;
      for (let at = t.indexOf(query); at !== -1 && hits.length < 5000; at = t.indexOf(query, at + query.length)) hits.push({ page: k + 1, i: i++ });
    });
    if (!hits.length) return showCount();
    // From the page in view on.
    const inView = pages.find((p) => p.el.offsetTop + p.el.offsetHeight > pagesEl.scrollTop + 10)?.n ?? 1;
    go(Math.max(0, hits.findIndex((h) => h.page >= inView)));
  }
  async function go(k) {
    if (!hits.length) return;
    current = (k + hits.length) % hits.length;
    showCount();
    const h = hits[current];
    await showMatch(h.page, query, h.i);
  }
  function openFind() {
    find.hidden = false;
    bar.querySelector('[data-tool="find"]')?.setAttribute('aria-pressed', 'true');
    const sel = String(window.getSelection() ?? '').trim();
    if (sel && sel.length < 80 && pagesEl.contains(window.getSelection().anchorNode)) input.value = sel;
    input.focus();
    input.select();
    if (input.value) search(input.value);
  }
  function closeFind() {
    find.hidden = true;
    bar.querySelector('[data-tool="find"]')?.setAttribute('aria-pressed', 'false');
    clearMarks();
    hits = [];
    query = '';
  }
  on(input, 'input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(input.value), 250);
  });
  on(input, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (fold(input.value).trim() !== query) search(input.value);
      else go(current + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  });
  on(find, 'click', (e) => {
    const b = e.target.closest('[data-find]');
    if (!b) return;
    if (b.dataset.find === 'close') closeFind();
    else go(current + Number(b.dataset.find));
  });

  /* ---------- The full window ---------- */

  const fullBtn = bar.querySelector('[data-tool="full"]');
  const isFull = () => el.classList.contains('is-full');
  function setFull(full) {
    if (full === isFull()) return;
    // Keep the place read: the page in view, and how far down it.
    const p = pages.find((x) => x.el.offsetTop + x.el.offsetHeight > pagesEl.scrollTop) ?? pages[0];
    const y = p ? (pagesEl.scrollTop - p.el.offsetTop) / Math.max(1, p.el.offsetHeight) : 0;
    el.classList.toggle('is-full', full);
    el.classList.remove('show-comments');
    document.documentElement.classList.toggle('paper-full-open', full);
    fullBtn?.setAttribute('aria-pressed', String(full));
    if (fullBtn) fullBtn.title = full ? 'Leave the full window (Esc)' : 'Read in the full window';
    setTimeout(() => {
      if (p) pagesEl.scrollTop = p.el.offsetTop + y * p.el.offsetHeight;
      pagesEl.focus({ preventScroll: true });
    }, 120); // (after the pages are laid out at the new width)
  }

  /* ---------- Looking up: a word (meaning, IPA, saying it), a phrase or sentence (translation) ---------- */

  const lookupEl = popup('paper-lookup');
  lookupEl.setAttribute('role', 'dialog');
  lookupEl.setAttribute('aria-label', 'Look up');
  lookupEl.classList.add('cards'); // (its IPA and buttons as on the cards)
  useCardsCss();
  let lookingUp = 0;
  let shown = null; // what the card shows: the fields of a flash card

  /** Links to read more about `term` elsewhere. */
  function moreLinks(term, kind, from, to) {
    const q = encodeURIComponent(term);
    const ja = from === 'ja';
    const links = kind === 'phrase' ? [
      ['Google Translate', `https://translate.google.com/?sl=${from}&tl=${to}&text=${q}&op=translate`],
      ['DeepL', `https://www.deepl.com/translator#${from}/${to.slice(0, 2)}/${q}`],
    ] : [
      ['Wiktionary', `https://${ja ? 'ja' : 'en'}.wiktionary.org/wiki/${q}`],
      ['Wikipedia', `https://${ja ? 'ja' : 'en'}.wikipedia.org/w/index.php?search=${q}`],
      ['Weblio', ja ? `https://www.weblio.jp/content/${q}` : `https://ejje.weblio.jp/content/${q}`],
      ['Google', `https://www.google.com/search?q=${encodeURIComponent(`define ${term}`)}`],
    ];
    return `<p class="lookup-more">${links.map(([name, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${name} ↗</a>`).join('')}</p>`;
  }

  /** JSON from a look-up service, or null; asked twice when the network or the service stumbles. */
  async function fetchJson(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (res.ok) return await res.json();
        if (res.status < 500 || attempt) return null; // (not there)
      } catch (err) {
        if (attempt) throw err;
      }
      await sleep(400);
    }
  }

  /** An English word's entry (Free Dictionary): { word, ipa: [{ text, audio, region }], meanings }, or null. */
  async function dictionary(word) {
    const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`).catch(() => null);
    const entries = Array.isArray(data) ? data : [];
    if (!entries[0]?.meanings?.length) return null;
    // Every spelling of its sound, with its recording; the accent from the recording's name.
    const seen = new Set();
    const ipa = [];
    for (const p of entries.flatMap((e) => [...(e.phonetics ?? []), ...(e.phonetic ? [{ text: e.phonetic }] : [])])) {
      const region = /-(us|uk|au|ca)\.mp3$/i.exec(p.audio ?? '')?.[1]?.toUpperCase() ?? '';
      const key = `${p.text ?? ''}|${region}`;
      if (!p.text && !p.audio) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      ipa.push({ text: p.text ?? '', audio: /^https:\/\//.test(p.audio ?? '') ? p.audio : '', region });
    }
    // The ones with a recording first; text without a recording only once.
    ipa.sort((a, b) => Boolean(b.audio) - Boolean(a.audio));
    const unique = ipa.filter((p, i) => p.audio || !ipa.slice(0, i).some((q) => q.text === p.text));
    return { word: entries[0].word, ipa: unique.slice(0, 3), meanings: entries.flatMap((e) => e.meanings) };
  }

  /** Wikipedia's summary of a term: { title, extract, page }, or null. */
  async function summary(term, lang) {
    const data = await fetchJson(`https://${lang === 'ja' ? 'ja' : 'en'}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, '_'))}`).catch(() => null);
    if (!data?.extract || data.type === 'disambiguation') return null;
    return { title: data.title, extract: data.extract.slice(0, 600), page: data.content_urls?.desktop?.page ?? '' };
  }

  /**
   * `text` translated from `from` to `to` (MyMemory): { text } ('' if none,
   * with why as `error`). A word gets up to three of its translations
   * ("シーケンス · 順番"); one given back as it was is no translation.
   */
  async function translate(text, from, to, word = false) {
    const data = await fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${from}|${to}`).catch(() => null);
    const main = data?.responseData?.translatedText ?? '';
    if (Number(data?.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(main)) {
      return { text: '', error: data ? 'The free translation service declined (it allows a few thousand words a day).' : 'The translation service could not be reached.' };
    }
    const unescape = (t) => String(t ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    const same = (t) => t.toLowerCase() === text.trim().toLowerCase();
    const found = [main, ...(data.matches ?? []).sort((a, b) => (b.match ?? 0) - (a.match ?? 0)).map((m) => m.translation)]
      .map(unescape).filter((t) => t && !same(t));
    const distinct = [...new Set(found)];
    return { text: word ? distinct.slice(0, 3).join(' · ') : distinct[0] ?? '' };
  }

  /** What `text` is written in, roughly (enough to translate it and say it). */
  const languageOf = (text) => (/[぀-ヿ]/.test(text) ? 'ja' : /[가-힯]/.test(text) ? 'ko' : /[一-鿿]/.test(text) ? 'zh-CN' : 'en');

  // Translations go into the reader's language (chosen in the card, kept in this browser).
  const LANGS = [['ja', '日本語'], ['zh-CN', '中文 (简体)'], ['zh-TW', '中文 (繁體)'], ['ko', '한국어'], ['en', 'English'],
    ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['it', 'Italiano'], ['pt', 'Português'], ['ru', 'Русский'], ['vi', 'Tiếng Việt']];
  const TO_KEY = 'md4c-translate-to';
  function targetFor(from) {
    let to = '';
    try {
      to = localStorage.getItem(TO_KEY) ?? '';
    } catch {}
    if (!LANGS.some(([c]) => c === to)) {
      const mine = (navigator.languages ?? [navigator.language]).map((l) => (/^zh-(tw|hk|hant)/i.test(l) ? 'zh-TW' : /^zh/i.test(l) ? 'zh-CN' : l.slice(0, 2)));
      to = mine.find((l) => l !== 'en' && LANGS.some(([c]) => c === l)) ?? 'ja';
    }
    return to === from ? (from === 'en' ? 'ja' : 'en') : to;
  }
  const langSelect = (to) => `<select class="lookup-to" aria-label="Translate into">${LANGS.map(([c, name]) => `<option value="${c}"${c === to ? ' selected' : ''}>→ ${name}</option>`).join('')}</select>`;

  /**
   * Look up `text` (a selection) and show it by `rect`: a word's meaning,
   * IPA and sound; a phrase or sentence translated. `context` (the
   * sentence it was read in) and `source` (the paper, its page) go with
   * it onto a flash card when it is saved.
   */
  async function lookup(text, rect, { context = '', page = 0 } = {}) {
    // A word broken over two lines comes back whole; quotes and stray punctuation go.
    let full = String(text).replace(/(\w)-\s+(\w)/g, '$1$2').replace(/\s+/g, ' ').trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?)]+$/gu, '').slice(0, 480);
    if (!full) return;
    const from = languageOf(full);
    const words = from === 'en' ? full.split(' ').length : Math.ceil(full.length / 4);
    const kind = words >= 4 || full.length > 40 ? 'phrase' : 'word';
    if (kind === 'word') full = full.replace(/[^\p{L}\p{N}]+$/u, ''); // ("sequence." is the word "sequence")
    const to = targetFor(from);
    const ticket = ++lookingUp;
    const source = {
      title: (document.querySelector('.article-title')?.textContent || document.title || '').trim(),
      href: /^https?:/.test(location.href) ? location.href.split('#')[0] : '', page,
    };
    shown = { term: full, kind, lang: from === 'zh-CN' ? 'zh' : from, ipa: [], meaning: '', translation: '', to, context: context === full ? '' : context, source };
    draw('<p class="muted">Looking up…</p>');
    place(lookupEl, rect);
    const card = shown;
    const jobs = [translate(full, from, to, kind === 'word').then((r) => {
      card.translation = r.text;
      card.translateError = r.error;
    })];
    if (kind === 'word') {
      jobs.push((async () => {
        const entry = from === 'en' && /^[A-Za-z][A-Za-z'’-]*$/.test(full) ? await dictionary(full) : null;
        if (entry) {
          card.ipa = entry.ipa;
          card.entry = entry;
          card.meaning = entry.meanings.slice(0, 2).map((m) => `(${m.partOfSpeech}) ${m.definitions[0]?.definition ?? ''}`).join(' ');
          return;
        }
        const wiki = await summary(full, from) ?? (/\s/.test(full) || from !== 'en' ? null : await summary(full[0].toUpperCase() + full.slice(1), from));
        if (wiki) {
          card.wiki = wiki;
          card.meaning = wiki.extract.split(/(?<=\.)\s/)[0].slice(0, 300);
        }
      })());
    }
    await Promise.all(jobs);
    if (ticket !== lookingUp || lookupEl.hidden) return;
    draw();
    place(lookupEl, rect);
  }

  /** The look-up card, from `shown` (or `pending` while looking up). */
  function draw(pending = '') {
    const c = shown;
    const saved = deck.has(c);
    const say = c.kind === 'word' ? ipaHtml(c) : '<button type="button" class="say" data-say="voice" aria-label="Say it" title="Say it">▶</button>';
    let main = '';
    if (!pending) {
      if (c.entry) {
        main = `${c.entry.meanings.slice(0, 3).map((m) => `<p class="lookup-pos">${esc(m.partOfSpeech)}</p><ol class="lookup-defs">${
          m.definitions.slice(0, 2).map((d) => `<li>${esc(d.definition)}${d.example ? ` <span class="muted">“${esc(d.example)}”</span>` : ''}</li>`).join('')}</ol>`).join('')}
          <p class="lookup-from muted">Free Dictionary</p>`;
      } else if (c.wiki) {
        main = `<p class="lookup-extract">${esc(c.wiki.extract)}</p><p class="lookup-from muted">Wikipedia${c.wiki.page ? ` · <a href="${esc(c.wiki.page)}" target="_blank" rel="noopener noreferrer">article ↗</a>` : ''}</p>`;
      } else if (c.kind === 'word') main = '<p class="muted">No definition found here.</p>';
    }
    const translation = pending ? '' : `<div class="lookup-translation${c.kind === 'phrase' ? ' is-main' : ''}">
        <div class="lookup-translation-head">${langSelect(c.to)}<span class="lookup-from muted">MyMemory</span></div>
        ${c.translation ? `<p lang="${esc(c.to)}">${esc(c.translation)}</p>`
          : `<p class="muted">${esc(c.translating ? 'Translating…' : c.translateError || 'No translation.')}</p>`}</div>`;
    lookupEl.innerHTML = `<div class="lookup-top">
        <p class="lookup-head"><b lang="${esc(c.lang)}"${c.kind === 'phrase' ? ' class="is-phrase"' : ''}>${esc(c.kind === 'word' && c.entry ? c.entry.word : c.term)}</b></p>
        <button type="button" class="lookup-save${saved ? ' is-saved' : ''}" data-act="save" aria-pressed="${Boolean(saved)}" title="${saved ? 'Saved to your flash cards (save again to update it)' : 'Save to your flash cards'}">${saved ? '★ Saved' : '☆ Save'}</button>
      </div>
      <div class="lookup-say">${say}</div>
      ${pending}${c.kind === 'phrase' ? translation + main : main + translation}
      ${moreLinks(c.term, c.kind, c.lang === 'zh' ? 'zh-CN' : c.lang, c.to)}`;
  }

  on(lookupEl, 'click', (e) => {
    const say = e.target.closest('[data-say]');
    if (say && shown) {
      const p = shown.ipa[Number(say.dataset.say)];
      speak(shown.term, shown.lang, p?.audio ?? '');
      return;
    }
    const save = e.target.closest('[data-act="save"]');
    if (save && shown) {
      try {
        deck.add(shown);
        draw();
      } catch (err) {
        window.alert(err.message);
      }
    }
  });
  on(lookupEl, 'change', async (e) => {
    if (!e.target.matches('.lookup-to') || !shown) return;
    const to = e.target.value;
    try {
      localStorage.setItem(TO_KEY, to);
    } catch {}
    const c = shown;
    c.to = to;
    c.translation = '';
    c.translating = true;
    draw();
    const r = await translate(c.term, c.lang === 'zh' ? 'zh-CN' : c.lang, to, c.kind === 'word');
    if (shown !== c) return;
    Object.assign(c, { translation: r.text, translateError: r.error, translating: false });
    draw();
  });
  const closeLookup = () => {
    lookingUp++;
    lookupEl.hidden = true;
  };

  /** The sentence around the selection, from the text layer (for the card). */
  function contextOfSelection() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return {};
    const range = sel.getRangeAt(0);
    const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const span = start?.closest?.('.textLayer span');
    const page = Number(start?.closest?.('.paper-page')?.dataset.page) || 0;
    if (!span) return { page };
    // The selection's line and its neighbours in the same block of text (a
    // wider gap between lines ends it: a heading, the authors), cut to the
    // sentence holding it.
    const all = [...span.closest('.textLayer').querySelectorAll('span')].filter((x) => !x.children.length && x.textContent.trim());
    const at = all.indexOf(span);
    const box = (x) => x.getBoundingClientRect();
    const near = (a, b) => {
      const [ra, rb] = [box(a), box(b)];
      return Math.abs(rb.top - ra.top) < Math.max(ra.height, rb.height) * 1.9;
    };
    let lo = at;
    while (lo > 0 && at - lo < 12 && near(all[lo - 1], all[lo])) lo--;
    let hi = at;
    while (hi < all.length - 1 && hi - at < 12 && near(all[hi], all[hi + 1])) hi++;
    const text = all.slice(lo, hi + 1).map((x) => x.textContent).join(' ').replace(/(\w)-\s+(\w)/g, '$1$2').replace(/\s+/g, ' ');
    const picked = String(sel).replace(/\s+/g, ' ').trim();
    const i = text.indexOf(picked.slice(0, 30));
    if (i < 0) return { page };
    const stop = text.lastIndexOf('. ', i);
    let from = Math.max(stop < 0 ? 0 : stop + 2, i - 200);
    if (from > 0 && from !== stop + 2) from = text.indexOf(' ', from) + 1; // (from a whole word)
    let to = text.indexOf('. ', i + picked.length);
    to = to < 0 ? Math.min(text.length, i + picked.length + 200) : to + 1;
    return { context: text.slice(from, Math.min(to, from + 400)).trim(), page };
  }

  /* ---------- Flash cards: the toolbar's button, with how many are due ---------- */

  const cardsBtn = bar.querySelector('[data-tool="cards"]');
  const badge = () => {
    const n = deck.dueCount();
    const b = cardsBtn?.querySelector('.paper-badge');
    if (b) {
      b.textContent = n ? String(n) : '';
      b.hidden = !n;
    }
  };
  badge();
  on(window, 'cards-changed', badge);

  // Readers (no annotator): a small bar by a selection, to look it up or copy it.
  let readbar = null;
  if (!editable) {
    readbar = popup('paper-selbar');
    readbar.classList.add('paper-readbar');
    readbar.setAttribute('role', 'toolbar');
    readbar.innerHTML = `<div class="pop-row"><button type="button" class="pop-btn" data-act="lookup">${ICON_BOOK}<span>Look up</span></button>
      <button type="button" class="pop-btn" data-act="read" title="Read the selection aloud">${ICON_SPEAK}<span>Read</span></button>
      <button type="button" class="pop-btn" data-act="read-on" title="Read aloud from here on">From here</button>
      <button type="button" class="pop-btn" data-act="copy">Copy</button></div>`;
    let selected = null;
    let timer;
    on(document, 'selectionchange', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = window.getSelection();
        const text = String(sel ?? '').trim();
        if (!text || !sel.rangeCount || !pagesEl.contains(sel.anchorNode)) {
          if (Date.now() - downAt > 800) readbar.hidden = true;
          return;
        }
        selected = { text, rect: sel.getRangeAt(0).getBoundingClientRect(), context: contextOfSelection() };
        place(readbar, selected.rect);
      }, 250);
    });
    let downAt = 0;
    on(readbar, 'pointerdown', (e) => {
      e.preventDefault(); // (keep the selection)
      downAt = Date.now();
    });
    on(readbar, 'click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !selected) return;
      readbar.hidden = true;
      if (b.dataset.act === 'lookup') lookup(selected.text, selected.rect, selected.context);
      else if (b.dataset.act === 'read' || b.dataset.act === 'read-on') reader.readSelection(selected.text, selected.context.page, b.dataset.act === 'read-on');
      else await navigator.clipboard?.writeText(selected.text).catch(() => {});
    });
    on(pagesEl, 'scroll', () => { if (!readbar.classList.contains('is-docked') && readerScrolled()) readbar.hidden = true; }, { passive: true });
  }

  /* ---------- References ---------- */

  const refsEl = document.createElement('aside');
  refsEl.className = 'paper-refs';
  refsEl.hidden = true;
  refsEl.setAttribute('aria-label', 'References');
  viewer.append(refsEl);
  let refs = null; // the list, once read

  /** The text lines of page `p`: [{ text, x, y }], in the order of the PDF's text. */
  async function lines(p) {
    const c = await p.page.getTextContent();
    const out = [];
    let line = null;
    for (const item of c.items) {
      if (typeof item.str !== 'string') continue;
      const [x, y] = [item.transform[4], item.transform[5]];
      if (line && Math.abs(line.y - y) > Math.max(2, (item.height || 8) * 0.6) && item.str.trim()) {
        out.push(line);
        line = null;
      }
      if (!line && item.str.trim()) line = { text: '', x, y };
      if (line) line.text += item.str;
      if (item.hasEOL && line) {
        out.push(line);
        line = null;
      }
    }
    if (line) out.push(line);
    return out.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
  }

  const HEADING = /^(?:[\dIVX]+\.?\s+)?(references|bibliography|works cited|literature cited|references and notes|参考文献|引用文献)\.?$/i;
  const AFTER = /^(?:[A-Z]\.?\s+|\d+\.?\s+)?(appendix|appendices|supplementary|supplemental material|checklist)\b/i;

  /** The paper's reference list: [{ n, text, page, first, doi, arxiv, url }]. */
  async function readReferences() {
    // The last "References" heading, from the end.
    let start = null;
    const pageLines = [];
    for (let k = pages.length - 1; k >= 0 && !start; k--) {
      const ls = await lines(pages[k]);
      pageLines[k] = ls;
      for (let i = ls.length - 1; i >= 0; i--) {
        if (HEADING.test(ls[i].text)) {
          start = { k, i };
          break;
        }
      }
    }
    if (!start) return [];
    const all = [];
    for (let k = start.k; k < pages.length; k++) {
      const ls = pageLines[k] ?? await lines(pages[k]);
      const width = pages[k].page.view[2];
      for (const [i, l] of ls.entries()) {
        if (k === start.k && i <= start.i) continue;
        if (/^\d{1,4}$/.test(l.text)) continue; // a page number
        if (AFTER.test(l.text) && l.text.length < 60) return split(all);
        all.push({ ...l, page: k + 1, col: l.x < width * 0.45 ? 0 : 1 });
      }
    }
    return split(all);
  }

  /** The lines of a reference list into its entries. */
  function split(all) {
    if (!all.length) return [];
    const bracket = all.filter((l) => /^\[\d+\]/.test(l.text)).length;
    const numbered = all.filter((l) => /^\d{1,3}\.\s+\S/.test(l.text)).length;
    let starts;
    if (bracket >= 3) starts = (l) => /^\[\d+\]/.test(l.text);
    else if (numbered >= 3) starts = (l) => /^\d{1,3}\.\s+\S/.test(l.text);
    else {
      // Author–year: each entry's first line sticks out (a hanging indent).
      const left = new Map();
      for (const l of all) {
        const key = `${l.page}:${l.col}`;
        left.set(key, Math.min(left.get(key) ?? Infinity, l.x));
      }
      const indented = all.filter((l) => l.x > left.get(`${l.page}:${l.col}`) + 4).length;
      starts = indented >= all.length * 0.2
        ? (l) => l.x <= left.get(`${l.page}:${l.col}`) + 2
        : (l, prev) => !prev || (/[.)]$/.test(prev.text) && /^\p{Lu}[\p{L}'’-]+,/u.test(l.text));
    }
    const entries = [];
    let prev = null;
    for (const l of all) {
      if (!entries.length || starts(l, prev)) entries.push({ page: l.page, first: l.text, text: l.text });
      else {
        const e = entries[entries.length - 1];
        // A word hyphenated at the end of a line is joined again.
        e.text = /[a-z]-$/.test(e.text) && /^[a-z]/.test(l.text) ? e.text.slice(0, -1) + l.text : `${e.text} ${l.text}`;
      }
      prev = l;
    }
    return entries.slice(0, 1000).map((e, i) => {
      const doi = /\b(10\.\d{4,9}\/[^\s"<>]+)/.exec(e.text)?.[1].replace(/[.,;)\]]+$/, '');
      const arxiv = /arxiv(?:\.org\/abs\/|[:\s]+(?:preprint\s+)?(?:arxiv:)?)\s*(\d{4}\.\d{4,5})/i.exec(e.text)?.[1];
      const url = /https?:\/\/[^\s"<>]+/.exec(e.text)?.[0].replace(/[.,;)\]]+$/, '');
      return { n: i + 1, ...e, doi, arxiv, url };
    });
  }

  function renderRefs() {
    const head = `<div class="paper-refs-head"><b>References</b>${refs ? `<span class="count">${refs.length}</span>` : ''}
      <span class="pop-spacer"></span>${refs?.length ? '<button type="button" class="pop-btn" data-refs="copy">Copy all</button>' : ''}
      <button type="button" class="pop-icon" data-refs="close" aria-label="Close the references" title="Close (Esc)">×</button></div>`;
    if (!refs) {
      refsEl.innerHTML = `${head}<p class="muted">Reading the reference list…</p>`;
      return;
    }
    refsEl.innerHTML = `${head}${refs.length ? `<ol class="paper-refs-list">${refs.map((r) => `<li>
        <button type="button" class="paper-ref-text" data-ref="${r.n - 1}" title="Show it in the PDF (page ${r.page})">${esc(r.text)}</button>
        <span class="paper-ref-links">${r.doi ? `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener noreferrer">DOI ↗</a>` : ''}${
          r.arxiv ? `<a href="https://arxiv.org/abs/${esc(r.arxiv)}" target="_blank" rel="noopener noreferrer">arXiv ↗</a>` : ''}${
          r.url && !r.doi && !r.arxiv ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Link ↗</a>` : ''}<a href="https://scholar.google.com/scholar?q=${encodeURIComponent(r.text.slice(0, 250))}" target="_blank" rel="noopener noreferrer">Scholar ↗</a></span>
      </li>`).join('')}</ol>` : '<p class="muted">No reference list found: there is no “References” (or “Bibliography”) heading in the text.</p>'}`;
  }
  async function toggleRefs(open = refsEl.hidden) {
    refsEl.hidden = !open;
    bar.querySelector('[data-tool="refs"]')?.setAttribute('aria-pressed', String(open));
    if (!open) return;
    refsEl.style.top = `${bar.offsetHeight + (find.hidden ? 0 : find.offsetHeight)}px`; // (under the toolbar)
    if (!refs) {
      renderRefs();
      refs = await readReferences().catch((err) => {
        console.warn('references:', err);
        return [];
      });
    }
    renderRefs();
  }
  on(refsEl, 'click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.refs === 'close') toggleRefs(false);
    else if (b.dataset.refs === 'copy') {
      await navigator.clipboard?.writeText(refs.map((r) => r.text).join('\n')).catch(() => {});
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy all'; }, 1200);
    } else if (b.dataset.ref) {
      const r = refs[Number(b.dataset.ref)];
      if (window.matchMedia('(max-width: 700px)').matches) toggleRefs(false); // (over the pages on a phone)
      // Its first words, found on its page.
      const words = fold(r.first).split(' ');
      for (const n of [8, 5, 3]) if (await showMatch(r.page, words.slice(0, n).join(' '))) return;
    }
  });

  /** Where the references begin: { page, text } (their heading's line), or null. */
  async function referencesStart() {
    for (let k = pages.length - 1; k >= 0; k--) {
      const ls = await lines(pages[k]);
      for (let i = ls.length - 1; i >= 0; i--) if (HEADING.test(ls[i].text)) return { page: k + 1, text: ls[i].text };
    }
    return null;
  }

  /* ---------- Reading aloud (paper-tts.js) ---------- */

  const reader = attachReader({ el, viewer, bar, pages, pagesEl, ready, matchesOnPage, scrollTo, referencesStart });
  cleanups.push(() => reader.destroy());

  /* ---------- The toolbar, keys ---------- */

  on(bar, 'click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const tool = b.dataset.tool;
    if (tool === 'find') (find.hidden ? openFind() : closeFind());
    else if (tool === 'refs') toggleRefs();
    else if (tool === 'full') setFull(!isFull());
    else if (tool === 'comments') el.classList.toggle('show-comments');
    else if (tool === 'cards') openCards();
    else if (tool === 'tts') reader.toggle();
  });
  on(document, 'keydown', (e) => {
    const inPaper = isFull() || el.contains(document.activeElement);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && inPaper) {
      e.preventDefault();
      openFind();
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      if (!lookupEl.hidden) closeLookup();
      else if (!refsEl.hidden) toggleRefs(false);
      else if (!find.hidden && inPaper) closeFind();
      else if (isFull() && !document.querySelector('.paper-pop:not([hidden]).paper-editor')) setFull(false);
    }
  });
  on(document, 'pointerdown', (e) => {
    if (!lookupEl.hidden && !lookupEl.contains(e.target) && !readbar?.contains(e.target)) closeLookup();
  });
  on(pagesEl, 'scroll', () => { if (!lookupEl.classList.contains('is-docked') && readerScrolled()) closeLookup(); }, { passive: true });

  return {
    lookup,
    contextOfSelection,
    /** Read a selection aloud: just it, or on from it (`onwards`). */
    readAloud: (text, page, onwards) => reader.readSelection(text, page, onwards),
    openFind,
    setFull,
    destroy() {
      setFull(false);
      for (const f of cleanups) f();
      find.remove();
      refsEl.remove();
    },
  };
}

const ICON_SPEAK = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4"/></svg>';
const ICON_BOOK = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5c2-1 4-1 5.5.5v9c-1.5-1.5-3.5-1.5-5.5-.5zM13.5 3.5c-2-1-4-1-5.5.5v9c1.5-1.5 3.5-1.5 5.5-.5z"/></svg>';
