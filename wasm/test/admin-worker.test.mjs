// Admin Worker: Access authentication, CSRF defence, path rules, conflict
// checks, draft stores (R2 and WebDAV) and publishing with files. Runs the
// real Worker in Node against R2 stand-ins (admin/dev/r2-shim.mjs), a WebDAV
// server (webdav-server) and a local Access-style JWKS endpoint.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { v2 as webdav } from 'webdav-server';
import worker from '../admin/src/worker.js';
import { r2Bucket } from '../admin/dev/r2-shim.mjs';

const AUD = 'test-aud';
let dir;
let env;
let team;
let jwksServer;
let davServer;
let davPort;
let key;
let otherKey;

async function token({ email = 'owner@example.com', aud = AUD, iss = team, exp = '5m', signer = key } = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: signer === key ? 'k1' : 'k2' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(signer.privateKey);
}

async function call(method, path, { body, headers = {}, auth = {}, environment = env } = {}) {
  const h = new Headers(headers);
  if (auth !== null) h.set('cf-access-jwt-assertion', await token(auth));
  if (method !== 'GET' && !h.has('x-admin-request')) h.set('x-admin-request', '1');
  const res = await worker.fetch(new Request(`https://admin.test${path}`, { method, headers: h, body }), environment);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const put = (store, k, body, headers) => call('PUT', `/api/file?store=${store}&key=${encodeURIComponent(k)}`, { body, headers });
const create = (store, k, body = 'x') => put(store, k, body, { 'if-none-match': '*' });
const read = async (store, k) => {
  const r = await call('GET', `/api/file?store=${store}&key=${encodeURIComponent(k)}`);
  return r.status === 200 ? r.data : null;
};
const postJson = (path, body) => call('POST', path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const move = (from, to, ifMatch) => postJson('/api/move', { from, to, ifMatch });
const publish = (store, k, extra = {}) => postJson('/api/publish', { from: { store, key: k }, ...extra });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'admin-worker-'));
  key = await generateKeyPair('RS256');
  otherKey = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((req, res) => {
    res.writeHead(req.url === '/cdn-cgi/access/certs' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  team = `http://127.0.0.1:${jwksServer.address().port}`;

  const users = new webdav.SimpleUserManager();
  const user = users.addUser('me', 'secret', false);
  const rights = new webdav.SimplePathPrivilegeManager();
  rights.setRights(user, '/', ['all']);
  davPort = 20000 + Math.floor(Math.random() * 20000);
  davServer = new webdav.WebDAVServer({
    port: davPort, hostname: '127.0.0.1', privilegeManager: rights,
    httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'test'),
  });
  await new Promise((r) => davServer.start(r));

  env = {
    SITE: r2Bucket(dir, 'site'),
    DRAFTS: r2Bucket(dir, 'drafts'),
    DRAFT_STORES: JSON.stringify([
      { id: 'drafts', label: 'Drafts', type: 'r2', binding: 'DRAFTS' },
      { id: 'nas', label: 'Home NAS', type: 'webdav', baseUrl: `http://127.0.0.1:${davPort}`,
        root: '/', folder: 'blog-drafts', username: 'me', passwordSecret: 'NAS_PASSWORD' },
    ]),
    NAS_PASSWORD: 'secret',
    ACCESS_TEAM_DOMAIN: team,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: 'owner@example.com',
    PUBLIC_URL: 'https://blog.example.com/',
    MAX_UPLOAD_MB: '1',
    ASSETS: { fetch: async () => new Response('<!doctype html><title>admin</title>', { headers: { 'content-type': 'text/html' } }) },
  };
});

after(async () => {
  jwksServer.close();
  await new Promise((r) => davServer.stop(r));
  await rm(dir, { recursive: true, force: true });
});

