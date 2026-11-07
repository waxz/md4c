// Flash cards: words and phrases saved while reading (blog/paper-tools.js),
// reviewed with spaced repetition (blog/cards.js). Pure functions: the
// cards are plain objects, kept by the browser.
//
// A card: { id, term, kind ('word' | 'phrase'), lang, ipa: [{ text, audio,
// region }], meaning, translation, to (its language), context, source:
// { title, href, page }, added, due, interval (days), ease, reps, lapses,
// last }.
//
// Scheduling is SM-2, simplified: "again" brings a card back in ten
// minutes and starts it over; "hard", "good" and "easy" space it out by
// its ease (2.5 to start, 1.3 at least), which they lower or raise.

export const GRADES = ['again', 'hard', 'good', 'easy'];
const MINUTE = 60e3;
const DAY = 864e5;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The same word or phrase, whatever its case or spacing: one card for it. */
export const cardKey = (c) => `${c.lang ?? 'en'}\n${clip(c.term, 500).toLowerCase()}`;

function newId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `c-${Array.from(b, (x) => '0123456789abcdefghijklmnopqrstuvwxyz'[x % 36]).join('')}`;
}

/** A card as kept: known fields only, of sensible sizes; null if it has no term. */
export function cleanCard(c) {
  if (!c || typeof c !== 'object' || !clip(c.term, 500)) return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const url = (v) => (/^https?:\/\//i.test(String(v ?? '')) ? String(v).slice(0, 1000) : '');
  return {
    id: /^c-[a-z0-9]{4,16}$/.test(c.id ?? '') ? c.id : newId(),
    term: clip(c.term, 500),
    kind: c.kind === 'phrase' ? 'phrase' : 'word',
    lang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(c.lang ?? '') ? c.lang : 'en',
    ipa: (Array.isArray(c.ipa) ? c.ipa : []).slice(0, 4).map((p) => ({
      text: clip(p?.text, 80), audio: url(p?.audio), region: clip(p?.region, 8),
    })).filter((p) => p.text || p.audio),
    meaning: clip(c.meaning, 1000),
    translation: clip(c.translation, 1000),
    to: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(c.to ?? '') ? c.to : '',
    context: clip(c.context, 600),
    source: c.source && typeof c.source === 'object' ? {
      title: clip(c.source.title, 200), href: url(c.source.href), page: Math.max(0, Math.trunc(num(c.source.page, 0))),
    } : null,
    added: num(c.added, Date.now()),
    due: num(c.due, Date.now()),
    interval: Math.max(0, num(c.interval, 0)),
    ease: Math.min(3, Math.max(1.3, num(c.ease, 2.5))),
    reps: Math.max(0, Math.trunc(num(c.reps, 0))),
    lapses: Math.max(0, Math.trunc(num(c.lapses, 0))),
    ...(c.last ? { last: num(c.last, 0) } : {}),
  };
}

/** A new card, due now. */
export const newCard = (fields, now = Date.now()) => cleanCard({ ...fields, id: undefined, added: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0 });

/** The card after answering it with `grade` ("again", "hard", "good", "easy"). */
export function review(card, grade, now = Date.now()) {
  const g = GRADES.indexOf(grade);
  if (g < 0) throw new Error(`Unknown grade: ${grade}`);
  if (g === 0) {
    return { ...card, reps: 0, lapses: card.lapses + 1, interval: 0, ease: Math.max(1.3, card.ease - 0.2), due: now + 10 * MINUTE, last: now };
  }
  let interval;
  if (card.reps === 0) interval = [0, 1, 1, 4][g];
  else if (card.reps === 1) interval = [0, 3, 6, 8][g];
  else interval = Math.round(Math.max(1, card.interval) * [0, 1.2, card.ease, card.ease * 1.3][g]);
  interval = Math.max(1, interval);
  return {
    ...card,
    reps: card.reps + 1,
    interval,
    ease: Math.min(3, Math.max(1.3, card.ease + [0, -0.15, 0, 0.15][g])),
    due: now + interval * DAY,
    last: now,
  };
}

export const isDue = (card, now = Date.now()) => card.due <= now;

/** When answering `grade` would bring the card back: "10 min", "1 d", "3 mo"… */
export function nextLabel(card, grade, now = Date.now()) {
  return spanLabel(review(card, grade, now).due - now);
}

/** A span of time, short: "10 min", "5 h", "3 d", "2 mo", "1.5 y". */
export function spanLabel(ms) {
  if (ms < 90 * MINUTE) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < 20 * 3600e3) return `${Math.round(ms / 3600e3)} h`;
  const d = ms / DAY;
  if (d < 45) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${Math.round(d / 36.5) / 10} y`;
}

/** Cards from a file (JSON: a list, or { cards }): cleaned, one per word or phrase. */
export function parseCards(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : [];
  return mergeCards([], list.map(cleanCard).filter(Boolean));
}

/** `a` and `b` together, one card per word or phrase: the one reviewed more (else the later) wins. */
export function mergeCards(a, b) {
  const byKey = new Map();
  for (const c of [...a, ...b]) {
    const k = cardKey(c);
    const had = byKey.get(k);
    if (!had || c.reps > had.reps || (c.reps === had.reps && (c.last ?? c.added) > (had.last ?? had.added))) byKey.set(k, c);
  }
  return [...byKey.values()];
}

/** CSV for Anki and spreadsheets: front, back (IPA, meaning, translation), context, source. */
export function toCsv(cards) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = cards.map((c) => [
    c.term,
    [c.ipa.map((p) => p.text).filter(Boolean).join(' '), c.meaning, c.translation].filter(Boolean).join(' — '),
    c.context,
    c.source ? `${c.source.title}${c.source.page ? `, p. ${c.source.page}` : ''} ${c.source.href}`.trim() : '',
  ].map(cell).join(','));
  return `${['Front', 'Back', 'Context', 'Source'].map(cell).join(',')}\n${rows.join('\n')}\n`;
}
