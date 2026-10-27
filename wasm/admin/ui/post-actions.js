// What can be done to a post, run as background tasks (tasks.js): publish
// (or update the site), unpublish, delete. Used by the posts list (each
// card's ⋯ menu) and by the editor's Publish button. Only the questions
// (which files go public, what to delete) are asked in a dialog; the work
// itself runs in the Activity panel while the admin stays usable.
//
// A post is { draft: {store, key, etag} | null, published: {key, etag, blog}
// | null, title }: its working copy in a draft store and its published copy,
// on the public site (blog "site") or the private blog ("private", read only
// in the admin at /blog/). A post is on one of them at a time.

import { api, ApiError } from './client.js';
import { articleHtml, PARSER_FLAGS } from './lib/blog-render.js';
import { protectPost, wantsPassword } from './lib/protect.js';
import { parseFrontMatter } from './lib/post-format.js';
import {
  blogLabel, dialog, draftStores, esc, formatSize, getMd4c, privateUrl, publicUrl, rebuildSite, state, storeLabel, toast,
} from './shared.js';
import { Cancelled, runTask } from './tasks.js';
import { LOCAL_ID } from './local-store.js';
import { classify, referencedKeys } from './paths.js';

const slugOf = (key) => key.slice('posts/'.length, -'.md'.length);
const quoted = (post) => `“${post.title || slugOf((post.draft ?? post.published).key)}”`;

/**
 * Which of the files the post uses go public: lists them with checkboxes
 * (new files ticked; different public files unticked, ticking replaces
 * them). Returns { skip, overwrite }, or null when cancelled.
 */
async function chooseFiles(files, locked, store, to = 'site') {
  const open = files.filter((x) => x.action === 'copy' || x.action === 'conflict');
  if (!open.length) return { skip: [], overwrite: [] };
  const body = document.createElement('div');
  body.innerHTML = `<p>This post uses these files from ${esc(storeLabel(store))}. Tick the ones to copy to ${to === 'private' ? 'the private blog' : 'the public site'};
    unticked files stay in the draft store (their links won't work on the blog).</p>
    ${locked ? '<p class="warn">The post is password-protected, but its files are not encrypted: anyone with a file\'s address can open it. They are unticked.</p>' : ''}
    <ul class="file-choices">${open.map((x) => `<li><label class="check">
      <input type="checkbox" value="${esc(x.key)}" ${x.action === 'copy' && !locked ? 'checked' : ''}>
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

/** Delete the published copy (on its blog), unless it is already gone. */
async function removePublished(p) {
  await api.remove(p.blog ?? 'site', p.key, p.etag).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  });
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The Worker's /api/publish, done in the browser for a draft kept in this
 * browser (the Worker cannot read it): the same plan (copy, identical,
 * conflict, skip), the same choices, then the files and the post are
 * written to the site through the file API, which checks them as usual.
 */
async function browserPublish(draft, siteEtag, { dryRun, skip = [], overwrite = [], postBody, to = 'site', leave }) {
  const site = to; // the blog it goes to
  const { text, etag } = await api.read(LOCAL_ID, draft.key);
  if (draft.etag && etag !== draft.etag) {
    throw new ApiError(412, { error: `${draft.key} was changed since you opened it`, code: 'changed' });
  }
  const files = [];
  for (const key of referencedKeys(text, draft.key)) {
    if (classify('drafts', key) !== 'asset') continue;
    let bytes;
    try {
      ({ bytes } = await api.read(LOCAL_ID, key, 'bytes'));
    } catch {
      continue; // not in this browser: already public, or missing
    }
    if (skip.includes(key)) {
      files.push({ key, action: 'skip', size: bytes.length });
      continue;
    }
    const pub = (await api.listAll(site, key)).find((i) => i.key === key);
    if (!pub) files.push({ key, action: 'copy', size: bytes.length, bytes });
    else if (sameBytes(bytes, (await api.read(site, key, 'bytes')).bytes)) files.push({ key, action: 'identical', size: bytes.length });
    else if (overwrite.includes(key)) files.push({ key, action: 'overwrite', size: bytes.length, bytes, etag: pub.etag });
    else files.push({ key, action: 'conflict', size: bytes.length, reason: 'a different file with this name is already public' });
  }
  const live = (await api.listAll(site, draft.key)).find((i) => i.key === draft.key);
  const protectedPost = wantsPassword(parseFrontMatter(text).meta);
  if (dryRun) return { dryRun: true, updated: Boolean(live), protected: protectedPost, files: files.map(({ bytes, ...f }) => f) };
  const conflicts = files.filter((f) => f.action === 'conflict');
  if (conflicts.length) {
    throw new ApiError(409, { error: `Publishing would replace ${conflicts.length} public file(s) that differ from the draft's`, code: 'asset-conflict', assets: conflicts });
  }
  if (live && siteEtag && live.etag !== siteEtag) {
    throw new ApiError(412, { error: `The published ${draft.key} was changed elsewhere since you opened it`, code: 'changed' });
  }
  // Files first, so the post never goes live with missing images.
  for (const f of files) {
    if (f.bytes) await api.write(site, f.key, f.bytes, f.action === 'overwrite' ? f.etag : null);
  }
  // Off the other blog first: a post is on one blog at a time.
  const old = leave ? (await api.listAll(leave, draft.key)).find((i) => i.key === draft.key) : null;
  if (old) await api.remove(leave, draft.key, old.etag);
  const post = await api.write(site, draft.key, protectedPost ? postBody : text, live ? live.etag : null, { ofPublished: true, ignore: draft });
  const by = (a) => files.filter((f) => f.action === a).map((f) => f.key);
  return { post, updated: Boolean(live), files: { copy: by('copy'), identical: by('identical'), overwrite: by('overwrite'), skip: by('skip') } };
}

