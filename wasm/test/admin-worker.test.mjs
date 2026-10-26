// Admin Worker: Access authentication, CSRF defence, path rules, conflict
// checks, draft stores (R2 and WebDAV) and publishing with files. Runs the
// real Worker in Node against R2 stand-ins (admin/dev/r2-shim.mjs), a WebDAV
// server (webdav-server) and a local Access-style JWKS endpoint.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { v2 as webdav } from 'webdav-server';
import worker from '../admin/src/worker.js';
import { kvNamespace } from '../admin/dev/kv-shim.mjs';
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
    SETTINGS: kvNamespace(),
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
    for (const k of ['app.js', 'lib/md4c.js', 'vendor/katex/katex.mjs', 'style.css', 'other/a.png', 'posts/Bad.md']) {
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

  test('attachments of any type go in posts/ and assets/; only posts/<slug>.md is a post', async () => {
    for (const k of ['assets/talk.mp3', 'assets/demo/page.html', 'posts/data.zip', 'posts/notes/extra.md', 'posts/sub/clip.mov']) {
      const r = await create('drafts', k);
      assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.kind, 'asset', k);
    }
    assert.equal((await env.DRAFTS.head('assets/talk.mp3')).httpMetadata.contentType, 'audio/mpeg');
    assert.equal((await create('drafts', 'posts/x.html')).status, 403, 'posts/<slug>.html is a generated page');
  });

  test('empty folders are kept and listed until removed', async () => {
    const mk = (store, prefix) => postJson('/api/folder', { store, prefix });
    assert.equal((await mk('nas', 'assets/new-folder/')).status, 201);
    assert.equal((await mk('drafts', 'posts/gallery/')).status, 201);
    let list = await call('GET', '/api/list?store=nas');
    assert.ok(list.data.folders.includes('assets/new-folder/'), JSON.stringify(list.data.folders));
    assert.ok(!list.data.items.some((i) => i.key.endsWith('.keep')), 'the marker is not a file');
    assert.ok((await call('GET', '/api/list?store=drafts&prefix=posts/')).data.folders.includes('posts/gallery/'));
    assert.equal((await mk('nas', 'other/x/')).status, 400);
    assert.equal((await mk('nas', 'assets/')).status, 400);
    assert.equal((await mk('drafts', 'assets/talk.mp3/')).data.code, 'file-in-path');
    assert.equal((await mk('nas', 'assets/scans.v1/')).status, 201);
    assert.equal((await create('nas', 'assets/scans.v1')).data.code, 'folder-exists', 'a file may not take its name');
    assert.equal((await create('nas', 'assets/new-folder/a.pdf')).status, 201);
    assert.equal((await call('DELETE', '/api/folder?store=nas&prefix=assets/new-folder/')).data.code, 'not-empty');
    const del = await call('DELETE', '/api/folder?store=drafts&prefix=posts/gallery/');
    assert.equal(del.status, 204);
    list = await call('GET', '/api/list?store=drafts&prefix=posts/');
    assert.ok(!list.data.folders.includes('posts/gallery/'));
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

describe('Storage page', () => {
  const putStorage = (body) => call('PUT', '/api/storage', { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const dav = (extra = {}) => ({ id: 'dav2', label: 'Second share', type: 'webdav', baseUrl: `http://127.0.0.1:${davPort}`,
    root: '/', folder: 'saved-drafts', username: 'me', ...extra });
  // What the admin app sends for "this browser only" stores (ui/client.js).
  const cookies = (list, size = 50) => {
    const v = Buffer.from(JSON.stringify(list)).toString('base64url');
    return v.match(new RegExp(`.{1,${size}}`, 'g')).map((c, i) => `md4c_stores_${i}=${c}`).join('; ');
  };

  test('a store saved in KV works without secrets or a redeploy', async () => {
    const view = await call('GET', '/api/storage');
    assert.equal(view.status, 200);
    assert.equal(view.data.kv, true);
    assert.equal(view.data.version, 0);
    assert.deepEqual(view.data.deployed.map((s) => s.id), ['drafts', 'nas']);
    const saved = await putStorage({ version: 0, stores: [dav({ secrets: { password: 'secret' } })] });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.version, 1);
    assert.deepEqual(saved.data.stores[0].secretsSet, { password: true });
    assert.ok(!JSON.stringify(saved.data).includes('"secret"'), 'the password is never sent back');
    assert.ok(JSON.parse(await env.SETTINGS.get('draft-stores')).stores[0].secrets.password, 'kept in KV');
    assert.equal(await env.DRAFTS.head('.admin/stores.json'), null, 'nothing in the drafts bucket');

    const session = await call('GET', '/api/session');
    assert.ok(session.data.stores.some((s) => s.id === 'dav2' && s.location === 'kv' && s.role === 'drafts'));
    assert.equal((await create('dav2', 'posts/saved-one.md', 'hello')).status, 201);
    assert.equal(await read('dav2', 'posts/saved-one.md'), 'hello');
    // Slugs stay unique across all stores.
    assert.equal((await create('drafts', 'posts/saved-one.md')).data.code, 'draft-exists');
  });

  test('saving again keeps the password unless a new one is given', async () => {
    const view = await call('GET', '/api/storage');
    const r = await putStorage({ version: view.data.version, stores: [dav({ label: 'Renamed' })] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.stores[0].secretsSet, { password: true });
    assert.equal(await read('dav2', 'posts/saved-one.md'), 'hello');
    assert.equal((await call('GET', '/api/session')).data.stores.find((s) => s.id === 'dav2').label, 'Renamed');
  });

  test('stale saves, taken ids and bad settings are refused', async () => {
    const { version } = (await call('GET', '/api/storage')).data;
    assert.equal((await putStorage({ version: version - 1, stores: [] })).data.code, 'changed');
    assert.equal((await putStorage({ version, stores: [dav({ id: 'nas' })] })).data.code, 'exists');
    assert.equal((await putStorage({ version, stores: [dav(), dav()] })).data.code, 'exists');
    const s3 = await putStorage({ version, stores: [{ id: 'b2', type: 's3', bucket: 'my-drafts', accessKeyId: 'k' }] });
    assert.equal(s3.data.code, 'bad-store');
    assert.match(s3.data.error, /secret access key/);
    assert.equal((await putStorage({ version, stores: [dav({ baseUrl: 'ftp://x' })] })).data.code, 'bad-store');
    assert.equal((await putStorage({ version, stores: [{ id: 'gh', type: 'github', owner: 'me', repo: 'notes' }] })).data.code, 'bad-store');
    const local = await putStorage({ version, stores: [dav({ id: 'local' })] });
    assert.equal(local.data.code, 'bad-store', '"local" is the browser\'s own store');
  });

  test('without a KV namespace, saving is refused', async () => {
    const r = await call('PUT', '/api/storage', { environment: { ...env, SETTINGS: undefined },
      body: JSON.stringify({ version: 0, stores: [] }), headers: { 'content-type': 'application/json' } });
    assert.equal(r.data.code, 'no-kv');
  });

  test('a store kept in the browser travels in cookies and is never saved', async () => {
    const local = { ...dav({ id: 'mine', label: 'Only here', folder: 'browser-drafts' }), secrets: { password: 'secret' } };
    const checked = await postJson('/api/storage/test', { store: local, location: 'browser', check: true });
    assert.equal(checked.data.ok, true);
    assert.equal(checked.data.store.folder, 'browser-drafts/');
    const cookie = cookies([checked.data.store]);
    const withCookie = (method, path, body) => call(method, path, { body, headers: { cookie, ...(body ? { 'if-none-match': '*' } : {}) } });
    const session = await withCookie('GET', '/api/session');
    assert.ok(session.data.stores.some((s) => s.id === 'mine' && s.location === 'browser'));
    assert.equal((await withCookie('PUT', '/api/file?store=mine&key=posts/local-one.md', 'from my phone')).status, 201);
    assert.equal((await withCookie('GET', '/api/file?store=mine&key=posts/local-one.md')).data, 'from my phone');
    assert.ok((await withCookie('GET', '/api/posts')).data.posts.some((p) => p.store === 'mine'));
    // Other requests (another device) don't see it, and nothing was stored.
    assert.ok(!(await call('GET', '/api/session')).data.stores.some((s) => s.id === 'mine'));
    assert.ok(!(await env.SETTINGS.get('draft-stores')).includes('mine'));
    // A browser store whose id is taken, or an unreadable cookie, is reported.
    const clash = await call('GET', '/api/session', { headers: { cookie: cookies([{ ...checked.data.store, id: 'dav2' }]) } });
    assert.ok(clash.data.problems.some((p) => p.store === 'dav2' && p.location === 'browser'));
    const junk = await call('GET', '/api/session', { headers: { cookie: 'md4c_stores_0=@@@' } });
    assert.equal(junk.status, 200);
    assert.match(junk.data.problems[0].error, /could not be read/);
  });

  test('connection check reports a wrong password', async () => {
    const good = await postJson('/api/storage/test', { store: dav(), location: 'kv' });
    assert.equal(good.data.ok, true, JSON.stringify(good.data));
    assert.equal(good.data.wrote, true);
    const bad = await postJson('/api/storage/test', { store: dav({ secrets: { password: 'wrong' } }), location: 'kv' });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /Second share/);
    // A KV store's saved secret is only used for that store, not a browser one.
    const browser = await postJson('/api/storage/test', { store: dav(), location: 'browser' });
    assert.equal(browser.data.ok, false);
  });

  test('an unreachable store does not hide the other posts', async () => {
    const view = await call('GET', '/api/storage');
    const down = { id: 'down', label: 'Offline NAS', type: 'webdav', baseUrl: 'http://127.0.0.1:9', secrets: { password: 'x' } };
    await putStorage({ version: view.data.version, stores: [...view.data.stores, down] });
    const posts = await call('GET', '/api/posts');
    assert.equal(posts.status, 200);
    assert.ok(posts.data.posts.some((p) => p.key === 'posts/saved-one.md'));
    assert.ok(posts.data.problems.some((p) => p.store === 'down' && /Offline NAS/.test(p.error)));
    const write = await create('down', 'posts/nowhere.md');
    assert.equal(write.status, 502);
    assert.equal(write.data.code, 'store-unreachable');
    // Clean up: the remaining suites expect only the deployed stores.
    const now = await call('GET', '/api/storage');
    assert.equal((await putStorage({ version: now.data.version, stores: [] })).status, 200);
    assert.ok(!(await call('GET', '/api/session')).data.stores.some((s) => s.location !== 'deploy'));
  });
});

describe('WebDAV servers that answer differently', () => {
  // A Nextcloud-style share (/remote.php/dav/files/me) behind a server that
  // refuses single-file PROPFIND (Depth 0) with 403, as some NAS and Apache
  // setups do. Listing works, so the admin must not call files missing.
  let proxy;
  let base;
  const cookieFor = (list) => Buffer.from(JSON.stringify(list)).toString('base64url');
  before(async () => {
    const mount = join(dir, 'nc');
    await mkdir(mount, { recursive: true });
    await new Promise((r) => davServer.setFileSystem('/remote.php/dav/files/me', new webdav.PhysicalFileSystem(mount), () => r()));
    proxy = createServer((req, res) => {
      if (req.method === 'PROPFIND' && req.headers.depth === '0' && /\.[a-z0-9]+$/i.test(req.url)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const up = httpRequest({ host: '127.0.0.1', port: davPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${proxy.address().port}/remote.php/dav/files/me`;
  });
  after(() => proxy.close());

  test('upload, read, update and delete work, and Test connection passes', async () => {
    const store = { id: 'quirky', label: 'Quirky NAS', type: 'webdav', baseUrl: base, root: '/Documents', folder: 'blog', username: 'me', secrets: { password: 'secret' } };
    const checked = (await postJson('/api/storage/test', { store, location: 'browser', check: true })).data.store;
    const headers = { cookie: `md4c_stores_0=${cookieFor([checked])}` };
    const req = (method, path, body, extra = {}) => call(method, path, { body, headers: { ...headers, ...extra } });

    const created = await req('PUT', '/api/file?store=quirky&key=posts/nas-post.md', 'one', { 'if-none-match': '*' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await req('GET', '/api/file?store=quirky&key=posts/nas-post.md')).data, 'one');
    const updated = await req('PUT', '/api/file?store=quirky&key=posts/nas-post.md', 'two', { 'if-match': `"${created.data.etag}"` });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    const list = await req('GET', '/api/list?store=quirky&prefix=posts/');
    assert.deepEqual(list.data.items.map((i) => i.key), ['posts/nas-post.md']);
    assert.equal((await req('DELETE', '/api/file?store=quirky&key=posts/nas-post.md')).status, 204);
    assert.equal((await req('GET', '/api/file?store=quirky&key=posts/nas-post.md')).status, 404);

    const t = await postJson('/api/storage/test', { store, location: 'browser' });
    assert.equal(t.data.ok, true, JSON.stringify(t.data));
    assert.equal(t.data.wrote, true);
  });

  test('folders made by other WebDAV apps are listed, and can be removed when empty', async () => {
    const { createClient } = await import('webdav');
    const other = createClient(`http://127.0.0.1:${davPort}`, { username: 'me', password: 'secret' });
    // The "nas" store keeps its files in /blog-drafts on this server.
    await other.createDirectory('/blog-drafts/assets/from-phone-app/2026', { recursive: true });
    await other.createDirectory('/blog-drafts/notes', { recursive: true });
    await other.putFileContents('/blog-drafts/notes/idea.txt', 'hello');

    const all = await call('GET', '/api/list?store=nas');
    for (const f of ['assets/from-phone-app/', 'assets/from-phone-app/2026/', 'notes/']) {
      assert.ok(all.data.folders.includes(f), `${f} in ${JSON.stringify(all.data.folders)}`);
    }
    assert.ok(all.data.items.some((i) => i.key === 'notes/idea.txt'));
    const sub = await call('GET', '/api/list?store=nas&prefix=assets/');
    assert.ok(sub.data.folders.includes('assets/from-phone-app/'));
    assert.ok(!sub.data.folders.includes('notes/'), 'only folders under the prefix');

    // A file may not take an existing (empty) folder's name.
    assert.equal((await create('nas', 'assets/from-phone-app/2026')).data.code, 'bad-path');
    await other.createDirectory('/blog-drafts/assets/album.v2');
    assert.equal((await create('nas', 'assets/album.v2')).data.code, 'folder-exists');

    // New folder in the admin is a real folder other apps see.
    assert.equal((await postJson('/api/folder', { store: 'nas', prefix: 'assets/made-in-admin/' })).status, 201);
    assert.equal((await other.stat('/blog-drafts/assets/made-in-admin')).type, 'directory');

    // Removing empty folders deletes them on the server; non-empty ones are refused.
    assert.equal((await call('DELETE', '/api/folder?store=nas&prefix=assets/from-phone-app/')).status, 204);
    assert.equal(await other.exists('/blog-drafts/assets/from-phone-app'), false);
    assert.equal((await call('DELETE', '/api/folder?store=nas&prefix=notes/')).data.code, 'not-empty');
    assert.equal((await call('DELETE', '/api/folder?store=nas&prefix=assets/made-in-admin/')).status, 204);
    assert.equal(await other.exists('/blog-drafts/assets/made-in-admin'), false);
  });

  test('Test connection names the step and the server path that failed', async () => {
    const store = { id: 'nowhere', label: 'Wrong URL', type: 'webdav', baseUrl: `${base}/no-such-dir`, root: '/', folder: 'blog', username: 'me', secrets: { password: 'secret' } };
    const t = await postJson('/api/storage/test', { store, location: 'browser' });
    assert.equal(t.data.ok, false);
    assert.match(t.data.error, /Could not (write|find)/);
    assert.match(t.data.error, /no-such-dir\/blog\/posts\/md4c-admin-check-/);
  });
});

describe('fast listings', () => {
  test('a folder lists one level: its files and sub-folders', async () => {
    await create('drafts', 'assets/fast/a.png', 'A');
    await create('drafts', 'assets/fast/deep/b.png', 'B');
    await create('drafts', 'assets/fast/deeper/x/c.png', 'C');
    const r = await call('GET', '/api/list?store=drafts&prefix=assets/fast/&shallow=1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.items.map((i) => i.key), ['assets/fast/a.png']);
    assert.deepEqual(r.data.folders, ['assets/fast/deep/', 'assets/fast/deeper/']);
    assert.equal(r.data.exists, true);
    // WebDAV: one PROPFIND of the folder.
    await create('nas', 'assets/fast/n.png', 'N');
    await create('nas', 'assets/fast/sub/m.png', 'M');
    const d = await call('GET', '/api/list?store=nas&prefix=assets/fast/&shallow=1');
    assert.deepEqual(d.data.items.map((i) => i.key), ['assets/fast/n.png']);
    assert.deepEqual(d.data.folders, ['assets/fast/sub/']);
    const missing = await call('GET', '/api/list?store=nas&prefix=assets/nothing-here/&shallow=1');
    assert.deepEqual([missing.data.items, missing.data.folders, missing.data.exists], [[], [], false]);
  });

  test('the posts list reads no post: unknown titles show the address', async () => {
    const { createClient } = await import('webdav');
    const other = createClient(`http://127.0.0.1:${davPort}`, { username: 'me', password: 'secret' });
    await other.putFileContents('/blog-drafts/posts/written-elsewhere.md', '---\ntitle: Not read\n---\n\nBody');
    await create('nas', 'posts/written-here.md', '---\ntitle: Saved in the admin\ndate: 2026-10-16\n---\n\nBody');
    const r = await call('GET', '/api/posts');
    const byKey = (k) => r.data.posts.find((p) => p.key === k);
    assert.equal(byKey('posts/written-elsewhere.md').title, 'written-elsewhere', 'not read: shown by its address');
    assert.equal(byKey('posts/written-here.md').title, 'Saved in the admin', 'known from writing it');
    assert.equal(byKey('posts/written-here.md').url, '/api/raw/nas/posts/written-here.md');
    assert.ok(!('summary' in byKey('posts/written-here.md')));
  });

  test('R2 posts carry their summary, so the posts list reads no drafts', async () => {
    await create('drafts', 'posts/summary-one.md', '---\ntitle: "C++: fast"\ndate: 2026-10-16\ntags: [a, b]\n---\n\nBody');
    const head = await env.DRAFTS.head('posts/summary-one.md');
    assert.deepEqual({ ...head.customMetadata }, { s: '1', title: 'C++: fast', date: '2026-10-16', tags: 'a, b' });
    let gets = 0;
    const realGet = env.DRAFTS.get;
    env.DRAFTS.get = (...a) => { gets++; return realGet.apply(env.DRAFTS, a); };
    try {
      const r = await call('GET', '/api/posts');
      const p = r.data.posts.find((x) => x.key === 'posts/summary-one.md');
      assert.deepEqual([p.title, p.date, p.tags], ['C++: fast', '2026-10-16', 'a, b']);
      assert.equal(gets, 0, 'no draft in the R2 store was read');
    } finally {
      env.DRAFTS.get = realGet;
    }
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
    assert.equal(await read('site', 'posts/trip.md'), await read('nas', 'posts/trip.md'), 'published copy = draft');
    assert.equal(r.data.updated, false);
    assert.equal(await read('nas', 'posts/photo.png'), 'PNG-1', 'the draft keeps its files');
    assert.equal(await read('site', 'posts/unused.png'), null);
  });

  test('publishing again updates the public copy; the draft stays the working copy', async () => {
    await create('drafts', 'posts/shared.png', 'SHARED');
    const a1 = await create('drafts', 'posts/a1.md', md('![s](shared.png) one'));
    assert.equal((await publish('drafts', 'posts/a1.md')).status, 200);
    await create('drafts', 'posts/a2.md', md('![s](shared.png)'));
    const r2 = await publish('drafts', 'posts/a2.md');
    assert.deepEqual(r2.data.files.identical, ['posts/shared.png'], 'already public and identical: not copied again');
    assert.equal(await read('drafts', 'posts/shared.png'), 'SHARED');

    const site1 = (await call('GET', '/api/list?store=site&prefix=posts/a1.md')).data.items[0];
    const edited = await put('drafts', 'posts/a1.md', md('![s](shared.png) two'), { 'if-match': `"${a1.data.etag}"` });
    assert.equal(edited.status, 200);
    assert.match(await read('site', 'posts/a1.md'), /one/, 'saving the draft does not touch the site');
    assert.equal((await publish('drafts', 'posts/a1.md', { siteIfMatch: 'stale' })).data.published, true, 'site copy changed elsewhere');
    const again = await publish('drafts', 'posts/a1.md', { siteIfMatch: site1.etag });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.updated, true);
    assert.match(await read('site', 'posts/a1.md'), /two/);
    assert.match(await read('drafts', 'posts/a1.md'), /two/);
  });

  test('a post published elsewhere gets its draft only on purpose', async () => {
    assert.equal((await create('site', 'posts/solo.md', md('from the laptop'))).status, 201);
    assert.equal((await create('drafts', 'posts/solo.md', md('edit'))).data.code, 'published-exists', 'a new post may not take its slug');
    const own = await call('PUT', '/api/file?store=drafts&key=posts/solo.md&ofPublished=1',
      { body: md('edit'), headers: { 'if-none-match': '*' } });
    assert.equal(own.status, 201, JSON.stringify(own.data));
    assert.equal((await call('PUT', '/api/file?store=nas&key=posts/solo.md&ofPublished=1',
      { body: 'x', headers: { 'if-none-match': '*' } })).data.code, 'draft-exists', 'still one draft per slug');
    const r = await publish('drafts', 'posts/solo.md');
    assert.equal(r.data.updated, true);
    assert.match(await read('site', 'posts/solo.md'), /edit/);
  });

  test('a different public file with the same name is a conflict until overwrite is chosen', async () => {
    const cur = (await call('GET', '/api/list?store=nas&prefix=posts/photo.png')).data.items[0];
    assert.equal((await put('nas', 'posts/photo.png', 'PNG-2', { 'if-match': `"${cur.etag}"` })).status, 200);
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
    await create('drafts', 'posts/trip.md', md('again')).then((r) => assert.equal(r.data.code, 'published-exists'));
    const second = await call('PUT', '/api/file?store=drafts&key=posts/trip.md&ofPublished=1',
      { body: 'x', headers: { 'if-none-match': '*' } });
    assert.equal(second.data.code, 'draft-exists', 'trip already has its draft in nas');
    assert.equal((await publish('site', 'posts/trip.md')).status, 400, 'only drafts publish');
    assert.equal((await publish('nas', 'posts/nothing.md')).status, 404);
  });

  test('you choose which attachments go public', async () => {
    await create('drafts', 'posts/keep-private.pdf', 'PRIVATE');
    await create('drafts', 'posts/song.mp3', 'MP3');
    await create('drafts', 'posts/choose.md', md('[pdf](keep-private.pdf) <audio controls src="song.mp3"></audio>'));
    const plan = await publish('drafts', 'posts/choose.md', { dryRun: true });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.deepEqual(plan.data.files.map((f) => `${f.key}:${f.action}`).sort(), ['posts/keep-private.pdf:copy', 'posts/song.mp3:copy']);
    assert.equal(await read('site', 'posts/choose.md'), null, 'a dry run writes nothing');
    const r = await publish('drafts', 'posts/choose.md', { skip: ['posts/keep-private.pdf'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.files.skip, ['posts/keep-private.pdf']);
    assert.equal(await read('site', 'posts/song.mp3'), 'MP3');
    assert.equal(await read('site', 'posts/keep-private.pdf'), null, 'skipped files stay private');
  });

  test('a draft store file can be copied to the site on its own', async () => {
    const copy = (key, extra = {}) => postJson('/api/copy', { from: { store: 'drafts', key }, ...extra });
    await create('drafts', 'assets/handout.html', '<h1>v1</h1>');
    const r = await copy('assets/handout.html');
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(await read('site', 'assets/handout.html'), '<h1>v1</h1>');
    assert.equal((await copy('assets/handout.html')).data.action, 'identical');
    const cur = (await call('GET', '/api/list?store=drafts&prefix=assets/handout.html')).data.items[0];
    await put('drafts', 'assets/handout.html', '<h1>v2</h1>', { 'if-match': `"${cur.etag}"` });
    assert.equal((await copy('assets/handout.html')).data.code, 'exists');
    assert.equal((await copy('assets/handout.html', { overwrite: true, ifMatch: 'stale' })).data.code, 'changed');
    assert.equal((await copy('assets/handout.html', { overwrite: true })).data.action, 'overwrite');
    assert.equal(await read('site', 'assets/handout.html'), '<h1>v2</h1>');
    assert.equal((await copy('posts/d1.md')).data.code, 'use-publish');
    assert.equal((await postJson('/api/copy', { from: { store: 'site', key: 'assets/handout.html' } })).status, 400);
  });

  test('a post with a password goes public only encrypted', async () => {
    const { decryptText, protectPost, readProtected } = await import('../js/protect.js');
    const draft = '---\ntitle: Locked\ndate: 2026-10-14\npassword: pw1\n---\n\nSecret body.\n';
    await create('drafts', 'posts/locked.md', draft);
    const plan = await publish('drafts', 'posts/locked.md', { dryRun: true });
    assert.equal(plan.data.protected, true);
    assert.equal((await publish('drafts', 'posts/locked.md')).data.code, 'needs-encryption');
    assert.equal((await publish('drafts', 'posts/locked.md', { postBody: draft })).data.code, 'needs-encryption');
    const envelope = await protectPost(draft, (md) => `<p>${md.trim()}</p>`);
    const r = await publish('drafts', 'posts/locked.md', { postBody: envelope });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const live = await read('site', 'posts/locked.md');
    assert.ok(!live.includes('Secret') && !live.includes('pw1'));
    assert.equal(await decryptText(readProtected(live).envelope, 'pw1'), '<p>Secret body.</p>');
    assert.match(await read('drafts', 'posts/locked.md'), /password: pw1/, 'the draft keeps the password');
    // Plain text with a password can't be written to the site any other way.
    assert.equal((await create('site', 'posts/sneaky.md', draft)).data.code, 'needs-encryption');
    assert.equal((await publish('nas', 'posts/d1x.md', { postBody: envelope })).data.code, 'bad-envelope', 'postBody only for posts with a password');
  });

  test('previews read draft files, falling back to the public copy', async () => {
    const r = await call('GET', '/api/raw/nas/posts/photo.png');
    assert.equal(r.status, 200);
    assert.equal(r.data, 'PNG-2', 'the draft store copy');
    assert.equal((await call('GET', '/api/raw/nas/posts/unused.png')).data, 'UNUSED');
    assert.equal((await call('GET', '/api/raw/nas/index.html')).status, 404, 'no fallback for non-assets');
  });

  test("a published post's Markdown stays private: the public bucket gets no .md", async () => {
    assert.equal(await env.SITE.head('posts/trip.md'), null, 'not in the public bucket');
    assert.ok(await env.DRAFTS.head('.published/posts/trip.md'), 'kept in the private bucket');
    const site = await call('GET', '/api/list?store=site&prefix=posts/&shallow=1');
    assert.ok(site.data.items.some((i) => i.key === 'posts/trip.md'), 'the admin still sees it as published');
    assert.ok(site.data.items.some((i) => i.key === 'posts/photo.png'), 'next to its public files');
    const drafts = await call('GET', '/api/list?store=drafts&prefix=');
    assert.ok(!drafts.data.items.some((i) => i.key.includes('.published')), 'hidden from the drafts store');
    assert.equal((await call('GET', '/api/session')).data.privateSources, true);
  });

  test('Markdown published before is moved out of the public bucket', async () => {
    await env.SITE.put('posts/old-post.md', '---\ntitle: Old\ndate: 2026-01-01\n---\n\nOld.\n');
    assert.equal(await read('site', 'posts/old-post.md'), '---\ntitle: Old\ndate: 2026-01-01\n---\n\nOld.\n', 'still readable before the move');
    const r = await postJson('/api/site/private-sources', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.moved, ['posts/old-post.md']);
    assert.equal(await env.SITE.head('posts/old-post.md'), null);
    assert.match(await read('site', 'posts/old-post.md'), /title: Old/);
    assert.deepEqual((await postJson('/api/site/private-sources', {})).data.moved, [], 'nothing left to move');
    // Updating a post whose Markdown was still public moves it too.
    await env.SITE.put('posts/old-two.md', 'two');
    const etag = (await env.SITE.head('posts/old-two.md')).etag;
    assert.equal((await put('site', 'posts/old-two.md', 'two!', { 'if-match': `"${etag}"` })).status, 200);
    assert.equal(await env.SITE.head('posts/old-two.md'), null);
    assert.equal(await read('site', 'posts/old-two.md'), 'two!');
    assert.equal((await call('DELETE', '/api/file?store=site&key=posts/old-post.md')).status, 204);
    assert.equal(await read('site', 'posts/old-post.md'), null);
  });

  test("without a private bucket, a post's Markdown is refused rather than made public", async () => {
    const bare = { ...env, DRAFTS: undefined, SOURCES: undefined, DRAFT_STORES: undefined };
    const r = await call('PUT', '/api/file?store=site&key=posts/no-private.md', {
      body: '---\ntitle: Draft text\n---\n', headers: { 'if-none-match': '*' }, environment: bare,
    });
    assert.equal(r.status, 500);
    assert.match(r.data.error, /never written to the public bucket/);
    assert.equal(await env.SITE.head('posts/no-private.md'), null);
    const page = await call('PUT', '/api/file?store=site&key=posts/no-private.png', { body: 'PNG', headers: { 'if-none-match': '*' }, environment: bare });
    assert.equal(page.status, 201, 'other files are written as usual');
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

describe('large uploads', () => {
  test('the limit comes from the settings; large files stream into and between R2 buckets', async () => {
    const index = await read('site', 'index.json');
    await put('site', 'index.json', JSON.stringify({ version: 1, site: { title: 'T', maxUploadMb: 12 }, items: [] }));
    assert.equal((await call('GET', '/api/session')).data.maxUploadMb, 12, 'the settings raise the deploy\'s 1 MB');
    const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251);
    const r = await create('drafts', 'posts/big-paper.pdf', big);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.size, big.length);
    const copied = await postJson('/api/copy', { from: { store: 'drafts', key: 'posts/big-paper.pdf' } });
    assert.equal(copied.status, 201, JSON.stringify(copied.data));
    const back = await call('GET', '/api/file?store=site&key=posts%2Fbig-paper.pdf');
    assert.equal(back.status, 200);
    // Identical by R2's etags (MD5) or a streamed digest; this test's R2 stand-in has neither, so it asks.
    const again = await postJson('/api/copy', { from: { store: 'drafts', key: 'posts/big-paper.pdf' } });
    assert.ok(again.data.action === 'identical' || again.data.code === 'exists', JSON.stringify(again.data));
    const tooBig = await create('drafts', 'posts/huge.pdf', new Uint8Array(13 * 1024 * 1024));
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.data.error ?? JSON.stringify(tooBig.data), /12 MB/);
    await put('site', 'index.json', typeof index === 'string' ? index : JSON.stringify(index ?? { version: 1, items: [] }));
  });
});
