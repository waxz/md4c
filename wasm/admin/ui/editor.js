// Post editor: front matter fields, Markdown with a live preview in the
// blog's own theme, and the save / publish / update / unpublish flows. All
// conflict rules are enforced by the Worker; this view explains them.
//
// A post's draft (in a draft store) is its working copy. Publishing copies
// it, with the files it uses, to the site; the draft stays. A published post
// without a draft (e.g. published from a laptop) gets one on its first save.
// Without any draft store, posts are written to the site directly.

import { api, ApiError } from './client.js';
import { flag, parseFrontMatter, SLUG_RE } from './lib/post-format.js';
import { digest, readProtected } from './lib/protect.js';
import { slugify } from './lib/blog-render.js';
import { finishArticle, renderLive } from './render.js';
import { attachSourceSync } from './sync.js';
import { publishPost } from './post-actions.js';
import { Cancelled } from './tasks.js';
import { drop, entryKey, keep, newId, read, setOpen, takeRestore } from './unsaved.js';
import { LOCAL_ID } from './local-store.js';
import { attachmentMarkdown, editHref, filesHref, IMAGE_EXT, uploadFiles } from './explorer.js';
import {
  confirmDialog, dialog, draftStores, esc, formatTime, getMd4c, publicUrl, rebuildSite, reportError, state,
  storeLabel, toast,
} from './shared.js';

const KNOWN = ['title', 'date', 'tags', 'author', 'description', 'summary', 'image', 'banner', 'cover', 'background', 'password', 'toc', 'numbered'];
let current = null; // the open editor, for the leave-page guard

export function hasUnsavedChanges() {
  return Boolean(current?.dirty);
}

