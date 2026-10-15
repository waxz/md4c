// Storage: the draft stores, and adding your own from the browser. Stores
// added here (WebDAV, S3-compatible, GitHub) are saved by the Worker in the
// private drafts bucket, with their passwords and keys, so no Worker secrets
// or redeploys are needed. Saved secrets are never sent back to the browser.

import { api, ApiError } from './client.js';
import { confirmDialog, esc, reportError, state, toast } from './shared.js';

// S3-compatible services: endpoint pattern and default region.
const S3_PROVIDERS = {
  aws: { label: 'Amazon S3', endpoint: '', region: 'us-east-1', note: 'Leave the endpoint empty for AWS.' },
  r2: { label: 'Cloudflare R2', endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto',
    note: 'Use an R2 API token’s S3 keys, scoped to this bucket.' },
  b2: { label: 'Backblaze B2', endpoint: 'https://s3.<region>.backblazeb2.com', region: 'us-west-004',
    note: 'Use an application key limited to this bucket.' },
  wasabi: { label: 'Wasabi', endpoint: 'https://s3.<region>.wasabisys.com', region: 'us-east-1' },
  spaces: { label: 'DigitalOcean Spaces', endpoint: 'https://<region>.digitaloceanspaces.com', region: 'nyc3' },
  minio: { label: 'MinIO', endpoint: 'https://minio.example.com', region: 'us-east-1', pathStyle: true },
  other: { label: 'Other S3-compatible', endpoint: 'https://s3.example.com', region: 'auto' },
};

const TYPE_LABELS = { r2: 'R2 bucket', webdav: 'WebDAV', s3: 'S3-compatible', github: 'GitHub' };

let data = null; // GET /api/storage

function summary(s) {
  if (s.type === 'webdav') {
    let host = s.baseUrl;
    try {
      host = new URL(s.baseUrl).host;
    } catch {}
    return `${host}${s.root}${s.folder}`;
  }
  if (s.type === 's3') return `${S3_PROVIDERS[s.provider]?.label ?? 'S3'} · ${s.bucket}/${s.folder ?? ''}`;
  if (s.type === 'github') return `${s.owner}/${s.repo}${s.branch ? ` @ ${s.branch}` : ''}/${s.folder ?? ''}`;
  return '';
}

const problemOf = (id) => data.problems.find((p) => p.store === id)?.error ?? '';

function storeCard(s, saved) {
  const problem = saved ? problemOf(s.id) : '';
  return `<li class="post-card store-card">
    <div class="post-card-main">
      <span class="post-title">${esc(s.label)}</span>
      <span class="post-meta"><span class="chip">${esc(TYPE_LABELS[s.type] ?? s.type)}</span>
        ${saved ? `<span>${esc(summary(s))}</span>` : '<span>set in the deploy</span>'}</span>
      ${problem ? `<span class="error store-problem">${esc(problem)}</span>` : ''}
    </div>
    ${saved ? `<button type="button" class="btn btn-small" data-act="edit" data-id="${esc(s.id)}">Edit</button>` : ''}
  </li>`;
}

export async function showStorage(view) {
  view.innerHTML = '<p class="muted">Loading storage…</p>';
  data = await api.storage();
  view.innerHTML = `<div class="storage-view">
    <div class="view-head">
      <h1>Storage</h1>
      ${data.canSave ? '<button type="button" class="btn btn-primary" data-act="add">Add storage</button>' : ''}
    </div>
    <p class="hint">Drafts and their images are kept in private storage until you publish. Add a NAS or
      Nextcloud (WebDAV), any S3-compatible bucket, or a GitHub repository. Settings and passwords are kept
      in the private drafts bucket; passwords are never shown again.</p>
    ${data.canSave ? '' : '<p class="warn">Adding storage needs the DRAFTS bucket, which this deploy does not bind.</p>'}
    <section class="post-section"><h2>Storage <span class="count">${1 + data.deployed.length + data.stores.length}</span></h2>
      <ul class="post-cards">
        <li class="post-card store-card"><div class="post-card-main"><span class="post-title">Published site</span>
          <span class="post-meta"><span class="chip">R2 bucket</span><span>public</span></span></div></li>
        ${data.deployed.map((s) => storeCard(s, false)).join('')}
        ${data.stores.map((s) => storeCard(s, true)).join('')}
      </ul>
    </section>
    <div class="store-form-slot"></div>
  </div>`;
  view.querySelector('.storage-view').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.closest('.store-form')) return;
    if (btn.dataset.act === 'add') openForm(view, null);
    if (btn.dataset.act === 'edit') openForm(view, data.stores.find((s) => s.id === btn.dataset.id));
  });
}

