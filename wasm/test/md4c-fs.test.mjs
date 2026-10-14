// Tests for the wasm build, the IndexedDB storagesdk adapter, and Md4cFs.
// IndexedDB comes from fake-indexeddb so this runs under plain Node.

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Storage } from '@storagesdk/core';
import { indexedDbAdapter } from '../js/idb-adapter.js';
import { Md4cFs } from '../js/md4c-fs.js';
import { Dialect, Flags, loadMd4c } from '../js/md4c.js';

const WASM_URL = new URL('../dist/md4c.wasm', import.meta.url);
let dbCounter = 0;
const freshStorage = () =>
  new Storage({ adapter: indexedDbAdapter({ name: `test-${++dbCounter}` }) });

test('toHtml renders CommonMark and extensions', async () => {
  const md4c = await loadMd4c(WASM_URL);
  assert.equal(md4c.toHtml('# Hi *there*'), '<h1>Hi <em>there</em></h1>\n');
  assert.equal(
    md4c.toHtml('~~x~~', { parserFlags: Flags.STRIKETHROUGH }),
    '<p><del>x</del></p>\n'
  );
  assert.match(
    md4c.toHtml('| a |\n|---|\n| 1 |', { parserFlags: Dialect.GITHUB }),
    /<table>/
  );
  assert.equal(md4c.toHtml('héllo – ünïcode'), '<p>héllo – ünïcode</p>\n');
  assert.equal(md4c.toHtml(''), '');
});

test('toHtml handles large input and repeated calls', async () => {
  const md4c = await loadMd4c(WASM_URL);
  const big = '* item **bold** [link](http://x.y)\n'.repeat(50000);
  for (let i = 0; i < 3; i++) {
    const html = md4c.toHtml(big);
    assert.equal(html.match(/<li>/g).length, 50000);
  }
  assert.equal(md4c.toHtml('ok'), '<p>ok</p>\n');
});

test('idb adapter: upload, download, list, move, delete', async () => {
  const s = freshStorage();
  await s.upload('posts/a.md', 'A', { contentType: 'text/markdown' });
  await s.upload('posts/b.md', 'B');
  await s.upload('other.txt', 'X');

  assert.equal(await s.download('posts/a.md', { as: 'text' }), 'A');
  const head = await s.head('posts/a.md');
  assert.equal(head.size, 1);
  assert.equal(head.contentType, 'text/markdown');

  const listed = await s.list({ prefix: 'posts/' });
  assert.deepEqual(listed.items.map((i) => i.path), ['posts/a.md', 'posts/b.md']);

  const p1 = await s.list({ limit: 2 });
  assert.equal(p1.items.length, 2);
  const p2 = await s.list({ limit: 2, cursor: p1.cursor });
  assert.deepEqual(p2.items.map((i) => i.path), ['posts/b.md']);
  assert.equal(p2.cursor, undefined);

  await s.move('posts/b.md', 'posts/c.md');
  await assert.rejects(s.head('posts/b.md'), { code: 'NotFound' });
  await s.delete('posts/a.md');
  assert.deepEqual(
    (await s.list({ prefix: 'posts/' })).items.map((i) => i.path),
    ['posts/c.md']
  );
});

test('idb adapter: snapshots and forks', async () => {
  const s = freshStorage();
  await s.upload('a.md', 'v1');
  const snap = await s.snapshots.create({ name: 'before' });
  await s.upload('a.md', 'v2');

  assert.equal(await s.snapshots.get(snap.id).download('a.md', { as: 'text' }), 'v1');
  assert.equal(await s.download('a.md', { as: 'text' }), 'v2');

  await s.forks.create({ name: 'draft', fromSnapshot: snap.id });
  const fork = s.forks.get('draft');
  await fork.upload('b.md', 'new in fork');
  assert.equal(await fork.download('a.md', { as: 'text' }), 'v1');
  await assert.rejects(s.head('b.md'), { code: 'NotFound' });

  await s.forks.merge('draft');
  assert.equal(await s.download('b.md', { as: 'text' }), 'new in fork');

  await s.forks.delete('draft');
  assert.deepEqual(await s.forks.list(), []);
  await assert.rejects(fork.head('b.md'), { code: 'NotFound' });
});

test('Md4cFs converts files like md2html', async () => {
  const fs = await Md4cFs.open({ storage: freshStorage(), wasmUrl: WASM_URL });
  await fs.writeFile('docs/readme.md', '# Title\n\n- [x] done\n');
  const out = await fs.convertFile('docs/readme.md', { fullHtml: true, title: 'T<' });
  assert.equal(out, 'docs/readme.html');

  const html = await fs.readFile('docs/readme.html');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>T&lt;<\/title>/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /type="checkbox"/);
  assert.equal((await fs.stat(out)).contentType, 'text/html; charset=utf-8');

  assert.deepEqual(
    (await fs.readdir('docs/')).map((i) => i.path),
    ['docs/readme.html', 'docs/readme.md']
  );
  assert.equal(await fs.exists('nope.md'), false);
});
