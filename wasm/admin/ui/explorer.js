// Folder explorer over the site and drafts buckets. R2 keys are flat; folders
// are derived from "/" in the keys, and an empty folder exists only in the
// URL until something is uploaded into it.

import { api, ApiError } from './client.js';
import { classify, postSlug } from './paths.js';
import {
  confirmDialog, dialog, esc, formatSize, formatTime, promptDialog, publicUrl, rebuildSite,
  reportError, safeName, state, toast,
} from './shared.js';

const KIND_LABEL = {
  content: 'Post', asset: 'File', generated: 'Generated', locked: 'Site code',
};
const TEXT_EXT = /\.(md|json|css|txt|svg|xml|csv|bib)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/;

export const filesHref = (bucket, prefix = '') => `#/files/${bucket}/${prefix}`;
export const editHref = (bucket, key) => `#/edit/${bucket}/${key}`;

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
  const type = file.type === 'image/png' ? 'image/png' : file.type;
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.86));
  return blob && blob.size < file.size ? blob : file;
}

/**
 * Upload files into `prefix`. Name clashes ask before replacing.
 * Returns the keys written.
 */
export async function uploadFiles(bucket, prefix, files, existing = []) {
  const written = [];
  const byKey = new Map(existing.map((i) => [i.key, i]));
  for (const file of files) {
    const name = safeName(file.name);
    let key = `${prefix}${name}`;
    const kind = classify(bucket, key);
    if (kind !== 'asset' && kind !== 'content') {
      toast(`${name}: files of this type cannot go in ${prefix || 'the top folder'}`, 'error');
      continue;
    }
    const body = await resizeImage(file);
    try {
      try {
        await api.write(bucket, key, body, null);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'exists')) throw err;
        const choice = await dialog({
          title: 'File already exists',
          body: `${key} already exists. Replace it, or keep both under a new name?`,
          buttons: [{ label: 'Skip', value: 'skip' }, { label: 'Keep both', value: 'both' }, { label: 'Replace', value: 'replace', kind: 'danger' }],
        });
        if (choice === 'replace') {
          const current = byKey.get(key) ?? (await api.listAll(bucket, key)).find((i) => i.key === key);
          await api.write(bucket, key, body, current?.etag ?? null);
        } else if (choice === 'both') {
          const dot = name.lastIndexOf('.');
          for (let n = 2; ; n++) {
            key = `${prefix}${name.slice(0, dot)}-${n}${name.slice(dot)}`;
            try {
              await api.write(bucket, key, body, null);
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
  if (written.length) toast(`Uploaded ${written.length} file(s).`, 'success');
  return written;
}

function folderView(items, prefix) {
  const folders = new Map();
  const files = [];
  for (const item of items) {
    if (!item.key.startsWith(prefix)) continue;
    const rest = item.key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.push(item);
    else {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  files.sort((a, b) => a.key.localeCompare(b.key));
  return { folders: [...folders].sort((a, b) => a[0].localeCompare(b[0])), files };
}

function breadcrumbs(bucket, prefix) {
  const parts = prefix.split('/').filter(Boolean);
  const crumbs = [`<a href="${filesHref(bucket)}">${bucket === 'site' ? 'Site' : 'Drafts'}</a>`];
  parts.forEach((p, i) => {
    crumbs.push(`<a href="${esc(filesHref(bucket, `${parts.slice(0, i + 1).join('/')}/`))}">${esc(p)}</a>`);
  });
  return crumbs.join('<span aria-hidden="true">/</span>');
}

export async function showFiles(view, bucket, prefix) {
  if (bucket === 'drafts' && !state.session.drafts) {
    view.innerHTML = '<p class="muted">No drafts bucket is configured (see admin/README.md).</p>';
    return;
  }
  view.innerHTML = '<p class="muted">Loading…</p>';
  const items = await api.listAll(bucket);
  const { folders, files } = folderView(items, prefix);
  const canUpload = bucket === 'site' && (/^posts\/$/.test(prefix) || prefix.startsWith('assets/'));

  view.innerHTML = `
  <div class="files">
    <div class="bucket-tabs" role="tablist">
      <a role="tab" href="${filesHref('site')}" aria-selected="${bucket === 'site'}">Site</a>
      ${state.session.drafts ? `<a role="tab" href="${filesHref('drafts', 'posts/')}" aria-selected="${bucket === 'drafts'}">Drafts</a>` : ''}
    </div>
    <nav class="crumbs" aria-label="Folder">${breadcrumbs(bucket, prefix)}</nav>
    <div class="toolbar-row">
      <a class="btn btn-primary" href="#/new">New post</a>
      ${canUpload ? `<label class="btn">Upload<input type="file" id="upload" multiple hidden></label>` : ''}
      ${bucket === 'site' ? '<button type="button" class="btn" id="new-folder">New folder</button>' : ''}
    </div>
    ${!canUpload && bucket === 'site' ? '<p class="hint">Upload images and files into <a href="#/files/site/posts/">posts/</a> or a folder under <a href="#/files/site/assets/">assets/</a>.</p>' : ''}
    <ul class="file-list">
      ${prefix ? `<li class="file-row folder"><a href="${esc(filesHref(bucket, prefix.replace(/[^/]+\/$/, '')))}" class="file-main"><span class="icon" aria-hidden="true">↰</span><span class="name">..</span></a></li>` : ''}
      ${folders.map(([name, n]) => `<li class="file-row folder"><a class="file-main" href="${esc(filesHref(bucket, `${prefix}${name}/`))}"><span class="icon" aria-hidden="true">▸</span><span class="name">${esc(name)}/</span><span class="meta">${n} item${n === 1 ? '' : 's'}</span></a></li>`).join('')}
      ${files.map((f) => fileRow(bucket, f)).join('')}
      ${!folders.length && !files.length ? '<li class="empty muted">This folder is empty.</li>' : ''}
    </ul>
  </div>`;

  view.querySelector('#upload')?.addEventListener('change', async (e) => {
    const written = await uploadFiles(bucket, prefix, [...e.target.files], items);
    if (written.length) showFiles(view, bucket, prefix);
  });
  view.querySelector('#new-folder')?.addEventListener('click', async () => {
    const name = await promptDialog('New folder', `Folder name inside ${prefix || 'the top folder'}`);
    if (!name) return;
    const safe = safeName(name).replace(/\./g, '-');
    if (!prefix) {
      if (safe !== 'assets' && safe !== 'posts') {
        toast('New top-level folders go under assets/; creating it there.', 'info');
        location.hash = filesHref(bucket, `assets/${safe}/`);
        return;
      }
    }
    location.hash = filesHref(bucket, `${prefix}${safe}/`);
    toast('Empty folder: it is created when you upload the first file.', 'info');
  });
  view.querySelector('.file-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const item = files.find((f) => f.key === btn.dataset.key);
    fileAction(view, bucket, prefix, item, btn.dataset.action);
  });
}

function fileRow(bucket, f) {
  const name = f.key.slice(f.key.lastIndexOf('/') + 1);
  const editable = f.kind === 'content' || (f.kind === 'asset' && TEXT_EXT.test(f.key) && !/\.svg$/.test(f.key));
  const open = f.kind === 'content' || postSlug(f.key)
    ? editHref(bucket, f.key)
    : `#/view/${bucket}/${f.key}`;
  const thumb = IMAGE_EXT.test(f.key) && !/\.svg$/.test(f.key)
    ? `<img class="thumb" src="${esc(api.fileUrl(bucket, f.key))}" alt="" loading="lazy">`
    : `<span class="icon" aria-hidden="true">${f.kind === 'content' ? '✎' : f.kind === 'locked' ? '⚙' : '▫'}</span>`;
  const movable = f.kind === 'content' || f.kind === 'asset';
  return `<li class="file-row kind-${f.kind}">
    <a class="file-main" href="${esc(open)}">${thumb}<span class="name">${esc(name)}</span>
      <span class="meta">${esc(formatSize(f.size))} · ${esc(formatTime(f.uploaded))}${f.kind !== 'content' && f.kind !== 'asset' ? ` · <span class="badge">${KIND_LABEL[f.kind]}</span>` : ''}</span></a>
    <span class="file-actions">
      ${editable ? `<a class="btn btn-small" href="${esc(open)}">Edit</a>` : ''}
      ${movable ? `<button type="button" class="btn btn-small" data-action="rename" data-key="${esc(f.key)}">Rename</button>
      <button type="button" class="btn btn-small btn-danger-text" data-action="delete" data-key="${esc(f.key)}">Delete</button>` : ''}
    </span>
  </li>`;
}

async function fileAction(view, bucket, prefix, item, action) {
  if (!item) return;
  const published = bucket === 'site' && postSlug(item.key);
  try {
    if (action === 'delete') {
      const ok = await confirmDialog('Delete file?', published
        ? `Delete the published post ${item.key}? Its page disappears from the blog.`
        : `Delete ${item.key}? This cannot be undone.`);
      if (!ok) return;
      await api.remove(bucket, item.key, item.etag);
      toast(`Deleted ${item.key}.`, 'success');
      if (published) await rebuildSite();
    } else if (action === 'rename') {
      const to = await promptDialog('Rename or move', 'New path', item.key);
      if (!to || to === item.key) return;
      if (published && !(await confirmDialog('Change the address?',
        `Renaming a published post changes its address; existing links to ${item.key.replace(/\.md$/, '.html')} will stop working.`,
        'Rename', 'primary'))) return;
      await api.move({ bucket, key: item.key }, { bucket, key: to }, item.etag);
      toast(`Moved to ${to}.`, 'success');
      if (published) await rebuildSite();
    }
  } catch (err) {
    reportError(err);
  }
  showFiles(view, bucket, prefix);
}

/** Read-only view of a file: image preview or text, with its public URL. */
export async function showFile(view, bucket, key) {
  const items = await api.listAll(bucket, key);
  const item = items.find((i) => i.key === key);
  if (!item) {
    view.innerHTML = `<p>Not found: <code>${esc(key)}</code></p>`;
    return;
  }
  const folder = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  const url = bucket === 'site' ? publicUrl(key) : '';
  const isImage = IMAGE_EXT.test(key);
  const editable = item.kind === 'asset' && TEXT_EXT.test(key) && !/\.svg$/.test(key);
  view.innerHTML = `<div class="file-view">
    <nav class="crumbs">${breadcrumbs(bucket, folder)}<span aria-hidden="true">/</span><span>${esc(key.slice(folder.length))}</span></nav>
    <p class="meta">${esc(formatSize(item.size))} · ${esc(item.contentType)} · ${esc(formatTime(item.uploaded))} · <span class="badge">${KIND_LABEL[item.kind]}</span></p>
    <div class="toolbar-row">
      ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open public URL</a>` : ''}
      ${isImage && folder === 'posts/' ? `<button type="button" class="btn" id="copy-md">Copy Markdown</button>` : ''}
      ${editable ? `<a class="btn btn-primary" href="${esc(`#/text/${bucket}/${key}`)}">Edit</a>` : ''}
    </div>
    ${isImage ? `<img class="file-preview" src="${esc(api.fileUrl(bucket, key))}" alt="">` : '<pre class="file-text">Loading…</pre>'}
  </div>`;
  if (!isImage) {
    const { text } = await api.read(bucket, key);
    view.querySelector('.file-text').textContent = text.length > 200000 ? `${text.slice(0, 200000)}\n…` : text;
  }
  view.querySelector('#copy-md')?.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(`![](${key.slice(folder.length)})`).catch(() => {});
    toast('Markdown copied.', 'success');
  });
}
