// Reading a paper aloud (the PDF viewer's 🔊, paper-tools.js).
//
// The text of the PDF, page by page, is cut into sentences and read one
// after another, the one being read marked on its page and kept in view.
// Start at the page in view (▶), at a sentence clicked after ⌖, or at a
// selection ("From here"); or read just a selection ("Read").
//
// Two voices:
//   - this browser's (the Web Speech API): everywhere, free, offline;
//   - an OpenAI-style speech API (POST …/audio/speech), in the admin only:
//     its Worker calls it (api/tts/speech), with the key kept in Cloudflare
//     (Settings, Text to speech), so no key is ever in a page. A visitor of
//     the blog has the browser's voice only.
//
// attachReader(ctx): ctx = { el, viewer, bar, pages, pagesEl, ready(p),
// matchesOnPage(p, query), scrollTo(p, y), referencesStart() }.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => s.replace(/\s+/g, ' ').toLowerCase();
const PREFS = 'md4c-tts';
const API_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

function prefs() {
  try {
    return { engine: 'browser', rate: 1, voice: '', apiVoice: '', toReferences: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') };
  } catch {
    return { engine: 'browser', rate: 1, voice: '', apiVoice: '', toReferences: false };
  }
}
function keepPrefs(p) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {}
}

/** What is said for a piece of the PDF's text: words broken at the end of a line joined, citation numbers left out. */
export function speakable(text) {
  return text
    .replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2')
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .replace(/https?:\/\/[^\s)\]]+/g, 'a link')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
    .replace(/[∗*†‡§¶]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A page's text in sentences: [{ start, end, text }] (offsets in `text`,
 * the page's text with spaces folded). Very short ones join the next.
 */
export function sentences(text, lang = 'en') {
  const parts = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const s of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)) parts.push({ start: s.index, end: s.index + s.segment.length });
  } else {
    const re = /[^.!?。！？]+(?:[.!?。！？]+["”’)]*|$)\s*/g;
    for (let m = re.exec(text); m && m[0]; m = re.exec(text)) parts.push({ start: m.index, end: m.index + m[0].length });
  }
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    // "Fig. 3", "e.g." and lone numbers are not sentences of their own.
    if (last && (last.end - last.start < 40 || /\b(?:fig|eq|sec|e\.g|i\.e|et al|vs|cf)\.\s*$/i.test(text.slice(last.start, last.end)))) last.end = p.end;
    else out.push({ ...p });
  }
  return out.map((s) => ({ ...s, text: text.slice(s.start, s.end).trim() })).filter((s) => s.text);
}

