# Blog admin: edit and publish from any device

A small admin app for the blog, usable from a phone. You can browse the
storage folders, write and edit posts with a live preview in the blog's own
theme, upload photos, and save drafts, publish, update or unpublish posts.
Drafts and their photos stay private in one or more draft stores (R2
buckets, WebDAV shares such as Nextcloud or a NAS, S3-compatible buckets
or GitHub). Publishing puts the rendered page and the files it uses in the
public bucket, and the draft stays as your working copy. The post's
Markdown itself never goes public (see below).
It runs as a Cloudflare Worker on its own hostname (for example
`admin.blog.example.com`), behind Cloudflare Access.

Readers are unaffected: they still read the public R2 bucket directly and
never touch the Worker.

```
phone/laptop browser ──(Cloudflare Access login)──▶ admin Worker ──R2 binding──▶ my-blog         (public)
  admin app + md4c.wasm: renders pages locally        checks every write ─R2───▶ my-blog-drafts  (private)
                                                                         └WebDAV▶ NAS / Nextcloud (private)
readers ───────────────────────────────────────────────────────────────────────▶ my-blog public URL
```

Publishing runs the same site build as `scripts/publish.mjs`
(`js/site-build.js`, with md4c.wasm), but in your browser. The Worker only
authenticates you and stores files, so the R2 API token never leaves
Cloudflare. Builds are incremental: publishing one post re-renders that
post's page, the home page, `index.json`, the sitemap and the feed.

## What the Worker enforces

All of these checks happen on the server, whatever the browser sends.