const field = (name, label, attrs = '', hint = '') =>
  `<label class="field" data-for="${name}"><span>${label}</span><input name="${name}" autocapitalize="off" autocomplete="off" spellcheck="false" ${attrs}>${hint ? `<em class="field-hint">${hint}</em>` : ''}</label>`;

const secretField = (name, label, isSet) =>
  field(name, label, `type="password" autocomplete="new-password" ${isSet ? 'placeholder="Saved — leave empty to keep"' : ''}`);

function typeFields(type, s) {
  const set = s?.type === type ? s.secretsSet ?? {} : {};
  if (type === 'webdav') {
    return `${field('baseUrl', 'Server URL', 'type="url" required placeholder="https://cloud.example.com/remote.php/dav/files/me"',
      'Nextcloud: Files → Settings → WebDAV. The server must be reachable from the internet (or a Cloudflare Tunnel).')}
      ${field('root', 'Base folder', 'placeholder="/"')}
      ${field('folder', 'Drafts folder', 'placeholder="blog-drafts"')}
      ${field('username', 'User name')}
      ${secretField('password', 'Password (an app password is best)', set.password)}
      ${secretField('token', 'Or a bearer token', set.token)}`;
  }
  if (type === 's3') {
    return `<label class="field"><span>Service</span><select name="provider">${Object.entries(S3_PROVIDERS).map(([k, p]) =>
      `<option value="${k}">${esc(p.label)}</option>`).join('')}</select><em class="field-hint provider-note"></em></label>
      ${field('endpoint', 'Endpoint', 'type="url"')}
      ${field('region', 'Region')}
      ${field('bucket', 'Bucket', 'required pattern="[a-z0-9][a-z0-9.\\-]{1,62}"', 'Use a private bucket.')}
      ${field('folder', 'Folder in the bucket (optional)', 'placeholder="blog-drafts"')}
      ${field('accessKeyId', 'Access key ID', 'required')}
      ${secretField('secretAccessKey', 'Secret access key', set.secretAccessKey)}
      <label class="check"><input type="checkbox" name="forcePathStyle"> Path-style URLs (MinIO and some others)</label>`;
  }
  return `${field('owner', 'Owner (user or organisation)', 'required')}
    ${field('repo', 'Repository', 'required', 'A private repository; every save is a commit.')}
    ${field('branch', 'Branch (optional)', 'placeholder="default branch"')}
    ${field('folder', 'Folder in the repository', 'placeholder="blog-drafts"')}
    ${secretField('token', 'Access token', set.token)}
    <p class="hint">A fine-grained token for this repository only, with <b>Contents: Read and write</b>. Files over 1 MB cannot be stored.</p>`;
}

function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30);
}

