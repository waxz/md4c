// Folder explorer over the stores (the public site and each draft store).
// Keys are flat; folders are derived from "/" in the keys, and an empty
// folder exists only in the URL until something is uploaded into it.
//
// Each folder lists, in separate sections: sub-folders, posts, images and
// other files, and (collapsed) generated pages and site code, which can be
// viewed but not changed.

import { api, ApiError } from './client.js';
import { classify, postSlug } from './paths.js';
import {
  confirmDialog, dialog, esc, formatSize, formatTime, isDraftStore, promptDialog, publicUrl,
  rebuildSite, reportError, safeName, state, storeLabel, toast,
} from './shared.js';

const TEXT_EXT = /\.(md|json|css|txt|xml|csv|bib)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/;

export const filesHref = (store, prefix = '') => `#/files/${store}/${prefix}`;
export const editHref = (store, key) => `#/edit/${store}/${key}`;
const roleOf = (store) => (store === 'site' ? 'site' : 'drafts');

/** Shrink big photos (phones take 12+ megapixel shots) before uploading. */
export async function resizeImage(file, max = 2400) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = max / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, file.type, 0.86));
  return blob && blob.size < file.size ? blob : file;
}

/** Upload files into `prefix` of `store`. Name clashes ask first. Returns the keys written. */
export async function uploadFiles(store, prefix, files) {
  const written = [];
  for (const file of files) {
    const name = safeName(file.name);
    let key = `${prefix}${name}`;
    const kind = classify(roleOf(store), key);
    if (kind !== 'asset' && kind !== 'content') {
      toast(`${name}: files of this type cannot go in ${prefix || 'the top folder'}`, 'error');
      continue;
    }
    const body = await resizeImage(file);
    try {
      try {
        await api.write(store, key, body, null);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'exists')) throw err;
        const choice = await dialog({
          title: 'File already exists',
          body: `${key} already exists in ${storeLabel(store)}. Replace it, or keep both under a new name?`,
          buttons: [{ label: 'Skip', value: 'skip' }, { label: 'Keep both', value: 'both' }, { label: 'Replace', value: 'replace', kind: 'danger' }],
        });
        if (choice === 'replace') {
          const current = (await api.listAll(store, key)).find((i) => i.key === key);
          await api.write(store, key, body, current?.etag ?? null);
        } else if (choice === 'both') {
          const dot = name.lastIndexOf('.');
          for (let n = 2; ; n++) {
            key = `${prefix}${name.slice(0, dot)}-${n}${name.slice(dot)}`;
            try {
              await api.write(store, key, body, null);
              break;
            } catch (e) {
              if (!(e instanceof ApiError && e.code === 'exists') || n > 50) throw e;
            }
          }
        } else {
          continue;
        }
      }
      written.push(key);
    } catch (err) {
      reportError(err, `Uploading ${name} failed`);
    }
  }
  if (written.length) toast(`Uploaded ${written.length} file(s) to ${storeLabel(store)}.`, 'success');
  return written;
}

function splitFolder(items, prefix) {
  const folders = new Map();
  const files = [];
  for (const item of items) {
    if (!item.key.startsWith(prefix)) continue;
    const rest = item.key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.push(item);
    else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
  }
  files.sort((a, b) => a.key.localeCompare(b.key));
  return { folders: [...folders].sort((a, b) => a[0].localeCompare(b[0])), files };
}

function breadcrumbs(store, prefix) {
  const parts = prefix.split('/').filter(Boolean);
  const crumbs = [`<a href="${filesHref(store)}">${esc(storeLabel(store))}</a>`];
  parts.forEach((p, i) => {
    crumbs.push(`<a href="${esc(filesHref(store, `${parts.slice(0, i + 1).join('/')}/`))}">${esc(p)}</a>`);
  });
  return crumbs.join('<span aria-hidden="true">/</span>');
}

function openHref(store, f) {
  if (postSlug(f.key) && f.kind === 'content') return editHref(store, f.key);
  if (f.kind === 'asset' && TEXT_EXT.test(f.key)) return `#/text/${store}/${f.key}`;
  return `#/view/${store}/${f.key}`;
}

