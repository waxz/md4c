// Blog admin app: routes between the folder explorer, the post editor and
// the site settings. Runs behind Cloudflare Access on the admin hostname;
// everything it changes goes through the Worker's checked file API.
//
// Routes (<store> = "site" or a draft store id):
//   #/posts                     drafts and published posts (home)
//   #/files/<store>/<prefix>    folder explorer
//   #/edit/<store>/<key>        post editor;  #/new[/<store>]  a new post
//   #/view/<store>/<key>        file details; #/text/<store>/<key> text editor
//   #/storage                   draft stores; add WebDAV, S3 or GitHub storage
//   #/settings                  site settings and rebuild

import { api } from './client.js';
import { showPosts } from './posts.js';

// Views other than the posts list load when first opened.
let editorModule = null;
const editor = async () => (editorModule ??= await import('./editor.js'));
const explorer = () => import('./explorer.js');
const hasUnsavedChanges = () => editorModule?.hasUnsavedChanges() ?? false;
import { DEFAULT_SITE, googleTagId, normalizeSite } from './lib/site-config.js';
import { dialog, esc, init, publicUrl, rebuildSite, reportError, state, toast } from './shared.js';

const view = document.getElementById('view');
let lastHash = location.hash;

function parseRoute() {
  const [, name = 'posts', store = 'site', ...rest] = location.hash.replace(/^#/, '').split('/');
  return { name, store: store || 'site', path: decodeURIComponent(rest.join('/')) };
}

async function route() {
  const r = parseRoute();
  const section = { edit: 'posts', new: 'new', view: 'files', text: 'files' }[r.name] ?? r.name;
  document.querySelectorAll('.app-nav a').forEach((a) => {
    a.setAttribute('aria-current', String(a.dataset.route === section));
  });
  try {
    if (r.name === 'new') await (await editor()).showEditor(view, null, null, location.hash.split('/')[2]);
    else if (r.name === 'edit') await (await editor()).showEditor(view, r.store, r.path);
    else if (r.name === 'view') await (await explorer()).showFile(view, r.store, r.path);
    else if (r.name === 'text') await (await editor()).showTextEditor(view, r.store, r.path);
    else if (r.name === 'settings') await showSettings();
    else if (r.name === 'storage') await (await import('./storage.js')).showStorage(view);
    else if (r.name === 'files') await (await explorer()).showFiles(view, r.store, r.path);
    else await showPosts(view);
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
    <div class="settings-form grid">
      <label class="field"><span>Title</span><input data-key="title" maxlength="120"></label>
      <label class="field"><span>Slogan</span><input data-key="slogan" maxlength="200"></label>
      <label class="field"><span>Author</span><input data-key="author" maxlength="120"></label>
      <div class="field"><span>Home page banner (wide image above the articles)</span><span class="field-row">
        <input data-key="banner" aria-label="Home page banner" autocapitalize="off" spellcheck="false" placeholder="assets/banner.jpg">
        <label class="btn btn-small">Upload<input type="file" accept="image/*" data-upload="banner" hidden></label></span></div>
      <div class="field"><span>Background image</span><span class="field-row">
        <input data-key="backgroundImage" aria-label="Background image" autocapitalize="off" spellcheck="false" placeholder="assets/background.jpg">
        <label class="btn btn-small">Upload<input type="file" accept="image/*" data-upload="backgroundImage" hidden></label></span></div>
      <label class="field"><span>Google tag ID (paste the ID or Google's whole snippet; empty: none)</span>
        <input data-key="googleTag" aria-label="Google tag ID" autocapitalize="characters" spellcheck="false" placeholder="G-XXXXXXXXXX"></label>
      <label class="field"><span>Background shown</span><select data-key="backgroundMode">
        <option value="hero">behind the title (masthead)</option><option value="page">behind the whole page</option></select></label>
      <fieldset class="field span-2 checks"><legend>In every post (a post's front matter can say otherwise)</legend>
        <label><input type="checkbox" data-key="numberedHeadings"> <span>Number the sections (1, 1.1, …) <code>numbered:</code></span></label>
        <label><input type="checkbox" data-key="toc"> <span>"Contents" box when a post has two or more sections <code>toc:</code></span></label>
        <label><input type="checkbox" data-key="graph"> <span>Cross-references and the Graph page</span></label>
        <label><input type="checkbox" data-key="citation"> <span>"How to cite" box</span></label>
      </fieldset>
    </div>
    <p class="hint">Everything else is in the <code>site</code> section of <code>index.json</code> below: theme, colours, links,
      search-engine verification, full-text search engine and more (see the deploy guide). Saving re-renders every page.
      A post can set its own <code>banner</code> and <code>background</code> in its front matter.</p>
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
  ta.addEventListener('input', () => {
    parse();
    fillForm();
  });
  // The form edits the same JSON: each field is one key of "site".
  const formFields = [...view.querySelectorAll('.settings-form [data-key]')];
  const fillForm = () => {
    let obj = {};
    try {
      obj = JSON.parse(ta.value || '{}') ?? {};
    } catch {
      return;
    }
    for (const el of formFields) {
      if (el.type === 'checkbox') el.checked = typeof obj[el.dataset.key] === 'boolean' ? obj[el.dataset.key] : DEFAULT_SITE[el.dataset.key];
      else if (document.activeElement !== el) el.value = obj[el.dataset.key] ?? (el.tagName === 'SELECT' ? 'hero' : '');
    }
  };
  const setKey = (key, value) => {
    let obj;
    try {
      obj = JSON.parse(ta.value || '{}') ?? {};
    } catch {
      toast('Fix the JSON below first.', 'error');
      return;
    }
    if (value === '') delete obj[key];
    else obj[key] = value;
    ta.value = JSON.stringify(obj, null, 2);
    parse();
  };
  for (const el of formFields) {
    if (el.type === 'checkbox') el.addEventListener('change', () => setKey(el.dataset.key, el.checked));
    else if (el.dataset.key === 'googleTag') {
      // Google's whole snippet may be pasted: keep only its ID.
      el.addEventListener('input', () => {
        const id = googleTagId(el.value);
        if (id && id !== el.value.trim()) el.value = id;
        setKey('googleTag', id || (el.value.trim() ? el.value.trim() : ''));
      });
    } else el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => setKey(el.dataset.key, el.value.trim()));
  }
  for (const input of view.querySelectorAll('.settings-form input[data-upload]')) {
    input.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      // Site images are public: they go to assets/ in the published site.
      const [key] = await (await explorer()).uploadFiles('site', 'assets/', files);
      if (!key) return;
      setKey(input.dataset.upload, key);
      fillForm();
    });
  }
  parse();
  fillForm();
  view.querySelector('.settings').addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    try {
      // Both run in the background: see the Activity panel.
      if (act === 'save') {
        const obj = parse();
        if (obj) {
          toast('Saving the settings and rebuilding every page in the background.', 'info');
          rebuildSite({ site: obj, full: true }).then(() => toast('Settings saved; every page rebuilt.', 'success'), () => {});
        }
      } else if (act === 'rebuild') {
        rebuildSite({ full: true }).then(() => toast('Every page rebuilt.', 'success'), () => {});
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
  if (!location.hash) history.replaceState(null, '', '#/posts');
  route();
}

main();
