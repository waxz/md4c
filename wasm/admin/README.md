# Blog admin: edit and publish from any device

A small admin app for the blog, usable from a phone. You can browse the
bucket's folders, write and edit posts with a live preview in the blog's own
theme, upload photos, and save drafts, publish, update or unpublish posts.
It runs as a Cloudflare Worker on its own hostname (for example
`admin.blog.example.com`), behind Cloudflare Access.

Readers are unaffected: they still read the public R2 bucket directly and
never touch the Worker.

```
phone/laptop browser ──(Cloudflare Access login)──▶ admin Worker ──R2 binding──▶ my-blog         (public)
  admin app + md4c.wasm: renders pages locally        checks every write          my-blog-drafts  (private)
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
| Slug conflicts | A slug is either a draft or a published post, never both. `409 published-exists` and `409 draft-exists` are returned on create, rename, publish and unpublish. |
| Size | Uploads are limited to `MAX_UPLOAD_MB` (25 MB by default). The editor shrinks photos to 2400 px first. |
| Reading | Files are served to the admin with a sandboxing CSP, and HTML is served as text, so stored content can never run in the admin's origin. |

Drafts live in a separate, private bucket. Anything in the public bucket
can be read by URL, so drafts stay out of it until you publish.

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

- **Files:** the explorer covers both buckets. Tabs switch between *Site* and
  *Drafts*, with breadcrumbs for folders.
  - Upload into `posts/` or a folder under `assets/`, and rename, move or
    delete files there.
  - Badges mark files that are generated by the build or part of the site's
    code. You can view those but not change them.
  - A folder appears once something is uploaded into it.
- **New post:** fill in the title (the address is derived from it), date,
  tags, and optionally a search description and social image. Then write.
  - The toolbar inserts Markdown. *Image* uploads photos from the camera
    roll and inserts them as figures.
  - *Preview* shows the post in the blog's theme, with contents box, figures
    and maths.
  - What you type is also kept on the device until it's saved.
- **Save draft** stores the post privately. **Publish** moves it to the
  public bucket and updates the site. **Update** republishes edits.
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
  which stands in for the public bucket. Drafts go to `dist/drafts/`.

`npm test` covers the Worker's authentication, path and conflict rules
(`test/admin-worker.test.mjs`). `npx wrangler dev --config admin/wrangler.toml`
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
