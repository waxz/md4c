// Storage: the draft stores, and adding your own from the browser
// (WebDAV, S3-compatible, GitHub). Each store's settings and password are
// kept either
//   - in this browser only (localStorage; sent to the Worker with each
//     request, never saved by it), or
//   - in Cloudflare KV, for every device (saved secrets are never sent
//     back to the browser).

import { api, ApiError, browserStores } from './client.js';
import { confirmDialog, esc, formatSize, reportError, state, toast } from './shared.js';
import { localStore } from './local-store.js';

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
const WHERE = { deploy: 'set in the deploy', kv: 'KV · every device', browser: 'this browser only' };

let data = null; // GET /api/storage

/** Browser stores as the page shows them: settings plus which secrets are set. */
function localView() {
  return browserStores.all().map(({ secrets = {}, ...rest }) => ({
    ...rest,
    location: 'browser',
    secretsSet: Object.fromEntries(Object.keys(secrets).filter((k) => secrets[k]).map((k) => [k, true])),
  }));
}

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

function storeCard(s) {
  const problem = s.location === 'deploy' ? '' : data.problems.find((p) => p.store === s.id && p.location === s.location)?.error ?? '';
  return `<li class="post-card store-card">
    <div class="post-card-main">
      <span class="post-title">${esc(s.label)}</span>
      <span class="post-meta"><span class="chip">${esc(TYPE_LABELS[s.type] ?? s.type)}</span><span>${esc(WHERE[s.location])}</span></span>
      ${s.location === 'deploy' ? '' : `<span class="post-meta">${esc(summary(s))}</span>`}
      ${problem ? `<span class="error store-problem">${esc(problem)}</span>` : ''}
    </div>
    ${s.location === 'deploy' ? '' : `<button type="button" class="btn btn-small" data-act="edit" data-id="${esc(s.id)}" data-location="${s.location}">Edit</button>`}
  </li>`;
}

