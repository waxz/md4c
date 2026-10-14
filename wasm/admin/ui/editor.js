// Post editor: front matter fields, Markdown with a live preview in the
// blog's own theme, and the save / publish / update / unpublish flows. All
// conflict rules are enforced by the Worker; this view explains them.

import { api, ApiError } from './client.js';
import { parseFrontMatter, SLUG_RE } from './lib/post-format.js';
import { slugify } from './lib/blog-render.js';
import { finishArticle, renderLive } from './render.js';
import { uploadFiles, editHref, filesHref } from './explorer.js';
import {
  confirmDialog, dialog, draftStores, esc, formatTime, publicUrl, rebuildSite, reportError, state,
  storeLabel, toast,
} from './shared.js';

const KNOWN = ['title', 'date', 'tags', 'description', 'image'];
let current = null; // the open editor, for the leave-page guard

export function hasUnsavedChanges() {
  return Boolean(current?.dirty);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clean(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function compose(fields, extra, body) {
  const lines = ['---', `title: ${clean(fields.title)}`, `date: ${clean(fields.date)}`, `tags: ${clean(fields.tags)}`];
  if (clean(fields.description)) lines.push(`description: ${clean(fields.description)}`);
  if (clean(fields.image)) lines.push(`image: ${clean(fields.image)}`);
  for (const [k, v] of Object.entries(extra)) if (k !== 'draft') lines.push(`${k}: ${clean(v)}`);
  lines.push('---', '', body.replace(/^\s+/, ''));
  return lines.join('\n');
}

const storeKey = (store, key) => `md4c-admin:${store ?? 'new'}:${key ?? 'new'}`;
function saveLocal(k, data) {
  try { localStorage.setItem(k, JSON.stringify({ ...data, at: Date.now() })); } catch {}
}
function loadLocal(k) {
  try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; }
}
function dropLocal(k) {
  try { localStorage.removeItem(k); } catch {}
}

/** Insert Markdown around the selection of a textarea. */
function wrapSelection(ta, before, after = '', placeholder = '') {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const selected = value.slice(s, e) || placeholder;
  ta.setRangeText(`${before}${selected}${after}`, s, e, 'select');
  ta.setSelectionRange(s + before.length, s + before.length + selected.length);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function prefixLines(ta, prefix) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const start = value.lastIndexOf('\n', s - 1) + 1;
  const block = value.slice(start, e).split('\n').map((l) => `${prefix}${l}`).join('\n');
  ta.setRangeText(block, start, e, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Open the editor. `store`/`key` = an existing post (posts/<slug>.md in the
 * site or a draft store); omit both for a new post (`newStore` = the draft
 * store to start it in).
 */
export async function showEditor(view, store, key, newStore) {
  const isNew = !key;
  let etag = null;
  let source = `---\ntitle: \ndate: ${today()}\ntags: \n---\n\n`;
  if (!isNew) {
    try {
      ({ text: source, etag } = await api.read(store, key));
    } catch (err) {
      view.innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="#/posts">Back to posts</a></p>`;
      return;
    }
  }
  const { meta, body } = parseFrontMatter(source);
  const extra = Object.fromEntries(Object.entries(meta).filter(([k]) => !KNOWN.includes(k)));
  const stores = draftStores();
  const ed = {
    store: isNew ? null : store,
    key: isNew ? null : key,
    etag,
    // Where a new post (and its photos) will be saved.
    target: isNew ? (stores.find((s) => s.id === newStore) ?? stores[0])?.id ?? 'site' : store,
    slugTouched: !isNew,
    dirty: false,
    saved: source,
  };
  current = ed;
  const home = () => ed.store ?? ed.target;
  const status = () => (ed.store === 'site' ? 'Published' : ed.store ? 'Draft' : 'New');

  view.innerHTML = `<form class="editor" autocomplete="off" novalidate>
    <div class="editor-head">
      <a class="back" href="#/posts">← Posts</a>
      <span class="badge status-badge"></span>
      <span class="where muted"></span>
      <span class="save-state muted" aria-live="polite"></span>
    </div>
    <div class="restore" hidden></div>
    <details class="meta-fields" ${isNew ? 'open' : ''}>
      <summary>Title, date, tags…</summary>
      <div class="grid">
        <label class="field span-2"><span>Title</span><input name="title" required maxlength="200"></label>
        <label class="field"><span>Address (slug)</span><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" autocapitalize="off" spellcheck="false"><small class="slug-note"></small></label>
        <label class="field"><span>Date</span><input name="date" type="date" required></label>
        <label class="field span-2"><span>Tags (comma separated)</span><input name="tags" autocapitalize="off"></label>
        <label class="field span-2"><span>Description for search results (optional)</span><input name="description" maxlength="300"></label>
        <label class="field span-2"><span>Social preview image (optional, e.g. photo.jpg)</span><input name="image" autocapitalize="off" spellcheck="false"></label>
        ${isNew && stores.length > 1 ? `<label class="field span-2"><span>Keep the draft in</span><select name="target">${stores.map((s) =>
          `<option value="${esc(s.id)}"${s.id === ed.target ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>` : ''}
      </div>
    </details>
    <div class="pane-tabs" role="tablist">
      <button type="button" role="tab" data-pane="write" aria-selected="true">Write</button>
      <button type="button" role="tab" data-pane="preview" aria-selected="false">Preview</button>
    </div>
    <div class="panes" data-show="write">
      <div class="write-pane">
        <div class="md-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" data-md="bold" title="Bold"><b>B</b></button>
          <button type="button" data-md="italic" title="Italic"><i>I</i></button>
          <button type="button" data-md="h2" title="Section heading">H2</button>
          <button type="button" data-md="link" title="Link">Link</button>
          <button type="button" data-md="list" title="List">• List</button>
          <button type="button" data-md="quote" title="Quote">❝</button>
          <button type="button" data-md="code" title="Code">{ }</button>
          <button type="button" data-md="math" title="Math">∑</button>
          <label class="tb-upload" title="Insert image">Image<input type="file" accept="image/*" multiple hidden></label>
        </div>
        <textarea name="body" spellcheck="true" aria-label="Markdown"></textarea>
      </div>
      <div class="preview-pane"><iframe title="Preview" src="preview.html"></iframe></div>
    </div>
    <div class="editor-actions"></div>
  </form>`;

  const form = view.querySelector('form');
  const f = form.elements;
  f.title.value = meta.title ?? '';
  f.slug.value = isNew ? '' : key.slice(6, -3);
  f.date.value = /^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? '') ? meta.date : today();
  f.tags.value = meta.tags ?? '';
  f.description.value = meta.description ?? meta.summary ?? '';
  f.image.value = meta.image ?? '';
  f.body.value = body;
  f.target?.addEventListener('change', () => {
    ed.target = f.target.value;
    renderActions();
    schedulePreview();
  });

  const text = () => compose(
    { title: f.title.value, date: f.date.value, tags: f.tags.value, description: f.description.value, image: f.image.value },
    extra, f.body.value
  );
  const slug = () => f.slug.value.trim();
  const local = storeKey(ed.store, ed.key);

  // ---- Actions ----
  const actions = form.querySelector('.editor-actions');
  function renderActions() {
    const badge = form.querySelector('.status-badge');
    badge.textContent = status();
    badge.dataset.status = status().toLowerCase();
    form.querySelector('.where').textContent = ed.store === 'site' ? '' : `in ${storeLabel(home())}`;
    const live = ed.store === 'site' ? publicUrl(`posts/${ed.key.slice(6, -3)}.html`) : '';
    actions.innerHTML = [
      ed.store === 'site'
        ? '<button type="button" class="btn btn-primary" data-act="update">Update</button>'
        : '<button type="button" class="btn btn-primary" data-act="publish">Publish</button>',
      stores.length && ed.store !== 'site' ? '<button type="button" class="btn" data-act="draft">Save draft</button>' : '',
      stores.length && ed.store === 'site' ? '<button type="button" class="btn" data-act="unpublish">Unpublish</button>' : '',
      live ? `<a class="btn" href="${esc(live)}" target="_blank" rel="noopener">View</a>` : '',
      ed.store ? '<button type="button" class="btn btn-danger-text" data-act="delete">Delete</button>' : '',
    ].join('');
    form.querySelector('.slug-note').textContent = ed.store === 'site'
      ? 'Changing the address of a published post breaks existing links.' : '';
  }
  renderActions();

  function setDirty(d) {
    ed.dirty = d;
    form.querySelector('.save-state').textContent = d ? 'Unsaved changes' : (ed.etag ? 'Saved' : '');
  }

  // ---- Preview ----
  const iframe = form.querySelector('iframe');
  let previewTimer;
  async function updatePreview() {
    const doc = iframe.contentDocument;
    if (!doc?.querySelector('.prose')) return;
    const root = doc.documentElement;
    root.dataset.theme = state.site.theme;
    root.dataset.scheme = state.site.colorScheme;
    root.dataset.font = state.site.font || (state.site.theme === 'modern' ? 'sans' : 'serif');
    root.dataset.numbered = String(state.site.numberedHeadings);
    if (state.site.accent) root.style.setProperty('--accent-base', state.site.accent);
    doc.querySelector('.article-title').textContent = f.title.value || 'Untitled';
    doc.querySelector('.byline').textContent = [state.site.author, f.date.value].filter(Boolean).join(' · ');
    const article = doc.querySelector('article');
    article.querySelector('.toc')?.remove();
    const prose = doc.querySelector('.prose');
    const s = slug() || 'untitled';
    // Images resolve through the Worker: the draft store first, then the site.
    prose.replaceChildren(renderLive({ render: (md, o) => state.md4c.toHtml(md, o) }, f.body.value, {
      postUrl: api.rawUrl(home(), `posts/${s}.md`),
      storageBase: api.rawUrl(home(), ''),
      postHref: () => '#',
    }));
    prose.className = 'prose';
    await finishArticle(article, { ...state.site, citation: false }, { title: f.title.value, date: f.date.value, slug: s, url: '' })
      .catch((err) => console.warn('preview:', err));
  }
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 250);
  };
  iframe.addEventListener('load', updatePreview);

  for (const tab of form.querySelectorAll('.pane-tabs button')) {
    tab.addEventListener('click', () => {
      form.querySelector('.panes').dataset.show = tab.dataset.pane;
      for (const t of form.querySelectorAll('.pane-tabs button')) t.setAttribute('aria-selected', String(t === tab));
      if (tab.dataset.pane === 'preview') updatePreview();
    });
  }

  // ---- Editing ----
  form.addEventListener('input', (e) => {
    if (e.target === f.title && !ed.slugTouched) f.slug.value = slugify(f.title.value);
    if (e.target === f.slug) ed.slugTouched = true;
    setDirty(text() !== ed.saved);
    saveLocal(local, { text: text(), slug: slug() });
    schedulePreview();
  });

  const md = {
    bold: () => wrapSelection(f.body, '**', '**', 'bold text'),
    italic: () => wrapSelection(f.body, '*', '*', 'italic text'),
    h2: () => prefixLines(f.body, '## '),
    link: () => wrapSelection(f.body, '[', '](https://)', 'link text'),
    list: () => prefixLines(f.body, '- '),
    quote: () => prefixLines(f.body, '> '),
    code: () => wrapSelection(f.body, '\n```\n', '\n```\n', 'code'),
    math: () => wrapSelection(f.body, '$', '$', 'x^2'),
  };
  form.querySelector('.md-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-md]');
    if (b) md[b.dataset.md]();
  });
  // Photos go where the post is: a draft's stay private in its draft store
  // and are copied to the site when it is published.
  form.querySelector('.tb-upload input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const keys = await uploadFiles(home(), 'posts/', files);
    for (const k of keys) {
      const name = k.slice('posts/'.length);
      const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
      // Its own paragraph, so the blog typesets it as a numbered figure.
      const before = f.body.value.slice(0, f.body.selectionStart);
      const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      wrapSelection(f.body, `${lead}![${alt}](${name})\n\n`, '', '');
    }
  });

  // Offer to restore text that was typed but never saved (e.g. tab closed).
  const stash = loadLocal(local);
  if (stash?.text && stash.text !== source) {
    const box = form.querySelector('.restore');
    box.hidden = false;
    box.innerHTML = `Unsaved text from ${esc(formatTime(new Date(stash.at).toISOString()))} was found on this device.
      <button type="button" class="btn btn-small" data-restore="yes">Restore it</button>
      <button type="button" class="btn btn-small" data-restore="no">Discard</button>`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-restore]');
      if (!b) return;
      if (b.dataset.restore === 'yes') {
        const r = parseFrontMatter(stash.text);
        f.title.value = r.meta.title ?? '';
        f.date.value = r.meta.date ?? f.date.value;
        f.tags.value = r.meta.tags ?? '';
        f.description.value = r.meta.description ?? '';
        f.image.value = r.meta.image ?? '';
        f.body.value = r.body;
        if (isNew && stash.slug) f.slug.value = stash.slug;
        setDirty(true);
        schedulePreview();
      } else {
        dropLocal(local);
      }
      box.remove();
    });
  }

  // ---- Saving ----
  function validate() {
    if (!f.title.value.trim()) {
      form.querySelector('.meta-fields').open = true;
      f.title.focus();
      toast('Give the post a title.', 'error');
      return false;
    }
    if (!SLUG_RE.test(slug())) {
      form.querySelector('.meta-fields').open = true;
      f.slug.focus();
      toast('The address may use lowercase letters, digits and dashes.', 'error');
      return false;
    }
    return true;
  }

  /** Resolve a 412: keep mine (overwrite), load theirs, or cancel. */
  async function onChanged(err) {
    const when = err.current ? ` (${formatTime(err.current.uploaded)})` : '';
    const choice = await dialog({
      title: 'Changed elsewhere',
      body: err.current
        ? `This post was saved from somewhere else${when} after you opened it. Overwrite it with your version, or load the other version (your text stays on this device and can be restored)?`
        : 'This post was deleted or moved elsewhere after you opened it.',
      buttons: err.current
        ? [{ label: 'Cancel', value: null }, { label: 'Load theirs', value: 'theirs' }, { label: 'Overwrite', value: 'mine', kind: 'danger' }]
        : [{ label: 'OK', value: null }],
    });
    if (choice === 'mine') {
      ed.etag = err.current.etag;
      return 'retry';
    }
    if (choice === 'theirs') {
      ed.dirty = false;
      showEditor(view, ed.store, ed.key);
    }
    return 'stop';
  }

  /** Move the open post (rename within its store, or unpublish to a draft store). */
  async function relocate(toStore, newKey) {
    const moved = await api.move({ store: ed.store, key: ed.key }, { store: toStore, key: newKey }, ed.etag);
    Object.assign(ed, { store: toStore, key: newKey, etag: moved.etag });
  }

  /** Publish the draft with its files; asks before replacing different public files. */
  async function publishDraft() {
    let overwrite = [];
    for (;;) {
      try {
        const r = await api.publish({ store: ed.store, key: ed.key }, ed.etag, overwrite);
        Object.assign(ed, { store: 'site', etag: r.post.etag });
        return r;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'asset-conflict')) throw err;
        const ul = document.createElement('div');
        ul.innerHTML = `<p>These files already exist on the public site with different content:</p><ul>${err.assets
          .map((a) => `<li><code>${esc(a.key)}</code></li>`).join('')}</ul><p>Replace them with this draft's versions? Other posts using them will show the new files.</p>`;
        const ok = await dialog({ title: 'Replace public files?', body: ul, buttons: [
          { label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger' },
        ] });
        if (!ok) return null;
        overwrite = err.assets.map((a) => a.key);
      }
    }
  }

  async function chooseDraftStore() {
    if (stores.length === 1) return stores[0].id;
    return dialog({
      title: 'Unpublish to which draft store?',
      body: 'The post leaves the blog and is kept as a draft.',
      buttons: [...stores.map((s) => ({ label: s.label, value: s.id })), { label: 'Cancel', value: null }],
      stacked: true,
    });
  }

  async function run(act) {
    if (!validate()) return;
    const newKey = `posts/${slug()}.md`;
    const content = text();
    const wasPublished = ed.store === 'site';
    let toStore = null;
    if (act === 'unpublish') {
      toStore = await chooseDraftStore();
      if (!toStore) return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        let published = null;
        if (!ed.store) {
          // New: save it in its draft store (or straight to the site when
          // there are none); the Worker refuses slugs already in use.
          const target = stores.length ? ed.target : 'site';
          const created = await api.write(target, newKey, content, null);
          Object.assign(ed, { store: target, key: newKey, etag: created.etag });
        } else {
          if (ed.key !== newKey) await relocate(ed.store, newKey);
          ed.etag = (await api.write(ed.store, ed.key, content, ed.etag)).etag;
        }
        ed.saved = content;
        dropLocal(local);
        setDirty(false);
        schedulePreview();
        if (act === 'publish' && ed.store !== 'site') {
          published = await publishDraft();
          if (!published) {
            toast('Saved as a draft; not published.', 'info');
            return;
          }
        }
        if (act === 'unpublish' && ed.store === 'site') await relocate(toStore, ed.key);
        history.replaceState(null, '', editHref(ed.store, ed.key));
        renderActions();
        if (ed.store === 'site' || wasPublished) {
          await rebuildSite();
          const url = publicUrl(`posts/${slug()}.html`);
          if (ed.store === 'site' && state.site.indexNowKey && state.site.url && url) {
            api.indexNow([url, publicUrl('index.html')]).catch((err) => console.warn('IndexNow:', err));
          }
          const copied = published ? published.files.copy.length + published.files.overwrite.length : 0;
          toast(ed.store === 'site'
            ? `Published${copied ? ` with ${copied} file(s)` : ''}.`
            : `Unpublished; kept as a draft in ${storeLabel(ed.store)}.`, 'success');
        } else {
          toast(`Draft saved in ${storeLabel(ed.store)}.`, 'success');
        }
        return;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'changed') {
          if ((await onChanged(err)) === 'retry') continue;
          return;
        }
        if (err instanceof ApiError && ['exists', 'draft-exists', 'published-exists'].includes(err.code)) {
          form.querySelector('.meta-fields').open = true;
          f.slug.focus();
        }
        reportError(err);
        return;
      } finally {
        renderActions();
      }
    }
  }

  async function remove() {
    const published = ed.store === 'site';
    if (!(await confirmDialog('Delete post?', published
      ? 'Delete this published post? Its page is removed from the blog.'
      : `Delete this draft from ${storeLabel(ed.store)}? This cannot be undone.`))) return;
    try {
      await api.remove(ed.store, ed.key, ed.etag);
      ed.dirty = false;
      dropLocal(local);
      if (published) await rebuildSite();
      toast('Deleted.', 'success');
      location.hash = '#/posts';
    } catch (err) {
      if (err instanceof ApiError && err.code === 'changed') await onChanged(err);
      else reportError(err);
    }
  }

  actions.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'delete') remove();
    else run(b.dataset.act);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  setDirty(false);
  schedulePreview();
}

