// Access-control tests for the blog server. These talk to the HTTP API
// directly, the way an attacker would, bypassing the browser UI entirely.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Storage } from '@storagesdk/core';
import { createApp } from '../server/app.mjs';
import { hashPassword } from '../server/auth.mjs';
import { openStorage } from '../server/server.mjs';
import { httpAdapter } from '../js/http-adapter.js';

const PASSWORD = 'correct horse battery staple';
let dir;
let server;
let base;
let storage;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blog-test-'));
  storage = openStorage(dir);
  await storage.upload('posts/hello.md', '---\ntitle: Hello\n---\n\nHi', {
    contentType: 'text/markdown; charset=utf-8',
    metadata: { title: 'Hello' },
  });
  await storage.upload('drafts/secret.md', 'top secret draft');
  const record = await hashPassword(PASSWORD);
  server = createServer(createApp({
    storage,
    staticDir: join(dir, 'static-does-not-exist'),
    adminFile: async () => record,
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const req = (path, init = {}) => fetch(base + path, init);

async function login(password = PASSWORD) {
  return req('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

async function adminSession() {
  const res = await login();
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await res.json();
  return { cookie, csrfToken };
}

describe('guest (not logged in)', () => {
  test('can read and list published posts', async () => {
    const res = await req('/api/files/posts/hello.md');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hi$/);
    const list = await (await req('/api/files?prefix=posts/')).json();
    assert.deepEqual(list.items.map((i) => i.path), ['posts/hello.md']);
    assert.equal(list.items[0].metadata.title, 'Hello');
  });

  test('cannot see drafts', async () => {
    assert.equal((await req('/api/files/drafts/secret.md')).status, 404);
    assert.equal((await req('/api/files/drafts/secret.md?meta')).status, 404);
    assert.equal((await req('/api/files?prefix=drafts/')).status, 403);
    assert.equal((await req('/api/files')).status, 403);
  });

  test('cannot write, delete, or move', async () => {
    const put = await req('/api/files/posts/evil.md', { method: 'PUT', body: 'pwned' });
    assert.equal(put.status, 401);
    const del = await req('/api/files/posts/hello.md', { method: 'DELETE' });
    assert.equal(del.status, 401);
    const mv = await req('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'posts/hello.md', to: 'drafts/hello.md' }),
    });
    assert.equal(mv.status, 401);
    assert.equal((await req('/api/files/posts/hello.md')).status, 200);
    assert.equal((await req('/api/files/posts/evil.md')).status, 404);
  });

  test('forged session cookie is rejected', async () => {
    const res = await req('/api/files/posts/evil.md', {
      method: 'PUT',
      headers: { cookie: 'blog_session=forged', 'x-csrf-token': 'x' },
      body: 'pwned',
    });
    assert.equal(res.status, 401);
  });

  test('the storagesdk HTTP adapter sees the same restrictions', async () => {
    const s = new Storage({ adapter: httpAdapter({ baseUrl: `${base}/api` }) });
    assert.match(await s.download('posts/hello.md', { as: 'text' }), /Hi$/);
    await assert.rejects(s.upload('posts/x.md', 'x'), { code: 'Unauthorized' });
    await assert.rejects(s.download('drafts/secret.md'), { code: 'NotFound' });
  });
});

describe('login', () => {
  test('wrong password is refused, then rate limited', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('nope')).status, 401);
    assert.equal((await login('nope')).status, 429);
    assert.equal((await login()).status, 429, 'locked out even with the right password');
  });
});