export async function showStorage(view) {
  view.innerHTML = '<p class="muted">Loading storage…</p>';
  try {
    data = await api.storage();
  } catch (err) {
    if (err.code !== 'offline') throw err;
    // Signed out: only this browser's own store is at hand.
    data = { deployed: [], stores: [], offline: true };
  }
  const all = [
    ...data.deployed.map((s) => ({ ...s, location: 'deploy' })),
    ...data.stores.map((s) => ({ ...s, location: 'kv' })),
    ...localView(),
  ];
  view.innerHTML = `<div class="storage-view">
    <div class="view-head">
      <h1>Storage</h1>
      <button type="button" class="btn btn-primary" data-act="add">Add storage</button>
    </div>
    <p class="hint">Drafts and their images are kept in private storage until you publish. Add a NAS or
      Nextcloud (WebDAV), any S3-compatible bucket, or a GitHub repository. Keep its settings and password in
      this browser only, or in Cloudflare KV to use it from every device.</p>
    <section class="post-section"><h2>Storage <span class="count">${all.length + 2}</span></h2>
      <ul class="post-cards">
        <li class="post-card store-card"><div class="post-card-main"><span class="post-title">Published site</span>
          <span class="post-meta"><span class="chip">R2 bucket</span><span>public</span></span></div></li>
        ${all.map(storeCard).join('')}
        <li class="post-card store-card"><div class="post-card-main"><span class="post-title">This browser</span>
          <span class="post-meta"><span class="chip">Browser database</span><span>this device only; no sign-in needed</span></span>
          <span class="post-meta local-usage">…</span>
          <span class="post-meta">Saving works offline and when Cloudflare Access has signed you out. Clearing this browser's
            site data deletes it: publish, or move drafts to other storage, to keep them.</span></div>
          <a class="btn btn-small" href="#/files/local/">Files</a></li>
      </ul>
    </section>
    <div class="store-form-slot"></div>
  </div>`;
  localStore.usage().then((u) => {
    const el = view.querySelector('.local-usage');
    if (el) el.textContent = `${u.posts} post(s), ${u.files} file(s), ${formatSize(u.bytes)}`;
  }, () => {});
  view.querySelector('.storage-view').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.closest('.store-form')) return;
    if (btn.dataset.act === 'add') openForm(view, null);
    if (btn.dataset.act === 'edit') {
      openForm(view, all.find((s) => s.id === btn.dataset.id && s.location === btn.dataset.location));
    }
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
  const where = existing?.location ?? (data.kv ? 'kv' : 'browser');
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
      <fieldset class="where">
        <legend>Keep the settings and password</legend>
        <label class="check"><input type="radio" name="location" value="kv" ${data.kv ? '' : 'disabled'}>
          In Cloudflare KV: use it from every device${data.kv ? '' : ' (this deploy has no KV namespace)'}</label>
        <label class="check"><input type="radio" name="location" value="browser">
          In this browser only: other devices never see it</label>
      </fieldset>
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
  form.querySelector(`input[name=location][value=${where}]`).checked = true;
  let idTouched = !isNew;

  const renderType = () => {
    form.querySelector('.type-fields').innerHTML = typeFields(typeSel.value, existing);
    if (existing?.type === typeSel.value) {
      for (const [k, v] of Object.entries(existing)) {
        const el = form.elements[k];
        if (!el || el.type === 'password' || el.type === 'radio' || k === 'type') continue;
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

  const target = () => form.querySelector('input[name=location]:checked').value;

  /** The form's settings. Empty secrets mean "keep": filled in here from a
   *  browser store, or by the Worker for a store saved in KV. */
  const collect = () => {
    const out = { type: typeSel.value, secrets: {} };
    for (const el of form.elements) {
      if (!el.name || el.name === 'type' || el.name === 'location') continue;
      if (el.type === 'password') out.secrets[el.name] = el.value;
      else if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value.trim();
    }
    if ((out.type === 'webdav' || out.type === 'github') && !out.folder) out.folder = 'blog-drafts';
    if (existing?.location === 'browser' && existing.type === out.type) {
      const kept = browserStores.all().find((s) => s.id === existing.id)?.secrets ?? {};
      for (const [k, v] of Object.entries(kept)) if (!out.secrets[k]) out.secrets[k] = v;
    }
    return out;
  };
  const busy = (on) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

  /** Remove the store being edited from where it is kept now. */
  const removeExisting = async () => {
    if (existing?.location === 'browser') browserStores.save(browserStores.all().filter((s) => s.id !== existing.id));
    if (existing?.location === 'kv') {
      data = await api.saveStorage(data.version, data.stores.filter((s) => s.id !== existing.id));
    }
  };

  const save = async () => {
    const store = collect();
    const to = target();
    const moving = existing && existing.location !== to;
    if (moving && existing.location === 'kv' && Object.values(store.secrets).every((v) => !v)) {
      // KV never sends its secrets back, so they must be typed in again.
      throw new Error('To keep this store in the browser instead, type its password or key again.');
    }
    if (to === 'browser') {
      const { store: checked } = await api.testStorage(store, 'browser', true);
      const others = browserStores.all().filter((s) => s.id !== store.id);
      if (moving) await removeExisting();
      browserStores.save([...others, checked]);
    } else {
      const list = data.stores.filter((s) => s.id !== store.id);
      data = await api.saveStorage(data.version, [...list, store]);
      if (moving) await removeExisting();
    }
    state.session = await api.session();
    return store;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const id = form.elements.id.value;
    const taken = [...data.deployed, ...data.stores, ...localView()].some((s) => s.id === id);
    if (isNew && taken) {
      toast(`The id “${id}” is already used.`, 'error');
      return;
    }
    busy(true);
    try {
      const store = await save();
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
        const r = await api.testStorage(collect(), existing?.location === 'kv' ? 'kv' : 'browser');
        check.className = r.ok ? 'store-check ok' : 'store-check error';
        check.textContent = r.ok
          ? `Connected: ${r.posts} post(s) found${r.wrote ? '; writing, reading and deleting a test file all work' : ''}.`
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
        await removeExisting();
        state.session = await api.session();
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
