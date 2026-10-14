# MD4C for the browser (WebAssembly)

This directory compiles MD4C to WebAssembly, adds a browser file system built
on [storagesdk](https://github.com/storagesdk/storagesdk), and ships a small
blog that renders Markdown in the browser. The blog is fully static: posts
are files in read-only public storage (for example a Cloudflare R2 bucket),
and only the owner, who holds the storage credentials, can publish.

```
wasm/
├── build.sh            compile src/*.c + wrapper to dist/md4c.wasm
├── md4c_wasm.c         wasm entry points (buffer in, HTML out)
├── libc/               tiny freestanding libc (malloc, string, printf...)
├── js/
│   ├── md4c.js         loads md4c.wasm, exposes toHtml() and the flag constants
│   ├── md4c-fs.js      file API on storagesdk: readFile, writeFile, convertFile...
│   ├── url-adapter.js  read-only storagesdk adapter for a public URL (R2, ...)
│   └── post-format.js  front matter parsing shared by blog and publish script
├── blog/               the blog front end (HTML/CSS/JS) and sample posts
├── scripts/            assemble-blog.mjs (build the site), publish.mjs (owner's tool)
└── test/               Node tests + an md2html-compatible CLI for the test suites
```

## Quick start

Requirements: `clang` with the WebAssembly backend, `wasm-ld` (from `lld`),
and Node.js 20 or newer. You don't need Emscripten or a WASI SDK.

```sh
cd wasm
npm install
npm run build           # dist/md4c.wasm and the site in dist/blog/
npm run deploy          # publish site + posts to dist/public/ (fs adapter)
python3 -m http.server -d dist/public 8080   # any static server works
# open http://localhost:8080/index.html
```

To build just the wasm module, run `sh wasm/build.sh [out.wasm]`. You can
override the compiler and optimisation flags with `CC` and `OPTFLAGS`.

## Using the renderer

```js
import { loadMd4c, Dialect, Flags } from './md4c.js';

const md4c = await loadMd4c();                 // fetches ./md4c.wasm
md4c.toHtml('# Hello *world*');                // GitHub dialect by default
md4c.toHtml(src, { parserFlags: Dialect.COMMONMARK | Flags.TABLES });
```

`toHtml` accepts a string or UTF-8 bytes and returns a string. Every
`MD_FLAG_*` and `MD_HTML_FLAG_*` constant is available as `Flags.*` and
`HtmlFlags.*`.

## The file system wrapper

The wasm module does no I/O. Where native `md2html` reads and writes files
through stdio, the browser build relies on `md4c-fs.js`, which gives you a
small file API backed by a storagesdk `Storage`:

```js
import { Md4cFs } from './md4c-fs.js';

// In the browser: read-only, over a public URL.
const fs = await Md4cFs.open({ baseUrl: 'https://pub-xxxx.r2.dev/' });
const html = await fs.renderFile('posts/hello.md');
const files = await fs.readdir('posts/');

// Anywhere with a writable storagesdk adapter (fs, R2, S3, ...):
const rw = await Md4cFs.open({ storage: new Storage({ adapter: r2({...}) }) });
await rw.writeFile('docs/intro.md', '# Intro');
await rw.convertFile('docs/intro.md', { fullHtml: true });  // -> docs/intro.html
```

`url-adapter.js` implements the storagesdk adapter interface over plain
HTTP GETs. Every write method throws `NotSupported`. A public bucket URL
can't list its contents, so `list()` and `head()` read an `index.json` that
the publish script maintains.

`@storagesdk/core` is plain ESM with no Node dependencies. The site build
copies it into `vendor/` and rewrites the imports to relative paths, so you
don't need a bundler or an inline import map, which the CSP would block.

## The blog

Guests can only read. Nothing on the page can change the storage: there's
no login, no editor and no server code. The owner publishes from their own
machine.

| Who            | How they reach the storage                  | Can do      |
|----------------|---------------------------------------------|-------------|
| Guest          | the bucket's public URL (plain HTTP GET)    | read        |
| Owner (admin)  | storagesdk adapter with write credentials   | read, write |

Storage layout:

| Path              | Contents                                               |
|-------------------|--------------------------------------------------------|
| `index.html`, ... | the site itself (`publish.mjs --site`)                 |
| `index.json`      | published posts with title, date, tags, excerpt        |
| `posts/<slug>.md` | Markdown with front matter (`title`, `date`, `tags`)   |

### Publishing

Posts are Markdown files in a local folder (default `blog/posts/`).
`scripts/publish.mjs` uploads them through any storagesdk adapter and then
rebuilds `index.json`:

```sh
node scripts/publish.mjs --to fs                 # local folder dist/public/
node scripts/publish.mjs --to r2 --site          # R2: site + posts
node scripts/publish.mjs --to r2 --posts ~/blog  # only posts, from ~/blog
node scripts/publish.mjs --to r2 --prune         # also delete removed posts
node scripts/publish.mjs --to r2 --no-posts      # only rebuild index.json
node scripts/publish.mjs --help
```

- Posts with `draft: true` in the front matter are never uploaded. If one
  was published before, it is deleted from storage.
- You can also write files into the bucket directly, with the Cloudflare
  dashboard, `rclone`, the storagesdk CLI or anything else. Run
  `--no-posts` afterwards so `index.json` lists them.
- Adapters are chosen with `--to` or `STORAGE_ADAPTER` and configured with
  storagesdk's env vars. For the `fs` adapter, `FS_ROOT`/`FS_FOLDER` default
  to `dist/` and `public`.

### Hosting on Cloudflare R2

1. Create a bucket and an R2 API token with **Object Read & Write** on it.
   Keep the token on your machine only.
2. Turn on public access for the bucket (an `r2.dev` URL or a custom
   domain). Public access is read-only: it serves GET requests and nothing
   else.
3. Publish:
   ```sh
   export R2_BUCKET=my-blog R2_ACCOUNT_ID=... \
          R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
   npm run build && node scripts/publish.mjs --to r2 --site
   ```
4. Open `https://<public-url>/index.html`. R2 doesn't map `/` to
   `index.html`, so link to `index.html` or add a redirect rule on a custom
   domain.

If you host the site somewhere else and read posts from the bucket, set
`STORAGE_URL` in `blog/config.js` to the bucket URL. You also need to add
that URL to `connect-src` in the CSP in `blog/index.html` and allow GET from
the site's origin in the bucket's CORS policy.

The R2 adapter needs the AWS S3 SDK packages, which are installed as
optional dependencies. Other storagesdk backends, such as S3, GCS or Azure,
need their own SDKs.

### Security

- **Writes:** guests have no write path at all. The public URL is read-only,
  the page contains no credentials, and `url-adapter.js` refuses writes.
  The only write credentials are the owner's API token.
- **Drafts:** drafts stay on the owner's machine. Anything uploaded to the
  bucket is readable by URL, so the publish script warns if a draft turns up
  there.
- **XSS:** posts may contain raw HTML, so all rendered HTML goes through
  DOMPurify. It removes scripts, event handlers, `javascript:` URLs, iframes
  and forms, and adds `rel="noopener noreferrer nofollow"` to external
  links. This guards against a bad or compromised post.
- **CSP:** a static bucket can't add response headers, so `index.html`
  sets a Content-Security-Policy through a `<meta>` tag (`script-src 'self'
  'wasm-unsafe-eval'`, no inline script or style, `form-action 'none'`).
  It also sets `referrer` to `no-referrer`.
- **Paths:** slugs are limited to lowercase letters, digits and dashes, and
  `..` paths are rejected.

## Tests

```sh
cd wasm && npm test    # renderer, Md4cFs, URL adapter, publish script

# The upstream spec suites, run against md4c.wasm instead of md2html:
python3 test/run-testsuite.py -s test/spec.txt -p "$PWD/wasm/test/md2html-wasm.mjs"
```

## How the C build works

`build.sh` compiles `src/md4c.c`, `src/md4c-html.c`, `src/entity.c`,
`md4c_wasm.c` and `libc/libc.c` with `--target=wasm32 -nostdlib`. The libc
allocator is a bump arena that `md4c_wasm_reset()` clears before each
conversion. This keeps the allocator tiny and leaves memory use proportional
to the largest document converted. The module imports only one function,
`env.md4c_wasm_log`, which forwards anything MD4C writes to `stderr`.
