// Citations and a bibliography, as in a paper: BibTeX entries, cited in a
// post as Pandoc does, with an author-year or a numeric style.
//
//   [@vaswani2017]              (Vaswani et al., 2017)        [1]
//   [@vaswani2017, p. 5]        (Vaswani et al., 2017, p. 5)  [1, p. 5]
//   [see @a; @b]                (see A, 2019; B, 2020)        [see 1, 2]
//   [-@vaswani2017]             (2017)                        [1]
//   @vaswani2017 says           Vaswani et al. (2017) says    Vaswani et al. [1] says
//
// The entries come from .bib files (front matter "bibliography:", the
// site's "bibliography" setting) and from ```bibtex blocks in the post.
// The references cited are listed at the end of the post ("References"),
// each linked back to where it is cited.
//
// Shared by the blog and the admin (render.js does the page's part); no DOM.

export const STYLES = ['author-year', 'numeric'];

/** "numeric" or "author-year" (the default). */
export const citeStyle = (v) => (/^num/i.test(String(v ?? '').trim()) ? 'numeric' : 'author-year');

/* ---------- BibTeX ---------- */

const COMBINING = {
  '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', u: '̆', '.': '̇',
  '"': '̈', r: '̊', H: '̋', v: '̌', c: '̧', k: '̨', d: '̣', b: '̱',
};
const LETTERS = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', oe: 'œ', OE: 'Œ', i: 'ı', j: 'ȷ' };

