// Unsaved changes, kept in this browser: one entry per draft (and one per
// new post being written), saved on every change, dropped once the draft is
// saved. Nothing asks before leaving the editor: the banner (admin.js) says
// how many drafts have unsaved changes, and the Storage page lists them to
// reopen or discard. localStorage, so a closing tab still keeps the last
// keystroke.
//
// Entry: { text, slug, title, at, store, key } — store/key: where the draft
// is kept (null for a new post, with `target`, the store it will go to).

const PREFIX = 'md4c-admin:';
const RESTORE = 'md4c-admin-restore';
let open = ''; // the entry of the post open in the editor (not counted)

/** The entry key for a draft, or for a new post (`newId`). */
export const entryKey = (store, key, newId) => (store && key ? `${PREFIX}${store}:${key}` : `${PREFIX}new:${newId}`);
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const changed = () => window.dispatchEvent(new CustomEvent('unsaved'));

export function keep(k, data) {
  try {
    localStorage.setItem(k, JSON.stringify({ ...data, at: Date.now() }));
  } catch {}
  changed();
}

export function read(k) {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null');
  } catch {
    return null;
  }
}

export function drop(...keys) {
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
  changed();
}

/** Every entry, newest first: [{ id, text, slug, title, at, store, key, target }]. */
export function list() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const id = localStorage.key(i);
      if (!id?.startsWith(PREFIX)) continue;
      const e = read(id);
      if (e?.text) out.push({ ...e, id });
    }
  } catch {}
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The entries other than the post open in the editor. */
export const others = () => list().filter((e) => e.id !== open);

export function setOpen(k) {
  open = k ?? '';
  changed();
}

/** Open an entry in the editor with its text restored. */
export function reopen(e) {
  try {
    sessionStorage.setItem(RESTORE, e.id);
  } catch {}
  location.hash = e.store && e.key ? `#/edit/${e.store}/${e.key}` : `#/new/${e.target ?? ''}`;
}

/** The entry to restore at once (set by reopen), taken. */
export function takeRestore() {
  try {
    const id = sessionStorage.getItem(RESTORE);
    sessionStorage.removeItem(RESTORE);
    return id;
  } catch {
    return null;
  }
}

// Other tabs change them too.
window.addEventListener('storage', (e) => {
  if (!e.key || e.key.startsWith(PREFIX)) changed();
});
