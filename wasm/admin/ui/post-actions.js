// What can be done to a post, run as background tasks (tasks.js): publish
// (or update the site), unpublish, delete. Used by the posts list (each
// card's ⋯ menu) and by the editor's Publish button. Only the questions
// (which files go public, what to delete) are asked in a dialog; the work
// itself runs in the Activity panel while the admin stays usable.
//
// A post is { draft: {store, key, etag} | null, published: {key, etag} | null,
// title }: its working copy in a draft store and its public copy.

import { api, ApiError } from './client.js';
import { linkPostsForStaticPage, PARSER_FLAGS } from './lib/blog-render.js';
import { protectPost } from './lib/protect.js';
import { dialog, draftStores, esc, formatSize, getMd4c, publicUrl, rebuildSite, state, storeLabel, toast } from './shared.js';
import { Cancelled, runTask } from './tasks.js';

const slugOf = (key) => key.slice('posts/'.length, -'.md'.length);
const quoted = (post) => `“${post.title || slugOf((post.draft ?? post.published).key)}”`;

/**
 * Which of the files the post uses go public: lists them with checkboxes
 * (new files ticked; different public files unticked, ticking replaces
 * them). Returns { skip, overwrite }, or null when cancelled.
 */
async function chooseFiles(files, locked, store) {
  const open = files.filter((x) => x.action === 'copy' || x.action === 'conflict');
  if (!open.length) return { skip: [], overwrite: [] };
  const body = document.createElement('div');
  body.innerHTML = `<p>This post uses these files from ${esc(storeLabel(store))}. Tick the ones to copy to the public site;
    unticked files stay private (their links won't work on the blog).</p>
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

/** Delete the published copy, unless it is already gone. */
async function removePublished(p) {
  await api.remove('site', p.key, p.etag).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  });
}

/** Wait for the site update, showing it as this task's step. */
async function updateSite(step) {
  step('Updating the site (see “Update the site”)…');
  await rebuildSite();
}

/**
 * Publish a draft (or update its public copy) in the background.
 * `alsoRemove`: an older public copy to take down (the post was renamed).
 * Resolves with the publish result; rejects with Cancelled if the owner
 * cancels the file choice.
 */
export function publishPost(post, { alsoRemove = null } = {}) {
  const { draft, published } = post;
  const updating = Boolean(published);
  return runTask(`${updating ? 'Update' : 'Publish'} ${quoted(post)}`, async ({ step, log, link }) => {
    const from = { store: draft.store, key: draft.key };
    const siteEtag = published?.key === draft.key ? published.etag : undefined;
    step('Checking the files it uses…');
    const plan = await api.publish(from, draft.etag, [], siteEtag, { dryRun: true });
    step('Waiting for your choice of files…');
    const choice = await chooseFiles(plan.files, plan.protected, draft.store);
    if (!choice) throw new Cancelled('Not published: the file choice was cancelled.');
    let postBody;
    if (plan.protected) {
      // Encrypted here, in the browser: the password never leaves the draft.
      step('Encrypting…');
      const [{ text }, md4c] = await Promise.all([api.read(draft.store, draft.key), getMd4c()]);
      postBody = await protectPost(text, (md) => linkPostsForStaticPage(md4c.toHtml(md, { parserFlags: PARSER_FLAGS })));
    }
    let overwrite = choice.overwrite;
    let r;
    for (;;) {
      try {
        step('Copying the post and its files to the site…');
        r = await api.publish(from, draft.etag, overwrite, siteEtag, { skip: choice.skip, postBody });
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
    await updateSite(step);
    const url = publicUrl(`posts/${slugOf(draft.key)}.html`);
    link(url, 'View on the blog');
    if (state.site.indexNowKey && state.site.url && url) {
      api.indexNow([url, publicUrl('index.html')]).catch((err) => log(`IndexNow: ${err.message}`));
    }
    const copied = r.files.copy.length + r.files.overwrite.length;
    const kept = r.files.skip.length;
    toast(`${r.updated ? 'Updated' : 'Published'} ${quoted(post)}${copied ? ` with ${copied} file(s)` : ''}${kept ? `; ${kept} kept private` : ''}.`, 'success');
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
      await api.move({ store: 'site', key: published.key }, { store, key: published.key }, published.etag);
    }
    await updateSite(step);
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
      step('Removing the public copy…');
      await removePublished(published);
      await updateSite(step);
    }
    toast(`Deleted ${quoted(post)}${what === 'draft' && published ? ' (draft only; still published)' : ''}.`, 'success');
  }, { key: (draft ?? published).key });
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