/** TeX in a BibTeX value as plain text (accents as letters; $math$ kept for KaTeX). */
export function texToText(s) {
  return String(s ?? '').split(/(\$[^$]*\$)/).map((part, i) => {
    if (i % 2) return part; // math
    return part
      .replace(/\\url\s*\{([^}]*)\}/g, '$1')
      .replace(/\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|mathrm|text)\s*\{/g, '{')
      .replace(/\\([`'^"~=.uvHcdbrk])\s*(?:\{\s*(?:\\([ij])|([A-Za-z]))\s*\}|\\([ij])\b|([A-Za-z]))/g,
        (_, acc, i1, l1, i2, l2) => ((i1 || i2) ? (i1 || i2) === 'i' ? 'i' : 'j' : (l1 || l2)) + COMBINING[acc])
      .replace(/\\(ss|ae|AE|aa|AA|oe|OE|o|O|l|L|i|j)\b\s*/g, (_, l) => LETTERS[l])
      .replace(/\\([&%$_#{}])/g, '$1')
      .replace(/---/g, '—').replace(/--/g, '–')
      .replace(/``|''/g, (q) => (q === '``' ? '“' : '”'))
      .replace(/~/g, ' ')
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '');
  }).join('').replace(/\s+/g, ' ').trim().normalize('NFC');
}

/**
 * BibTeX entries: Map key -> { type, key, fields: { lowercase name: raw value } }.
 * Lenient: a broken entry is skipped, the rest is read.
 */
export function parseBibtex(text) {
  const src = String(text ?? '');
  const entries = new Map();
  const strings = new Map(Object.entries({
    jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
    jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
  }));
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const balanced = (open, close) => { // at src[i] === open; returns the inside
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === open) depth++;
      else if (src[i] === close && --depth === 0) return src.slice(start, i++);
    }
    throw new Error('unbalanced');
  };
  const quoted = () => { // at '"'
    let depth = 0;
    const start = ++i;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      else if (src[i] === '"' && depth === 0) return src.slice(start, i++);
    }
    throw new Error('unclosed quote');
  };
  const value = () => {
    let out = '';
    for (;;) {
      ws();
      if (src[i] === '{') out += balanced('{', '}');
      else if (src[i] === '"') out += quoted();
      else {
        const m = /^[^\s,#}\)]+/.exec(src.slice(i));
        if (!m) break;
        i += m[0].length;
        out += strings.get(m[0].toLowerCase()) ?? m[0];
      }
      ws();
      if (src[i] !== '#') break;
      i++;
    }
    return out;
  };
  while ((i = src.indexOf('@', i)) !== -1) {
    i++;
    const m = /^([A-Za-z]+)\s*([{(])/.exec(src.slice(i));
    if (!m) continue;
    const type = m[1].toLowerCase();
    i += m[0].length - 1;
    const close = m[2] === '{' ? '}' : ')';
    const startBody = i;
    try {
      if (type === 'comment' || type === 'preamble') {
        balanced(m[2], close);
        continue;
      }
      i++;
      if (type === 'string') {
        ws();
        const name = /^[^\s=]+/.exec(src.slice(i))[0];
        i += name.length;
        ws();
        if (src[i] === '=') i++;
        strings.set(name.toLowerCase(), value());
        ws();
        if (src[i] === close) i++;
        continue;
      }
      ws();
      const key = /^[^\s,]+/.exec(src.slice(i))?.[0] ?? '';
      i += key.length;
      const fields = {};
      for (;;) {
        ws();
        if (src[i] === ',') i++;
        ws();
        if (src[i] === close || i >= src.length) { i++; break; }
        const name = /^[^\s=,}]+/.exec(src.slice(i))?.[0];
        if (!name) throw new Error('bad field');
        i += name.length;
        ws();
        if (src[i] !== '=') throw new Error('bad field');
        i++;
        fields[name.toLowerCase()] = value().trim();
      }
      if (key) entries.set(key, { type, key, fields });
    } catch {
      i = startBody + 1; // skip what could not be read
    }
  }
  return entries;
}

/** Split a BibTeX name list ("A and B and {C and D}") at its top-level "and"s. */
function splitNames(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  const words = String(s ?? '').split(/(\s+and\s+|[{}])/i);
  for (const w of words) {
    if (w === '{') depth++;
    else if (w === '}') depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(w)) {
      out.push(cur);
      cur = '';
    } else cur += w;
  }
  if (cur.trim()) out.push(cur);
  return out.map((n) => n.trim()).filter(Boolean);
}

/** A name: { last, first } ("Last, First", "First von Last", "{Corporate Name}"). */
function parseName(raw) {
  const n = raw.trim();
  if (/^\{[^{}]*\}$/.test(n)) return { last: texToText(n), first: '' };
  if (n.includes(',')) {
    const [last, ...rest] = n.split(',');
    return { last: texToText(last), first: texToText(rest[rest.length - 1] ?? '') };
  }
  const words = n.split(/\s+(?![^{]*\})/);
  let k = words.length - 1;
  while (k > 0 && /^[a-z]/.test(words[k - 1])) k--; // "van", "de la": part of the last name
  return { last: texToText(words.slice(k).join(' ')), first: texToText(words.slice(0, k).join(' ')) };
}

const initials = (first) => first.split(/\s+/).filter(Boolean)
  .map((w) => w.split('-').map((p) => (p.endsWith('.') ? p : `${[...p][0]}.`)).join('-')).join(' ');

/* ---------- Formatting ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Text with its $…$ as <x-equation>s (typeset by the page, as in posts). */
const withMath = (s) => esc(s).replace(/\$([^$]+)\$/g, '<x-equation>$1</x-equation>');

/** An entry, ready to format: names, year, title, … as plain text. */
function prepare(entry) {
  const f = entry.fields;
  const people = splitNames(f.author).map(parseName);
  const editors = splitNames(f.editor).map(parseName);
  const year = texToText(f.year || String(f.date ?? '').slice(0, 4)) || 'n.d.';
  return { ...entry, people, editors, year, title: texToText(f.title), f };
}

/** The names in a citation: "Vaswani", "Vaswani & Shazeer", "Vaswani et al." (narrative: "and"). */
function shortNames(e, narrative) {
  const list = e.people.length ? e.people : e.editors;
  if (!list.length) return e.title ? `“${e.title.length > 40 ? `${e.title.slice(0, 40)}…` : e.title}”` : e.key;
  if (list.length === 1) return list[0].last;
  if (list.length === 2) return `${list[0].last} ${narrative ? 'and' : '&'} ${list[1].last}`;
  return `${list[0].last} et al.`;
}

/** An entry as it appears in the references list (HTML; APA-like). `year`: as cited ("2019a"). */
export function referenceHtml(entry, { year } = {}) {
  const e = prepare(entry);
  if (year) e.year = year;
  const f = e.f;
  const t = (k) => texToText(f[k]);
  const names = (list) => {
    const ns = list.map((p) => (p.first ? `${p.last}, ${initials(p.first)}` : p.last));
    if (ns.length <= 1) return ns.join('');
    if (ns.length > 20) return `${ns.slice(0, 19).join(', ')}, … ${ns[ns.length - 1]}`;
    return `${ns.slice(0, -1).join(', ')}, & ${ns[ns.length - 1]}`;
  };
  const parts = [];
  const who = e.people.length ? names(e.people) : e.editors.length ? `${names(e.editors)} (Ed${e.editors.length > 1 ? 's' : ''}.)` : '';
  const italicTitle = /^(book|phdthesis|mastersthesis|thesis|techreport|report|manual|proceedings)$/.test(e.type);
  const title = e.title ? (italicTitle ? `<em>${withMath(e.title)}</em>` : withMath(e.title)) : '';
  if (who) parts.push(`${esc(who)} (${esc(e.year)}).`);
  if (title) parts.push(`${title}${/[.?!]$/.test(e.title) ? '' : '.'}`);
  if (!who) parts.push(`(${esc(e.year)}).`);
  const pages = t('pages');
  if (f.journal || f.journaltitle) {
    let c = `<em>${withMath(t('journal') || t('journaltitle'))}</em>`;
    if (f.volume) c += `, <em>${esc(t('volume'))}</em>`;
    if (f.number) c += `(${esc(t('number'))})`;
    if (pages) c += `, ${esc(pages)}`;
    parts.push(`${c}.`);
  } else if (f.booktitle) {
    parts.push(`In ${e.editors.length && e.people.length ? `${esc(names(e.editors))} (Ed${e.editors.length > 1 ? 's' : ''}.), ` : ''}<em>${withMath(t('booktitle'))}</em>${pages ? ` (pp. ${esc(pages)})` : ''}.`);
  } else if (pages) parts.push(`pp. ${esc(pages)}.`);
  const kind = /phdthesis/.test(e.type) ? 'Doctoral dissertation' : /mastersthesis/.test(e.type) ? 'Master’s thesis' : '';
  if (kind) parts.push(`[${kind}${f.school ? `, ${esc(t('school'))}` : ''}].`);
  else if (f.institution && /report/.test(e.type)) parts.push(`${esc(t('institution'))}.`);
  if (f.publisher && !kind) parts.push(`${esc(t('publisher'))}.`);
  if (f.eprint && /arxiv/i.test(f.archiveprefix ?? f.eprinttype ?? 'arxiv') && !f.journal) parts.push(`arXiv:${esc(t('eprint'))}.`);
  else if (f.howpublished) parts.push(`${esc(t('howpublished'))}.`);
  if (f.note) parts.push(`${withMath(t('note'))}.`);
  const doi = String(f.doi ?? '').replace(/^\s*(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '').trim();
  const url = doi ? `https://doi.org/${doi}` : /^https?:\/\//.test(t('url')) ? t('url') : '';
  if (url) parts.push(`<a href="${esc(url)}" rel="noopener">${esc(url)}</a>`);
  return parts.join(' ');
}

/** The plain-text form of a reference (for a citation's tooltip). */
export const referenceText = (entry) => referenceHtml(entry).replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* ---------- Citations in text ---------- */

const KEY = '[A-Za-z0-9_][\\w:.#$%&+?<>~/-]*';
const BRACKET_RE = new RegExp(`\\[([^\\[\\]\\n]*?-?@${KEY}[^\\[\\]\\n]*)\\]`, 'g');
const NARRATIVE_RE = new RegExp(`(^|[\\s(\\u00a0])@(${KEY})`, 'g');
/** Cross-reference labels: figures, tables, equations, sections. */
export const XREF_RE = /^(fig|tbl|eq|sec):[\w.:-]+$/;
const LABEL_RE = /\{#((?:fig|tbl|eq|sec):[\w.:-]+)\}/g;

/** A key as written, without the punctuation that ends a sentence after it. */
function trimKey(key, known) {
  let k = key;
  while (k && !known(k) && /[.:,;?]$/.test(k)) k = k.slice(0, -1);
  return k;
}

/**
 * The citations, cross-references and labels in a piece of text, in order:
 * [{ text }, { cite: [{ key, prefix, suffix, suppress }], narrative },
 *  { xref: label }, { label }]. `known(key)`: whether a key is in the
 * bibliography (a narrative @key is only a citation then).
 */
export function citationTokens(text, known = () => false) {
  const tokens = [];
  const s = String(text);
  const found = [];
  for (const m of s.matchAll(BRACKET_RE)) {
    const items = m[1].split(';').map((part) => {
      const im = new RegExp(`^([\\s\\S]*?)(-?)@(${KEY})([\\s\\S]*)$`).exec(part);
      if (!im) return null;
      const key = trimKey(im[3], known);
      return { key, prefix: im[1].trim(), suffix: (im[3].slice(key.length) + im[4]).replace(/^\s*,\s*/, '').trim(), suppress: im[2] === '-' };
    });
    if (items.some((x) => !x)) continue;
    found.push({ at: m.index, end: m.index + m[0].length, token: items.length === 1 && XREF_RE.test(items[0].key) ? { xref: items[0].key } : { cite: items, narrative: false } });
  }
  const inside = (at) => found.some((f) => at >= f.at && at < f.end);
  for (const m of s.matchAll(NARRATIVE_RE)) {
    const at = m.index + m[1].length;
    if (inside(at)) continue;
    const key = trimKey(m[2], known);
    if (XREF_RE.test(key)) found.push({ at, end: at + 1 + key.length, token: { xref: key } });
    else if (known(key)) found.push({ at, end: at + 1 + key.length, token: { cite: [{ key, prefix: '', suffix: '', suppress: false }], narrative: true } });
  }
  for (const m of s.matchAll(LABEL_RE)) if (!inside(m.index)) found.push({ at: m.index, end: m.index + m[0].length, token: { label: m[1] } });
  found.sort((a, b) => a.at - b.at);
  let pos = 0;
  for (const f of found) {
    if (f.at < pos) continue;
    if (f.at > pos) tokens.push({ text: s.slice(pos, f.at) });
    tokens.push(f.token);
    pos = f.end;
  }
  if (pos < s.length) tokens.push({ text: s.slice(pos) });
  return tokens;
}

/** An id-safe form of a key. */
export const keyId = (key) => String(key).replace(/[^\w-]/g, '_');

/**
 * A bibliography for one post: `entries` (from parseBibtex, merged), the
 * style, and the keys cited in order (`use(keys)` as they are found, then
 * `citationHtml` / `referencesHtml`).
 */
export function createBibliography(entries, { style = 'author-year', nocite = '' } = {}) {
  const order = []; // keys cited, first citation first
  const counts = new Map(); // key -> citations so far (for ids and back-links)
  const known = (k) => entries.has(k);
  let suffixes = null;

  /** Note keys in citation order (call for every citation first). */
  function use(keys) {
    for (const k of keys) if (known(k) && !order.includes(k)) order.push(k);
    suffixes = null;
  }
  const listed = () => {
    const extra = String(nocite ?? '').trim();
    const more = extra === '*' || /^all$/i.test(extra) ? [...entries.keys()]
      : extra.split(/[,\s]+/).map((k) => k.replace(/^@/, '')).filter(known);
    return [...order, ...more.filter((k) => !order.includes(k))];
  };
  /** "2017a", "2017b": the same names and year, told apart (author-year). */
  function yearOf(key) {
    if (!suffixes) {
      suffixes = new Map();
      const groups = new Map();
      for (const k of listed()) {
        const e = prepare(entries.get(k));
        const g = `${shortNames(e, false)}|${e.year}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(k);
      }
      for (const ks of groups.values()) {
        if (ks.length < 2) continue;
        ks.sort((a, b) => prepare(entries.get(a)).title.localeCompare(prepare(entries.get(b)).title));
        ks.forEach((k, n) => suffixes.set(k, String.fromCharCode(97 + (n % 26))));
      }
    }
    return prepare(entries.get(key)).year + (suffixes.get(key) ?? '');
  }
  const number = (key) => order.indexOf(key) + 1;

  /** The HTML of one citation ({ cite, narrative } from citationTokens). */
  function citationHtml({ cite, narrative }) {
    const link = (item, text) => {
      if (!known(item.key)) return `<span class="cite-missing" title="Not in the bibliography">${esc(item.key)}?</span>`;
      const n = (counts.get(item.key) ?? 0) + 1;
      counts.set(item.key, n);
      return `<a class="cite-ref" href="#ref-${keyId(item.key)}" id="cite-${keyId(item.key)}-${n}" data-cite="${esc(item.key)}" title="${esc(referenceText(entries.get(item.key)))}">${text}</a>`;
    };
    const pre = (it) => (it.prefix ? `${esc(it.prefix)} ` : '');
    const post = (it) => (it.suffix ? `, ${esc(it.suffix)}` : '');
    if (style === 'numeric') {
      if (narrative) {
        const it = cite[0];
        return known(it.key) ? `${esc(shortNames(prepare(entries.get(it.key)), true))} [${link(it, String(number(it.key)))}]` : link(it, '');
      }
      return `<span class="cite-group">[${cite.map((it) => `${pre(it)}${known(it.key) ? link(it, String(number(it.key))) : link(it, '')}${post(it)}`).join(', ')}]</span>`;
    }
    if (narrative) {
      const it = cite[0];
      if (!known(it.key)) return link(it, '');
      const e = prepare(entries.get(it.key));
      return link(it, `${esc(shortNames(e, true))} (${esc(yearOf(it.key))}${post(it)})`);
    }
    return `<span class="cite-group">(${cite.map((it) => {
      if (!known(it.key)) return link(it, '');
      const e = prepare(entries.get(it.key));
      return `${pre(it)}${link(it, it.suppress ? esc(yearOf(it.key)) : `${esc(shortNames(e, false))}, ${esc(yearOf(it.key))}`)}${post(it)}`;
    }).join('; ')})</span>`;
  }

  /** The "References" section: the entries cited (and `nocite`), each linked back to its citations. */
  function referencesHtml() {
    let keys = listed();
    if (!keys.length) return '';
    if (style !== 'numeric') {
      const sortKey = (k) => {
        const e = prepare(entries.get(k));
        return `${(e.people[0] ?? e.editors[0])?.last ?? e.title}\u0000${yearOf(k)}\u0000${e.title}`.toLowerCase();
      };
      keys = [...keys].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    }
    const items = keys.map((k) => {
      const backs = Array.from({ length: counts.get(k) ?? 0 }, (_, i) => `<a class="ref-back" href="#cite-${keyId(k)}-${i + 1}" aria-label="Back to citation ${i + 1}">↩</a>`).join(' ');
      return `<li id="ref-${keyId(k)}"${style === 'numeric' && order.includes(k) ? ` value="${number(k)}"` : ''}>${referenceHtml(entries.get(k), { year: style === 'numeric' ? '' : yearOf(k) })}${backs ? ` <span class="ref-backs">${backs}</span>` : ''}</li>`;
    });
    return `<section class="references" id="references">
<h2 class="references-title">References</h2>
<${style === 'numeric' ? 'ol' : 'ul'} class="references-list ${style}">
${items.join('\n')}
</${style === 'numeric' ? 'ol' : 'ul'}>
</section>`;
  }

  return { use, citationHtml, referencesHtml, known, style };
}