/** The Worker's publish, or the browser's for a draft kept in this browser. */
const publishCall = (draft, siteEtag, opts) => (draft.store === LOCAL_ID
  ? browserPublish(draft, siteEtag, opts)
  : api.publish({ store: draft.store, key: draft.key }, draft.etag, opts.overwrite ?? [], siteEtag, opts));

/** Wait for the blogs' update (["site"], ["private"] or both), showing it as this task's step. */
async function updateSite(step, blogs = ['site']) {
  step(blogs.includes('private') && blogs.length === 1 ? 'Updating the private blog…' : 'Updating the site (see “Update the site”)…');
  await Promise.all([...new Set(blogs)].map((target) => rebuildSite({ target })));
}

/** A published post's page: on the public blog, or the private one in the admin. */
export const pageUrl = (key, blog) => (blog === 'private' ? privateUrl : publicUrl)(`posts/${slugOf(key)}.html`);

/** Ask which blog to publish to; null when cancelled. With no private blog: the public one. */
export async function askPublishTarget(post) {
  if (!state.session?.privateBlog) return 'site';
  const now = post.published?.blog;
  return dialog({
    title: `Publish ${quoted(post)} to…`,
    body: now ? `It is on ${blogLabel(now)} now; publishing to the other one takes it off ${blogLabel(now)}.`
      : 'The public blog is for everyone; the private blog is read only here, in the admin, once you have signed in.',
    buttons: [
      { label: now === 'site' ? 'Update the public blog' : 'The public blog', value: 'site', kind: now !== 'private' ? 'primary' : undefined },
      { label: now === 'private' ? 'Update the private blog' : 'The private blog', value: 'private', kind: now === 'private' ? 'primary' : undefined },
      { label: 'Cancel', value: null },
    ],
    stacked: true,
  });
}

/**
 * Publish a draft (or update its public copy) in the background.
 * `alsoRemove`: an older public copy to take down (the post was renamed).
 * Resolves with the publish result; rejects with Cancelled if the owner
 * cancels the file choice.
 */
