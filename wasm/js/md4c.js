// MD4C compiled to WebAssembly: a tiny ES module wrapper.
//
//   import { loadMd4c, Flags, Dialect } from './md4c.js';
//   const md4c = await loadMd4c();
//   const html = md4c.toHtml('# Hello *world*', { parserFlags: Dialect.GITHUB });
//
// Works in browsers and in Node.js (>= 18).

export const Flags = Object.freeze({
  COLLAPSEWHITESPACE: 0x1,
  PERMISSIVEATXHEADERS: 0x2,
  PERMISSIVEURLAUTOLINKS: 0x4,
  PERMISSIVEEMAILAUTOLINKS: 0x8,
  NOINDENTEDCODEBLOCKS: 0x10,
  NOHTMLBLOCKS: 0x20,
  NOHTMLSPANS: 0x40,
  TABLES: 0x100,
  STRIKETHROUGH: 0x200,
  PERMISSIVEWWWAUTOLINKS: 0x400,
  TASKLISTS: 0x800,
  LATEXMATHSPANS: 0x1000,
  WIKILINKS: 0x2000,
  UNDERLINE: 0x4000,
  HARD_SOFT_BREAKS: 0x8000,
  SPOILERS: 0x10000,
  SUPERSCRIPTS: 0x20000,
  SUBSCRIPTS: 0x40000,
  ADMONITIONS: 0x80000,
  FOOTNOTES: 0x100000,
  HIGHLIGHT: 0x200000,
  PRESERVEBLANKLINES: 0x400000,
  INSERT: 0x800000,
  PERMISSIVEAUTOLINKS: 0x4 | 0x8 | 0x400,
  NOHTML: 0x20 | 0x40,
});

export const Dialect = Object.freeze({
  COMMONMARK: 0,
  GITHUB:
    Flags.PERMISSIVEAUTOLINKS |
    Flags.TABLES |
    Flags.STRIKETHROUGH |
    Flags.TASKLISTS |
    Flags.ADMONITIONS |
    Flags.FOOTNOTES,
});

export const HtmlFlags = Object.freeze({
  DEBUG: 0x1,
  VERBATIM_ENTITIES: 0x2,
  SKIP_UTF8_BOM: 0x4,
  XHTML: 0x8,
  // md4c.wasm only: each block's opening tag gets data-src="<byte offset
  // of its text in the input>" (the admin's preview, to follow the source).
  SOURCE_POS: 0x10000,
});

// By default md4c.wasm is expected next to this file.
const DEFAULT_WASM_URL = new URL('./md4c.wasm', import.meta.url);

async function instantiate(source, imports) {
  if (source instanceof WebAssembly.Module)
    return WebAssembly.instantiate(source, imports);
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
    return (await WebAssembly.instantiate(source, imports)).instance;

  if (source instanceof URL && source.protocol === 'file:') {
    // Node.js: fetch() cannot read file: URLs.
    const { readFile } = await import('node:fs/promises');
    return (await WebAssembly.instantiate(await readFile(source), imports))
      .instance;
  }

  const response = source instanceof Response ? source : await fetch(source);
  if (!response.ok)
    throw new Error(`md4c: failed to fetch wasm (${response.status})`);
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      return (await WebAssembly.instantiateStreaming(response.clone(), imports))
        .instance;
    } catch {
      // Wrong MIME type (e.g. a naive static server): fall through.
    }
  }
  return (
    await WebAssembly.instantiate(await response.arrayBuffer(), imports)
  ).instance;
}

/**
 * Load the MD4C wasm module.
 *
 * @param {URL|string|Response|ArrayBuffer|Uint8Array|WebAssembly.Module} [source]
 *        Where to get md4c.wasm from. Defaults to ./md4c.wasm next to this module.
 * @param {{ onLog?: (fd: number, message: string) => void }} [options]
 */
export async function loadMd4c(source = DEFAULT_WASM_URL, options = {}) {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let memory;

  const onLog =
    options.onLog ??
    ((fd, msg) => (fd === 1 ? console.log(msg) : console.warn(msg)));

  const instance = await instantiate(source, {
    env: {
      md4c_wasm_log(fd, ptr, len) {
        onLog(fd, decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  const ex = instance.exports;
  memory = ex.memory;

  /**
   * Convert Markdown to HTML.
   *
   * @param {string|Uint8Array} markdown  Markdown text (or UTF-8 bytes).
   * @param {{ parserFlags?: number, rendererFlags?: number }} [opts]
   * @returns {string}
   */
  function toHtml(markdown, opts = {}) {
    const parserFlags = opts.parserFlags ?? Dialect.GITHUB;
    const rendererFlags = opts.rendererFlags ?? HtmlFlags.SKIP_UTF8_BOM;
    const bytes =
      typeof markdown === 'string' ? encoder.encode(markdown) : markdown;

    ex.md4c_wasm_reset();
    const ptr = ex.md4c_wasm_alloc(bytes.length);
    if (ptr === 0 && bytes.length > 0) throw new Error('md4c: out of memory');
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);

    const ret = ex.md4c_wasm_to_html(
      ptr,
      bytes.length,
      parserFlags >>> 0,
      rendererFlags >>> 0
    );
    if (ret !== 0) throw new Error('md4c: conversion failed');

    // Read memory.buffer only now: it is replaced whenever memory grows.
    const out = new Uint8Array(
      memory.buffer,
      ex.md4c_wasm_output_ptr(),
      ex.md4c_wasm_output_len()
    );
    return decoder.decode(out);
  }

  return { toHtml, exports: ex };
}
