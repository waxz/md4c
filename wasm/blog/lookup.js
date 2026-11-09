// Look up (the selection bars of the PDF viewer, the editor and the
// reader's articles): a word's IPA by accent with play buttons, meanings
// and translations; a phrase or sentence translated and said; Save keeps
// it as a flash card (cards.js).
//
// Asks the Free Dictionary (English words: meaning, IPA, recordings),
// Wikipedia (terms; Japanese ones on ja.wikipedia.org) and MyMemory
// (translation), only when "Look up" is pressed; the pages' CSP allows
// those hosts and no others.
//
// createLookup({ popup(cls), place(node, rect) }) -> { lookup(text, rect,
// { context, page }), close(), el, destroy() }.

import { deck, ipaHtml, speak, useCardsCss } from './cards.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLookup({ popup, place }) {
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

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

  // Closed by a press elsewhere, or Escape.
  on(document, 'pointerdown', (e) => {
    if (!lookupEl.hidden && !lookupEl.contains(e.target) && !e.target.closest?.('.paper-selbar')) closeLookup();
  });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !lookupEl.hidden) {
      e.preventDefault();
      closeLookup();
    }
  });

  return {
    lookup,
    close: closeLookup,
    el: lookupEl,
    destroy() {
      for (const f of cleanups) f();
      lookupEl.remove();
    },
  };
}
