# Deploying the blog on Cloudflare R2

The whole blog is a set of static files in one R2 bucket: the page, its
JavaScript, `md4c.wasm`, and your posts and images. Readers' browsers fetch
them straight from the bucket's public URL and render the Markdown
themselves. No Workers, Pages Functions or other Cloudflare compute is
involved, and R2 doesn't charge for egress, so readers cost you only R2 read
operations. The free tier includes 10 million reads a month.

```
https://blog.example.com/            (R2 bucket behind a custom domain)
├── index.html  app.js  config.js  style.css
├── lib/        md4c.js  md4c.wasm  md4c-fs.js  url-adapter.js  post-format.js
├── vendor/     storagesdk-core/  dompurify/  katex/  source-serif-4/
├── index.json  site settings (title, theme, ...) and the list of posts
├── index.html  home page, pre-rendered     ┐
├── theme.css   accent / background image   │ written by publish.mjs from
├── sitemap.xml  feed.xml  robots.txt       │ the posts in the bucket
└── posts/      hello.md  hello.html  trip.md  trip.html  trip-photo.png ...
```

The bucket's public URL serves GET requests only, so readers can't change
anything. Only you hold the R2 API token that can write.

## 1. Create the bucket and its public URL

1. In the Cloudflare dashboard, create an R2 bucket, for example `my-blog`.
2. Open the bucket's **Settings**:
   - **Custom Domains → Add**: use a domain or subdomain on your Cloudflare
     account, such as `blog.example.com`. Use this URL for the real site.
     The domain must be a zone in the same Cloudflare account; the free plan
     is fine.
   - Or, just to try things out, enable the **Public Development URL**
     (`pub-….r2.dev`). Cloudflare rate-limits `r2.dev`, doesn't cache it at
     the edge, and says it is for development only.
3. Create an **R2 API token** with *Object Read & Write* on this bucket, for
   uploading from your machine. Never put it in the site.

## 2. Upload the site, once

The page's JavaScript modules must be served with a JavaScript content type,
or browsers refuse to run them. The publish script sets every file's type
correctly, so use it for the site files:

```sh
cd wasm
npm install
npm run build

export R2_BUCKET=my-blog R2_ACCOUNT_ID=<account id> \
       R2_ACCESS_KEY_ID=<token key id> R2_SECRET_ACCESS_KEY=<token secret>
node scripts/publish.mjs --to r2 --site      # site + posts in blog/posts/
```

Run this again only when you change the blog's code.

## 3. Write posts by uploading files

A post is a Markdown file at `posts/<slug>.md`. A slug uses lowercase
letters, digits and dashes, and becomes the post's address,
`posts/<slug>.html`. The post starts with a front matter block:

```markdown
---
title: A weekend in Kyoto
date: 2026-10-14
tags: travel, japan
description: Two days of temples, gardens and a very good bookshop.
image: kyoto-temple.jpg
---

Text in **Markdown**.

![The temple](kyoto-temple.jpg)

See also [my first post](hello.md).
```

`title`, `date` (YYYY-MM-DD) and `tags` drive the home page's filters.
`description` (optional) is what search engines show; otherwise the first
paragraph is used. `image` (optional) is the picture shown when the post is
shared on social media. `author` and `updated` are also understood.

Put images and other files anywhere in the bucket. Relative paths in a post
resolve against the post's own location, so `kyoto-temple.jpg` above loads
`posts/kyoto-temple.jpg`. A link to another post's `.md` file opens that
post in the blog.

You can upload with any tool:

- **Dashboard:** the bucket's *Objects* tab, then *Upload*. Put posts in the
  `posts/` folder.
- **Wrangler:**
  ```sh
  npx wrangler r2 object put my-blog/posts/kyoto.md --file kyoto.md --remote \
      --content-type "text/markdown; charset=utf-8" --cache-control "public, no-cache"
  npx wrangler r2 object put my-blog/posts/kyoto-temple.jpg --file kyoto-temple.jpg --remote \
      --content-type image/jpeg
  ```
- **rclone** (or any S3 client) with the endpoint
  `https://<account id>.r2.cloudflarestorage.com`. rclone sets content types
  from file extensions.
