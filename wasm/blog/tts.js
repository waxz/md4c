// Reading aloud: the speech engine and its player, for any text. A
// "source" gives what to read and shows where: the PDF viewer's
// (paper-tts.js) or an article's (article-tts.js).
//
// Two voices:
//   - this browser's (the Web Speech API): everywhere, free, offline;
//   - an OpenAI-style speech API (POST …/audio/speech), in the admin only:
//     its Worker calls it (api/tts/speech), with the key kept in Cloudflare
//     (Settings, Text to speech), so no key is ever in a page. A visitor of
//     the blog has the browser's voice only.
//
// createReader({ source, mount(player), button, root }): the player is
// docked at the bottom of the window, the same for a PDF and an article
// (unless `mount` puts it elsewhere); `button` shows whether it is open.
// source = {
//   units(): Promise<[{ say, … }]>  what to read, in order
//   referencesAt                    the first unit of the references (after units()), or null
//   mark(unit), clear()             show the unit read; stop showing it
//   label(unit, i, until)           the player's status ("Page 3 · 12 / 190")
//   fromView(): Promise<index>      where ▶ starts (without a selection)
//   indexAtSelection(text, where)   the unit a selection starts in
//   selection()                     the reader's selection in this text: { text, where }, or null
//   empty                           what to say when there is nothing to read
// }
// Only one reader speaks at a time: starting one stops the others.

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

/** What is said for a piece of text: words broken at the end of a line joined, citation numbers left out. */
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
 * Text in sentences: [{ start, end, text }] (offsets in `text`). Very
 * short ones join the next.
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


let speaking = null; // the reader that speaks now

/** The speaker icon of every "Read aloud" button. */
export const SPEAK_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4"/></svg>';
// The player's words, the same wherever it reads.
const TITLE = {
  play: 'Read aloud from what is in view, or from the selected text',
  pause: 'Pause',
  resume: 'Resume',
};

/** The player at the bottom of the window. */
function dock(player) {
  const box = document.createElement('div');
  box.className = 'tts-dock';
  box.append(player);
  document.body.append(box);
  new MutationObserver(() => box.classList.toggle('is-open', !player.hidden)).observe(player, { attributes: true, attributeFilter: ['hidden'] });
  return box;
}

export function createReader({ source, mount = null, button = null, root = null }) {
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  let p = prefs();
  const synth = window.speechSynthesis;

  /* ---------- Saying it ---------- */

  let units = null; // the source's units, once read
  const textUnits = async () => (units ??= await source.units());

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
    if (!list.length) return status(source.empty ?? 'No text to read here.');
    if (speaking && speaking !== self) speaking.stop();
    speaking = self;
    stop(false);
    const myRun = ++run;
    at = Math.max(0, Math.min(from, list.length - 1));
    const referencesAt = source.referencesAt ?? null;
    until = to ?? (p.toReferences || referencesAt === null || at >= referencesAt ? list.length - 1 : referencesAt - 1);
    state = 'playing';
    render();
    mediaSession();
    while (myRun === run && at <= until) {
      status();
      source.mark(list[at]);
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
      source.clear();
      status(at > until && until < list.length - 1 && referencesAt !== null ? 'Read up to the references.' : 'Read to the end.');
      render();
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
      source.clear();
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
      <button type="button" data-tts="play" class="tts-main" aria-label="Read aloud" title="${TITLE.play}">▶</button>
      <button type="button" data-tts="prev" aria-label="Previous sentence" title="Previous sentence">⏮</button>
      <button type="button" data-tts="next" aria-label="Next sentence" title="Next sentence">⏭</button>
      <select data-pref="rate" aria-label="Speed" title="Speed">${[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
      <span class="tts-status muted" aria-live="polite"></span>
      <button type="button" data-tts="more" aria-expanded="false" aria-label="Voice" title="Voice, and what to read">⚙</button>
      <button type="button" data-tts="close" class="tts-close" aria-label="Stop and close" title="Stop and close">×</button>
    </div>
    <div class="tts-row tts-settings" hidden>
      <select data-pref="engine" aria-label="Voice from"><option value="browser">This browser's voice</option><option value="api" disabled>Speech API (Settings)</option></select>
      <select data-pref="voice" aria-label="Voice"></select>
      <label class="tts-refs"><input type="checkbox" data-pref="toReferences"> the references too</label>
    </div>`;
  const docked = mount ? (mount(player), null) : dock(player);
  const statusEl = player.querySelector('.tts-status');
  function status(text) {
    if (text !== undefined) {
      statusEl.textContent = text;
      return;
    }
    if (units && at >= 0) statusEl.textContent = source.label(units[at], at, until);
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
    main.title = state === 'playing' ? TITLE.pause : state === 'paused' ? TITLE.resume : TITLE.play;
    player.querySelector('[data-pref="engine"]').value = p.engine === 'api' && apiOk ? 'api' : 'browser';
    player.querySelector('[data-pref="rate"]').value = String(p.rate);
    player.querySelector('[data-pref="toReferences"]').checked = p.toReferences;
    button?.setAttribute('aria-pressed', String(!player.hidden));
    root?.classList.toggle('is-reading', state !== 'stopped');
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
    player.hidden = true;
    render();
  }
  /** Read on from the selection, if there is one here; else from what is in view. */
  async function start() {
    await textUnits();
    const sel = source.selection?.();
    play(sel ? await source.indexAtSelection(sel.text, sel.where) : await source.fromView());
  }

  // (Pressing a button keeps the text selected.)
  on(player, 'pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  on(player, 'click', async (e) => {
    const b = e.target.closest('[data-tts]');
    if (!b) return;
    const act = b.dataset.tts;
    if (act === 'play') {
      if (state === 'playing') pause();
      else if (state === 'paused') resume();
      else start();
    } else if (act === 'prev') skip(-1);
    else if (act === 'next') skip(1);
    else if (act === 'more') {
      const box = player.querySelector('.tts-settings');
      box.hidden = !box.hidden;
      b.setAttribute('aria-expanded', String(!box.hidden));
    } else if (act === 'close') closePlayer();
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

  const self = {
    open: openPlayer,
    /** "Read aloud": reads at once (from the selection, else what is in view); again, stops and closes. */
    async toggle() {
      if (!player.hidden) return closePlayer();
      await openPlayer();
      start();
    },
    /** Read on from a selection (`where`: its Range, as the source knows it). */
    async readFrom(where) {
      await openPlayer();
      await textUnits();
      play(await source.indexAtSelection('', where));
    },
    stop,
    destroy() {
      stop(false);
      for (const f of cleanups) f();
      player.remove();
      docked?.remove();
    },
  };
  return self;
}
