// File system layer for MD4C in the browser.
//
// The native md2html tool reads a Markdown file and writes an HTML file with
// stdio. A browser has no such file system, and the wasm module itself has no
// I/O at all (see md4c_wasm.c), so this module supplies the missing piece: a
// small file API built on storagesdk (https://github.com/storagesdk/storagesdk).
//
// Any storagesdk adapter works. By default files live in IndexedDB through
// ./idb-adapter.js, so they survive page reloads; pass your own `Storage` to
// keep them in S3, R2, WebDAV, etc. instead.
//
//   const fs = await Md4cFs.open({ name: 'my-site' });
//   await fs.writeFile('docs/readme.md', '# Hi');
//   await fs.convertFile('docs/readme.md');           // -> docs/readme.html
//   const html = await fs.readFile('docs/readme.html');

import { Storage, StorageError } from '@storagesdk/core';
import { indexedDbAdapter } from './idb-adapter.js';
import { Dialect, HtmlFlags, loadMd4c } from './md4c.js';

const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  );
}

export class Md4cFs {
  /**
   * @param {{ storage: Storage, md4c: { toHtml: Function } }} opts
   */
  constructor({ storage, md4c }) {
    this.storage = storage;
    this.md4c = md4c;
  }

  /**
   * Load md4c.wasm and open (or create) a storage-backed file system.
   *
   * @param {{ name?: string, storage?: Storage, wasmUrl?: URL|string,
   *           indexedDB?: IDBFactory }} [opts]
   */
  static async open(opts = {}) {
    const storage =
      opts.storage ??
      new Storage({
        adapter: indexedDbAdapter({
          name: opts.name ?? 'md4c-fs',
          indexedDB: opts.indexedDB,
        }),
      });
    const md4c = await loadMd4c(opts.wasmUrl);
    return new Md4cFs({ storage, md4c });
  }

  /** Read a file as text (or as bytes with `{ as: 'bytes' }`). */
  async readFile(path, { as = 'text' } = {}) {
    return this.storage.download(path, { as });
  }

  /** Write text or bytes to a file, creating or replacing it. */
  async writeFile(path, data, { contentType, metadata } = {}) {
    return this.storage.upload(path, data, {
      contentType: contentType ?? contentTypeFor(path),
      ...(metadata ? { metadata } : {}),
    });
  }

  async exists(path) {
    try {
      await this.storage.head(path);
      return true;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'NotFound') return false;
      throw err;
    }
  }

  async stat(path) {
    return this.storage.head(path);
  }

  async unlink(path) {
    await this.storage.delete(path);
  }

  async rename(from, to) {
    await this.storage.move(from, to);
  }

  /** List every file under `prefix` (all pages), sorted by path. */
  async readdir(prefix = '') {
    const items = [];
    let cursor;
    do {
      const page = await this.storage.list({
        prefix,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return items;
  }

  /** Render a Markdown string to an HTML fragment. */
  render(markdown, { parserFlags = Dialect.GITHUB, rendererFlags } = {}) {
    return this.md4c.toHtml(markdown, {
      parserFlags,
      rendererFlags: rendererFlags ?? HtmlFlags.SKIP_UTF8_BOM,
    });
  }

  /** Render a Markdown file to an HTML fragment string. */
  async renderFile(path, opts) {
    return this.render(await this.readFile(path, { as: 'bytes' }), opts);
  }

  /**
   * The browser equivalent of `md2html [--full-html] -o OUTPUT INPUT`:
   * read a Markdown file, convert it, and write the HTML next to it (or to
   * `output`). Returns the output path.
   *
   * @param {string} input
   * @param {{ output?: string, fullHtml?: boolean, title?: string,
   *           css?: string, parserFlags?: number, rendererFlags?: number }} [opts]
   */
  async convertFile(input, opts = {}) {
    const output = opts.output ?? input.replace(/\.(md|markdown)$/i, '') + '.html';
    let html = await this.renderFile(input, opts);
    if (opts.fullHtml) {
      const title = escapeHtml(opts.title ?? input);
      const css = opts.css
        ? `<link rel="stylesheet" href="${escapeHtml(opts.css)}">\n`
        : '';
      html =
        '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n' +
        `<title>${title}</title>\n${css}</head>\n<body>\n${html}</body>\n</html>\n`;
    }
    await this.writeFile(output, html);
    return output;
  }
}