describe('Cloudflare Access', () => {
  test('a valid token for an allowed admin is accepted', async () => {
    const r = await call('GET', '/api/session');
    assert.equal(r.status, 200);
    assert.equal(r.data.email, 'owner@example.com');
    assert.deepEqual(r.data.stores.map((s) => `${s.id}:${s.role}:${s.type}`), ['site:site:r2', 'drafts:drafts:r2', 'nas:drafts:webdav']);
  });

  test('missing, forged, foreign, expired or unauthorised tokens are refused', async () => {
    assert.equal((await call('GET', '/api/session', { auth: null })).status, 401);
    assert.equal((await call('GET', '/api/session', { headers: { 'cf-access-jwt-assertion': 'not.a.jwt' }, auth: null })).status, 403);
    for (const bad of [
      { aud: 'another-app' },
      { iss: 'https://evil.cloudflareaccess.com' },
      { signer: otherKey },
      { exp: Math.floor(Date.now() / 1000) - 120 },
      { email: 'intruder@example.com' },
    ]) {
      assert.equal((await call('GET', '/api/session', { auth: bad })).status, 403, JSON.stringify(Object.keys(bad)));
    }
  });

  test('the admin app itself is protected and served with a strict CSP', async () => {
    assert.equal((await call('GET', '/', { auth: null })).status, 401);
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.match(r.headers.get('content-security-policy'), /img-src 'self' blob: data: https:\/\/blog.example.com/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('CSRF defence', () => {
  test('writes need the admin header and a same-origin request', async () => {
    for (const headers of [{ 'x-admin-request': '0' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await put('site', 'posts/csrf.md', 'x', { 'if-none-match': '*', ...headers })).status, 403);
    }
    assert.equal(await read('site', 'posts/csrf.md'), null);
  });
});

describe('paths', () => {
  test('site code and malformed paths cannot be written', async () => {
    for (const k of ['app.js', 'lib/md4c.js', 'vendor/katex/katex.mjs', 'style.css', 'posts/x.js', 'other/a.png']) {
      const r = await create('site', k);
      assert.equal(r.status, 403, k);
      assert.equal(r.data.code, 'locked');
    }
    for (const k of ['../escape.md', 'posts/../x.md', 'posts/.env.png', 'posts/a b.md', '/posts/a.md', 'posts//a.md']) {
      assert.equal((await create('site', k)).status, 400, k);
    }
  });

  test('draft stores hold posts and their files, nothing generated', async () => {
    assert.equal((await create('drafts', 'index.html')).status, 403);
    assert.equal((await create('drafts', 'posts/x.html')).status, 403);
    assert.equal((await create('drafts', 'assets/d/ok.png')).status, 201);
    assert.equal((await call('GET', '/api/list?store=nope')).status, 404);
  });

  test('content types come from the extension, not the client', async () => {
    await put('site', 'assets/logo.svg', '<svg/>', { 'if-none-match': '*', 'content-type': 'text/html' });
    assert.equal((await env.SITE.head('assets/logo.svg')).httpMetadata.contentType, 'image/svg+xml');
  });

  test('reading HTML through the API returns text, inside a sandbox', async () => {
    await put('site', 'index.html', '<script>alert(1)</script>');
    const r = await call('GET', '/api/file?store=site&key=index.html');
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
  });

  test('uploads over the size limit are refused', async () => {
    assert.equal((await create('site', 'assets/big.png', new Uint8Array(2 * 1024 * 1024))).status, 413);
  });
});

describe('conflicts', () => {
  test('content writes must say create or update', async () => {
    assert.equal((await put('site', 'posts/p1.md', 'x')).status, 428);
    assert.equal((await put('site', 'index.json', '{}')).status, 200, 'generated files may be overwritten');
  });

  test('create refuses an existing file; update needs the current etag', async () => {
    const c = await create('site', 'posts/p1.md', 'one');
    assert.equal(c.status, 201);
    assert.equal((await create('site', 'posts/p1.md', 'two')).data.code, 'exists');
    const stale = await put('site', 'posts/p1.md', 'two', { 'if-match': '"not-the-etag"' });
    assert.equal(stale.status, 412);
    assert.equal(stale.data.code, 'changed');
    assert.equal(stale.data.current.etag, c.data.etag);
    const ok = await put('site', 'posts/p1.md', 'two', { 'if-match': `"${c.data.etag}"` });
    assert.equal(ok.status, 200);
    assert.equal(await read('site', 'posts/p1.md'), 'two');
  });

  test('a file and a folder cannot share a name', async () => {
    assert.equal((await create('site', 'assets/a.png')).status, 201);
    assert.equal((await create('site', 'assets/a.png/b.png')).data.code, 'file-in-path');
    assert.equal((await create('site', 'assets/set.png/x.png')).status, 201);
    assert.equal((await create('site', 'assets/set.png')).data.code, 'folder-exists');
  });

  test('a slug lives in exactly one store', async () => {
    assert.equal((await create('drafts', 'posts/d1.md')).status, 201);
    assert.equal((await create('site', 'posts/d1.md')).data.code, 'draft-exists');
    assert.equal((await create('nas', 'posts/d1.md')).data.code, 'draft-exists');
    assert.equal((await create('site', 'posts/p2.md')).status, 201);
    assert.equal((await create('drafts', 'posts/p2.md')).data.code, 'published-exists');
    assert.equal((await create('nas', 'posts/p2.md')).data.code, 'published-exists');
  });

  test('moves: rename, unpublish, and drafts only go live through publish', async () => {
    const back = await move({ store: 'site', key: 'posts/p2.md' }, { store: 'nas', key: 'posts/p2.md' });
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal(back.data.store, 'nas');
    assert.equal((await move({ store: 'nas', key: 'posts/p2.md' }, { store: 'site', key: 'posts/p2.md' })).data.code, 'use-publish');
    assert.equal((await move({ store: 'nas', key: 'posts/p2.md' }, { store: 'drafts', key: 'posts/d1.md' })).data.code, 'exists');
    assert.equal((await move({ store: 'nas', key: 'posts/p2.md' }, { store: 'nas', key: 'posts/p3.md' }, '"stale"')).status, 412);
    assert.equal((await move({ store: 'site', key: 'index.html' }, { store: 'site', key: 'posts/x.md' })).status, 403);
    assert.equal((await move({ store: 'site', key: 'posts/p1.md' }, { store: 'site', key: 'assets/p1.png' })).status, 400);
  });

  test('delete honours If-Match', async () => {
    assert.equal((await call('DELETE', '/api/file?store=site&key=posts/p1.md', { headers: { 'if-match': '"stale"' } })).status, 412);
    assert.equal((await call('DELETE', '/api/file?store=site&key=posts/p1.md')).status, 204);
    assert.equal((await call('DELETE', '/api/file?store=site&key=posts/p1.md')).status, 404);
    assert.equal((await call('DELETE', '/api/file?store=site&key=app.js')).status, 403);
  });
});

describe('WebDAV draft store', () => {
  test('reads, writes and conditional updates work over WebDAV', async () => {
    const c = await create('nas', 'posts/w1.md', 'one');
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(await read('nas', 'posts/w1.md'), 'one');
    assert.equal((await put('nas', 'posts/w1.md', 'two', { 'if-match': '"stale"' })).data.code, 'changed');
    const ok = await put('nas', 'posts/w1.md', 'two', { 'if-match': `"${c.data.etag}"` });
    assert.equal(ok.status, 200);
    const list = await call('GET', '/api/list?store=nas&prefix=posts/');
    assert.ok(list.data.items.some((i) => i.key === 'posts/w1.md' && i.kind === 'content'));
  });

  test('WebDAV folders are not mistaken for files', async () => {
    // posts/ exists as a collection on the server; creating inside it is fine,
    // but a file named like the folder is a folder conflict.
    assert.equal((await create('nas', 'posts/w2.md')).status, 201);
    assert.equal((await create('nas', 'assets/pics.png/one.png')).status, 201);
    assert.equal((await create('nas', 'assets/pics.png')).data.code, 'folder-exists');
  });

  test('configuration problems are reported, not hidden', async () => {
    const broken = { ...env, DRAFT_STORES: '[{"id":"x","type":"webdav","baseUrl":"https://dav.example","passwordSecret":"MISSING"}]' };
    const r = await call('GET', '/api/session', { environment: broken });
    assert.equal(r.status, 500);
    assert.match(r.data.error, /secret MISSING/);
    const bad = await call('GET', '/api/session', { environment: { ...env, DRAFT_STORES: '[{"id":"site","type":"r2","binding":"DRAFTS"}]' } });
    assert.match(bad.data.error, /not "site"/);
  });
});

describe('Storage page (saved stores)', () => {
  const putStorage = (body) => call('PUT', '/api/storage', { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const dav = (extra = {}) => ({ id: 'dav2', label: 'Second share', type: 'webdav', baseUrl: `http://127.0.0.1:${davPort}`,
    root: '/', folder: 'saved-drafts', username: 'me', ...extra });

  test('a store added in the admin works without secrets or a redeploy', async () => {
    const view = await call('GET', '/api/storage');
    assert.equal(view.status, 200);
    assert.equal(view.data.canSave, true);
    assert.deepEqual(view.data.deployed.map((s) => s.id), ['drafts', 'nas']);
    const saved = await putStorage({ etag: view.data.etag, stores: [dav({ secrets: { password: 'secret' } })] });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const [store] = saved.data.stores;
    assert.equal(store.id, 'dav2');
    assert.deepEqual(store.secretsSet, { password: true });
    assert.ok(!JSON.stringify(saved.data).includes('"secret"'), 'the password is never sent back');

    const session = await call('GET', '/api/session');
    assert.ok(session.data.stores.some((s) => s.id === 'dav2' && s.saved && s.role === 'drafts'));
    assert.equal((await create('dav2', 'posts/saved-one.md', 'hello')).status, 201);
    assert.equal(await read('dav2', 'posts/saved-one.md'), 'hello');
    // Slugs stay unique across deployed and saved stores.
    assert.equal((await create('drafts', 'posts/saved-one.md')).data.code, 'draft-exists');
  });

  test('saving again keeps the password unless a new one is given', async () => {
    const view = await call('GET', '/api/storage');
    const r = await putStorage({ etag: view.data.etag, stores: [dav({ label: 'Renamed' })] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.stores[0].secretsSet, { password: true });
    assert.equal(await read('dav2', 'posts/saved-one.md'), 'hello');
    assert.equal((await call('GET', '/api/session')).data.stores.find((s) => s.id === 'dav2').label, 'Renamed');
  });

  test('stale saves, taken ids and bad settings are refused', async () => {
    const view = await call('GET', '/api/storage');
    assert.equal((await putStorage({ etag: 'old', stores: [] })).data.code, 'changed');
    assert.equal((await putStorage({ etag: view.data.etag, stores: [dav({ id: 'nas' })] })).data.code, 'exists');
    assert.equal((await putStorage({ etag: view.data.etag, stores: [dav(), dav()] })).data.code, 'exists');
    const s3 = await putStorage({ etag: view.data.etag, stores: [{ id: 'b2', type: 's3', bucket: 'my-drafts', accessKeyId: 'k' }] });
    assert.equal(s3.data.code, 'bad-store');
    assert.match(s3.data.error, /secret access key/);
    assert.equal((await putStorage({ etag: view.data.etag, stores: [dav({ baseUrl: 'ftp://x' })] })).data.code, 'bad-store');
    assert.equal((await putStorage({ etag: view.data.etag, stores: [{ id: 'gh', type: 'github', owner: 'me', repo: 'notes' }] })).data.code, 'bad-store');
  });

  test('the settings file is hidden from the file API', async () => {
    const list = await call('GET', '/api/list?store=drafts');
    assert.ok(!list.data.items.some((i) => i.key.startsWith('.')));
    assert.equal((await read('drafts', '.admin/stores.json')), null);
  });

  test('connection check reports a wrong password', async () => {
    const good = await postJson('/api/storage/test', { store: dav() });
    assert.equal(good.data.ok, true, JSON.stringify(good.data));
    assert.equal(good.data.wrote, true);
    const bad = await postJson('/api/storage/test', { store: dav({ secrets: { password: 'wrong' } }) });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /Second share/);
  });

  test('an unreachable saved store does not hide the other posts', async () => {
    const view = await call('GET', '/api/storage');
    const down = { id: 'down', label: 'Offline NAS', type: 'webdav', baseUrl: 'http://127.0.0.1:9', secrets: { password: 'x' } };
    await putStorage({ etag: view.data.etag, stores: [...view.data.stores, down] });
    const posts = await call('GET', '/api/posts');
    assert.equal(posts.status, 200);
    assert.ok(posts.data.posts.some((p) => p.key === 'posts/saved-one.md'));
    assert.ok(posts.data.problems.some((p) => p.store === 'down' && /Offline NAS/.test(p.error)));
    const write = await create('down', 'posts/nowhere.md');
    assert.equal(write.status, 502);
    assert.equal(write.data.code, 'store-unreachable');
    // Clean up: the remaining suites expect only the deployed stores.
    const now = await call('GET', '/api/storage');
    assert.equal((await putStorage({ etag: now.data.etag, stores: [] })).status, 200);
    assert.ok(!(await call('GET', '/api/session')).data.stores.some((s) => s.saved));
  });
});

describe('publishing with files', () => {
  const md = (body) => `---\ntitle: Trip\ndate: 2026-10-14\nimage: cover.png\n---\n\n${body}\n`;

  test('a draft goes live with the images and files it uses', async () => {
    await create('nas', 'posts/photo.png', 'PNG-1');
    await create('nas', 'posts/cover.png', 'COVER');
    await create('nas', 'assets/docs/paper.pdf', 'PDF');
    await create('nas', 'posts/unused.png', 'UNUSED');
    await create('nas', 'posts/trip.md', md('![p](photo.png) [paper](../assets/docs/paper.pdf) ![x](https://elsewhere.example/x.png) ![m](missing.png)'));
    const r = await publish('nas', 'posts/trip.md');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.files.copy.sort(), ['assets/docs/paper.pdf', 'posts/cover.png', 'posts/photo.png']);
    assert.equal(await read('site', 'posts/photo.png'), 'PNG-1');
    assert.equal(await read('site', 'assets/docs/paper.pdf'), 'PDF');
    assert.ok(await read('site', 'posts/trip.md'));
    assert.equal(await read('nas', 'posts/trip.md'), null, 'draft removed');
    assert.equal(await read('nas', 'posts/photo.png'), null, 'copied files leave the draft store');
    assert.equal(await read('nas', 'posts/unused.png'), 'UNUSED', 'unrelated files stay');
    assert.equal(await read('site', 'posts/unused.png'), null);
  });

  test('files other drafts still use stay in the draft store', async () => {
    await create('drafts', 'posts/shared.png', 'SHARED');
    await create('drafts', 'posts/a1.md', md('![s](shared.png)'));
    await create('drafts', 'posts/a2.md', md('![s](shared.png)'));
    const r = await publish('drafts', 'posts/a1.md');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(await read('site', 'posts/shared.png'), 'SHARED');
    assert.equal(await read('drafts', 'posts/shared.png'), 'SHARED', 'a2 still needs it');
    const r2 = await publish('drafts', 'posts/a2.md');
    assert.deepEqual(r2.data.files.identical, ['posts/shared.png'], 'already public and identical: not copied again');
    assert.equal(await read('drafts', 'posts/shared.png'), null, 'now unused, so cleaned up');
  });

  test('a different public file with the same name is a conflict until overwrite is chosen', async () => {
    await create('nas', 'posts/photo.png', 'PNG-2');
    await create('nas', 'posts/trip2.md', md('![p](photo.png)'));
    const r = await publish('nas', 'posts/trip2.md');
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'asset-conflict');
    assert.deepEqual(r.data.assets.map((a) => a.key), ['posts/photo.png']);
    assert.equal(await read('site', 'posts/trip2.md'), null, 'nothing was published');
    assert.equal(await read('site', 'posts/photo.png'), 'PNG-1', 'nothing was overwritten');
    const ok = await publish('nas', 'posts/trip2.md', { overwrite: ['posts/photo.png'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.files.overwrite, ['posts/photo.png']);
    assert.equal(await read('site', 'posts/photo.png'), 'PNG-2');
  });

  test('publish checks the slug, the etag and the source', async () => {
    await create('nas', 'posts/d1x.md', md('x'));
    assert.equal((await publish('nas', 'posts/d1x.md', { ifMatch: '"stale"' })).status, 412);
    await create('nas', 'posts/trip.md', md('again')).then((r) => assert.equal(r.data.code, 'published-exists'));
    assert.equal((await publish('site', 'posts/trip.md')).status, 400, 'only drafts publish');
    assert.equal((await publish('nas', 'posts/nothing.md')).status, 404);
  });

  test('previews read draft files, falling back to the public copy', async () => {
    const r = await call('GET', '/api/raw/nas/posts/photo.png');
    assert.equal(r.status, 200, 'photo.png is now only on the site');
    assert.equal(r.data, 'PNG-2');
    assert.equal((await call('GET', '/api/raw/nas/posts/unused.png')).data, 'UNUSED');
    assert.equal((await call('GET', '/api/raw/nas/index.html')).status, 404, 'no fallback for non-assets');
  });

  test('the posts list shows every store', async () => {
    const r = await call('GET', '/api/posts');
    const byKey = (store, k) => r.data.posts.find((p) => p.store === store && p.key === k);
    assert.equal(byKey('site', 'posts/trip.md').status, 'published');
    assert.equal(byKey('site', 'posts/trip.md').title, 'Trip');
    assert.equal(byKey('nas', 'posts/d1x.md').status, 'draft');
    assert.equal(byKey('drafts', 'posts/d1.md').status, 'draft');
  });
});