| Check | Rule |
|---|---|
| Identity | Each request must carry a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`). The Worker checks the signature against your team's rotating keys, the issuer, the audience (AUD) and the expiry. `ADMIN_EMAILS` optionally narrows access further. This includes the admin pages, not just the API. |
| CSRF | Writes need an `X-Admin-Request` header and a same-origin request (`Origin`, `Sec-Fetch-Site`). |
| Paths | Posts must be `posts/<slug>.md` (slug: `a-z`, `0-9`, `-`). Only posts are rendered to pages. Attachments of any type (images, audio, video, PDFs, HTML, archives…) go in `posts/`, its sub-folders, or `assets/`, and are served as they are. An empty folder is kept by a hidden `.keep` marker (`POST /api/folder`). Generated files (`index.html`, `posts/<slug>.html`, `index.json`, `sitemap.xml`, `feed.xml`, `robots.txt`, `theme.css`) are written by the build. The site's code (`app.js`, `lib/`, `vendor/`, …) is locked and deployed only with `publish.mjs --site`. No `..`, hidden files or odd characters are allowed. |
| Content types | Set by the server from the file extension. The client's claim is ignored. |
| Create vs update | Creating needs `If-None-Match: *`, and fails with `409 exists` if the file is there. Updating needs `If-Match: <etag>`, and fails with `412 changed` if the file was changed elsewhere, for example from your laptop, since you opened it. A post or asset written without either gets `428`. |
| Path conflicts | `409 file-in-path`: a parent "folder" is actually a file. `409 folder-exists`: a folder already has that name. |
| Slug conflicts | A post has at most one draft, in one draft store, and at most one published copy. A new post can't take the slug of another draft (`409 draft-exists`) or of a published post (`409 published-exists`). The exception is the published post's own draft, which the editor creates with `ofPublished=1`. |
| Publishing | Drafts go live only through `/api/publish`; a plain move into the site is refused with `use-publish`. Publishing works out which local files the post uses, from its Markdown links and images, HTML `src`/`href`, and front-matter `image:`, and copies them from the draft store to the site before the post itself. The editor first asks for the plan (`dryRun`) and lets you untick files, which stay private (`skip`). Single attachments can also be copied with `/api/copy`. A public file with the same name is kept if identical. If it differs, publishing stops with `409 asset-conflict` and lists the files, and nothing is written until you choose to replace them. The draft and its files stay in the draft store. Publishing again updates the public copy; if that copy was changed elsewhere since the editor last saw it (`siteIfMatch`), it stops with `412 changed`. |
| Size | Uploads are limited to `MAX_UPLOAD_MB` (25 MB by default). The editor shrinks photos to 2400 px first. |
| Reading | Files are served to the admin with a sandboxing CSP, and HTML is served as text, so stored content can never run in the admin's origin. |

Drafts and their photos live in private draft stores. Anything in the
public bucket can be read by URL, so drafts stay out of it until you publish.

### Published Markdown stays private

The public bucket holds only what readers need: the pages, `index.json`
and the attachments. A published post's Markdown (`posts/<slug>.md`, the
source the pages are built from) is kept in the private `DRAFTS` bucket
under `.published/` (or in a `SOURCES` R2 binding, if the deploy has one).
To the admin and the site build it still looks like part of the site:
the Explorer shows it under **Published site**, publishing writes it, and
unpublishing removes it.

Markdown published before this (in the public bucket) is moved there on
the next publish or rebuild, and the build log lists each file as
`private posts/<slug>.md`. A rebuild that cannot see the private Markdown
(`publish.mjs` without `--sources-bucket`) is refused, so it cannot
delete every page by mistake. Without a `DRAFTS` bucket (only
`DRAFT_STORES`), the Markdown stays public, as before.

## Draft stores

The `DRAFTS` R2 bucket is always a draft store. Add more from the admin's
**Storage** page, from any device, with no redeploy and no Worker secrets:

| Type | For | You enter |
|---|---|---|
| WebDAV | Nextcloud, ownCloud, a NAS | server URL, folder, user name, password (an app password is best) or token |
| S3-compatible | Amazon S3, another R2 bucket, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO | service, endpoint, region, bucket, optional folder, access key ID and secret |
| GitHub | a private repository | owner, repository, branch, folder, and a fine-grained token with *Contents: Read and write* |

For each store you choose where its settings and password are kept:

- **In Cloudflare KV (every device).** Saved in the `SETTINGS` KV namespace.
  - The password is never sent back to the browser; leave the field empty
    to keep it.
  - KV is eventually consistent, so another device may take up to a
    minute to see a change.
- **In this browser only.** Kept in the browser's local storage.
  - The admin app sends them to the Worker with each request, in cookies
    limited to `/api` (`SameSite=Strict`, `Secure`), so image previews
    work too.
  - The Worker uses them for that request and never saves them.
  - Other devices never see the store. Clearing the site's data in the
    browser forgets it.

Nothing is kept in the drafts bucket.

**Using the page:**
- **Test connection** does a full round trip with a small check file in
  `posts/`: write it, find it again, see it in the folder listing, read it
  back, delete it, and confirm it's gone.
  - If a step fails, it says which one, and for WebDAV the exact server
    address it used. That shows at once whether the server URL, base
    folder or drafts folder is wrong.
  - GitHub is only listed, so the check makes no commits.
- **Saving** checks the settings on the server.
- **Moving a store.** You can move a store between KV and the browser by
  editing it. Moving it into the browser needs its password typed again,
  because KV never sends it back.
- **Removing a store** only stops the admin using it. Its files stay where
  they are.

Give each store credentials limited to it, such as an app password, a key
scoped to one bucket, or a token for one repository. For KV, anyone with
access to the KV namespace in your Cloudflare account can read them. For
the browser, anyone with access to the browser can.

Each store's server must be reachable from Cloudflare. For a home NAS, that
usually means a public HTTPS address or a Cloudflare Tunnel.

**WebDAV servers differ in small ways**, for example a server URL with a
path such as Nextcloud's `/remote.php/dav/files/<user>`, or a server that
refuses to describe a single file. So the admin never takes one
file-lookup request's word that a file is missing:
- it checks the folder listing, which is what the explorer shows;
- it reads, replaces and deletes the file at the path the server reports;
- after an upload or a delete, it checks the result, and an error names
  the server address if the server disagrees;
- folders are real WebDAV folders. The explorer lists the server's folders,
  including empty ones that other WebDAV apps made. *New folder* and
  *Remove folder* create and delete real folders that other apps see too.
  R2, S3 and GitHub have no real folders, so there an empty folder is kept
  by a hidden `.keep` file.

A store that can't be reached doesn't stop the rest of the admin. The
Posts page shows the error for that store, and writes to it fail with
`502 store-unreachable` and the reason.

**Limits:**
- **Change checks.** WebDAV, S3 and GitHub stores have no conditional
  writes through storagesdk, so "changed elsewhere" is checked just before
  writing. That is safe for one admin, but not a lock between two
  simultaneous writers.
- **GitHub.** Every save is a commit, and files over 1 MB can't be stored.

**In the deploy instead (optional).** `DRAFT_STORES` in `wrangler.toml`
still works for stores you want fixed in the deploy, such as extra R2
bindings. There, credentials name Worker secrets
(`"passwordSecret": "NAS_PASSWORD"`) rather than values. Those stores are
listed as "set in the deploy" and can't be edited from the admin.

## One-time setup

You need the blog already deployed (see `DEPLOY-CLOUDFLARE.md`), a domain on
Cloudflare, and Node.js 20 or newer on a computer for the first deploy.

1. **Create the drafts bucket.** In R2, create a second bucket, for example
   `my-blog-drafts`. Do **not** enable public access on it.
   Optionally create a KV namespace too, for example `blog-admin-settings`,
   if you want storage added on the Storage page to be usable from every
   device. Without one, it is kept in each browser.
2. **Protect the admin hostname with Cloudflare Access.** In the Zero Trust
   dashboard (Cloudflare One), add an Access application:
   - Type: *Self-hosted*. Application domain: `admin.blog.example.com`.
   - Policy: *Allow*, with *Include → Emails* set to your address. Choose a
     login method: one-time PIN by email works immediately, or connect
     Google or GitHub.
   - Then copy two values:
     - the application's **Audience (AUD) tag**, from the application's
       settings;
     - your **team domain**, `https://<team>.cloudflareaccess.com`.