- **The publish script**, which uploads a whole folder of posts, skips
  `draft: true` posts, encrypts posts with a `password:` and rebuilds the
  index: `node scripts/publish.mjs --to r2 --posts ~/blog-posts`.

### Password-protected posts

Add `password: <something>` to a post's front matter, and the post is
published encrypted. This happens in the admin editor's 🔒 Password field,
or with the publish script, which encrypts the post before uploading it.

**What is public:**
- The bucket gets only an envelope: the title, date, tags and author in
  the clear, and the rendered article encrypted with AES-256-GCM. The key
  comes from the password through PBKDF2-SHA256 with 600,000 iterations
  and a random salt.
- The post's page shows an unlock form, and the reader's browser decrypts
  the article. The password is asked for on every visit and never stored.
- Pages and posts are served with `Cache-Control: no-cache`, so a new
  password or new text is live as soon as you publish. Readers' browsers
  check for a new version on each visit, which is a cheap 304 when nothing
  changed.
- The home page and the feed list the post as 🔒 Password-protected, with
  no excerpt. The sitemap leaves it out, and the page asks search engines
  not to index it.

**What it does and doesn't protect:**
- **No password hash is stored, on purpose.** A wrong password simply
  fails to decrypt. A public hash would only give guessers a faster
  target.
- **Where the password lives.** The password stays in your private draft
  (or your local file). To change it, edit it and publish again.
- **It is as strong as the password.** Anyone can download the encrypted
  page and try passwords offline, so use a long passphrase rather than a
  short word.
- **Attachments are not encrypted.** Images or files the post links to are
  public if you copy them to the bucket. The admin unticks them by default
  for protected posts.
- **Never upload a protected post's Markdown as is**, for example with
  rclone or the dashboard: it would be public plain text. The build refuses
  to list such a file and warns you, but the file itself is still readable
  until you delete it.

As soon as it is uploaded, a new post can be read at
`https://blog.example.com/index.html#/post/<slug>`, rendered live in the
reader's browser.

## 4. Build the home page and post pages

A public bucket URL can't list its files, and search engines can't see a
post that is only rendered by JavaScript behind a `#` address. After
uploading posts, rebuild the generated files:

```sh
node scripts/publish.mjs --to r2 --no-posts
```

This lists the bucket with your API token, renders every post with md4c.wasm
on your machine, and writes:
- `posts/<slug>.html` for each post;
- the home page and `index.json`;
- `sitemap.xml`, `feed.xml`, `robots.txt` and `theme.css`.

Pages of deleted or re-drafted posts are removed. Old `#/post/<slug>` links
redirect to the post's page.

If you'd rather not run the script, you can maintain `index.json` by hand.
The home page then lists the posts and links them to the live
`#/post/<slug>` view, but they get no page of their own for search engines.
Each entry is either a path, or a path plus the details the filters need:

```json
{
  "site": { "title": "…" },
  "items": [
    "posts/hello.md",
    { "path": "posts/kyoto.md", "title": "A weekend in Kyoto",
      "date": "2026-10-14", "tags": ["travel", "japan"] }
  ]
}
```

A plain path makes the browser read the title, date and tags from the post
itself.

### Filtering by tag and date

The home page groups articles by year, newest first, and offers:
- a search box over titles, abstracts and keywords;
- a year menu;
- a chip for every tag, with its article count.

Clicking a keyword under any article filters by it. The filters live in the
address, so they can be bookmarked and shared: `index.html?tag=japan`,
`index.html?year=2025` or `index.html?tag=parsing&q=unicode`.

## 5. Customise the look

The `site` section of `index.json` sets the blog's appearance. Edit it in
the bucket like any other file; readers see the change on their next visit.
Every field is optional:

```json
{
  "site": {
    "title": "Notes on Computation",
    "slogan": "Essays on parsing, compilers and the web platform",
    "author": "Your Name",
    "description": "Shown to search engines and link previews.",
    "theme": "academic",
    "colorScheme": "auto",
    "accent": "#8b1e2d",
    "font": "serif",
    "backgroundImage": "assets/header.jpg",
    "backgroundMode": "hero",
    "stylesheet": "assets/custom.css",
    "numberedHeadings": true,
    "toc": true,
    "citation": true,
    "math": true,
    "footer": "© 2026 Your Name · Text licensed under CC BY 4.0",
    "links": [ { "label": "About", "href": "#/post/about" } ]
  },
  "items": ["posts/hello.md", "posts/kyoto.md"]
}
```

