// Tests for the wasm renderer, Md4cFs, the read-only URL adapter, and the
// publish script. Publishing goes to a temp folder with storagesdk's fs
// adapter, which is then served as a plain static site, the way a public
// R2 bucket serves it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Storage } from '@storagesdk/core';
import { fs as fsAdapter } from '@storagesdk/adapters/fs';
import { Md4cFs } from '../js/md4c-fs.js';
import { Dialect, Flags, loadMd4c } from '../js/md4c.js';
import { urlAdapter } from '../js/url-adapter.js';

const WASM_URL = new URL('../dist/md4c.wasm', import.meta.url);
const PUBLISH = fileURLToPath(new URL('../scripts/publish.mjs', import.meta.url));
const run = promisify(execFile);

test('toHtml renders CommonMark and extensions', async () => {
  const md4c = await loadMd4c(WASM_URL);
  assert.equal(md4c.toHtml('# Hi *there*'), '<h1>Hi <em>there</em></h1>\n');
  assert.equal(md4c.toHtml('~~x~~', { parserFlags: Flags.STRIKETHROUGH }), '<p><del>x</del></p>\n');
  assert.match(md4c.toHtml('| a |\n|---|\n| 1 |', { parserFlags: Dialect.GITHUB }), /<table>/);
  assert.equal(md4c.toHtml('héllo – ünïcode'), '<p>héllo – ünïcode</p>\n');
  assert.equal(md4c.toHtml(''), '');
});

test('toHtml handles large input and repeated calls', async () => {
  const md4c = await loadMd4c(WASM_URL);
  const big = '* item **bold** [link](http://x.y)\n'.repeat(50000);
  for (let i = 0; i < 3; i++) assert.equal(md4c.toHtml(big).match(/<li>/g).length, 50000);
  assert.equal(md4c.toHtml('ok'), '<p>ok</p>\n');
});

test('Md4cFs converts files like md2html (writable fs adapter)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'md4cfs-'));
  try {
    const storage = new Storage({ adapter: fsAdapter({ root: dir, folder: 'files' }) });
    const fs = await Md4cFs.open({ storage, wasmUrl: WASM_URL });
    await fs.writeFile('docs/readme.md', '# Title\n\n- [x] done\n');
    const out = await fs.convertFile('docs/readme.md', { fullHtml: true, title: 'T<' });
    assert.equal(out, 'docs/readme.html');
    const html = await fs.readFile(out);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>T&lt;<\/title>/);
    assert.match(html, /<h1>Title<\/h1>/);
    assert.equal(await fs.exists('nope.md'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('publish + read-only URL access', () => {
  let dir;
  let server;
  let baseUrl;
  const env = () => ({ ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' });
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], { env: env() });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-publish-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'posts', 'hello.md'), '---\ntitle: Hello\ndate: 2026-01-02\ntags: a, b\n---\n\nFirst **post**.\n');
    await writeFile(join(dir, 'posts', 'secret.md'), '---\ntitle: Secret\ndraft: true\n---\n\nNot yet.\n');
    await writeFile(join(dir, 'posts', 'Bad Name.md'), 'ignored');

    // A dumb static file server: GET only, like a public bucket URL.
    const root = join(dir, 'public');
    server = createServer(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
      const file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(root)) return res.writeHead(403).end();
      try {
        await stat(file);
        res.writeHead(200);
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
  });

  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('publish uploads posts, skips drafts and bad names, writes index.json', async () => {
    const { stdout, stderr } = await publish('--posts', join(dir, 'posts'));
    assert.match(stdout, /Done: 1 published post/);
    assert.match(stderr, /skip Bad Name\.md/);
    const index = JSON.parse(await readFile(join(dir, 'public', 'index.json'), 'utf8'));
    assert.deepEqual(index.items.map((i) => i.path), ['posts/hello.md']);
    assert.deepEqual(index.items[0].metadata, {
      title: 'Hello', date: '2026-01-02', tags: 'a, b', excerpt: 'First post.',
    });
    await assert.rejects(stat(join(dir, 'public', 'posts', 'secret.md')));
  });

  test('guests read through the URL adapter and cannot write', async () => {
    const storage = new Storage({ adapter: urlAdapter({ baseUrl }) });
    const list = await storage.list({ prefix: 'posts/' });
    assert.deepEqual(list.items.map((i) => i.path), ['posts/hello.md']);
    assert.equal(list.items[0].metadata.title, 'Hello');
    assert.match(await storage.download('posts/hello.md', { as: 'text' }), /First \*\*post\*\*/);
    await assert.rejects(storage.download('posts/secret.md'), { code: 'NotFound' });
    await assert.rejects(storage.download('posts/../index.json'), { code: 'InvalidArgument' });
    for (const write of [
      () => storage.upload('posts/x.md', 'x'),
      () => storage.delete('posts/hello.md'),
      () => storage.move('posts/hello.md', 'posts/y.md'),
      () => storage.copy('posts/hello.md', 'posts/y.md'),
    ]) await assert.rejects(write(), { code: 'NotSupported' });
  });

  test('Md4cFs renders published posts read-only', async () => {
    const fs = await Md4cFs.open({ baseUrl, wasmUrl: WASM_URL });
    assert.match(await fs.renderFile('posts/hello.md'), /<strong>post<\/strong>/);
    await assert.rejects(fs.writeFile('posts/x.md', 'x'), { code: 'NotSupported' });
  });

  test('un-drafting publishes, re-drafting unpublishes, --prune removes', async () => {
    const secret = join(dir, 'posts', 'secret.md');
    await writeFile(secret, '---\ntitle: Secret\n---\n\nNow public.\n');
    await publish('--posts', join(dir, 'posts'));
    await stat(join(dir, 'public', 'posts', 'secret.md'));

    await writeFile(secret, '---\ntitle: Secret\ndraft: true\n---\n\nBack to draft.\n');
    await publish('--posts', join(dir, 'posts'));
    await assert.rejects(stat(join(dir, 'public', 'posts', 'secret.md')));

    await rm(join(dir, 'posts', 'hello.md'));
    await publish('--posts', join(dir, 'posts'), '--prune');
    const index = JSON.parse(await readFile(join(dir, 'public', 'index.json'), 'utf8'));
    assert.deepEqual(index.items, []);
  });

  test('files written directly to storage appear after --no-posts reindex', async () => {
    const owner = new Storage({ adapter: fsAdapter({ root: dir, folder: 'public' }) });
    await owner.upload('posts/direct.md', '---\ntitle: Direct\n---\n\nWritten straight to the bucket.\n');
    await publish('--no-posts');
    const index = JSON.parse(await readFile(join(dir, 'public', 'index.json'), 'utf8'));
    assert.deepEqual(index.items.map((i) => i.metadata.title), ['Direct']);
  });
});