describe('admin', () => {
  before(async () => {
    // The previous test locked out 127.0.0.1; restart with a fresh limiter.
    server.close();
    const record = await hashPassword(PASSWORD);
    server = createServer(createApp({ storage, staticDir: dir, adminFile: async () => record }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test('session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await login();
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('writes need the CSRF token', async () => {
    const { cookie } = await adminSession();
    const res = await req('/api/files/drafts/x.md', { method: 'PUT', headers: { cookie }, body: 'x' });
    assert.equal(res.status, 403);
    const wrong = await req('/api/files/drafts/x.md', {
      method: 'PUT', headers: { cookie, 'x-csrf-token': 'wrong' }, body: 'x',
    });
    assert.equal(wrong.status, 403);
  });

  test('cross-origin writes are refused', async () => {
    const { cookie, csrfToken } = await adminSession();
    const res = await req('/api/files/drafts/x.md', {
      method: 'PUT',
      headers: { cookie, 'x-csrf-token': csrfToken, origin: 'https://evil.example' },
      body: 'x',
    });
    assert.equal(res.status, 403);
  });

  test('can draft, read draft, publish, unpublish and delete', async () => {
    const { cookie, csrfToken } = await adminSession();
    const h = { cookie, 'x-csrf-token': csrfToken };
    const meta = encodeURIComponent(JSON.stringify({ title: 'New' }));

    let res = await req('/api/files/drafts/new.md', {
      method: 'PUT', headers: { ...h, 'x-storage-metadata': meta }, body: '# New',
    });
    assert.equal(res.status, 200);
    assert.equal((await req('/api/files/drafts/new.md', { headers: { cookie } })).status, 200);
    assert.equal((await req('/api/files/drafts/new.md')).status, 404, 'guests still cannot see it');

    const move = (from, to) => req('/api/move', {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    assert.equal((await move('drafts/new.md', 'posts/new.md')).status, 200);
    assert.equal((await req('/api/files/posts/new.md')).status, 200, 'published for guests');
    assert.equal((await move('posts/new.md', 'drafts/new.md')).status, 200);
    assert.equal((await req('/api/files/posts/new.md')).status, 404, 'unpublished');

    res = await req('/api/files/drafts/new.md', { method: 'DELETE', headers: h });
    assert.equal(res.status, 204);
  });

  test('same slug cannot exist as both draft and post', async () => {
    const { cookie, csrfToken } = await adminSession();
    const res = await req('/api/files/drafts/hello.md', {
      method: 'PUT', headers: { cookie, 'x-csrf-token': csrfToken }, body: 'dup',
    });
    assert.equal(res.status, 409);
  });

  test('only posts/<slug>.md and drafts/<slug>.md can be written', async () => {
    const { cookie, csrfToken } = await adminSession();
    const h = { cookie, 'x-csrf-token': csrfToken };
    for (const path of [
      '../escape.md', 'posts/../../escape.md', 'posts/%2e%2e%2fescape.md',
      'index.html', 'posts/x.html', 'posts/UPPER.md', 'other/x.md', 'posts/a/b.md',
    ]) {
      const res = await req(`/api/files/${path}`, { method: 'PUT', headers: h, body: 'x' });
      assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
    }
  });

  test('oversized bodies, bad metadata and binary data are refused', async () => {
    const { cookie, csrfToken } = await adminSession();
    const h = { cookie, 'x-csrf-token': csrfToken };
    let res = await req('/api/files/drafts/big.md', { method: 'PUT', headers: h, body: 'x'.repeat(600 * 1024) });
    assert.equal(res.status, 413);
    res = await req('/api/files/drafts/m.md', {
      method: 'PUT',
      headers: { ...h, 'x-storage-metadata': encodeURIComponent('{"evil":"x"}') },
      body: 'x',
    });
    assert.equal(res.status, 400);
    res = await req('/api/files/drafts/bin.md', { method: 'PUT', headers: h, body: new Uint8Array([0xff, 0xfe, 0xfd]) });
    assert.equal(res.status, 400);
  });

  test('logout ends the session', async () => {
    const { cookie, csrfToken } = await adminSession();
    const res = await req('/api/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken } });
    assert.equal(res.status, 200);
    assert.deepEqual(await (await req('/api/session', { headers: { cookie } })).json(), { admin: false });
  });
});

describe('security headers', () => {
  test('API responses are sandboxed plain data', async () => {
    const res = await req('/api/files/posts/hello.md');
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });
});
