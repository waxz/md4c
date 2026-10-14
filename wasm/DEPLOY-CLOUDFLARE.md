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
└── posts/      hello.md  trip.md  trip-photo.png ...
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
`#/post/<slug>`. The post starts with a front matter block:

```markdown
---
title: A weekend in Kyoto
date: 2026-10-14
tags: travel, japan
---

Text in **Markdown**.

![The temple](kyoto-temple.jpg)

See also [my first post](hello.md).
```

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
      --content-type "text/markdown; charset=utf-8" --cache-control "public, max-age=300"
  npx wrangler r2 object put my-blog/posts/kyoto-temple.jpg --file kyoto-temple.jpg --remote \
      --content-type image/jpeg
  ```
- **rclone** (or any S3 client) with the endpoint
  `https://<account id>.r2.cloudflarestorage.com`. rclone sets content types
  from file extensions.
- **The publish script**, which uploads a whole folder of posts, skips
  `draft: true` posts and rebuilds the index:
  `node scripts/publish.mjs --to r2 --posts ~/blog-posts`.

A new post works at `https://blog.example.com/index.html#/post/<slug>` as
soon as it is uploaded.

## 4. Add the post to the home page list

A public bucket URL can't list its files, so the home page reads the list
of posts from `index.json`. Update it after uploading a post, in either of
two ways:

- **By hand:** edit `index.json` and add the post's path. The simplest valid
  file is a plain list:
  ```json
  ["posts/hello.md", "posts/kyoto.md"]
  ```
  The browser reads each post's title, date, tags and first paragraph from
  the file itself.
- **Automatically:** `node scripts/publish.mjs --to r2 --no-posts` lists the
  bucket with your API token and writes a full `index.json`, including
  titles and excerpts, so the home page loads faster.

To remove a post, delete its file and its line in `index.json`, or delete
the file and rerun `--no-posts`.

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

It uses Source Serif 4. The font and KaTeX are served from the same bucket,
so readers never contact a third-party CDN.

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

The publish script uploads with `Cache-Control: public, max-age=300` for
files and `max-age=60` for `index.json`. New posts therefore appear within a
few minutes. Set the same headers with `--cache-control` when uploading
with wrangler.

## Reading posts from a bucket on another domain

The setup above serves the site and the posts from the same bucket and
domain, so no CORS setup is needed. If the site is hosted elsewhere, you
need three changes:

- Set `STORAGE_URL` in `blog/config.js` to the bucket's URL.
- Add that URL to `connect-src` in the Content-Security-Policy in
  `blog/index.html`.
- Add a CORS rule to the bucket allowing `GET` from the site's origin.
