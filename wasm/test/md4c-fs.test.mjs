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

  test('a hand-written index of plain paths works, and posts load without it', async () => {
    const pub = join(dir, 'public');
    await mkdir(join(pub, 'posts'), { recursive: true });
    await writeFile(join(pub, 'posts', 'by-hand.md'), '---\ntitle: By hand\n---\n\nUploaded directly.\n');
    const saved = await readFile(join(pub, 'index.json'), 'utf8');
    try {
      // Not in index.json yet: listing skips it, reading it by path works.
      let storage = new Storage({ adapter: urlAdapter({ baseUrl }) });
      assert.match(await storage.download('posts/by-hand.md', { as: 'text' }), /Uploaded directly/);

      await writeFile(join(pub, 'index.json'), '["posts/by-hand.md", "/posts/not-uploaded.md"]');
      storage = new Storage({ adapter: urlAdapter({ baseUrl }) });
      const list = await storage.list({ prefix: 'posts/' });
      assert.deepEqual(list.items.map((i) => i.path), ['posts/by-hand.md', 'posts/not-uploaded.md']);
      assert.equal(list.items[0].metadata, undefined);

      await rm(join(pub, 'index.json'));
      storage = new Storage({ adapter: urlAdapter({ baseUrl }) });
      assert.deepEqual((await storage.list()).items, [], 'missing index lists nothing');
    } finally {
      await writeFile(join(pub, 'index.json'), saved);
      await rm(join(pub, 'posts', 'by-hand.md'));
    }
  });

  test('index.json "site" settings survive reindexing; --config replaces them', async () => {
    const indexFile = join(dir, 'public', 'index.json');
    let index = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.equal(typeof index.site?.title, 'string', 'seeded from blog/site.json');

    // The owner edits the theme directly in the bucket ...
    index.site = { title: 'My Journal', theme: 'modern', accent: '#123456' };
    await writeFile(indexFile, JSON.stringify(index));
    await publish('--no-posts');
    index = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.deepEqual(index.site, { title: 'My Journal', theme: 'modern', accent: '#123456' });

    // ... or sets it from a local file.
    const cfg = join(dir, 'site.json');
    await writeFile(cfg, JSON.stringify({ title: 'From file', slogan: 'Hello' }));
    await publish('--no-posts', '--config', cfg);
    index = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.deepEqual(index.site, { title: 'From file', slogan: 'Hello' });

    // The URL adapter exposes it to the page.
    const adapter = urlAdapter({ baseUrl });
    assert.equal((await adapter.raw.document()).site.title, 'From file');
  });

  test('files written directly to storage appear after --no-posts reindex', async () => {
    const owner = new Storage({ adapter: fsAdapter({ root: dir, folder: 'public' }) });
    await owner.upload('posts/direct.md', '---\ntitle: Direct\n---\n\nWritten straight to the bucket.\n');
    await publish('--no-posts');
    const index = JSON.parse(await readFile(join(dir, 'public', 'index.json'), 'utf8'));
    assert.deepEqual(index.items.map((i) => i.metadata.title), ['Direct']);
  });
});

