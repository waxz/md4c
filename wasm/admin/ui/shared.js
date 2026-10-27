// State and helpers shared by the admin views.

import { normalizeSite } from './lib/site-config.js';
import { api, ApiError } from './client.js';
import { LOCAL_STORE } from './local-store.js';
import { requestBuild } from './tasks.js';

// The Markdown engine and the site build load only when first needed
// (editor, publishing), so the posts list and the explorer start light.
let md4cPromise;
/** md4c.wasm, loaded once; also kept in state.md4c. */
export function getMd4c() {
  md4cPromise ??= import('./lib/md4c.js')
    .then(({ loadMd4c }) => loadMd4c(new URL('./lib/md4c.wasm', import.meta.url)))
    .then((m) => (state.md4c = m));
  return md4cPromise;
}

/** The site's index.json as an object, or null. */
async function readSiteIndex() {
  try {
    const doc = JSON.parse((await api.read('site', 'index.json')).text);
    return doc && typeof doc === 'object' ? (Array.isArray(doc) ? { items: doc } : doc) : null;
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof ApiError && err.status === 404)) return null;
    throw err;
  }
}

export const state = {
  session: null, // { email, publicUrl, drafts, maxUploadMb }
  md4c: null,
  site: null, // normalized site settings
  rawSite: null,
};

// The last session and site settings, for when the server cannot be reached
// (signed out of Cloudflare Access, offline): the admin still opens, with
// the drafts kept in this browser.
const SESSION_CACHE = 'md4c-admin-session';
function remember(data) {
  try {
    localStorage.setItem(SESSION_CACHE, JSON.stringify({ ...JSON.parse(localStorage.getItem(SESSION_CACHE) ?? '{}'), ...data }));
  } catch {}
}
function remembered() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_CACHE) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export async function init() {
  // Session and site settings load side by side.
  const index = readSiteIndex().catch((err) => {
    if (err.code !== 'offline') throw err;
    return { site: remembered().rawSite ?? null };
  });
  try {
    state.session = await api.session();
    remember({ session: { email: state.session.email, publicUrl: state.session.publicUrl } });
  } catch (err) {
    if (err.code !== 'offline') throw err;
    const last = remembered().session ?? {};
    state.session = {
      email: last.email ?? '', publicUrl: last.publicUrl ?? '', kv: false, problems: [], maxUploadMb: 100,
      stores: [{ id: 'site', label: 'Published site', role: 'site', type: 'r2', location: 'deploy' }, LOCAL_STORE],
      offline: true,
    };
  }
  applySiteIndex(await index);
}

function applySiteIndex(index) {
  state.rawSite = index?.site ?? null;
  state.site = normalizeSite(state.rawSite, state.session.publicUrl || location.href);
  if (!state.session.offline) remember({ rawSite: state.rawSite });
}

export async function refreshSite() {
  applySiteIndex(await readSiteIndex());
}

export const draftStores = () => state.session.stores.filter((s) => s.role === 'drafts');
export const storeLabel = (id) => state.session.stores.find((s) => s.id === id)?.label ?? id;
export const isDraftStore = (id) => draftStores().some((s) => s.id === id);

export function publicUrl(key) {
  return state.session.publicUrl ? new URL(key, state.session.publicUrl).href : '';
}

/** A page of the private blog (served by the admin at /blog/). */
export const privateUrl = (key = '') => new URL(`blog/${key}`, location.href.split('#')[0]).href;

/** The blog a post's page is on: "site" (public) or "private". */
export const blogLabel = (blog) => (blog === 'private' ? 'the private blog' : 'the public blog');

/**
 * The private blog's settings: the public site's, without what is only for
 * the public (its address, analytics, search engines), and marked private.
 */
export function privateSiteSettings(raw = state.rawSite ?? {}) {
  const { url, googleTag, verification, indexNowKey, ...rest } = raw ?? {};
  return { ...rest, title: `${rest.title || 'Blog'} · private`, search: 'none' };
}

/* ---------- Formatting ---------- */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A key-safe file name: lowercase letters, digits, ".", "_" and "-". */
export function safeName(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'file';
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return ext ? `${base}.${ext}` : base;
}

/* ---------- Toasts and dialogs ---------- */

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}

/**
 * A modal dialog. `buttons` = [{ label, value, kind }]; resolves with the
 * chosen value (or null when dismissed). `body` may be a string or a Node.
 */
