---
title: How it works
date: 2026-10-13
tags: meta, wasm, storage
---

This blog has four layers.

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
Here it talks to the blog server through an HTTP adapter; the server keeps
the files on disk with storagesdk's filesystem adapter.

| Path               | Who can read it       |
|--------------------|-----------------------|
| `posts/<slug>.md`  | everyone              |
| `drafts/<slug>.md` | the admin only        |

## 3. Access control

The server checks every request: guests can read published posts and
nothing else, while writes need the admin's session cookie and a CSRF
token. Rendered HTML is cleaned by DOMPurify and the page runs under a
strict Content-Security-Policy, so a post cannot run script.

## 4. The blog itself

A few hundred lines of plain JavaScript: a hash router, a post list,
a post view and an editor with live preview.[^speed]

[^speed]: The preview re-renders the whole post on every keystroke. MD4C is
    fast enough that this usually takes well under a millisecond.