/** Plain text editor for other writable text files (CSS, JSON, …). */
export async function showTextEditor(view, store, key) {
  let { text, etag } = await api.read(store, key);
  const folder = key.slice(0, key.lastIndexOf('/') + 1);
  view.innerHTML = `<form class="text-editor">
    <div class="editor-head"><a class="back" href="${esc(filesHref(store, folder))}">← ${esc(folder || storeLabel(store))}</a><code>${esc(key)}</code><span class="save-state muted"></span></div>
    <textarea name="text" spellcheck="false" aria-label="${esc(key)}"></textarea>
    <div class="editor-actions"><button type="button" class="btn btn-primary" data-act="save">Save</button></div>
  </form>`;
  const ta = view.querySelector('textarea');
  ta.value = text;
  current = { dirty: false };
  ta.addEventListener('input', () => {
    current.dirty = ta.value !== text;
    view.querySelector('.save-state').textContent = current.dirty ? 'Unsaved changes' : '';
  });
  view.querySelector('[data-act="save"]').addEventListener('click', async () => {
    try {
      if (/\.json$/.test(key)) JSON.parse(ta.value);
    } catch (err) {
      toast(`Not valid JSON: ${err.message}`, 'error');
      return;
    }
    try {
      ({ etag } = await api.write(store, key, ta.value, etag));
      text = ta.value;
      current.dirty = false;
      view.querySelector('.save-state').textContent = 'Saved';
      toast('Saved.', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'changed' && err.current) {
        const ok = await confirmDialog('Changed elsewhere', `${key} was changed elsewhere after you opened it. Overwrite it with your version?`, 'Overwrite');
        if (ok) {
          etag = err.current.etag;
          view.querySelector('[data-act="save"]').click();
        }
      } else reportError(err);
    }
  });
}