function row(store, f) {
  const name = f.key.slice(f.key.lastIndexOf('/') + 1);
  const thumb = IMAGE_EXT.test(f.key)
    ? `<img class="thumb" src="${esc(api.fileUrl(store, f.key))}" alt="" loading="lazy">`
    : `<span class="icon" aria-hidden="true">${f.kind === 'content' ? '✎' : f.kind === 'locked' ? '⚙' : f.kind === 'generated' ? '⎙' : '▫'}</span>`;
  const actionable = f.kind === 'content' || f.kind === 'asset' || (store === 'site' && f.kind === 'generated');
  return `<li class="file-row kind-${f.kind}">
    <a class="file-main" href="${esc(openHref(store, f))}">${thumb}
      <span class="name">${esc(name)}</span>
      <span class="meta">${esc(formatSize(f.size))} · ${esc(formatTime(f.uploaded))}</span>
    </a>
    ${actionable ? `<button type="button" class="row-menu" data-key="${esc(f.key)}" aria-label="Actions for ${esc(name)}">⋯</button>` : ''}
  </li>`;
}

const list = (rows) => `<ul class="file-list">${rows.join('')}</ul>`;

export async function showFiles(view, store, prefix) {
  if (!state.session.stores.some((s) => s.id === store)) {
    view.innerHTML = `<p class="error">No store “${esc(store)}”.</p>`;
    return;
  }
  view.innerHTML = '<p class="muted">Loading…</p>';
  const items = await api.listAll(store);
  const { folders, files } = splitFolder(items, prefix);
  const posts = files.filter((f) => f.kind === 'content');
  const assets = files.filter((f) => f.kind === 'asset');
  const hidden = files.filter((f) => f.kind === 'generated' || f.kind === 'locked');
  const canUpload = /^(posts\/|assets\/)/.test(prefix);

  view.innerHTML = `<div class="files">
    <div class="view-head">
      <label class="store-switch"><span class="visually-hidden">Storage</span>
        <select aria-label="Storage">${state.session.stores.map((s) =>
          `<option value="${esc(s.id)}"${s.id === store ? ' selected' : ''}>${esc(s.label)}${s.role === 'site' ? ' (public)' : ' (private)'}</option>`).join('')}</select>
      </label>
    </div>
    <nav class="crumbs" aria-label="Folder">${breadcrumbs(store, prefix)}</nav>
    <div class="toolbar-row">
      ${canUpload ? '<label class="btn btn-primary">Upload<input type="file" id="upload" multiple hidden></label>' : ''}
      <button type="button" class="btn" id="new-folder">New folder</button>
    </div>
    ${!canUpload ? `<p class="hint">Files go in <a href="${esc(filesHref(store, 'posts/'))}">posts/</a> (next to the posts that use them) or in a folder under <a href="${esc(filesHref(store, 'assets/'))}">assets/</a>.</p>` : ''}
    ${prefix || folders.length ? `<section class="file-section"><h2>Folders</h2>${list([
      ...(prefix ? [`<li class="file-row folder"><a class="file-main" href="${esc(filesHref(store, prefix.replace(/[^/]+\/$/, '')))}"><span class="icon" aria-hidden="true">↰</span><span class="name">Up</span></a></li>`] : []),
      ...folders.map(([name, n]) => `<li class="file-row folder"><a class="file-main" href="${esc(filesHref(store, `${prefix}${name}/`))}"><span class="icon" aria-hidden="true">▸</span><span class="name">${esc(name)}</span><span class="meta">${n} item${n === 1 ? '' : 's'}</span></a></li>`),
    ])}</section>` : ''}
    ${posts.length ? `<section class="file-section"><h2>Posts</h2>${list(posts.map((f) => row(store, f)))}</section>` : ''}
    ${assets.length ? `<section class="file-section"><h2>Images &amp; files</h2>${list(assets.map((f) => row(store, f)))}</section>` : ''}
    ${!posts.length && !assets.length && !folders.length ? '<p class="muted empty">This folder is empty.</p>' : ''}
    ${hidden.length ? `<details class="file-section hidden-files"><summary>Generated pages &amp; site code (${hidden.length})</summary>
      <p class="hint">Rebuilt on every publish, or deployed with the site's code. View only.</p>${list(hidden.map((f) => row(store, f)))}</details>` : ''}
  </div>`;

  view.querySelector('select').addEventListener('change', (e) => {
    location.hash = filesHref(e.target.value, e.target.value === 'site' ? '' : 'posts/');
  });
  view.querySelector('#upload')?.addEventListener('change', async (e) => {
    const written = await uploadFiles(store, prefix, [...e.target.files]);
    if (written.length) showFiles(view, store, prefix);
  });
  view.querySelector('#new-folder').addEventListener('click', async () => {
    const name = await promptDialog('New folder', `Folder name inside ${prefix || 'the top folder'}`);
    if (!name) return;
    const safe = safeName(name).replace(/\./g, '-');
    const target = !prefix && safe !== 'posts' && safe !== 'assets' ? `assets/${safe}/` : `${prefix}${safe}/`;
    location.hash = filesHref(store, target);
    toast('Empty folder: it is created when you upload the first file.', 'info');
  });
  view.querySelector('.files').addEventListener('click', (e) => {
    const btn = e.target.closest('.row-menu');
    if (!btn) return;
    const item = files.find((f) => f.key === btn.dataset.key);
    if (item) rowActions(view, store, prefix, item);
  });
}

/** The ⋯ menu: one tidy list of what can be done with a file. */
async function rowActions(view, store, prefix, item) {
  const name = item.key.slice(item.key.lastIndexOf('/') + 1);
  const editable = item.kind === 'content' || item.kind === 'asset';
  const url = store === 'site' ? publicUrl(item.key.replace(/\.md$/, '.html')) : '';
  const choices = [
    { label: item.kind === 'content' ? 'Edit' : 'Open', value: 'open', kind: 'primary' },
    ...(IMAGE_EXT.test(item.key) && /^(posts|assets)\//.test(item.key) ? [{ label: 'Copy Markdown', value: 'md' }] : []),
    ...(url ? [{ label: 'Open on the blog', value: 'public' }] : []),
    ...(editable ? [{ label: 'Rename or move', value: 'rename' }, { label: 'Delete', value: 'delete', kind: 'danger' }] : []),
    { label: 'Cancel', value: null },
  ];
  const choice = await dialog({ title: name, body: `${storeLabel(store)} · ${item.key} · ${formatSize(item.size)}`, buttons: choices, stacked: true });
  const published = store === 'site' && postSlug(item.key);
  try {
    if (choice === 'open') {
      location.hash = openHref(store, item);
    } else if (choice === 'public') {
      window.open(url, '_blank', 'noopener');
    } else if (choice === 'md') {
      const rel = item.key.startsWith('posts/') ? item.key.slice(6) : `../${item.key}`;
      await navigator.clipboard?.writeText(`![](${rel})`).catch(() => {});
      toast(`Copied ![](${rel})`, 'success');
    } else if (choice === 'delete') {
      if (!(await confirmDialog('Delete?', published
        ? `Delete the published post ${item.key}? Its page disappears from the blog.`
        : `Delete ${item.key} from ${storeLabel(store)}? This cannot be undone.`))) return;
      await api.remove(store, item.key, item.etag);
      toast(`Deleted ${name}.`, 'success');
      if (published) await rebuildSite();
      showFiles(view, store, prefix);
    } else if (choice === 'rename') {
      const to = await promptDialog('Rename or move', 'New path', item.key);
      if (!to || to === item.key) return;
      if (published && !(await confirmDialog('Change the address?',
        `Renaming a published post changes its address; links to ${item.key.replace(/\.md$/, '.html')} stop working.`,
        'Rename', 'primary'))) return;
      await api.move({ store, key: item.key }, { store, key: to }, item.etag);
      toast(`Moved to ${to}.`, 'success');
      if (published) await rebuildSite();
      showFiles(view, store, prefix);
    }
  } catch (err) {
    reportError(err);
  }
}

/** Read-only view of a file: image preview or text, with its public URL. */
export async function showFile(view, store, key) {
  const item = (await api.listAll(store, key)).find((i) => i.key === key);
  if (!item) {
    view.innerHTML = `<p>Not found: <code>${esc(key)}</code></p>`;
    return;
  }
  const folder = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  const url = store === 'site' ? publicUrl(key) : '';
  const isImage = IMAGE_EXT.test(key);
  view.innerHTML = `<div class="file-view">
    <nav class="crumbs">${breadcrumbs(store, folder)}<span aria-hidden="true">/</span><span>${esc(key.slice(folder.length))}</span></nav>
    <p class="meta">${esc(formatSize(item.size))} · ${esc(item.contentType)} · ${esc(formatTime(item.uploaded))}${isDraftStore(store) ? ' · private draft store' : ''}</p>
    <div class="toolbar-row">${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open public URL</a>` : ''}</div>
    ${isImage ? `<img class="file-preview" src="${esc(api.fileUrl(store, key))}" alt="">` : '<pre class="file-text">Loading…</pre>'}
  </div>`;
  if (!isImage) {
    const { text } = await api.read(store, key);
    view.querySelector('.file-text').textContent = text.length > 200000 ? `${text.slice(0, 200000)}\n…` : text;
  }
}