3. **Edit `admin/wrangler.toml`:**
   - the route pattern (`admin.blog.example.com`);
   - the two `bucket_name`s, and the KV namespace `id` (or remove that
     section);
   - `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` and `PUBLIC_URL`
     (the blog's public address).

   Keep `workers_dev = false`, so the Worker is only reachable through the
   Access-protected hostname.
4. **Deploy:**
   ```sh
   cd wasm
   npm install
   npx wrangler login
   npm run build
   npm run admin:deploy
   ```
5. Open `https://admin.blog.example.com` on your phone. Sign in through
   Access, then add the page to the home screen.

To update the admin later, rerun `npm run build && npm run admin:deploy`.

## Using it

- **Posts** (the home screen) lists drafts, labelled by their store, and
  published posts in separate sections, with search.
- **Files** browses one store at a time; choose it from the menu at the top.
  - Each folder lists sub-folders, posts and attachments separately.
    Generated pages and site code are folded away and can only be viewed.
  - **Uploads:** any type of file can go into `posts/`, a folder inside
    it, or a folder under `assets/`.
  - **Markdown uploaded to `posts/` becomes a post.** Its address uses
    lowercase letters, digits and dashes, so the file is renamed if needed
    (`My_Notes v1.2.md` → `my-notes-v1-2.md`). A name with no usable
    letters, for example Chinese only, takes the post's title instead.
  - **Folders:** *New folder* creates a folder straight away, and it stays
    listed while it is empty. *Remove folder* removes an empty one.
  - **Viewing a file:** a file's page plays audio and video, shows images
    and text, and offers a download.
  - **The ⋯ menu** on a row offers open, copy Markdown, open on the blog,
    rename or move, and delete. In a draft store it also has *Copy to
    public site*, which asks before replacing a different public file.
- **New post:** fill in the title (the address is derived from it), date,
  tags, and optionally an author, a banner image above the article, a page
  background, a search description and a social image. The banner and
  background have their own upload buttons. Then write.
  - The toolbar inserts Markdown.
    - *Image* uploads photos from the camera roll and inserts them as
      figures.
    - *File* attaches anything else. Audio and video become players, and
      other files become links.
  - **🔒 Password** (in *Title, date, tags…*): the post is published
    encrypted, and readers type the password to read it.
    - The password is kept only in the private draft.
    - The editor encrypts the post in your browser before it is sent, and
      the Worker refuses a post with a password unless it is encrypted.
    - Attachments are not encrypted, so they are unticked when you publish.
    - See *Password-protected posts* in `DEPLOY-CLOUDFLARE.md`.
  - **Publish** lists the files the post uses. Untick any that should stay
    private.
  - *Preview* shows the post in the blog's theme, with contents box, figures
    and maths.
  - Text and preview follow each other:
    - **Side by side** (wide screens): scrolling either one scrolls the
      other to the same place.
    - **Click a block in the preview** (a paragraph, heading, list item,
      code block, table cell…) to select its lines in the text. On a phone,
      tapping it in *Preview* switches to *Write* with those lines selected.
    - The block the cursor is in is marked in the preview.
    - This works because the preview is rendered with md4c.wasm's
      `SOURCE_POS` flag: each block carries `data-src`, where its text starts
      in the Markdown (`md4c_wasm.c`). Published pages are rendered without it.
  - What you type is also kept on the device until it's saved.
- **The draft is the working copy.**
  - **Save draft** stores the post privately. A published post isn't
    changed by it, and shows *changes not live* until you update the site.
  - **Publish** first saves the draft. It then copies the post, and the
    files it uses, to the public bucket and updates the site. The draft
    stays.
  - **Update site** republishes the draft.
  - **Unpublish** removes the public copy and its page, and keeps the
    draft.
  - **Delete**, for a published post, asks whether to delete only the draft
    or the draft and the public copy.
  - **Posts published elsewhere**, for example with `publish.mjs` from a
    laptop, get a draft the first time you save them in the admin.
  - **Without any draft store**, posts are written straight to the public
    bucket.
- **Changed elsewhere:** if a post was saved from another device while you
  were editing, you choose to overwrite it with your version or load theirs.
- **Storage:** add, test, edit or remove draft storage (see above).
- **Settings:** the title, slogan, author, home-page banner and background
  (with upload buttons) are simple fields. Everything else is in the
  `site` section of `index.json` below them (theme,
  colours, background, `url`, search-engine verification…). Saving rebuilds
  every page. *Notify search engines* submits the pages to IndexNow when
  `indexNowKey` is set.

The laptop workflow (`scripts/publish.mjs`) keeps working alongside the
admin. Both write the same files, and the etag checks catch overlapping
edits.

## Local development

```sh
npm run build && npm run admin:dev
```

- **Admin:** <http://127.0.0.1:8787/>, running the real Worker in Node.
  Access is simulated by signing a token for every request, so it listens on
  127.0.0.1 only.
- **Blog:** <http://127.0.0.1:8788/index.html>, served from `dist/public/`,
  which stands in for the public bucket.
- **Draft stores:** an R2 stand-in in `dist/drafts/`, and an embedded WebDAV
  server on port 8789 with files in `dist/webdav/`.

`npm test` covers the Worker's authentication, path and conflict rules,
both kinds of draft store, and publishing with files
(`test/admin-worker.test.mjs`, which runs a WebDAV server). `npx wrangler dev --config admin/wrangler.toml`
runs it in Cloudflare's own runtime with local R2 buckets.

## Costs and limits

- Everything fits Cloudflare's free tiers for a personal blog: Workers
  (100,000 requests a day), R2 (1 million writes a month) and Access (free
  for small teams).
- Each publish makes a few dozen requests: the listing, a few reads, the
  changed pages, the home page and the indexes.
- **Posts list:** it never reads a post. It shows each post as a link,
  using only the storage listing and summaries already known:
  - **R2 drafts:** they carry their title, date and tags as object metadata,
    written with each save.
  - **Published posts:** their titles come from `index.json`.
  - **Drafts the Worker saved:** it remembers their titles.
  - **Anything else** is shown by its address until its next save in the
    admin. That covers drafts written outside the admin, and drafts in
    WebDAV, S3 or GitHub stores after the Worker restarts.

  The list shows the last result at once, then refreshes in the background.
  The page loads only the list's code (under 100 KB). The Markdown engine,
  site builder, editor and file explorer load when first opened.
- **Files:** each folder is listed one level deep, with one R2 list or one
  WebDAV `PROPFIND`, and the last listing shows at once on the next visit.
- A move (rename, publish, unpublish) is a copy followed by a delete. If the
  delete fails, the explorer shows both copies, and you can delete the
  leftover.
