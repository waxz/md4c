---
title: How it works
date: 2026-10-13
tags: meta, wasm, storage
---

This blog has three layers.

## 1. MD4C as WebAssembly

The C parser and HTML renderer from `src/` are compiled with plain
`clang --target=wasm32`. A tiny freestanding libc (`wasm/libc/`) supplies
`malloc`, `memcpy`, `snprintf` and friends, so neither Emscripten nor a WASI
SDK is needed. The module is about 130 KB and exports one real function:

```c
int md4c_wasm_to_html(const char* input, unsigned input_size,
                      unsigned parser_flags, unsigned renderer_flags);
```

## 2. A file system made of storagesdk

The native `md2html` reads and writes files with stdio. A browser has no
files, so `wasm/js/md4c-fs.js` provides `readFile`, `writeFile`, `readdir`
and `convertFile` on top of [storagesdk](https://github.com/storagesdk/storagesdk).
The bundled IndexedDB adapter keeps everything local, but any storagesdk
adapter (S3, R2, WebDAV, …) can be swapped in.

| Path               | Contents                         |
|--------------------|----------------------------------|
| `posts/<slug>.md`  | Markdown source with front matter |
| `html/<slug>.html` | Rendered HTML, refreshed on save  |

## 3. The blog itself

A few hundred lines of plain JavaScript: a hash router, a post list,
a post view and an editor with live preview.[^speed]

[^speed]: The preview re-renders the whole post on every keystroke. MD4C is
    fast enough that this usually takes well under a millisecond.
