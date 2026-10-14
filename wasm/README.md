# MD4C for the browser (WebAssembly)

This directory compiles MD4C to WebAssembly, adds a browser file system built
on [storagesdk](https://github.com/storagesdk/storagesdk), and ships a small
blog that renders Markdown in the browser. Anyone can read the blog; only
its owner, logged in as admin, can write, publish and delete posts.

```
wasm/
├── build.sh            compile src/*.c + wrapper to dist/md4c.wasm
├── md4c_wasm.c         wasm entry points (buffer in, HTML out)
├── libc/               tiny freestanding libc (malloc, string, printf...)
├── js/
│   ├── md4c.js         loads md4c.wasm, exposes toHtml() and the flag constants
│   ├── md4c-fs.js      file API on storagesdk: readFile, writeFile, convertFile...
│   ├── http-adapter.js storagesdk adapter for the blog server's API
│   ├── idb-adapter.js  storagesdk adapter that stores files in IndexedDB
│   └── post-format.js  front matter parsing shared by blog and server
├── blog/               the blog front end (HTML/CSS/JS + sample posts)
├── server/             blog server: access control, auth, security headers
├── scripts/            assemble-blog.mjs, set-admin-password.mjs
└── test/               Node tests + an md2html-compatible CLI for the test suites
```

## Quick start

Requirements: `clang` with the WebAssembly backend, `wasm-ld` (from `lld`),
and Node.js 20 or newer. You don't need Emscripten or a WASI SDK.

```sh
cd wasm
npm install             # storagesdk, DOMPurify (+ fake-indexeddb for tests)
npm run build           # dist/md4c.wasm and the site in dist/blog/
npm run set-password    # choose the admin password (12+ characters)
npm start               # http://127.0.0.1:8080/
```

On first start the server imports the sample posts from `blog/posts/`.
Posts and the admin password hash live in `wasm/data/` (`BLOG_DATA_DIR`).

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

const fs = await Md4cFs.open({ name: 'my-site' });   // IndexedDB database
await fs.writeFile('docs/intro.md', '# Intro');
await fs.convertFile('docs/intro.md', { fullHtml: true });  // -> docs/intro.html
const html = await fs.readFile('docs/intro.html');
const files = await fs.readdir('docs/');
```

Files go to IndexedDB through `idb-adapter.js`. That adapter implements the
full storagesdk `Adapter` contract, including snapshots, forks,
merge/rebase/diff. Any other storagesdk adapter works too, because
`Md4cFs.open({ storage })` accepts any `Storage`:

```js
import { Storage } from '@storagesdk/core';
import { s3 } from '@storagesdk/adapters/s3';
const fs = await Md4cFs.open({ storage: new Storage({ adapter: s3({...}) }) });
```

`@storagesdk/core` is plain ESM with no Node dependencies. The site build
copies it into `vendor/` and rewrites the imports to relative paths, so you
don't need a bundler or an inline import map, which the CSP would block.

## The blog

- The server stores posts through storagesdk's filesystem adapter:
  published posts as `posts/<slug>.md`, drafts as `drafts/<slug>.md`. Each
  post has a front matter block (`title`, `date`, `tags`). The title, date,
  tags and excerpt are also kept as storagesdk object metadata, so the post
  list needs no Markdown parsing.
- The browser reads and writes posts through `Md4cFs` with the HTTP adapter
  and renders them with md4c.wasm.
- Guests can browse published posts and filter them by tag. The admin can
  also write drafts in an editor with live preview, and publish, unpublish,
  edit and delete posts. Wiki links such as `[[Other post]]` link to other
  posts.

### Who can do what

| Action                                   | Guest | Admin |
|------------------------------------------|:-----:|:-----:|
| Read and list published posts (`posts/`) |  yes  |  yes  |
| Read and list drafts (`drafts/`)         |  no   |  yes  |
| Create, edit, publish, unpublish, delete |  no   |  yes  |

The server enforces these rules on every request (`server/app.mjs`). The UI
only hides controls a visitor can't use. Hiding a button doesn't secure
anything, so the tests in `test/server.test.mjs` call the API directly as a
guest.

### Security measures

- **One admin account.** Its password is stored as a salted scrypt hash in
  `data/admin.json` (mode 600) and checked in constant time. Five failed
  logins lock the client out for 15 minutes.
- **Sessions.** A random 256-bit token is set as an `HttpOnly`,
  `SameSite=Strict` cookie, valid for 12 hours. Set `COOKIE_SECURE=1` behind
  HTTPS so the cookie also carries `Secure`. Sessions live in memory, so
  restarting the server logs the admin out.
- **CSRF.** Every write needs the session's CSRF token in an `x-csrf-token`
  header, and cross-origin `Origin` headers are refused.
- **Input limits.** Only `posts/<slug>.md` and `drafts/<slug>.md` can be
  written, which rules out path traversal and arbitrary files. Bodies must be
  UTF-8 text of at most 512 KB. Metadata keys are whitelisted. A slug can't
  exist as a draft and a post at once. Guests get 404 for drafts, so they
  can't tell which drafts exist.
- **XSS.** Markdown may contain raw HTML, so every rendered post and preview
  goes through DOMPurify. It removes scripts, event handlers, `javascript:`
  URLs, iframes and forms, and adds `rel="noopener noreferrer nofollow"` to
  external links.
- **Headers.** Pages are served with a strict Content-Security-Policy
  (`script-src 'self' 'wasm-unsafe-eval'`, no inline script or style,
  `frame-ancestors 'none'`). API responses are sandboxed `text/plain`
  with `nosniff`, so a stored file can never render as a page. Pages also get
  `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

### Deploying

Run the server behind an HTTPS reverse proxy with `COOKIE_SECURE=1`. Set
`TRUST_PROXY=1` so the login rate limit sees real client addresses through
`X-Forwarded-For`; enable it only when a proxy sets that header. The server
listens on `127.0.0.1` by default; set `HOST` to change that.

## Tests

```sh
cd wasm && npm test    # renderer, adapters, Md4cFs, server access control

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
