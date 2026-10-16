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

  test('--site-url fills in a missing url and never replaces one', async () => {
    const indexFile = join(dir, 'public', 'index.json');
    const original = await readFile(indexFile, 'utf8');
    const doc = JSON.parse(original);
    delete doc.site.url;
    await writeFile(indexFile, JSON.stringify(doc));
    await publish('--no-posts', '--site-url', 'https://pub-abc.r2.dev');
    assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).site.url, 'https://pub-abc.r2.dev/');
    await publish('--no-posts', '--site-url', 'https://other.example');
    assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).site.url, 'https://pub-abc.r2.dev/');
    assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).site.title, 'Test Journal', 'other settings kept');
    await writeFile(indexFile, original);
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

describe('password-protected posts', () => {
  let dir;
  const pub = () => join(dir, 'public');
  const read = (p) => readFile(join(pub(), p), 'utf8');
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });
  const SECRET = 'The launch code is 4242';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-protected-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({ title: 'Locked Journal', url: 'https://blog.example.com' }));
    await writeFile(join(dir, 'posts', 'vault.md'),
      `---\ntitle: The Vault\ndate: 2026-03-04\ntags: private\ndescription: ${SECRET} (summary)\npassword: open sesame\n---\n\n${SECRET}, see **notes**.\n`);
    await writeFile(join(dir, 'posts', 'open.md'), '---\ntitle: Open\ndate: 2026-03-01\n---\n\nPublic text.\n');
    await publish('--posts', join(dir, 'posts'), '--config', join(dir, 'site.json'));
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test('encryption round-trips, and a wrong password fails', async () => {
    const { decryptText, encryptText, WrongPasswordError } = await import('../js/protect.js');
    const env = await encryptText('héllo <b>world</b>', 'pässword');
    assert.equal(env.iter, 600000);
    assert.equal(await decryptText(env, 'pässword'), 'héllo <b>world</b>');
    await assert.rejects(decryptText(env, 'wrong'), WrongPasswordError);
    const again = await encryptText('héllo <b>world</b>', 'pässword');
    assert.notEqual(again.ct, env.ct, 'fresh salt and IV each time');
  });

  test('nothing secret reaches the public bucket', async () => {
    for (const f of ['posts/vault.md', 'posts/vault.html', 'index.json', 'index.html', 'feed.xml', 'sitemap.xml']) {
      const text = await read(f);
      assert.ok(!text.includes('4242'), `${f} leaks the text`);
      assert.ok(!text.includes('open sesame'), `${f} leaks the password`);
    }
    const md = await read('posts/vault.md');
    assert.match(md, /title: The Vault/);
    assert.match(md, /protected: true/);
    assert.doesNotMatch(md, /description:/, 'the description could tell too much');
    const entry = JSON.parse(await read('index.json')).items.find((e) => e.path === 'posts/vault.md');
    assert.equal(entry.metadata.protected, 'true');
    assert.equal(entry.metadata.excerpt, '');
    assert.doesNotMatch(await read('sitemap.xml'), /vault/);
    assert.match(await read('index.html'), /Password-protected/);
  });

  test('the page carries the encrypted article and unlocks with the password', async () => {
    const { decryptText } = await import('../js/protect.js');
    const html = await read('posts/vault.html');
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /class="unlock"/);
    const attr = /data-envelope="([^"]+)"/.exec(html)[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const article = await decryptText(JSON.parse(attr), 'open sesame');
    assert.match(article, /The launch code is 4242, see <strong>notes<\/strong>/);
  });

  test('pages and indexes are revalidated on every visit, so changes are live at once', async () => {
    const { build, CACHE_PAGES } = await import('../js/site-build.js');
    assert.equal(CACHE_PAGES, 'public, no-cache');
    const storage = new Storage({ adapter: fsAdapter({ root: dir, folder: 'public' }) });
    const seen = new Map();
    const spy = new Proxy(storage, {
      get(target, prop) {
        if (prop === 'upload') return (path, body, opts) => { seen.set(path, opts?.cacheControl); return target.upload(path, body, opts); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await build(spy, await loadMd4c(WASM_URL), { full: true });
    for (const f of ['posts/vault.html', 'posts/open.html', 'index.json', 'index.html', 'feed.xml', 'sitemap.xml']) {
      assert.equal(seen.get(f), 'public, no-cache', f);
    }
    const { cacheControlFor } = await import('../admin/src/paths.js');
    assert.equal(cacheControlFor('posts/vault.md'), 'public, no-cache');
    assert.equal(cacheControlFor('posts/vault.html'), 'public, no-cache');
    assert.equal(cacheControlFor('posts/photo.jpg'), 'public, max-age=300');
  });

  test('a post with a password found in plain text is never rendered', async () => {
    await writeFile(join(pub(), 'posts', 'leak.md'), '---\ntitle: Leak\ndate: 2026-03-05\npassword: x\n---\n\nOops 4242.\n');
    const { stderr } = await publish('--no-posts');
    assert.match(stderr, /leak\.md has a password but is NOT encrypted/);
    await assert.rejects(read('posts/leak.html'));
    assert.ok(!(await read('index.json')).includes('Oops'));
  });
});

test('full-text search of the blog on a web search engine', async () => {
  const { normalizeSite, webSearch } = await import('../js/site-config.js');
  const site = normalizeSite({ url: 'https://blog.example.com' }, 'https://blog.example.com/');
  assert.equal(site.search, 'google', 'on by default');
  assert.deepEqual(webSearch(site, ' c++ templates ', 'blog.example.com'), {
    label: 'Google',
    href: 'https://www.google.com/search?q=c%2B%2B%20templates%20site%3Ablog.example.com',
  });
  assert.equal(webSearch(site, '   ', 'blog.example.com'), null);
  assert.match(webSearch(normalizeSite({ search: 'bing' }, 'https://x/'), 'q', 'x.org').href, /^https:\/\/www\.bing\.com\/search\?q=q%20site%3Ax\.org$/);
  assert.equal(webSearch(normalizeSite({ search: 'none' }, 'https://x/'), 'q', 'x.org'), null);
  assert.equal(normalizeSite({ search: 'evil.example' }, 'https://x/').search, 'google', 'unknown engines are ignored');
});

describe('front matter (YAML), titles, banners and backgrounds', () => {
  let dir;
  const read = (p) => readFile(join(dir, 'public', p), 'utf8');
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-yaml-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({ title: 'Y', url: 'https://y.example', banner: 'assets/home.jpg' }));
    await writeFile(join(dir, 'posts', 'yaml.md'), [
      '---', '# a comment', 'title: "C++ tips: a + b"', 'date: 2026-10-16', 'tags: [c++, "g++", compilers]',
      'author: \'O\'\'Brien\'', 'banner: banner.jpg', 'background: /assets/paper.jpg', 'backgroundMode: page',
      'summary: |', '  two', '  lines', '---', '', 'Body text.', '',
    ].join('\n'));
    await writeFile(join(dir, 'posts', 'heading.md'), '# C# & C++ notes\n\nFirst paragraph.\n');
    await publish('--posts', join(dir, 'posts'), '--config', join(dir, 'site.json'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('YAML values: quotes, lists, block text, comments', async () => {
    const { parseFrontMatter } = await import('../js/post-format.js');
    const { meta } = parseFrontMatter(await readFile(join(dir, 'posts', 'yaml.md'), 'utf8'));
    assert.equal(meta.title, 'C++ tips: a + b');
    assert.equal(meta.tags, 'c++, g++, compilers');
    assert.equal(meta.author, "O'Brien");
    assert.equal(meta.summary, 'two\nlines');
    assert.equal(parseFrontMatter('---\ntags:\n  - a\n  - "b c"\n---\n').meta.tags, 'a, b c');
    assert.equal(parseFrontMatter('---\ntitle: Issue #42\n---\n').meta.title, 'Issue #42', '"#" inside a value is kept');
  });

  test('the title keeps every character, and a leading "# Heading" is the title', async () => {
    const yaml = await read('posts/yaml.html');
    assert.match(yaml, /<h1 class="article-title">C\+\+ tips: a \+ b<\/h1>/);
    assert.match(yaml, /rel="tag">c\+\+</);
    assert.match(yaml, /class="author">O&#39;Brien</);
    const heading = await read('posts/heading.html');
    assert.match(heading, /<h1 class="article-title">C# &amp; C\+\+ notes<\/h1>/);
    assert.equal((heading.match(/C# &amp; C\+\+ notes<\/h1>/g) ?? []).length, 1, 'the heading is not repeated in the body');
    assert.equal(JSON.parse(await read('index.json')).items.find((i) => i.path === 'posts/heading.md').metadata.title, 'C# & C++ notes');
  });

  test('post banner and background, and the home page banner', async () => {
    const yaml = await read('posts/yaml.html');
    assert.match(yaml, /<figure class="post-banner"><img src="\.\.\/posts\/banner\.jpg"/);
    assert.match(yaml, /data-background="\.\.\/assets\/paper\.jpg" data-background-mode="page"/);
    assert.match(yaml, /og:image" content="https:\/\/y\.example\/posts\/banner\.jpg"/, 'the banner is the social image');
    assert.match(await read('index.html'), /<figure class="home-banner"><img src="assets\/home\.jpg"/);
    const { referencedKeys } = await import('../admin/src/paths.js');
    assert.deepEqual(referencedKeys(await readFile(join(dir, 'posts', 'yaml.md'), 'utf8'), 'posts/yaml.md').sort(),
      ['assets/paper.jpg', 'posts/banner.jpg'], 'publishing copies the banner and background');
  });
});

describe('links between posts (graph) and section headings', () => {
  let dir;
  const read = (p) => readFile(join(dir, 'public', p), 'utf8');
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-graph-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({ title: 'G', url: 'https://g.example/blog/' }));
    const post = (slug, body) => writeFile(join(dir, 'posts', `${slug}.md`), `---\ntitle: ${slug}\ndate: 2026-10-01\n---\n\n${body}\n`);
    await post('alpha', 'See [[Beta]], [gamma](gamma.md#x), [again](https://g.example/blog/posts/beta.html), '
      + '[live](../index.html#/post/gamma), [[Not Written]], [self](alpha.md), [elsewhere](https://other.example/posts/x.html) and ![](pic.png).');
    await post('beta', '# Install\n\nText.\n\n## Step 1\n\n```sh\n# not a heading\n```\n\n# Use\n\nBack to [alpha](alpha.md).');
    await post('gamma', 'No links.');
    await writeFile(join(dir, 'posts', 'locked.md'), '---\ntitle: Locked\ndate: 2026-10-02\npassword: pw\n---\n\nSecret [[Alpha]] link.\n');
    await publish('--posts', join(dir, 'posts'), '--config', join(dir, 'site.json'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('index.json lists the posts each post links to', async () => {
    const items = JSON.parse(await read('index.json')).items;
    const links = Object.fromEntries(items.map((i) => [i.path, i.links]));
    assert.deepEqual(links['posts/alpha.md'], ['beta', 'gamma', 'not-written']);
    assert.deepEqual(links['posts/beta.md'], ['alpha']);
    assert.deepEqual(links['posts/gamma.md'], []);
    assert.deepEqual(links['posts/locked.md'], [], 'a protected post keeps its links secret');
    const alpha = items.find((i) => i.path === 'posts/alpha.md');
    assert.deepEqual(alpha.context.beta, ['See ', 'Beta', ', gamma, again, live, Not Written, self, elsewhere and .'],
      'where each link appears: text before, link text, text after');
    assert.deepEqual(items.find((i) => i.path === 'posts/beta.md').context.alpha, ['Back to ', 'alpha', '.']);
    assert.equal(items.find((i) => i.path === 'posts/locked.md').context, undefined);
  });

  test('a Graph page, linked from every page', async () => {
    const graph = await read('graph.html');
    assert.match(graph, /data-page="graph"/);
    assert.match(graph, /id="graph-view"/);
    assert.match(graph, /name="robots" content="noindex, follow"/);
    assert.match(await read('posts/alpha.html'), /<a href="\.\.\/graph\.html">Graph<\/a>/);
    assert.match(await read('index.html'), /<a href="graph\.html">Graph<\/a>/);
  });

  test('"# Section" headings in the body become h2, so posts get contents and numbers', async () => {
    const beta = await read('posts/beta.html');
    assert.match(beta, /<h2>Install<\/h2>/);
    assert.match(beta, /<h3>Step 1<\/h3>/);
    assert.match(beta, /<h2>Use<\/h2>/);
    assert.match(beta, /# not a heading/, 'code is left alone');
    assert.equal((beta.match(/<h1[\s>]/g) ?? []).length, 1, 'the title is the only h1');
  });

  test('graphData and neighbourhood', async () => {
    const { graphData, neighbourhood } = await import('../blog/graph.js');
    const items = JSON.parse(await read('index.json')).items;
    const g = graphData(items, { postHref: (s) => `${s}.html` });
    assert.deepEqual(g.nodes.map((n) => `${n.id}:${n.kind}`).sort(),
      ['p:alpha:post', 'p:beta:post', 'p:gamma:post', 'p:locked:post', 'p:not-written:missing']);
    assert.deepEqual(g.edges.map((e) => `${e.source}>${e.target}${e.both ? ' both' : ''}`).sort(),
      ['p:alpha>p:beta both', 'p:alpha>p:gamma', 'p:alpha>p:not-written'], 'links both ways are one edge, with both arrows');
    const near = neighbourhood(g, 'p:gamma', 1);
    assert.deepEqual(near.nodes.map((n) => n.id).sort(), ['p:alpha', 'p:gamma'], 'backlinks count');
    assert.equal(neighbourhood(g, 'p:gamma', 2).nodes.length, 4);
    const tagged = graphData([{ path: 'posts/a.md', metadata: { title: 'A', tags: 'x, y' }, links: [] }],
      { postHref: (s) => s, tags: true });
    assert.deepEqual(tagged.nodes.map((n) => `${n.id}:${n.kind}`), ['p:a:post', 't:x:tag', 't:y:tag']);
    assert.ok(tagged.edges.every((e) => e.tag), 'tag edges are marked as such');
  });
});

describe("private Markdown: the public bucket gets only pages", () => {
  let dir;
  const pub = (p) => readFile(join(dir, 'public', p), 'utf8');
  const has = (folder, p) => stat(join(dir, folder, p)).then(() => true, () => false);
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-private-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'posts', 'one.md'), '---\ntitle: One\ndate: 2026-10-01\n---\n\nSee [[Two]].\n');
    await writeFile(join(dir, 'posts', 'two.md'), '---\ntitle: Two\ndate: 2026-10-02\n---\n\nText.\n');
    // Published the old way first: Markdown in the public bucket.
    await publish('--posts', join(dir, 'posts'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('--sources-bucket moves the Markdown out and builds from it', async () => {
    assert.ok(await has('public', 'posts/one.md'), 'the old way: public');
    await publish('--posts', join(dir, 'posts'), '--sources-bucket', 'private');
    assert.equal(await has('public', 'posts/one.md'), false);
    assert.equal(await has('public', 'posts/two.md'), false);
    assert.ok(await has('private', '.published/posts/one.md'));
    assert.match(await pub('posts/one.html'), /<a href="two\.html">Two<\/a>/);
    const index = JSON.parse(await pub('index.json'));
    assert.equal(index.build.sources, 'private');
    assert.deepEqual(index.items.map((i) => i.path), ['posts/one.md', 'posts/two.md']);
    await publish('--no-posts', '--sources-bucket', 'private', '--full');
    assert.ok(await has('public', 'posts/two.html'), 'rebuilds from the private copy');
  });

  test('a rebuild without the private Markdown is refused, not destructive', async () => {
    await assert.rejects(publish('--no-posts'), /keeps its posts' Markdown privately/);
    assert.ok(await has('public', 'posts/one.html'), 'pages untouched');
  });
});

describe('per-post style in the front matter: toc and numbered', () => {
  let dir;
  const read = (p) => readFile(join(dir, 'public', p), 'utf8');
  const publish = (...args) => run(process.execPath, [PUBLISH, '--to', 'fs', ...args], {
    env: { ...process.env, FS_ROOT: dir, FS_FOLDER: 'public' },
  });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blog-style-'));
    await mkdir(join(dir, 'posts'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({ title: 'S' }));
    await writeFile(join(dir, 'posts', 'plain.md'), '---\ntitle: Plain\ndate: 2026-10-01\n---\n\n# A\n\n# B\n');
    await writeFile(join(dir, 'posts', 'styled.md'), '---\ntitle: Styled\ndate: 2026-10-02\ntoc: no\nnumbered: yes\n---\n\n# A\n\n# B\n');
    await publish('--posts', join(dir, 'posts'), '--config', join(dir, 'site.json'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('sections are not numbered unless the site or the post asks', async () => {
    const plain = await read('posts/plain.html');
    assert.match(plain, /<html [^>]*data-numbered="false"/);
    assert.match(plain, /<article [^>]*data-numbered="false"/);
    assert.doesNotMatch(plain, /data-toc=/);
    const styled = await read('posts/styled.html');
    assert.match(styled, /<html [^>]*data-numbered="true"/);
    assert.match(styled, /<article [^>]*data-numbered="true" data-toc="false"/);
    const meta = JSON.parse(await read('index.json')).items.find((i) => i.path === 'posts/styled.md').metadata;
    assert.equal(meta.toc, 'false');
    assert.equal(meta.numbered, 'true');
  });
});
