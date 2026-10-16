// State and helpers shared by the admin views.

import { loadMd4c } from './lib/md4c.js';
import { normalizeSite } from './lib/site-config.js';
import { build, readIndex } from './lib/site-build.js';
import { adminStorage, api, ApiError } from './client.js';

export const state = {
  session: null, // { email, publicUrl, drafts, maxUploadMb }
  md4c: null,
  site: null, // normalized site settings
  rawSite: null,
};

export async function init() {
  // Session, Markdown engine and site settings load side by side.
  const md4c = loadMd4c(new URL('./lib/md4c.wasm', import.meta.url));
  const index = readIndex(adminStorage('site'));
  state.session = await api.session();
  [state.md4c] = await Promise.all([md4c, index.then(applySiteIndex)]);
}

function applySiteIndex(index) {
  state.rawSite = index?.site ?? null;
  state.site = normalizeSite(state.rawSite, state.session.publicUrl || location.href);
}

export async function refreshSite() {
  applySiteIndex(await readIndex(adminStorage('site')));
}

export const draftStores = () => state.session.stores.filter((s) => s.role === 'drafts');
export const storeLabel = (id) => state.session.stores.find((s) => s.id === id)?.label ?? id;
export const isDraftStore = (id) => draftStores().some((s) => s.id === id);

export function publicUrl(key) {
  return state.session.publicUrl ? new URL(key, state.session.publicUrl).href : '';
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
 * Run the shared site build against the public bucket, showing progress.
 * Returns the build result. Options as for lib/site-build.js build().
 */
export async function rebuildSite(opts = {}) {
  const log = document.createElement('pre');
  log.className = 'build-log';
  const status = document.createElement('p');
  status.textContent = opts.full ? 'Rebuilding every page…' : 'Updating the site…';
  const body = document.createElement('div');
  body.append(status, log);
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = '<h2>Publishing</h2>';
  dlg.append(body);
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  try {
    const result = await build(adminStorage('site'), state.md4c, {
      ...opts,
      log: (line) => {
        log.textContent += `${line}\n`;
        log.scrollTop = log.scrollHeight;
      },
    });
    await refreshSite();
    dlg.close();
    dlg.remove();
    toast(`Site updated: ${result.rendered.length} page(s) rendered${result.removed.length ? `, ${result.removed.length} removed` : ''}.`, 'success');
    return result;
  } catch (err) {
    status.textContent = `The build stopped: ${err.message ?? err}`;
    status.className = 'error';
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = 'Close';
    close.addEventListener('click', () => { dlg.close(); dlg.remove(); });
    body.append(close);
    throw err;
  }
}