export function publishPost(post, { alsoRemove = null, to } = {}) {
  const { draft, published } = post;
  const blog = to ?? published?.blog ?? 'site';
  // Published on the other blog: it moves (taken off there once it is here).
  const leave = published && (published.blog ?? 'site') !== blog ? (published.blog ?? 'site') : undefined;
  const updating = Boolean(published) && !leave;
  return runTask(`${updating ? 'Update' : 'Publish'} ${quoted(post)}${blog === 'private' ? ' (private)' : ''}`, async ({ step, log, link }) => {
    const siteEtag = !leave && published?.key === draft.key ? published.etag : undefined;
    step('Checking the files it uses…');
    const plan = await publishCall(draft, siteEtag, { dryRun: true, to: blog, leave });
    step('Waiting for your choice of files…');
    const choice = await chooseFiles(plan.files, plan.protected, draft.store, blog);
    if (!choice) throw new Cancelled('Not published: the file choice was cancelled.');
    let postBody;
    if (plan.protected) {
      // Encrypted here, in the browser: the password never leaves the draft.
      step('Encrypting…');
      const [{ text }, md4c] = await Promise.all([api.read(draft.store, draft.key), getMd4c()]);
      postBody = await protectPost(text, (md, meta) => articleHtml(meta, md, (m) => md4c.toHtml(m, { parserFlags: PARSER_FLAGS })));
    }
    let overwrite = choice.overwrite;
    let r;
    for (;;) {
      try {
        step('Copying the post and its files to the site…');
        r = await publishCall(draft, siteEtag, { overwrite, skip: choice.skip, postBody, to: blog, leave });
        break;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'asset-conflict')) throw err;
        const box = document.createElement('div');
        box.innerHTML = `<p>These files already exist on the public site with different content:</p><ul>${err.assets
          .map((a) => `<li><code>${esc(a.key)}</code></li>`).join('')}</ul><p>Replace them with this draft's versions? Other posts using them will show the new files.</p>`;
        const ok = await dialog({ title: 'Replace public files?', body: box, buttons: [
          { label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger' },
        ] });
        if (!ok) throw new Cancelled('Not published: different public files were kept.');
        overwrite = err.assets.map((a) => a.key);
      }
    }
    for (const a of ['copy', 'overwrite', 'skip']) for (const k of r.files[a]) log(`${a === 'skip' ? 'kept private' : a} ${k}`);
    if (alsoRemove && alsoRemove.key !== draft.key) {
      step('Taking down the old address…');
      await removePublished(alsoRemove);
    }
    await updateSite(step, leave ? [blog, leave] : [blog]);
    const url = pageUrl(draft.key, blog);
    link(url, blog === 'private' ? 'View on the private blog' : 'View on the blog');
    if (blog === 'site' && state.site.indexNowKey && state.site.url && url) {
      api.indexNow([url, publicUrl('index.html')]).catch((err) => log(`IndexNow: ${err.message}`));
    }
    const copied = r.files.copy.length + r.files.overwrite.length;
    const kept = r.files.skip.length;
    toast(`${r.updated ? 'Updated' : 'Published'} ${quoted(post)}${blog === 'private' ? ' on the private blog' : ''}${copied ? ` with ${copied} file(s)` : ''}${kept ? `; ${kept} kept in the draft store` : ''}.`, 'success');
    return r;
  }, { key: draft.key });
}

/**
 * Take a post off the blog. Its draft stays; without one, the public copy
 * becomes a draft in the first draft store (nothing is lost).
 */
export function unpublishPost(post) {
  const { draft, published } = post;
  return runTask(`Unpublish ${quoted(post)}`, async ({ step }) => {
    if (draft) {
      step('Removing the public copy…');
      await removePublished(published);
    } else {
      const store = draftStores()[0]?.id;
      if (!store) throw new Error('There is no draft store to keep it in.');
      step(`Moving it to ${storeLabel(store)}…`);
      await api.move({ store: published.blog ?? 'site', key: published.key }, { store, key: published.key }, published.etag);
    }
    await updateSite(step, [published.blog ?? 'site']);
    toast(`Unpublished ${quoted(post)}; the draft stays in ${storeLabel(draft?.store ?? draftStores()[0]?.id)}.`, 'success');
  }, { key: published.key });
}

/** Delete the draft, the public copy, or both (`what`: 'draft' | 'published' | 'both'). */
export function deletePost(post, what) {
  const { draft, published } = post;
  const label = { draft: 'Delete the draft of', published: 'Delete the published', both: 'Delete' }[what];
  return runTask(`${label} ${quoted(post)}`, async ({ step }) => {
    if (what !== 'published' && draft) {
      step(`Deleting the draft from ${storeLabel(draft.store)}…`);
      await api.remove(draft.store, draft.key, draft.etag);
    }
    if (what !== 'draft' && published) {
      step('Removing the published copy…');
      await removePublished(published);
      await updateSite(step, [published.blog ?? 'site']);
    }
    toast(`Deleted ${quoted(post)}${what === 'draft' && published ? ' (draft only; still published)' : ''}.`, 'success');
  }, { key: (draft ?? published).key });
}

/** Ask which draft store to move a draft to; null when cancelled or there is none. */
export async function askMoveTarget(post) {
  const others = draftStores().filter((d) => d.id !== post.draft.store);
  if (!others.length) return null;
  return dialog({
    title: `Move ${quoted(post)} to…`,
    body: `It is in ${storeLabel(post.draft.store)}. The files it uses are copied along (and kept where they are, in case other drafts use them).`,
    buttons: [...others.map((d) => ({ label: d.label, value: d.id, kind: 'primary' })), { label: 'Cancel', value: null }],
    stacked: true,
  });
}

/**
 * Move a draft to another draft store (e.g. from this browser to a cloud
 * store, or back), with the files it uses. Different files with the same
 * name already there stop it before anything moves.
 */
