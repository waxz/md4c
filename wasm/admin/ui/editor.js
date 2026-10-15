// Post editor: front matter fields, Markdown with a live preview in the
// blog's own theme, and the save / publish / update / unpublish flows. All
// conflict rules are enforced by the Worker; this view explains them.
//
// A post's draft (in a draft store) is its working copy. Publishing copies
// it, with the files it uses, to the site; the draft stays. A published post
// without a draft (e.g. published from a laptop) gets one on its first save.
// Without any draft store, posts are written to the site directly.

import { api, ApiError } from './client.js';
import { parseFrontMatter, SLUG_RE } from './lib/post-format.js';
import { slugify } from './lib/blog-render.js';
import { finishArticle, renderLive } from './render.js';
import { attachmentMarkdown, editHref, filesHref, IMAGE_EXT, uploadFiles } from './explorer.js';
import {
  confirmDialog, dialog, draftStores, esc, formatSize, formatTime, publicUrl, rebuildSite, reportError, state,
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

/** The draft store holding a draft of `key`, if any. */
async function findDraft(stores, key) {
  for (const s of stores) {
    const items = await api.listAll(s.id, key).catch(() => []);
    if (items.some((i) => i.key === key)) return s.id;
  }
  return null;
}

/** { key, etag, text } of the published copy of `key`, or null. */
async function readPublished(key) {
  const items = await api.listAll('site', key);
  if (!items.some((i) => i.key === key)) return null;
  const { text, etag } = await api.read('site', key);
  return { key, etag, text };
}

/**
 * Open the editor. `store`/`key` = an existing post (posts/<slug>.md in the
 * site or a draft store); omit both for a new post (`newStore` = the draft
 * store to start it in). A published post opens its draft when it has one.
 */
export async function showEditor(view, store, key, newStore) {
  const stores = draftStores();
  const direct = !stores.length; // no draft stores: write the site directly
  const isNew = !key;
  let etag = null;
  let published = null;
  let source = `---\ntitle: \ndate: ${today()}\ntags: \n---\n\n`;
  if (!isNew) {
    try {
      if (store === 'site' && !direct) {
        const draft = await findDraft(stores, key);
        if (draft) {
          history.replaceState(null, '', editHref(draft, key));
          return showEditor(view, draft, key);
        }
      }
      ({ text: source, etag } = await api.read(store, key));
      if (!direct) published = store === 'site' ? { key, etag, text: source } : await readPublished(key);
    } catch (err) {
      view.innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="#/posts">Back to posts</a></p>`;
      return;
    }
  }
  const { meta, body } = parseFrontMatter(source);
  const extra = Object.fromEntries(Object.entries(meta).filter(([k]) => !KNOWN.includes(k)));
  const noDraftYet = isNew || (store === 'site' && !direct);
  const ed = {
    // The draft (or, without draft stores, the site copy); null until saved.
    store: noDraftYet ? null : store,
    key: isNew ? null : key,
    etag: noDraftYet ? null : etag,
    // The published copy: { key, etag, text } or null.
    published,
    // Where a new draft (and its photos) will be saved.
    target: (stores.find((s) => s.id === (newStore ?? store)) ?? stores[0])?.id ?? 'site',
    slugTouched: !isNew,
    dirty: false,
    saved: source,
  };
  current = ed;
  const home = () => ed.store ?? ed.target;
  const status = () => {
    if (direct) return ed.store ? 'Published' : 'New';
    if (ed.published) return ed.store && (ed.dirty || ed.saved !== ed.published.text) ? 'Published · changes not live' : 'Published';
    return ed.store ? 'Draft' : 'New';
  };

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
        ${noDraftYet && stores.length > 1 ? `<label class="field span-2"><span>Keep the draft in</span><select name="target">${stores.map((s) =>
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
          <label class="tb-upload" title="Insert images">Image<input type="file" accept="image/*" multiple hidden></label>
          <label class="tb-upload" title="Attach files: audio, video, PDF, HTML, anything">File<input type="file" multiple hidden></label>
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
  function renderStatus() {
    const badge = form.querySelector('.status-badge');
    badge.textContent = status();
    badge.dataset.status = ed.published || (direct && ed.store) ? 'published' : ed.store ? 'draft' : 'new';
    form.querySelector('.where').textContent = direct ? ''
      : ed.store ? `draft in ${storeLabel(ed.store)}` : `the draft will be kept in ${storeLabel(home())}`;
  }
  function renderActions() {
    renderStatus();
    const liveKey = direct ? (ed.store ? ed.key : null) : ed.published?.key;
    const live = liveKey ? publicUrl(`posts/${liveKey.slice(6, -3)}.html`) : '';
    const isLive = Boolean(liveKey);
    actions.innerHTML = [
      `<button type="button" class="btn btn-primary" data-act="publish">${isLive ? 'Update site' : 'Publish'}</button>`,
      direct ? '' : '<button type="button" class="btn" data-act="draft">Save draft</button>',
      !direct && ed.published ? '<button type="button" class="btn" data-act="unpublish">Unpublish</button>' : '',
      live ? `<a class="btn" href="${esc(live)}" target="_blank" rel="noopener">View</a>` : '',
      ed.store || ed.published ? '<button type="button" class="btn btn-danger-text" data-act="delete">Delete</button>' : '',
    ].join('');
    form.querySelector('.slug-note').textContent = isLive
      ? 'Changing the address of a published post breaks existing links.' : '';
  }
  renderActions();

  function setDirty(d) {
    ed.dirty = d;
    form.querySelector('.save-state').textContent = d ? 'Unsaved changes' : (ed.etag ? 'Saved' : '');
    renderStatus();
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
  // Attachments go next to the post (posts/ in its draft store) and are
  // linked from it: images as figures, audio and video as players, other
  // files as links. Publishing offers to copy them to the site.
  for (const input of form.querySelectorAll('.tb-upload input')) {
    input.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      const keys = await uploadFiles(home(), 'posts/', files);
      for (const k of keys) {
        const snippet = attachmentMarkdown(k.slice('posts/'.length));
        const before = f.body.value.slice(0, f.body.selectionStart);
        // Images and players get their own paragraph (a numbered figure).
        const block = IMAGE_EXT.test(k) || snippet.startsWith('<');
        const lead = !block || before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        wrapSelection(f.body, block ? `${lead}${snippet}\n\n` : snippet, '', '');
      }
    });
  }

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
    if (err.published) {
      const ok = await confirmDialog('Changed elsewhere',
        `The published post was changed somewhere else${err.current ? ` (${formatTime(err.current.uploaded)})` : ''} after you opened it. Replace it with this version?`,
        'Replace', 'danger');
      if (!ok) return 'stop';
      if (ed.published && err.current) ed.published.etag = err.current.etag;
      return 'retry';
    }
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

  /** Rename the open post within its store. */
  async function relocate(toStore, newKey) {
    const moved = await api.move({ store: ed.store, key: ed.key }, { store: toStore, key: newKey }, ed.etag);
    Object.assign(ed, { store: toStore, key: newKey, etag: moved.etag });
  }

  /**
   * Which of the files the post uses go public: lists them with checkboxes
   * (new files ticked; different public files unticked, ticking replaces
   * them). Returns { skip, overwrite }, or null when cancelled.
   */
  async function chooseFiles(files) {
    const open = files.filter((x) => x.action === 'copy' || x.action === 'conflict');
    if (!open.length) return { skip: [], overwrite: [] };
    const body = document.createElement('div');
    body.innerHTML = `<p>This post uses these files from ${esc(storeLabel(ed.store))}. Tick the ones to copy to the public site;
      unticked files stay private (their links won't work on the blog).</p>
      <ul class="file-choices">${open.map((x) => `<li><label class="check">
        <input type="checkbox" value="${esc(x.key)}" ${x.action === 'copy' ? 'checked' : ''}>
        <span><code>${esc(x.key)}</code> <span class="muted">${esc(formatSize(x.size ?? 0))}${x.action === 'conflict'
          ? ' · <b>replaces</b> a different public file' : ''}</span></span></label></li>`).join('')}</ul>`;
    const ok = await dialog({ title: 'Files to publish', body, buttons: [
      { label: 'Cancel', value: false }, { label: 'Publish', value: true, kind: 'primary' },
    ] });
    if (!ok) return null;
    const ticked = new Set([...body.querySelectorAll('input:checked')].map((i) => i.value));
    return {
      skip: open.filter((x) => !ticked.has(x.key)).map((x) => x.key),
      overwrite: open.filter((x) => x.action === 'conflict' && ticked.has(x.key)).map((x) => x.key),
    };
  }

  /** Publish the draft with the files chosen; asks before replacing different public files. */
  async function publishDraft() {
    const from = { store: ed.store, key: ed.key };
    const siteEtag = () => (ed.published?.key === ed.key ? ed.published.etag : undefined);
    const plan = await api.publish(from, ed.etag, [], siteEtag(), { dryRun: true });
    const choice = await chooseFiles(plan.files);
    if (!choice) return null;
    let overwrite = choice.overwrite;
    for (;;) {
      try {
        return await api.publish(from, ed.etag, overwrite, siteEtag(), { skip: choice.skip });
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

  /** Delete the published copy, unless it is already gone. */
  async function removePublished(p) {
    await api.remove('site', p.key, p.etag).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return;
      if (err instanceof ApiError && err.code === 'changed') err.published = true;
      throw err;
    });
  }

  async function run(act) {
    if (!validate()) return;
    const newKey = `posts/${slug()}.md`;
    const content = text();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        if (direct) {
          // No draft stores: the site copy is the only copy.
          if (!ed.store) {
            const created = await api.write('site', newKey, content, null);
            Object.assign(ed, { store: 'site', key: newKey, etag: created.etag });
          } else {
            if (ed.key !== newKey) await relocate('site', newKey);
            ed.etag = (await api.write('site', ed.key, content, ed.etag)).etag;
          }
          ed.saved = content;
          dropLocal(local);
          setDirty(false);
          history.replaceState(null, '', editHref(ed.store, ed.key));
          await rebuildSite();
          toast('Published.', 'success');
          return;
        }

        // 1. Save the draft: the working copy, kept whatever happens next.
        if (!ed.store) {
          const created = await api.write(ed.target, newKey, content, null, { ofPublished: ed.published?.key === newKey });
          Object.assign(ed, { store: ed.target, key: newKey, etag: created.etag });
        } else {
          if (ed.key !== newKey) await relocate(ed.store, newKey);
          ed.etag = (await api.write(ed.store, ed.key, content, ed.etag)).etag;
        }
        ed.saved = content;
        dropLocal(local);
        setDirty(false);
        schedulePreview();
        history.replaceState(null, '', editHref(ed.store, ed.key));

        if (act === 'draft') {
          toast(`Draft saved in ${storeLabel(ed.store)}${ed.published ? '; the published post is unchanged until you update the site' : ''}.`, 'success');
          return;
        }

        if (act === 'publish') {
          // 2. Copy it, with its files, to the site.
          const r = await publishDraft();
          if (!r) {
            toast('Saved as a draft; not published.', 'info');
            return;
          }
          const renamedFrom = ed.published && ed.published.key !== ed.key ? ed.published : null;
          ed.published = { key: ed.key, etag: r.post.etag, text: content };
          if (renamedFrom) await removePublished(renamedFrom);
          renderActions();
          await rebuildSite();
          const url = publicUrl(`posts/${slug()}.html`);
          if (state.site.indexNowKey && state.site.url && url) {
            api.indexNow([url, publicUrl('index.html')]).catch((err) => console.warn('IndexNow:', err));
          }
          const copied = r.files.copy.length + r.files.overwrite.length;
          const kept = r.files.skip.length;
          toast(`${r.updated ? 'Site updated' : 'Published'}${copied ? ` with ${copied} file(s)` : ''}${kept ? `; ${kept} file(s) kept private` : ''}. The draft stays in ${storeLabel(ed.store)}.`, 'success');
          return;
        }

        if (act === 'unpublish' && ed.published) {
          await removePublished(ed.published);
          ed.published = null;
          renderActions();
          await rebuildSite();
          toast(`Unpublished. The draft stays in ${storeLabel(ed.store)}.`, 'success');
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
    const p = direct ? null : ed.published;
    let what;
    if (direct) {
      what = await confirmDialog('Delete post?', 'Delete this published post? Its page is removed from the blog.') ? 'draft' : null;
    } else if (ed.store && p) {
      what = await dialog({
        title: 'Delete post?',
        body: `This post is published, and its draft is in ${storeLabel(ed.store)}.`,
        buttons: [
          { label: 'Delete the draft only', value: 'draft' },
          { label: 'Delete the draft and unpublish', value: 'both', kind: 'danger' },
          { label: 'Cancel', value: null },
        ],
        stacked: true,
      });
    } else if (ed.store) {
      what = await confirmDialog('Delete draft?', `Delete this draft from ${storeLabel(ed.store)}? This cannot be undone.`) ? 'draft' : null;
    } else {
      what = await confirmDialog('Delete post?', 'Delete this published post? Its page is removed from the blog.') ? 'site' : null;
    }
    if (!what) return;
    try {
      if (what !== 'site') await api.remove(ed.store, ed.key, ed.etag);
      if (what !== 'draft') await removePublished(p);
      ed.dirty = false;
      dropLocal(local);
      if (direct || what !== 'draft') await rebuildSite();
      toast('Deleted.', 'success');
      location.hash = what === 'draft' && p ? editHref('site', p.key) : '#/posts';
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