const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clean(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** A front matter value, quoted when YAML would otherwise read it differently. */
function yamlValue(v) {
  const s = clean(v);
  return /^["'[{|>&*!%@`]|^-\s|:\s|\s#/.test(s) ? JSON.stringify(s) : s;
}

function compose(fields, extra, body) {
  const lines = ['---', `title: ${yamlValue(fields.title)}`, `date: ${clean(fields.date)}`, `tags: ${yamlValue(fields.tags)}`];
  for (const k of ['author', 'description', 'image', 'banner', 'background']) {
    if (clean(fields[k])) lines.push(`${k}: ${yamlValue(fields[k])}`);
  }
  if (clean(fields.password)) lines.push(`password: ${clean(fields.password)}`);
  for (const k of ['toc', 'numbered']) if (/^(true|false)$/.test(fields[k] ?? '')) lines.push(`${k}: ${fields[k]}`);
  for (const [k, v] of Object.entries(extra)) if (k !== 'draft') lines.push(`${k}: ${yamlValue(v)}`);
  lines.push('---', '', body.replace(/^\s+/, ''));
  return lines.join('\n');
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
  const engine = getMd4c(); // for the preview and publishing; loads while the post does
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
      if (!direct) {
        // Signed out: whether it is published is unknown; the draft still opens.
        published = store === 'site' ? { key, etag, text: source }
          : await readPublished(key).catch((err) => (err.code === 'offline' ? null : Promise.reject(err)));
      }
      // A protected post's public copy is encrypted; it records a digest of
      // the draft it was made from, so "changes not live" still works.
      const locked = published && store !== 'site' ? readProtected(published.text) : null;
      if (locked) published.text = locked.meta.source === await digest(source) ? source : '';
    } catch (err) {
      view.innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="#/posts">Back to posts</a></p>`;
      return;
    }
  }
  await engine;
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
    // (signed out, a new post starts in this browser: the others cannot be reached)
    target: (stores.find((s) => s.id === (newStore ?? store))
      ?? (state.session.offline ? stores.find((s) => s.id === LOCAL_ID) : null) ?? stores[0])?.id ?? 'site',
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
        <label class="field span-2"><span>Author (optional; default: the site's author)</span><input name="author" maxlength="120"></label>
        <div class="field span-2"><span>Banner image above the article (optional)</span><span class="field-row"><input name="banner" aria-label="Banner image" autocapitalize="off" spellcheck="false" placeholder="e.g. banner.jpg"><label class="btn btn-small">Upload<input type="file" accept="image/*" data-image-for="banner" hidden></label></span></div>
        <div class="field span-2"><span>Page background image (optional)</span><span class="field-row"><input name="background" aria-label="Page background image" autocapitalize="off" spellcheck="false" placeholder="e.g. paper.jpg"><label class="btn btn-small">Upload<input type="file" accept="image/*" data-image-for="background" hidden></label></span></div>
        <label class="field span-2"><span>Social preview image (optional; default: the banner)</span><input name="image" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Contents box</span><select name="toc">
          <option value="">site default</option><option value="true">show</option><option value="false">hide</option></select></label>
        <label class="field"><span>Number the sections (1, 1.1, …)</span><select name="numbered">
          <option value="">site default</option><option value="true">yes</option><option value="false">no</option></select></label>
        <label class="field span-2"><span>🔒 Password (optional): readers must type it to read the post</span><input name="password" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="200"><small class="password-note"></small></label>
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
  f.slug.value = isNew ? '' : key.slice(6, -3);
  /** Put front matter values in the fields; `partial`: only the keys present. */
  const fillFields = (m, partial = false) => {
    const set = (el, v) => {
      if (!partial || v !== undefined) el.value = v ?? '';
    };
    set(f.title, m.title);
    const date = /^\d{4}-\d{2}-\d{2}/.test(m.date ?? '') ? m.date.slice(0, 10) : undefined;
    if (date || !partial) f.date.value = date ?? today();
    set(f.tags, m.tags);
    set(f.description, m.description ?? m.summary);
    set(f.image, m.image);
    set(f.author, m.author);
    set(f.banner, m.banner || m.cover || (partial ? undefined : ''));
    set(f.background, m.background);
    set(f.password, m.password);
    set(f.toc, flag(m.toc) ?? (partial ? undefined : ''));
    set(f.numbered, flag(m.numbered) ?? (partial ? undefined : ''));
    for (const [k, v] of Object.entries(m)) if (!KNOWN.includes(k)) extra[k] = v;
  };
  fillFields(meta);
  f.body.value = body.replace(/^\r?\n/, ''); // the blank line after the front matter
  /**
   * A "---" front matter block typed or pasted at the top of the text (or
   * left there by an earlier save) moves into the fields: the post's real
   * front matter is made from the fields, so in the text it would only
   * show up as text. Returns true when it moved one.
   */
  const liftFrontMatter = () => {
    const text = f.body.value.replace(/^\uFEFF/, '');
    const m = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return false;
    const block = parseFrontMatter(text.replace(/^\s+/, '')).meta;
    if (!Object.keys(block).length) return false;
    fillFields(block, true);
    f.body.value = text.slice(m[0].length).replace(/^\s*\n/, '');
    form.querySelector('.meta-fields').open = true;
    toast(`Front matter (${Object.keys(block).join(', ')}) moved into the fields above.`, 'success');
    return true;
  };
  // A draft saved with its front matter in the text: fixed, to be saved.
  const liftedOnOpen = liftFrontMatter();
  f.target?.addEventListener('change', () => {
    ed.target = f.target.value;
    renderActions();
    schedulePreview();
  });

  const text = () => compose(
    {
      title: f.title.value, date: f.date.value, tags: f.tags.value, author: f.author.value, description: f.description.value,
      image: f.image.value, banner: f.banner.value, background: f.background.value, password: f.password.value,
      toc: f.toc.value, numbered: f.numbered.value,
    },
    extra, f.body.value
  );
  const slug = () => f.slug.value.trim();
  // Unsaved changes are kept in this browser, one entry per draft
  // (unsaved.js); the banner and the Storage page list them.
  const restoreId = takeRestore();
  ed.newId = isNew && restoreId?.startsWith(entryKey(null, null, '')) ? restoreId.slice(entryKey(null, null, '').length) : newId();
  const stashKey = () => entryKey(ed.store, ed.key, ed.newId);
  let stashedAt = stashKey();
  function stash(content = text()) {
    const k = stashKey();
    if (stashedAt !== k) drop(stashedAt); // renamed, or a new post now saved
    stashedAt = k;
    if (content === ed.saved) drop(k);
    else keep(k, { text: content, slug: slug(), title: f.title.value.trim(), store: ed.store, key: ed.key, target: ed.target });
    setOpen(k);
  }
  function unstash() {
    drop(stashedAt, stashKey(), entryKey(null, null, ed.newId));
    stashedAt = stashKey();
    setOpen(stashedAt);
  }
  setOpen(stashedAt);

  // ---- Actions ----
  const actions = form.querySelector('.editor-actions');
  function renderStatus() {
    const badge = form.querySelector('.status-badge');
    badge.textContent = status();
    badge.dataset.status = ed.published || (direct && ed.store) ? 'published' : ed.store ? 'draft' : 'new';
    form.querySelector('.where').textContent = (f.password.value.trim() ? '🔒 ' : '') + (direct ? ''
      : ed.store ? `draft in ${storeLabel(ed.store)}` : `the draft will be kept in ${storeLabel(home())}`);
    form.querySelector('.password-note').textContent = direct && f.password.value.trim()
      ? 'Password protection needs a draft store.'
      : f.password.value.trim() ? 'Published encrypted. Only the title, date and tags stay readable; attachments are not encrypted.' : '';
  }
  function renderActions() {
    renderStatus();
    const liveKey = direct ? (ed.store ? ed.key : null) : ed.published?.key;
    const live = liveKey ? publicUrl(`posts/${liveKey.slice(6, -3)}.html`) : '';
    const isLive = Boolean(liveKey);
    actions.innerHTML = [
      `<button type="button" class="btn btn-primary" data-act="publish">${isLive ? 'Update site' : 'Publish'}</button>`,
      direct ? '' : '<button type="button" class="btn" data-act="draft">Save draft</button>',
      live ? `<a class="btn" href="${esc(live)}" target="_blank" rel="noopener">View</a>` : '',
      ed.store || ed.published ? '<a class="more-actions muted" href="#/posts">Unpublish or delete: ⋯ in Posts</a>' : '',
    ].join('');
    form.querySelector('.slug-note').textContent = isLive
      ? 'Changing the address of a published post breaks existing links.' : '';
  }
  renderActions();

  function setDirty(d) {
    ed.dirty = d;
    form.querySelector('.save-state').textContent = d ? (ed.backupNote || 'Unsaved changes')
      : ed.etag ? (ed.autosavedAt ? `Autosaved at ${clock(ed.autosavedAt)}` : 'Saved') : '';
    renderStatus();
  }
  if (liftedOnOpen) setDirty(text() !== ed.saved);

  // ---- Preview ----
  const iframe = form.querySelector('iframe');
  let previewTimer;
  // Text and preview scroll together; a click in the preview finds its lines.
  const wide = matchMedia('(min-width: 1000px)');
  const sync = attachSourceSync({
    textarea: f.body,
    iframe,
    sideBySide: () => wide.matches,
    showWrite: () => form.querySelector('.pane-tabs button[data-pane="write"]').click(),
  });
  async function updatePreview() {
    const doc = iframe.contentDocument;
    if (!doc?.querySelector('.prose')) return;
    const root = doc.documentElement;
    root.dataset.theme = state.site.theme;
    root.dataset.scheme = state.site.colorScheme;
    root.dataset.font = state.site.font || (state.site.theme === 'modern' ? 'sans' : 'serif');
    root.dataset.numbered = f.numbered.value || String(state.site.numberedHeadings);
    if (state.site.accent) root.style.setProperty('--accent-base', state.site.accent);
    doc.querySelector('.article-title').textContent = f.title.value || 'Untitled';
    doc.querySelector('.byline').textContent = [f.author.value.trim() || state.site.author, f.date.value].filter(Boolean).join(' · ');
    const article = doc.querySelector('article');
    // Banner and background as the published page shows them; relative
    // names resolve next to the post, through the Worker.
    const imageUrl = (ref) => {
      const v = ref.trim();
      if (!v) return '';
      if (/^https?:\/\//.test(v)) return v;
      return api.rawUrl(home(), v.startsWith('/') ? v.slice(1) : `posts/${v.replace(/^\.\//, '')}`);
    };
    article.querySelector('.post-banner')?.remove();
    const bannerUrl = imageUrl(f.banner.value);
    if (bannerUrl) {
      const fig = doc.createElement('figure');
      fig.className = 'post-banner';
      const img = doc.createElement('img');
      img.src = bannerUrl;
      img.alt = '';
      fig.append(img);
      article.prepend(fig);
    }
    const bgUrl = imageUrl(f.background.value);
    if (bgUrl) {
      root.style.setProperty('--bg-image', `url(${JSON.stringify(bgUrl)})`);
      root.dataset.bg = 'page';
    } else {
      root.style.removeProperty('--bg-image');
      delete root.dataset.bg;
    }
    article.querySelector('.toc')?.remove();
    const prose = doc.querySelector('.prose');
    const s = slug() || 'untitled';
    // Images resolve through the Worker: the draft store first, then the site.
    prose.replaceChildren(renderLive({ render: (md, o) => state.md4c.toHtml(md, o) }, f.body.value, {
      postUrl: api.rawUrl(home(), `posts/${s}.md`),
      storageBase: api.rawUrl(home(), ''),
      postHref: () => '#',
      sourcePositions: true,
    }));
    prose.className = 'prose';
    await finishArticle(article, { ...state.site, citation: false }, { title: f.title.value, date: f.date.value, slug: s, url: '', toc: f.toc.value })
      .catch((err) => console.warn('preview:', err));
    sync.refresh();
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
  let lastInput = 0;
  form.addEventListener('input', (e) => {
    if (e.target === f.title && !ed.slugTouched) f.slug.value = slugify(f.title.value);
    if (e.target === f.slug) ed.slugTouched = true;
    if (e.target === f.body) liftFrontMatter();
    lastInput = Date.now();
    // Every change is also kept on this device at once (see the restore offer below).
    stash();
    setDirty(text() !== ed.saved);
    schedulePreview();
  });

  // ---- Autosave ----
  // Every few seconds, once typing pauses: a draft kept in "This browser" is
  // saved for real (no button needed, no network); a draft kept elsewhere
  // is backed up on this device (saving it there stays a choice: it costs a
  // request, and may need signing in), and the status says when.
  const AUTOSAVE_EVERY = 6000;
  const AUTOSAVE_PAUSE = 2000;
  let autosaving = null;
  const timer = setInterval(() => {
    if (current !== ed || !document.body.contains(form)) {
      clearInterval(timer);
      return;
    }
    if (ed.dirty && !ed.busy && !autosaving && Date.now() - lastInput >= AUTOSAVE_PAUSE) {
      autosaving = autosave().finally(() => { autosaving = null; });
    }
  }, AUTOSAVE_EVERY / 3);

  async function autosave() {
    const content = text();
    if (content === ed.saved) return setDirty(false);
    const newKey = `posts/${slug()}.md`;
    if (home() !== LOCAL_ID || direct) {
      stash(content);
      ed.backupNote = `Unsaved changes · backed up on this device at ${clock(Date.now())}`;
      return setDirty(true);
    }
    if (!f.title.value.trim() || !SLUG_RE.test(slug())) {
      ed.backupNote = 'Unsaved changes · autosave starts once the post has a title and an address';
      return setDirty(true);
    }
    if (ed.autosaveOff) return;
    try {
      if (!ed.store) {
        const created = await api.write(LOCAL_ID, newKey, content, null, { ofPublished: ed.published?.key === newKey });
        Object.assign(ed, { store: LOCAL_ID, key: newKey, etag: created.etag });
        renderActions();
      } else {
        // A new address follows the title while it is typed; a published post keeps its own.
        if (ed.key !== newKey && !ed.published) await relocate(LOCAL_ID, newKey);
        ed.etag = (await api.write(LOCAL_ID, ed.key, content, ed.etag)).etag;
      }
      ed.saved = content;
      ed.autosavedAt = Date.now();
      ed.backupNote = '';
      unstash();
      history.replaceState(null, '', editHref(ed.store, ed.key));
      setDirty(text() !== ed.saved);
    } catch (err) {
      // Taken address, or changed in another tab: saving by hand resolves it.
      ed.autosaveOff = true;
      ed.backupNote = `Unsaved changes · autosave paused: ${err.message}`;
      setDirty(true);
    }
  }

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
  // Banner and background images: uploaded next to the post, then named.
  for (const input of form.querySelectorAll('input[data-image-for]')) {
    input.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      const [key] = await uploadFiles(home(), 'posts/', files);
      if (!key) return;
      f[input.dataset.imageFor].value = key.slice('posts/'.length);
      form.dispatchEvent(new Event('input', { bubbles: true }));
      schedulePreview();
    });
  }

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
  const kept = read(stashedAt);
  const restore = () => {
    const r = parseFrontMatter(kept.text);
    fillFields(r.meta);
    f.body.value = r.body.replace(/^\r?\n/, '');
    if (isNew && kept.slug) f.slug.value = kept.slug;
    setDirty(true);
    schedulePreview();
  };
  if (kept?.text && kept.text !== source && restoreId === stashedAt) {
    restore(); // opened from the list of unsaved changes
  } else if (kept?.text && kept.text !== source) {
    const box = form.querySelector('.restore');
    box.hidden = false;
    box.innerHTML = `Unsaved text from ${esc(formatTime(new Date(kept.at).toISOString()))} was found on this device.
      <button type="button" class="btn btn-small" data-restore="yes">Restore it</button>
      <button type="button" class="btn btn-small" data-restore="no">Discard</button>`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-restore]');
      if (!b) return;
      if (b.dataset.restore === 'yes') restore();
      else unstash();
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

  async function run(act) {
    if (!validate()) return;
    if (autosaving) await autosaving; // never two saves at once
    ed.busy = true;
    ed.autosaveOff = false;
    ed.autosavedAt = 0;
    ed.backupNote = '';
    try {
      await runSave(act);
    } finally {
      ed.busy = false;
    }
  }

  async function runSave(act) {
    const newKey = `posts/${slug()}.md`;
    const content = text();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        if (direct) {
          if (f.password.value.trim()) {
            toast('Password protection needs a draft store (the password is kept in the draft).', 'error');
            return;
          }
          // No draft stores: the site copy is the only copy.
          if (!ed.store) {
            const created = await api.write('site', newKey, content, null);
            Object.assign(ed, { store: 'site', key: newKey, etag: created.etag });
          } else {
            if (ed.key !== newKey) await relocate('site', newKey);
            ed.etag = (await api.write('site', ed.key, content, ed.etag)).etag;
          }
          ed.saved = content;
          unstash();
          setDirty(false);
          history.replaceState(null, '', editHref(ed.store, ed.key));
          toast('Saved. The site is updating in the background (Activity).', 'success');
          rebuildSite().catch(() => {}); // shown in the Activity panel
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
        unstash();
        setDirty(false);
        schedulePreview();
        history.replaceState(null, '', editHref(ed.store, ed.key));

        if (act === 'draft') {
          toast(`Draft saved in ${storeLabel(ed.store)}${ed.published ? '; the published post is unchanged until you update the site' : ''}.`, 'success');
          return;
        }

        if (act === 'publish') {
          // 2. Copy it, with its files, to the site: in the background
          // (Activity panel), so writing can go on meanwhile.
          const renamedFrom = ed.published && ed.published.key !== ed.key ? ed.published : null;
          const job = publishPost({
            draft: { store: ed.store, key: ed.key, etag: ed.etag },
            published: ed.published ? { key: ed.published.key, etag: ed.published.etag } : null,
            title: f.title.value.trim(),
          }, { alsoRemove: renamedFrom });
          job.then((r) => {
            ed.published = { key: ed.key, etag: r.post.etag, text: content };
            if (current === ed) renderActions();
          }, (err) => {
            if (err instanceof Cancelled) toast('Saved as a draft; not published.', 'info');
          });
          return;
        }
        return;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'changed') {
          if ((await onChanged(err)) === 'retry') continue;
          return;
        }
        if (err instanceof ApiError && err.code === 'offline' && home() !== LOCAL_ID && act === 'draft') {
          // Signed out (or offline): keep the text in this browser instead.
          const ok = await dialog({
            title: 'Save in this browser?',
            body: `${storeLabel(home())} cannot be reached: Cloudflare Access may have signed you out. Save this draft in “This browser” instead? `
              + (ed.store ? `The copy in ${storeLabel(ed.store)} stays as it was; delete one of the two later.` : 'You can move it later.'),
            buttons: [{ label: 'Cancel', value: false }, { label: 'Save in this browser', value: true, kind: 'primary' }],
          });
          if (ok) {
            Object.assign(ed, { store: null, key: null, etag: null, target: LOCAL_ID });
            continue;
          }
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

  actions.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    run(b.dataset.act);
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