describe('static pages for search engines', () => {
  let dir;
  const pub = () => join(dir, 'public');
  const read = (p) => readFile(join(pub(), p), 'utf8');
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-seo-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({
      title: 'Test Journal', url: 'https://blog.example.com', author: 'A. Author', language: 'en-GB',
      verification: { google: 'g-token_1' }, accent: '#123456', backgroundImage: 'assets/bg.png',
    }));
    await writeFile(join(dir, 'posts', 'hello.md'),
      '---\ntitle: Hello <World>\ndate: 2026-01-02\ntags: a, b\ndescription: A short summary.\nimage: cover.png\n---\n\n' +
      'First **post**. See [the other one](other.md) and [[Other]].\n');
    await writeFile(join(dir, 'posts', 'other.md'),
      '---\ntitle: Other\ndate: 2025-06-01\ntags: b\nimage: javascript:alert(1)\n---\n\nSecond.\n');
    await writeFile(join(dir, 'posts', 'secret.md'), '---\ntitle: Secret\ndraft: true\n---\n\nNo.\n');
    await publish('--posts', join(dir, 'posts'), '--config', join(dir, 'site.json'));
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test('each post gets a real page with full metadata', async () => {
    const html = await read('posts/hello.html');
    assert.match(html, /<html lang="en-GB" data-theme="academic"/);
    assert.match(html, /<title>Hello &lt;World&gt; · Test Journal<\/title>/);
    assert.match(html, /<meta name="description" content="A short summary.">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/blog.example.com\/posts\/hello.html">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/blog.example.com\/posts\/cover.png">/);
    assert.match(html, /<meta name="citation_publication_date" content="2026\/01\/02">/);
    assert.match(html, /<meta name="google-site-verification" content="g-token_1">/);
    assert.match(html, /First <strong>post<\/strong>/, 'content is in the HTML, no JS needed');
    assert.match(html, /href="other.html">the other one/, '.md links point at pages');
    assert.match(html, /<a href="other.html">Other<\/a>/, 'wiki links point at pages');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(ld['@type'], 'ScholarlyArticle');
    assert.equal(ld.headline, 'Hello <World>');
    assert.equal(ld.datePublished, '2026-01-02');
    assert.equal(ld.author.name, 'A. Author');
    assert.equal(ld.url, 'https://blog.example.com/posts/hello.html');

    const other = await read('posts/other.html');
    assert.doesNotMatch(other, /javascript:/, 'unsafe image URL dropped');
    await assert.rejects(read('posts/secret.html'), 'drafts get no page');
  });

  test('home page lists articles as plain links, grouped by year', async () => {
    const html = await read('index.html');
    assert.match(html, /<link rel="canonical" href="https:\/\/blog.example.com\/index.html">/);
    assert.match(html, /<h2 class="year-heading sc">2026<\/h2>[\s\S]*href="posts\/hello.html"[\s\S]*<h2 class="year-heading sc">2025<\/h2>[\s\S]*href="posts\/other.html"/);
    assert.doesNotMatch(html, /secret/i);
    const index = JSON.parse(await read('index.json'));
    assert.deepEqual(index.items.map((i) => i.page).sort(), ['posts/hello.html', 'posts/other.html']);
    assert.equal(index.items.find((i) => i.page === 'posts/hello.html').metadata.description, 'A short summary.');
  });

  test('sitemap, feed, robots and theme.css', async () => {
    const map = await read('sitemap.xml');
    assert.match(map, /<loc>https:\/\/blog.example.com\/posts\/hello.html<\/loc><lastmod>2026-01-02<\/lastmod>/);
    assert.doesNotMatch(map, /secret/);
    const feed = await read('feed.xml');
    assert.match(feed, /<title>Hello &lt;World&gt;<\/title>/);
    assert.match(feed, /<link rel="self" href="https:\/\/blog.example.com\/feed.xml"\/>/);
    assert.match(await read('robots.txt'), /Sitemap: https:\/\/blog.example.com\/sitemap.xml/);
    const css = await read('theme.css');
    assert.match(css, /--accent-base: #123456;/);
    assert.match(css, /--bg-image: url\("assets\/bg.png"\);/);
  });

  test('pages of removed or re-drafted posts are deleted', async () => {
    await writeFile(join(dir, 'posts', 'other.md'), '---\ntitle: Other\ndraft: true\n---\n\nBack to draft.\n');
    await publish('--posts', join(dir, 'posts'));
    await assert.rejects(read('posts/other.html'));
    assert.doesNotMatch(await read('sitemap.xml'), /other.html/);
    assert.equal(JSON.parse(await read('index.json')).site.title, 'Test Journal', 'site settings kept');
  });

  test('builds are incremental: only changed posts are re-rendered', async () => {
    let { stdout } = await publish('--no-posts');
    assert.match(stdout, /Incremental build: 0 page\(s\) rendered/);
    await writeFile(join(pub(), 'posts', 'hello.md'),
      '---\ntitle: Hello again\ndate: 2026-01-02\ntags: a\n---\n\nEdited.\n');
    ({ stdout } = await publish('--no-posts'));
    assert.match(stdout, /Incremental build: 1 page\(s\) rendered/);
    assert.match(await read('posts/hello.html'), /<title>Hello again/);
    assert.match(await read('index.html'), /Hello again/);
    ({ stdout } = await publish('--no-posts', '--full'));
    assert.match(stdout, /Full build: 1 page\(s\) rendered/);
  });

  test('hand-written index entries can carry title, date and tags', async () => {
    const { urlAdapter: make } = await import('../js/url-adapter.js');
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ path: 'posts/x.md', title: 'X', date: '2026-02-03', tags: ['p', 'q'] }]));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const s = new Storage({ adapter: make({ baseUrl: `http://127.0.0.1:${server.address().port}/` }) });
      const [item] = (await s.list()).items;
      assert.deepEqual(item.metadata, { title: 'X', date: '2026-02-03', tags: 'p, q' });
    } finally {
      server.close();
    }
  });
});