export function dialog({ title, body, buttons = [{ label: 'OK', value: true, kind: 'primary' }], stacked = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `<form method="dialog"><h2></h2><div class="dialog-body"></div><div class="dialog-actions"></div></form>`;
    dlg.querySelector('h2').textContent = title;
    const content = dlg.querySelector('.dialog-body');
    if (typeof body === 'string') content.textContent = body;
    else if (body) content.append(body);
    const actions = dlg.querySelector('.dialog-actions');
    if (stacked) actions.classList.add('stacked');
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${b.kind ? `btn-${b.kind}` : ''}`;
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        dlg.close();
        resolve(b.value);
      });
      actions.append(btn);
    }
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog(title, message, label = 'Delete', kind = 'danger') {
  return dialog({ title, body: message, buttons: [
    { label: 'Cancel', value: false },
    { label, value: true, kind },
  ] });
}

export async function promptDialog(title, label, value = '') {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  wrap.innerHTML = `<span></span><input type="text" autocapitalize="off" autocomplete="off" spellcheck="false">`;
  wrap.querySelector('span').textContent = label;
  const input = wrap.querySelector('input');
  input.value = value;
  setTimeout(() => input.focus(), 0);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.closest('dialog').querySelector('.btn-primary').click();
    }
  });
  const ok = await dialog({ title, body: wrap, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, kind: 'primary' }] });
  return ok ? input.value.trim() : null;
}

/** Explain an API error to the user; returns true if it was a known conflict. */
export function reportError(err, what = 'That did not work') {
  console.error(err);
  toast(err instanceof ApiError ? err.message : `${what}: ${err.message ?? err}`, 'error');
}

/* ---------- Building the public site ---------- */

/**
 * Update the public site: the shared site build, run in the background
 * (tasks.js), one at a time; requests made while one waits join it.
 * Resolves with the build result. Options as for lib/site-build.js build().
 */
export function rebuildSite(opts = {}) {
  if (opts.target === 'private') return rebuildPrivate(opts);
  return requestBuild(opts, async (merged, { log, step }) => {
    step('Loading the site build…');
    const [{ build }, { adminStorage }, md4c] = await Promise.all([
      import('./lib/site-build.js'), import('./admin-storage.js'), getMd4c(),
    ]);
    // Markdown published before is moved out of the public bucket first:
    // readers get only the pages built from it.
    const { moved = [] } = await api.privateSources().catch((err) => {
      log(`note: the published Markdown could not be made private yet (${err.message ?? err})`);
      return {};
    });
    for (const key of moved) log(`private ${key} (removed from the public bucket)`);
    // The blog code's versions, deployed with the admin (site-assets.json).
    const assets = await fetch(new URL('./site-assets.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : undefined), () => undefined);
    step(merged.full ? 'Rendering every page…' : 'Rendering changed pages…');
    const result = await build(adminStorage('site'), md4c, {
      ...merged, ...(assets ? { assets } : {}), privateSources: Boolean(state.session?.privateSources),
      log: (line) => {
        log(line);
        if (/^(upload|delete) /.test(line)) step(line);
      },
    });
    await refreshSite();
    log(`${result.rendered.length} page(s) rendered${result.removed.length ? `, ${result.removed.length} removed` : ''}.`);
    window.dispatchEvent(new CustomEvent('site-updated'));
    return result;
  });
}

/**
 * Update the private blog (/blog/ on the admin): the same build, from the
 * private store, with the public site's settings (privateSiteSettings).
 */
export function rebuildPrivate(opts = {}) {
  if (!state.session?.privateBlog) return Promise.resolve(null);
  return requestBuild({ ...opts, target: 'private' }, async (merged, { log, step }) => {
    step('Loading the site build…');
    const [{ build }, { adminStorage }, md4c] = await Promise.all([
      import('./lib/site-build.js'), import('./admin-storage.js'), getMd4c(),
    ]);
    const assets = await fetch(new URL('./site-assets.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : undefined), () => undefined);
    step(merged.full ? 'Rendering every private page…' : 'Rendering changed private pages…');
    const result = await build(adminStorage('private'), md4c, {
      ...merged, site: privateSiteSettings(merged.site ?? state.rawSite), ...(assets ? { assets } : {}),
      log: (line) => {
        log(line);
        if (/^(upload|delete) /.test(line)) step(line);
      },
    });
    log(`${result.rendered.length} private page(s) rendered${result.removed.length ? `, ${result.removed.length} removed` : ''}.`);
    window.dispatchEvent(new CustomEvent('site-updated'));
    return result;
  });
}