function openForm(view, existing) {
  const slot = view.querySelector('.store-form-slot');
  const isNew = !existing;
  slot.innerHTML = `<form class="store-form" novalidate>
    <h2>${isNew ? 'Add storage' : `Edit “${esc(existing.label)}”`}</h2>
    <div class="grid">
      <label class="field"><span>Type</span><select name="type" ${isNew ? '' : 'disabled'}>
        <option value="webdav">WebDAV (Nextcloud, ownCloud, a NAS…)</option>
        <option value="s3">S3-compatible (S3, R2, B2, MinIO…)</option>
        <option value="github">GitHub repository</option>
      </select></label>
      ${field('label', 'Name shown in the admin', 'required maxlength="60" placeholder="Home NAS"')}
      ${field('id', 'Short id', `required pattern="[a-z][a-z0-9\\-]{0,30}" ${isNew ? '' : 'readonly'}`, 'Used in addresses; cannot be changed later.')}
      <div class="type-fields grid"></div>
    </div>
    <p class="store-check" aria-live="polite"></p>
    <div class="editor-actions">
      <button type="submit" class="btn btn-primary">Save</button>
      <button type="button" class="btn" data-act="test">Test connection</button>
      <button type="button" class="btn" data-act="cancel">Cancel</button>
      ${isNew ? '' : '<button type="button" class="btn btn-danger-text" data-act="remove">Remove</button>'}
    </div>
  </form>`;
  const form = slot.querySelector('form');
  const typeSel = form.elements.type;
  const check = form.querySelector('.store-check');
  let idTouched = !isNew;

  const renderType = () => {
    form.querySelector('.type-fields').innerHTML = typeFields(typeSel.value, existing);
    if (existing?.type === typeSel.value) {
      for (const [k, v] of Object.entries(existing)) {
        const el = form.elements[k];
        if (!el || el.type === 'password' || k === 'type') continue;
        if (el.type === 'checkbox') el.checked = Boolean(v);
        else el.value = k === 'root' || k === 'folder' ? String(v).replace(/^\/|\/$/g, '') || (k === 'root' ? '/' : '') : v;
      }
    }
    if (typeSel.value === 's3') {
      const provider = form.elements.provider;
      const apply = (fill) => {
        const p = S3_PROVIDERS[provider.value];
        form.elements.endpoint.placeholder = p.endpoint || 'empty for AWS';
        form.elements.region.placeholder = p.region;
        form.querySelector('.provider-note').textContent = p.note ?? '';
        if (fill) {
          form.elements.region.value = p.region;
          form.elements.forcePathStyle.checked = Boolean(p.pathStyle);
          if (!p.endpoint) form.elements.endpoint.value = '';
        }
      };
      provider.addEventListener('change', () => apply(true));
      apply(isNew || existing?.type !== 's3');
    }
  };
  if (existing) {
    typeSel.value = existing.type;
    form.elements.label.value = existing.label;
    form.elements.id.value = existing.id;
  }
  renderType();
  typeSel.addEventListener('change', renderType);
  form.elements.label.addEventListener('input', () => {
    if (!idTouched) form.elements.id.value = slugify(form.elements.label.value);
  });
  form.elements.id.addEventListener('input', () => { idTouched = true; });

  const collect = () => {
    const out = { type: typeSel.value, secrets: {} };
    for (const el of form.elements) {
      if (!el.name || el.name === 'type') continue;
      if (el.type === 'password') out.secrets[el.name] = el.value;
      else if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value.trim();
    }
    if (out.type === 'webdav' && !out.folder) out.folder = 'blog-drafts';
    if (out.type === 'github' && !out.folder) out.folder = 'blog-drafts';
    return out;
  };
  const busy = (on) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

  const save = async (stores) => {
    const saved = await api.saveStorage(data.etag, stores);
    state.session = await api.session();
    return saved;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const store = collect();
    const stores = isNew ? [...data.stores, store] : data.stores.map((s) => (s.id === existing.id ? store : s));
    busy(true);
    try {
      await save(stores);
      toast(`Saved “${store.label}”.`, 'success');
      await showStorage(view);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'changed') toast('Storage was changed in another window; reload and try again.', 'error');
      else reportError(err);
      busy(false);
    }
  });

  form.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') {
      slot.innerHTML = '';
      return;
    }
    if (act === 'test') {
      if (!form.reportValidity()) return;
      busy(true);
      check.className = 'store-check muted';
      check.textContent = 'Connecting…';
      try {
        const r = await api.testStorage(collect());
        check.className = r.ok ? 'store-check ok' : 'store-check error';
        check.textContent = r.ok
          ? `Connected: ${r.posts} post(s) found${r.wrote ? '; writing works too' : ''}.`
          : r.error;
      } catch (err) {
        check.className = 'store-check error';
        check.textContent = err.message;
      }
      busy(false);
      return;
    }
    if (act === 'remove') {
      const ok = await confirmDialog(`Remove “${existing.label}”?`,
        'The admin stops using it. Nothing is deleted: its files stay where they are, and you can add it again later.', 'Remove');
      if (!ok) return;
      try {
        await save(data.stores.filter((s) => s.id !== existing.id));
        toast(`Removed “${existing.label}”.`, 'success');
        await showStorage(view);
      } catch (err) {
        reportError(err);
      }
    }
  });
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.elements.label.focus({ preventScroll: true });
}
