# MD4C for the browser (WebAssembly)

This directory compiles MD4C to WebAssembly, adds a browser file system built
on [storagesdk](https://github.com/storagesdk/storagesdk), and ships a small
blog that renders Markdown entirely client side.

```
wasm/
├── build.sh            compile src/*.c + wrapper to dist/md4c.wasm
├── md4c_wasm.c         wasm entry points (buffer in, HTML out)
├── libc/               tiny freestanding libc (malloc, string, printf...)
├── js/
│   ├── md4c.js         loads md4c.wasm, exposes toHtml() and the flag constants
│   ├── idb-adapter.js  storagesdk adapter that stores files in IndexedDB
│   └── md4c-fs.js      file API on storagesdk: readFile, writeFile, convertFile...
├── blog/               the demo blog (static HTML/CSS/JS + sample posts)
├── scripts/            assemble-blog.mjs (build the site), serve.mjs (dev server)
└── test/               Node tests + an md2html-compatible CLI for the test suites
```

## Quick start

Requirements: `clang` with the WebAssembly backend, `wasm-ld` (from `lld`),
and Node.js 20 or newer. You don't need Emscripten or a WASI SDK.

```sh
cd wasm
npm install          # @storagesdk/core (+ fake-indexeddb for tests)
npm run build        # dist/md4c.wasm and the site in dist/blog/
npm run serve        # http://localhost:8080/
```

`dist/blog/` holds only static files. You can deploy it to any static host,
such as GitHub Pages, Netlify or S3.

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

`@storagesdk/core` is plain ESM with no Node dependencies. The blog loads it
with an import map, so you don't need a bundler.

## The blog

- Posts are stored as `posts/<slug>.md` with a front matter block (`title`,
  `date`, `tags`). The rendered HTML goes to `html/<slug>.html`, and the title,
  date, tags and excerpt are kept as storagesdk object metadata, so the post
  list needs no Markdown parsing.
- On first visit the blog imports the sample posts in `blog/posts/`, which
  are listed in `blog/posts/index.json`.
- You can browse posts, filter them by tag, and create, edit or delete them.
  The editor has a live preview. Wiki links such as `[[Other post]]` link to
  other posts.
- Posts are rendered with raw HTML enabled, as on most blogs. Only the
  author's own content, which lives in their browser, is rendered.

## Tests

```sh
cd wasm && npm test                  # renderer, IndexedDB adapter, Md4cFs

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