| Field | Values |
|---|---|
| `theme` | `academic` (default): journal-style serif typography. `modern`: plain sans-serif. |
| `colorScheme` | `auto` (follow the reader's system), `light` or `dark` |
| `accent` | any CSS colour, used for links and highlights |
| `font` | `serif` or `sans`; the default depends on the theme |
| `backgroundImage` | image URL, relative to the bucket. `backgroundMode` is `hero` (a banner behind the title) or `page` (the whole page, with the text on a paper card). |
| `stylesheet` | your own CSS file in the bucket, loaded after the built-in styles |
| `numberedHeadings` | number sections 1, 1.1, … (posts that number their own headings keep their numbers) |
| `toc` | show a "Contents" box on posts with three or more sections |
| `citation` | show a "How to cite" box with a reference and BibTeX |
| `math` | typeset `$…$` and `$$…$$` with KaTeX, loaded only on posts that use them |
| `links` | extra navigation links: `#/post/<slug>` or an http(s) URL |

Values are validated in the browser. Unknown or malformed values fall back
to the defaults, and text is never treated as HTML. Only http(s) URLs are
used. Nothing is applied as inline style markup, so the strict
Content-Security-Policy stays in force.

The `academic` theme is laid out like a journal:
- small-caps masthead;
- article list with dates, abstracts and keywords;
- centred titles with author, date and reading time;
- numbered sections and a contents box;
- an image on its own line becomes a numbered figure, with its alt text as
  the caption;
- tables with rules above, below and under the header only (booktabs
  style);
- footnotes collected as notes;
- a citation box;
- clean print styles.

In both themes, fenced code blocks get a **Copy** button. If the block
names its language (` ```cpp `, ` ```python `, ` ```bash `…), it shows the
language and colours the code in light and dark. highlight.js, with its
common languages, is loaded only on pages that need it. Blocks with no
language, or a language it doesn't know, stay plain.

It uses Source Serif 4. The font, KaTeX and highlight.js are served from the
same bucket, so readers never contact a third-party CDN.

`publish.mjs` keeps the `site` section when it rebuilds `index.json`. Use
`--config site.json` to replace it from a local file. On the first publish
it starts from `blog/site.json`.

## 6. Make `/` open the blog (optional)

R2 doesn't serve `index.html` for `/`, so the blog lives at
`https://blog.example.com/index.html`. To make the bare domain work, add a
URL rewrite rule. Rewrite rules are included in the free plan and run in
Cloudflare's configuration, not as code you deploy.

- In the dashboard, go to **Rules**, create a **URL Rewrite Rule**, and
  match requests where *URI Path* equals `/`.
- Set the path to rewrite statically to `/index.html`.

## 7. Cache at the edge (optional)

Cloudflare caches `.js`, `.css` and images from your custom domain
automatically. It doesn't cache `.html`, `.json`, `.md` or `.wasm` by
default, so every read of those goes to R2 and counts as an R2 operation.
To cache them too, add a **Cache Rule** (free plan) for your blog's
hostname:

- Make it *eligible for cache*.
- Let the edge TTL follow the `Cache-Control` header if present.

The publish script and the admin upload pages, posts (`posts/*.md`,
`posts/*.html`), `index.json`, `index.html`, the sitemap and the feed with
`Cache-Control: public, no-cache`. The edge and browsers may keep them, but
must check for a new version before using them, so edits and new passwords
are live at once. Attachments and the site's code get `public,
max-age=300`. Set the same headers with `--cache-control` when uploading
with wrangler.

## 8. Get found by search engines

The publish script pre-renders everything a crawler needs. Each post page
contains the article's full text in plain HTML, so no JavaScript is
required. It also carries:
- a title, a meta description and a canonical URL;
- Open Graph and Twitter card tags, for link previews;
- `ScholarlyArticle` structured data (`BlogPosting` with the `modern`
  theme);
- Google Scholar `citation_*` tags.

The home page lists every article as a plain link. `sitemap.xml`,
`robots.txt` and an Atom feed (`feed.xml`) are generated too.

1. **Set your public address.** Canonical links, social previews, the
   sitemap and the feed all need absolute URLs. Add this to the `site`
   section of `index.json`:
   ```json
   "url": "https://blog.example.com/",
   "language": "en"
   ```
   Then rerun `node scripts/publish.mjs --to r2 --no-posts`.
2. **Google:** a new site isn't searchable until Google has found it, and
   Google rarely finds a new domain by itself. Tell it once:
   - **Add the site.** Open [Search Console](https://search.google.com/search-console)
     and add the site. If the domain is on Cloudflare, the easiest way is a
     *Domain* property (`blog.example.com`) verified with the DNS TXT record
     Search Console shows; it can add the record to Cloudflare for you.
     Alternatively, use a *URL-prefix* property with the *HTML tag*
     method: put the `content` value in `index.json` as
     `"verification": { "google": "…" }`, republish, then click *Verify*.
   - **Submit the sitemap.** Under *Sitemaps*, submit
     `https://blog.example.com/sitemap.xml`.
   - **Optionally, ask for a quick crawl.** Paste a post's address into
     *URL inspection* and click *Request indexing*.

   Pages usually appear within a few days, sometimes up to a few weeks.
   Check with `site:blog.example.com` (the host name only, without
   `https://`), or `cpp site:blog.example.com` for posts mentioning cpp.
3. **Bing (which also feeds DuckDuckGo and others):** in
   [Bing Webmaster Tools](https://www.bing.com/webmasters), either import
   the site from Search Console, or verify with the meta tag
   (`"verification": { "bing": "…" }`). Then submit `sitemap.xml`.
4. **IndexNow (optional):** this tells Bing, Yandex and other participating
   engines about new pages within minutes, instead of waiting for a crawl.
   - Add a key of 32 hex characters to `site`, for example the output of
     `openssl rand -hex 16`: `"indexNowKey": "…"`.
   - Publish with `--indexnow`. The script uploads the key file the protocol
     requires and submits your page URLs to `api.indexnow.org`.
   - Google doesn't use IndexNow; it reads your sitemap.

**Full-text search on the blog.** The home page's search box filters
titles, abstracts and keywords as you type. For the posts' full text it
uses a web search engine with a `site:` query:
- pressing Enter in the box, or the *Full text on Google* link under it,
  opens Google with `… site:blog.example.com`;
- choose the engine with `"search"` in `site`: `google` (the default),
  `bing`, `duckduckgo`, or `none` to turn it off;
- results come from the engine's index, so they appear only once your
  pages are indexed (see above), and password-protected posts never show
  up.

Tips:
- Give every post a `description` of one or two sentences and a meaningful
  `title`. Use `image` for posts you expect to be shared.
- Keep slugs stable. A post's address is its file name, so renaming the file
  breaks existing links and resets its search ranking.
- The canonical home page is `index.html`, which works even without the
  rewrite rule from step 6.
- Pages, posts, the sitemap and the feed are served with `no-cache`, and
  crawlers revalidate them on each visit, so they see updates at once.

## 9. Edit from your phone (optional)

`admin/` holds a small admin app for writing, editing and publishing from any
device, with a posts list, folder explorer, editor, live preview and photo
upload. It runs as a Cloudflare Worker on `admin.blog.example.com`,
protected by Cloudflare Access. Drafts and their photos stay in private
draft stores (the drafts R2 bucket, plus any WebDAV share, S3-compatible
bucket or GitHub repository you add on the admin's Storage page, with its
settings kept in Cloudflare KV or in your browser), and are copied to the
public bucket on publish. Readers keep
reading the public bucket directly. Setup takes about ten minutes; see
[admin/README.md](admin/README.md).

## Reading posts from a bucket on another domain

The setup above serves the site and the posts from the same bucket and
domain, so no CORS setup is needed. If the site is hosted elsewhere, you
need three changes:

- Set `STORAGE_URL` in `blog/config.js` to the bucket's URL.
- Add that URL to `connect-src` in the Content-Security-Policy in
  `blog/index.html`.
- Add a CORS rule to the bucket allowing `GET` from the site's origin.
