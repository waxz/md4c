// File system layer for MD4C in the browser.
//
// The native md2html tool reads a Markdown file and writes an HTML file with
// stdio. A browser has no such file system, and the wasm module itself has no
// I/O at all (see md4c_wasm.c), so this module supplies the missing piece: a
// small file API built on storagesdk (https://github.com/storagesdk/storagesdk).
//
// Any storagesdk adapter works. In the browser the default is the read-only
// ./url-adapter.js, which reads files from a public URL (an R2 bucket, any
// static host). With a writable adapter (fs, R2, S3, ...; e.g. in Node) the
// write methods work too:
//
//   const fs = await Md4cFs.open({ baseUrl: 'https://pub-xxxx.r2.dev/' });
//   const html = await fs.renderFile('posts/hello.md');
//
//   const fs = await Md4cFs.open({ storage: new Storage({ adapter: r2({...}) }) });
//   await fs.writeFile('docs/readme.md', '# Hi');
//   await fs.convertFile('docs/readme.md');           // -> docs/readme.html

import { Storage, StorageError } from '@storagesdk/core';
import { urlAdapter } from './url-adapter.js';
import { Dialect, HtmlFlags, loadMd4c } from './md4c.js';

const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
};

export function contentTypeFor(path) {
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
   * Load md4c.wasm and open a storage-backed file system: `storage` if
   * given, else a read-only one over the public URL `baseUrl`.
   *
   * @param {{ storage?: Storage, baseUrl?: string|URL,
   *           wasmUrl?: URL|string }} [opts]
   */
  static async open(opts = {}) {
    const storage =
      opts.storage ?? new Storage({ adapter: urlAdapter({ baseUrl: opts.baseUrl }) });
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