export function moveDraft(post, to) {
  const { draft } = post;
  return runTask(`Move ${quoted(post)} to ${storeLabel(to)}`, async ({ step, log }) => {
    step('Reading the draft…');
    const { text } = await api.read(draft.store, draft.key);
    const files = [];
    for (const key of referencedKeys(text, draft.key)) {
      if (classify('drafts', key) !== 'asset') continue;
      const bytes = await api.read(draft.store, key, 'bytes').then((r) => r.bytes, () => null);
      if (!bytes) continue; // not in this store (public, or missing)
      const there = await api.read(to, key, 'bytes').then((r) => r.bytes, () => null);
      if (there && !sameBytes(there, bytes)) throw new Error(`${storeLabel(to)} already has a different ${key}; rename one of them first.`);
      if (!there) files.push({ key, bytes });
    }
    for (const f of files) {
      step(`Copying ${f.key}…`);
      await api.write(to, f.key, f.bytes, null);
      log(`copied ${f.key}`);
    }
    step('Moving the post…');
    await api.move({ store: draft.store, key: draft.key }, { store: to, key: draft.key }, draft.etag);
    toast(`Moved ${quoted(post)} to ${storeLabel(to)}${files.length ? ` with ${files.length} file(s)` : ''}.`, 'success');
  }, { key: draft.key });
}

/** Ask what to delete; null when cancelled. */
export async function askDelete(post) {
  const { draft, published } = post;
  if (draft && published) {
    return dialog({
      title: `Delete ${quoted(post)}?`,
      body: `It is published, and its draft is in ${storeLabel(draft.store)}.`,
      buttons: [
        { label: 'Delete the draft only', value: 'draft' },
        { label: 'Delete the draft and unpublish', value: 'both', kind: 'danger' },
        { label: 'Cancel', value: null },
      ],
      stacked: true,
    });
  }
  const ok = await dialog({
    title: `Delete ${quoted(post)}?`,
    body: draft
      ? `Delete this draft from ${storeLabel(draft.store)}? This cannot be undone.`
      : 'Delete this published post? Its page is removed from the blog. This cannot be undone.',
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger' }],
  });
  return ok ? (draft ? 'draft' : 'published') : null;
}

/**
 * Move a published post to the other blog (public ⇄ private), with the
 * files it uses. Made private, its files can also leave the public bucket
 * (those no other public post uses). Its draft, if any, stays as it is.
 */
export async function transferPost(post) {
  const { published } = post;
  const from = published.blog ?? 'site';
  const to = from === 'site' ? 'private' : 'site';
  const plan = await api.transfer(published.key, to, { dryRun: true });
  const conflicts = plan.files.filter((f) => f.action === 'conflict');
  const copies = plan.files.filter((f) => f.action === 'copy');
  const body = document.createElement('div');
  body.innerHTML = `<p>${to === 'private'
    ? 'It leaves the public blog (readers no longer see it) and goes to the private blog, read only here in the admin.'
    : 'It leaves the private blog and goes on the public blog, for everyone.'}</p>
    ${copies.length ? `<p>Its files go along: ${copies.map((f) => `<code>${esc(f.key)}</code>`).join(', ')}.</p>` : ''}
    ${to === 'private' && copies.length ? `<label class="check"><input type="checkbox" name="remove" checked>
      <span>Also delete them from the public site (unless another public post uses them)</span></label>` : ''}
    ${conflicts.length ? `<p class="warn">${to === 'private' ? 'The private blog' : 'The public site'} already has different files named
      ${conflicts.map((f) => `<code>${esc(f.key)}</code>`).join(', ')}: they will be replaced.</p>` : ''}`;
  const ok = await dialog({
    title: to === 'private' ? `Make ${quoted(post)} private?` : `Make ${quoted(post)} public?`,
    body,
    buttons: [{ label: 'Cancel', value: false }, { label: to === 'private' ? 'Make private' : 'Make public', value: true, kind: 'primary' }],
  });
  if (!ok) return null;
  const removeFiles = Boolean(body.querySelector('input[name=remove]')?.checked);
  return runTask(`Make ${quoted(post)} ${to === 'private' ? 'private' : 'public'}`, async ({ step, log, link }) => {
    step(`Moving it to ${blogLabel(to)}…`);
    const r = await api.transfer(published.key, to, { ifMatch: published.etag, overwrite: conflicts.map((f) => f.key), removeFiles });
    for (const k of [...r.files.copy, ...r.files.overwrite]) log(`copied ${k}`);
    for (const k of r.removed) log(`removed from ${blogLabel(from)}: ${k}`);
    await updateSite(step, [from, to]);
    link(pageUrl(published.key, to), to === 'private' ? 'View on the private blog' : 'View on the blog');
    toast(`${quoted(post)} is now on ${blogLabel(to)}.`, 'success');
    return r;
  }, { key: published.key });
}
