// Blog admin app: routes between the folder explorer, the post editor and
// the site settings. Runs behind Cloudflare Access on the admin hostname;
// everything it changes goes through the Worker's checked file API.
//
// Routes:
//   #/files/<bucket>/<prefix>   folder explorer (bucket: site | drafts)
//   #/edit/<bucket>/<key>       post editor;  #/new  a new post
//   #/view/<bucket>/<key>       file details; #/text/<bucket>/<key> text editor
//   #/settings                  site settings and rebuild

import { api } from './client.js';
import { hasUnsavedChanges, showEditor, showTextEditor } from './editor.js';
import { filesHref, showFile, showFiles } from './explorer.js';
import { DEFAULT_SITE, normalizeSite } from './lib/site-config.js';
import { dialog, esc, init, publicUrl, rebuildSite, reportError, state, toast } from './shared.js';

const view = document.getElementById('view');
let lastHash = location.hash;

function parseRoute() {
  const [, name = 'files', bucket = 'site', ...rest] = location.hash.replace(/^#/, '').split('/');
  return { name, bucket: bucket || 'site', path: decodeURIComponent(rest.join('/')) };
}

async function route() {
  const r = parseRoute();
  document.querySelectorAll('.app-nav a').forEach((a) => {
    a.setAttribute('aria-current', String(a.dataset.route === r.name || (a.dataset.route === 'files' && ['view', 'text'].includes(r.name))));
  });
  try {
    if (r.name === 'new') await showEditor(view);
    else if (r.name === 'edit') await showEditor(view, r.bucket, r.path);
    else if (r.name === 'view') await showFile(view, r.bucket, r.path);
    else if (r.name === 'text') await showTextEditor(view, r.bucket, r.path);
    else if (r.name === 'settings') await showSettings();
    else await showFiles(view, r.bucket === 'drafts' ? 'drafts' : 'site', r.path);
    lastHash = location.hash;
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    reportError(err);
    view.innerHTML = `<p class="error">${esc(err.message ?? err)}</p>`;
  }
}

async function showSettings() {
  const raw = JSON.stringify(state.rawSite ?? {}, null, 2);
  view.innerHTML = `<div class="settings">
    <h1>Site settings</h1>
    <p class="hint">The <code>site</code> section of <code>index.json</code>: title, slogan, theme, colours, background image,
      search-engine verification and more (see the deploy guide). Saving re-renders every page.</p>
    <textarea name="site" spellcheck="false" aria-label="Site settings (JSON)"></textarea>
    <p class="settings-check muted" aria-live="polite"></p>
    <div class="editor-actions">
      <button type="button" class="btn btn-primary" data-act="save">Save and rebuild</button>
      <button type="button" class="btn" data-act="rebuild">Rebuild all pages</button>
      ${state.site.indexNowKey && state.site.url ? '<button type="button" class="btn" data-act="indexnow">Notify search engines</button>' : ''}
    </div>
  </div>`;
  const ta = view.querySelector('textarea');
  ta.value = raw;
  const check = view.querySelector('.settings-check');
  const parse = () => {
    try {
      const obj = JSON.parse(ta.value || '{}');
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('must be a JSON object');
      const site = normalizeSite(obj, state.session.publicUrl || location.href);
      const known = new Set(Object.keys(DEFAULT_SITE));
      const ignored = Object.keys(obj).filter((k) => !known.has(k));
      check.className = ignored.length ? 'settings-check warn' : 'settings-check muted';
      check.textContent = ignored.length
        ? `These fields are unknown or invalid and will be ignored: ${ignored.join(', ')}`
        : `OK: "${site.title}", ${site.theme} theme, ${site.colorScheme} colours${site.url ? `, ${site.url}` : ' — set "url" for search engines'}.`;
      return obj;
    } catch (err) {
      check.className = 'settings-check error';
      check.textContent = `Not valid JSON: ${err.message}`;
      return null;
    }
  };
  ta.addEventListener('input', parse);
  parse();
  view.querySelector('.settings').addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'save') {
        const obj = parse();
        if (obj) await rebuildSite({ site: obj, full: true });
      } else if (act === 'rebuild') {
        await rebuildSite({ full: true });
      } else if (act === 'indexnow') {
        const items = await api.listAll('site', 'posts/');
        const urls = [publicUrl('index.html'), ...items.filter((i) => i.key.endsWith('.html')).map((i) => publicUrl(i.key))];
        const r = await api.indexNow(urls);
        toast(`Submitted ${r.submitted} URL(s) to IndexNow (HTTP ${r.status}).`, 'success');
      }
    } catch (err) {
      reportError(err);
    }
  });
}

window.addEventListener('hashchange', async () => {
  if (hasUnsavedChanges() && location.hash !== lastHash) {
    const leave = await dialog({
      title: 'Leave without saving?',
      body: 'Your changes are kept on this device and can be restored when you open the post again.',
      buttons: [{ label: 'Stay', value: false }, { label: 'Leave', value: true, kind: 'danger' }],
    });
    if (!leave) {
      history.replaceState(null, '', lastHash);
      return;
    }
  }
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges()) e.preventDefault();
});

async function main() {
  try {
    await init();
  } catch (err) {
    view.innerHTML = `<p class="error">${esc(err.message ?? err)}</p>`;
    return;
  }
  document.querySelector('.user').textContent = state.session.email;
  const site = document.querySelector('.view-site');
  if (state.session.publicUrl) site.href = publicUrl('index.html');
  else site.hidden = true;
  document.querySelector('.app-title').textContent = `${state.site.title} · Admin`;
  document.title = `Admin · ${state.site.title}`;
  if (!location.hash) history.replaceState(null, '', filesHref('site', 'posts/'));
  route();
}

main();
