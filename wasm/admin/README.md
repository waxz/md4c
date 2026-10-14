# Blog admin: edit and publish from any device

A small admin app for the blog, usable from a phone. You can browse the
storage folders, write and edit posts with a live preview in the blog's own
theme, upload photos, and save drafts, publish, update or unpublish posts.
Drafts and their photos stay private in one or more draft stores (R2
buckets, or WebDAV shares such as Nextcloud or a NAS), and are copied to
the public bucket when you publish.
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
| Paths | Posts must be `posts/<slug>.md` (slug: `a-z`, `0-9`, `-`). Files go in `posts/` or `assets/`. Generated files (`index.html`, `posts/<slug>.html`, `index.json`, `sitemap.xml`, `feed.xml`, `robots.txt`, `theme.css`) are written by the build. The site's code (`app.js`, `lib/`, `vendor/`, …) is locked and deployed only with `publish.mjs --site`. No `..`, hidden files or odd characters are allowed. |
| Content types | Set by the server from the file extension. The client's claim is ignored. |
| Create vs update | Creating needs `If-None-Match: *`, and fails with `409 exists` if the file is there. Updating needs `If-Match: <etag>`, and fails with `412 changed` if the file was changed elsewhere, for example from your laptop, since you opened it. A post or asset written without either gets `428`. |
| Path conflicts | `409 file-in-path`: a parent "folder" is actually a file. `409 folder-exists`: a folder already has that name. |
| Slug conflicts | A slug lives in exactly one store: it is either published or a draft in a single draft store. `409 published-exists` and `409 draft-exists` are returned on create, rename, publish and unpublish. |
| Publishing | Drafts go live only through `/api/publish`; a plain move into the site is refused with `use-publish`. Publishing works out which local files the post uses, from its Markdown links and images, HTML `src`/`href`, and front-matter `image:`, and copies them from the draft store to the site before the post itself. A public file with the same name is kept if identical. If it differs, publishing stops with `409 asset-conflict` and lists the files, and nothing is written until you choose to replace them. Afterwards the draft store keeps only files that other drafts still use. |
| Size | Uploads are limited to `MAX_UPLOAD_MB` (25 MB by default). The editor shrinks photos to 2400 px first. |
| Reading | Files are served to the admin with a sandboxing CSP, and HTML is served as text, so stored content can never run in the admin's origin. |

Drafts and their photos live in private draft stores. Anything in the
public bucket can be read by URL, so drafts stay out of it until you publish.

## Draft stores

By default the `DRAFTS` R2 bucket is the only draft store. Set
`DRAFT_STORES` in `wrangler.toml` to use several, for example R2 plus a
WebDAV share on a NAS, Nextcloud or ownCloud:

```toml
DRAFT_STORES = """[
  { "id": "drafts", "label": "Drafts",   "type": "r2", "binding": "DRAFTS" },
  { "id": "nas",    "label": "Home NAS", "type": "webdav",
    "baseUrl": "https://dav.example.com/remote.php/dav/files/me",
    "root": "/blog", "folder": "drafts",
    "username": "me", "passwordSecret": "NAS_PASSWORD" }
]"""
```

```sh
npx wrangler secret put NAS_PASSWORD --config admin/wrangler.toml
```

- `id`: lowercase letters, digits and dashes, not `site`.
- `label`: what the admin shows.
- `type`: `r2` (with a `binding`) or `webdav`.
- WebDAV settings: `baseUrl`, `root` and `folder` (files live in
  `<root>/<folder>`), plus `username` and `passwordSecret`, or `tokenSecret`
  for a bearer token.
- Credentials are always Worker secrets, referred to by name, never values
  in the config.

WebDAV stores use storagesdk's WebDAV adapter, which needs the
`nodejs_compat` flag (already set). The server must be reachable from
Cloudflare: for a home NAS, that usually means a public HTTPS address or a
Cloudflare Tunnel. WebDAV has no conditional writes, so for these stores
"changed elsewhere" is checked just before writing. That is safe for one
admin, but not a lock between two simultaneous writers.

A new post asks which draft store to use, and photos you add while
drafting are uploaded to that store. Unpublishing asks which store to keep
the post in. Files the post used stay public, because other posts may use
them too.

## One-time setup

You need the blog already deployed (see `DEPLOY-CLOUDFLARE.md`), a domain on
Cloudflare, and Node.js 20 or newer on a computer for the first deploy.

1. **Create the drafts bucket.** In R2, create a second bucket, for example
   `my-blog-drafts`. Do **not** enable public access on it.
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
   - the two `bucket_name`s;
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
  - Each folder lists sub-folders, posts, and images & files separately.
    Generated pages and site code are folded away and can only be viewed.
  - Upload into `posts/` or a folder under `assets/`.
  - The ⋯ button on a row offers open, copy Markdown, open on the blog,
    rename or move, and delete.
  - A folder appears once something is uploaded into it.
- **New post:** fill in the title (the address is derived from it), date,
  tags, and optionally a search description and social image. Then write.
  - The toolbar inserts Markdown. *Image* uploads photos from the camera
    roll and inserts them as figures.
  - *Preview* shows the post in the blog's theme, with contents box, figures
    and maths.
  - What you type is also kept on the device until it's saved.
- **Save draft** stores the post privately. **Publish** copies the files it
  uses to the public bucket, moves the post there and updates the site. **Update** republishes edits.
  **Unpublish** moves the post back to drafts and removes its page.
  **Delete** removes it.
- **Changed elsewhere:** if a post was saved from another device while you
  were editing, you choose to overwrite it with your version or load theirs.
- **Settings:** edit the `site` section of `index.json` (title, theme,
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
- A move (rename, publish, unpublish) is a copy followed by a delete. If the
  delete fails, the explorer shows both copies, and you can delete the
  leftover.