export function attachReader(ctx) {
  const { el, viewer, bar, pages, pagesEl, ready, matchesOnPage, scrollTo, referencesStart } = ctx;
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  let p = prefs();
  const synth = window.speechSynthesis;

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

  /* ---------- Saying it ---------- */

  let run = 0; // each start or stop begins a new run: what an older one does is dropped
  let at = -1; // the unit being read
  let until = -1; // the last unit to read
  let state = 'stopped'; // 'playing' | 'paused' | 'stopped'
  let audio = null;
  const fetched = new Map(); // unit index -> Promise<blob URL> (the API)
  let aborter = new AbortController(); // the API's requests of this run: cancelled on stop (they cost)
  let apiOk = null; // whether the admin's speech API is there (null: not asked yet)

  function voices() {
    const all = synth?.getVoices() ?? [];
    const lang = (document.documentElement.lang || 'en').slice(0, 2);
    return all.filter((v) => v.lang.toLowerCase().startsWith(lang)).sort((a, b) => Number(b.localService) - Number(a.localService));
  }

  /** The admin's speech API: { model, voice } when it can be used here, else null. */
  async function api() {
    if (apiOk !== null) return apiOk;
    try {
      const res = await fetch(new URL('./api/tts', import.meta.url), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const cfg = res.ok && /json/.test(res.headers.get('content-type') ?? '') ? await res.json() : null;
      apiOk = cfg?.configured ? cfg : false;
    } catch {
      apiOk = false;
    }
    return apiOk;
  }

  async function apiAudio(i) {
    if (!fetched.has(i)) {
      const u = units[i];
      fetched.set(i, (async () => {
        const res = await fetch(new URL('./api/tts/speech', import.meta.url), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-admin-request': '1' },
          body: JSON.stringify({ input: u.say, voice: p.apiVoice || undefined, speed: p.rate }),
          signal: aborter.signal,
        });
        if (!res.ok) {
          const msg = await res.json().then((d) => d.error, () => '');
          throw new Error(msg || `The speech service answered ${res.status}`);
        }
        return URL.createObjectURL(await res.blob());
      })());
      fetched.get(i).catch(() => fetched.delete(i));
    }
    return fetched.get(i);
  }
  function forgetAudio() {
    aborter.abort();
    aborter = new AbortController();
    for (const pr of fetched.values()) pr.then((url) => URL.revokeObjectURL(url), () => {});
    fetched.clear();
  }

  /** Say unit `i`; resolves when it has been said (or the run is over). */
  async function sayUnit(i, myRun) {
    const u = units[i];
    if (p.engine === 'api' && (await api())) {
      const url = await apiAudio(i);
      for (const k of [i + 1, i + 2]) if (k <= until && units[k]) apiAudio(k).catch(() => {}); // (the next ones meanwhile)
      if (myRun !== run) return;
      audio ??= new Audio();
      audio.src = url;
      audio.playbackRate = 1;
      await audio.play();
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.onpause = () => { if (state === 'stopped' || myRun !== run) resolve(); };
      });
      return;
    }
    if (!synth) throw new Error('This browser cannot read aloud.');
    await new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(u.say);
      const v = voices().find((x) => x.name === p.voice);
      if (v) utter.voice = v;
      utter.lang = v?.lang ?? document.documentElement.lang ?? 'en';
      utter.rate = p.rate;
      utter.onend = resolve;
      utter.onerror = resolve;
      synth.speak(utter);
    });
  }

  async function play(from, to = null) {
    const list = await textUnits();
    if (!list.length) return status('No text to read in this PDF (it may be scanned images).');
    stop(false);
    const myRun = ++run;
    at = Math.max(0, Math.min(from, list.length - 1));
    until = to ?? (p.toReferences || referencesAt === null || at >= referencesAt ? list.length - 1 : referencesAt - 1);
    state = 'playing';
    render();
    mediaSession();
    while (myRun === run && at <= until) {
      status();
      markUnit(list[at]);
      try {
        await sayUnit(at, myRun);
      } catch (err) {
        if (myRun !== run) return;
        status(err.message);
        state = 'stopped';
        render();
        return;
      }
      while (myRun === run && state === 'paused') await new Promise((r) => setTimeout(r, 150));
      if (myRun !== run) return;
      at++;
    }
    if (myRun === run) {
      state = 'stopped';
      clearMark();
      status(at > until && until < list.length - 1 && referencesAt !== null ? 'Read up to the references.' : 'Read to the end.');
      render();
    }
  }

  /** Read just `text` (a selection), not as part of the paper. */
  async function sayText(text) {
    stop(false);
    const myRun = ++run;
    const say = speakable(text);
    if (!say) return;
    state = 'playing';
    render();
    status('Reading the selection…');
    let failed = false;
    try {
      if (p.engine === 'api' && (await api())) {
        const res = await fetch(new URL('./api/tts/speech', import.meta.url), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-admin-request': '1' },
          body: JSON.stringify({ input: say.slice(0, 4000), voice: p.apiVoice || undefined, speed: p.rate }),
        });
        if (!res.ok) throw new Error(await res.json().then((d) => d.error, () => '') || `The speech service answered ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        if (myRun !== run) return;
        audio ??= new Audio();
        audio.src = url;
        await audio.play();
        await new Promise((r) => { audio.onended = r; audio.onerror = r; audio.onpause = () => { if (myRun !== run || state === 'stopped') r(); }; });
        URL.revokeObjectURL(url);
      } else {
        if (!synth) throw new Error('This browser cannot read aloud.');
        await new Promise((resolve) => {
          const utter = new SpeechSynthesisUtterance(say);
          const v = voices().find((x) => x.name === p.voice);
          if (v) utter.voice = v;
          utter.rate = p.rate;
          utter.onend = resolve;
          utter.onerror = resolve;
          synth.speak(utter);
        });
      }
    } catch (err) {
      failed = true;
      status(err.message);
    }
    if (myRun === run) {
      state = 'stopped';
      render();
      if (!failed) status('');
    }
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    if (audio && !audio.paused) audio.pause();
    else synth?.pause();
    render();
  }
  function resume() {
    if (state !== 'paused') return;
    state = 'playing';
    if (audio?.src && audio.paused && !audio.ended && p.engine === 'api') audio.play().catch(() => {});
    else synth?.resume();
    render();
  }
  function stop(redraw = true) {
    run++;
    state = 'stopped';
    synth?.cancel();
    if (audio) {
      audio.onpause = null;
      audio.pause();
    }
    forgetAudio();
    if (redraw) {
      clearMark();
      render();
      status('');
    }
  }
  /** Jump `by` sentences, reading on from there. */
  function skip(by) {
    if (at < 0 || !units) return;
    play(Math.max(0, Math.min(units.length - 1, at + by)), until);
  }

  /* ---------- The player ---------- */

  const player = document.createElement('div');
  player.className = 'paper-tts';
  player.hidden = true;
  player.setAttribute('role', 'region');
  player.setAttribute('aria-label', 'Read aloud');
  player.innerHTML = `<div class="tts-row">
      <button type="button" data-tts="play" class="tts-main" aria-label="Read aloud" title="Read from the page in view">▶</button>
      <button type="button" data-tts="prev" aria-label="Previous sentence" title="Previous sentence">⏮</button>
      <button type="button" data-tts="next" aria-label="Next sentence" title="Next sentence">⏭</button>
      <button type="button" data-tts="stop" aria-label="Stop" title="Stop">⏹</button>
      <button type="button" data-tts="pick" aria-pressed="false" title="Click a sentence in the PDF to read from there">⌖ Start here</button>
      <span class="tts-status muted" aria-live="polite"></span>
      <button type="button" data-tts="close" class="tts-close" aria-label="Close the reader" title="Close">×</button>
    </div>
    <div class="tts-row tts-settings">
      <select data-pref="engine" aria-label="Voice from"><option value="browser">This browser's voice</option><option value="api" disabled>Speech API (Settings)</option></select>
      <select data-pref="voice" aria-label="Voice"></select>
      <select data-pref="rate" aria-label="Speed">${[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
      <label class="tts-refs"><input type="checkbox" data-pref="toReferences"> the references too</label>
    </div>`;
  (viewer.querySelector('.paper-find') ?? bar).after(player);
  const statusEl = player.querySelector('.tts-status');
  function status(text) {
    if (text !== undefined) {
      statusEl.textContent = text;
      return;
    }
    if (units && at >= 0) statusEl.textContent = `Page ${units[at].page} · ${at + 1} / ${until + 1}`;
  }

  function fillVoices() {
    const sel = player.querySelector('[data-pref="voice"]');
    if (p.engine === 'api' && apiOk) {
      const names = [...new Set([apiOk.voice, ...API_VOICES].filter(Boolean))];
      sel.innerHTML = names.map((n) => `<option value="${esc(n)}"${n === (p.apiVoice || apiOk.voice) ? ' selected' : ''}>${esc(n)}</option>`).join('');
    } else {
      const vs = voices();
      sel.innerHTML = `<option value="">Default voice</option>${vs.map((v) => `<option value="${esc(v.name)}"${v.name === p.voice ? ' selected' : ''}>${esc(v.name)}${v.localService ? '' : ' (online)'}</option>`).join('')}`;
    }
  }
  function render() {
    const main = player.querySelector('[data-tts="play"]');
    main.textContent = state === 'playing' ? '⏸' : '▶';
    main.setAttribute('aria-label', state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Read aloud');
    main.title = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Read from the page in view';
    player.querySelector('[data-pref="engine"]').value = p.engine === 'api' && apiOk ? 'api' : 'browser';
    player.querySelector('[data-pref="rate"]').value = String(p.rate);
    player.querySelector('[data-pref="toReferences"]').checked = p.toReferences;
    bar.querySelector('[data-tool="tts"]')?.setAttribute('aria-pressed', String(!player.hidden));
    el.classList.toggle('is-reading', state !== 'stopped');
  }

  async function openPlayer() {
    player.hidden = false;
    render();
    fillVoices();
    const cfg = await api();
    const opt = player.querySelector('[data-pref="engine"] option[value="api"]');
    opt.disabled = !cfg;
    opt.textContent = cfg ? `Speech API (${cfg.model})` : 'Speech API (set it up in the admin: Settings)';
    render();
    fillVoices();
  }
  function closePlayer() {
    stop();
    setPick(false);
    player.hidden = true;
    render();
  }

  /** The unit at the top of the page in view. */
  async function fromView() {
    const pg = pages.find((x) => x.el.offsetTop + x.el.offsetHeight > pagesEl.scrollTop + 40) ?? pages[0];
    const list = await textUnits();
    const i = list.findIndex((u) => u.page >= pg.n);
    return i < 0 ? 0 : i;
  }

  // ⌖: the next click on the PDF's text says where to start.
  let picking = false;
  function setPick(onOff) {
    picking = onOff;
    player.querySelector('[data-tts="pick"]').setAttribute('aria-pressed', String(onOff));
    pagesEl.classList.toggle('is-picking', onOff);
    if (onOff) status('Click the sentence to start from.');
  }
  on(pagesEl, 'click', async (e) => {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    setPick(false);
    const page = Number(e.target.closest('.paper-page')?.dataset.page);
    if (!page) return;
    play(await unitAt(page, probeAt(e.clientX, e.clientY)));
  }, true);
  /** The text from the point (x, y) on: what is under the pointer, and after it. */
  function probeAt(x, y) {
    let node;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      [node, offset] = [c?.offsetNode, c?.offset ?? 0];
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      [node, offset] = [r?.startContainer, r?.startOffset ?? 0];
    }
    const span = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.textLayer span');
    if (!span) return '';
    // From the start of its word, on through the next spans.
    let text = span.textContent.slice(0, offset).replace(/\S*$/, '').length;
    text = span.textContent.slice(text);
    for (let s = span.nextElementSibling; s && text.length < 60; s = s.nextElementSibling) text += s.tagName === 'BR' ? ' ' : ` ${s.textContent}`;
    return text;
  }

  on(player, 'click', async (e) => {
    const b = e.target.closest('[data-tts]');
    if (!b) return;
    const act = b.dataset.tts;
    if (act === 'play') {
      if (state === 'playing') pause();
      else if (state === 'paused') resume();
      else play(await fromView());
    } else if (act === 'stop') stop();
    else if (act === 'prev') skip(-1);
    else if (act === 'next') skip(1);
    else if (act === 'pick') setPick(!picking);
    else if (act === 'close') closePlayer();
  });
  on(player, 'change', (e) => {
    const key = e.target.dataset.pref;
    if (!key) return;
    if (key === 'rate') p.rate = Number(e.target.value);
    else if (key === 'toReferences') p.toReferences = e.target.checked;
    else if (key === 'engine') p.engine = e.target.value;
    else if (key === 'voice') {
      if (p.engine === 'api') p.apiVoice = e.target.value;
      else p.voice = e.target.value;
    }
    keepPrefs(p);
    if (key === 'engine') fillVoices();
    // Heard from the next sentence on.
    if (state === 'playing' && key !== 'toReferences') {
      forgetAudio();
      play(at, until);
    }
    render();
  });
  if (synth) on(synth, 'voiceschanged', () => { if (!player.hidden) fillVoices(); });
  // Leaving the page, or another tab taking the voice: stop.
  on(window, 'pagehide', () => stop(false));

  /** The phone's lock screen and headphone buttons (when the API's audio plays). */
  function mediaSession() {
    if (!navigator.mediaSession) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({ title: document.querySelector('.article-title')?.textContent || document.title, artist: 'Read aloud' });
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
    set('play', resume);
    set('pause', pause);
    set('stop', () => stop());
    set('previoustrack', () => skip(-1));
    set('nexttrack', () => skip(1));
  }

  return {
    open: openPlayer,
    toggle: () => (player.hidden ? openPlayer() : closePlayer()),
    /** Read a selection: just it, or (`onwards`) on from it to the end. */
    async readSelection(text, page, onwards) {
      await openPlayer();
      if (onwards) play(await unitAt(page, text));
      else sayText(text);
    },
    stop,
    destroy() {
      stop(false);
      for (const f of cleanups) f();
      player.remove();
    },
  };
}
