// Admin Worker: Access authentication, CSRF defence, path rules and
// conflict checks. Runs the real Worker in Node against R2 stand-ins
// (admin/dev/r2-shim.mjs) and a local Access-style JWKS endpoint.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../admin/src/worker.js';
import { r2Bucket } from '../admin/dev/r2-shim.mjs';

const AUD = 'test-aud';
let dir;
let env;
let team;
let jwksServer;
let key;
let otherKey;

async function token({ email = 'owner@example.com', aud = AUD, iss = team, exp = '5m', signer = key } = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: signer === key ? 'k1' : 'k2' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(signer.privateKey);
}

async function call(method, path, { body, headers = {}, auth = {} } = {}) {
  const h = new Headers(headers);
  if (auth !== null) h.set('cf-access-jwt-assertion', await token(auth));
  if (method !== 'GET' && !h.has('x-admin-request')) h.set('x-admin-request', '1');
  const res = await worker.fetch(new Request(`https://admin.test${path}`, { method, headers: h, body }), env);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const put = (bucket, k, body, headers) => call('PUT', `/api/file?bucket=${bucket}&key=${encodeURIComponent(k)}`, { body, headers });
const create = (bucket, k, body = 'x') => put(bucket, k, body, { 'if-none-match': '*' });
const move = (from, to, ifMatch) => call('POST', '/api/move', {
  body: JSON.stringify({ from, to, ifMatch }), headers: { 'content-type': 'application/json' },
});

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
  env = {
    SITE: r2Bucket(dir, 'site'),
    DRAFTS: r2Bucket(dir, 'drafts'),
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
  await rm(dir, { recursive: true, force: true });
});

describe('Cloudflare Access', () => {
  test('a valid token for an allowed admin is accepted', async () => {
    const r = await call('GET', '/api/session');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { email: 'owner@example.com', publicUrl: 'https://blog.example.com/', drafts: true, maxUploadMb: 1 });
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
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('CSRF defence', () => {
  test('writes need the admin header and a same-origin request', async () => {
    let r = await put('site', 'posts/csrf.md', 'x', { 'if-none-match': '*', 'x-admin-request': '0' });
    assert.equal(r.status, 403);
    r = await put('site', 'posts/csrf.md', 'x', { 'if-none-match': '*', origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await put('site', 'posts/csrf.md', 'x', { 'if-none-match': '*', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    assert.equal(await env.SITE.head('posts/csrf.md'), null);
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
    assert.equal((await create('drafts', 'assets/a.png')).status, 403, 'drafts hold posts only');
  });

  test('content types come from the extension, not the client', async () => {
    await put('site', 'assets/logo.svg', '<svg/>', { 'if-none-match': '*', 'content-type': 'text/html' });
    assert.equal((await env.SITE.head('assets/logo.svg')).httpMetadata.contentType, 'image/svg+xml');
  });

  test('reading HTML through the API returns text, inside a sandbox', async () => {
    await put('site', 'index.html', '<script>alert(1)</script>');
    const r = await call('GET', '/api/file?bucket=site&key=index.html');
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
  });

  test('uploads over the size limit are refused', async () => {
    assert.equal((await create('site', 'assets/big.png', new Uint8Array(2 * 1024 * 1024))).status, 413);
  });
});

describe('conflicts', () => {
  test('content writes must say create or update', async () => {
    const r = await put('site', 'posts/p1.md', 'x');
    assert.equal(r.status, 428);
    assert.equal((await put('site', 'index.json', '{}')).status, 200, 'generated files may be overwritten');
  });

  test('create refuses an existing file; update needs the current etag', async () => {
    const c = await create('site', 'posts/p1.md', 'one');
    assert.equal(c.status, 201);
    const again = await create('site', 'posts/p1.md', 'two');
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'exists');

    const stale = await put('site', 'posts/p1.md', 'two', { 'if-match': '"not-the-etag"' });
    assert.equal(stale.status, 412);
    assert.equal(stale.data.code, 'changed');
    assert.equal(stale.data.current.etag, c.data.etag);

    const ok = await put('site', 'posts/p1.md', 'two', { 'if-match': `"${c.data.etag}"` });
    assert.equal(ok.status, 200);
    assert.notEqual(ok.data.etag, c.data.etag);
    assert.equal(await (await env.SITE.get('posts/p1.md')).text(), 'two');
  });

  test('a file and a folder cannot share a name', async () => {
    assert.equal((await create('site', 'assets/a.png')).status, 201);
    const inPath = await create('site', 'assets/a.png/b.png');
    assert.equal(inPath.status, 409);
    assert.equal(inPath.data.code, 'file-in-path');
    assert.equal((await create('site', 'assets/set.png/x.png')).status, 201);
    const folder = await create('site', 'assets/set.png');
    assert.equal(folder.status, 409);
    assert.equal(folder.data.code, 'folder-exists');
  });

  test('a slug is either a draft or a published post, never both', async () => {
    assert.equal((await create('drafts', 'posts/d1.md')).status, 201);
    const pub = await create('site', 'posts/d1.md');
    assert.equal(pub.status, 409);
    assert.equal(pub.data.code, 'draft-exists');

    assert.equal((await create('site', 'posts/p2.md')).status, 201);
    const draft = await create('drafts', 'posts/p2.md');
    assert.equal(draft.status, 409);
    assert.equal(draft.data.code, 'published-exists');
  });

  test('publish and unpublish move between buckets with the same checks', async () => {
    const d = await call('GET', '/api/file?bucket=drafts&key=posts/d1.md');
    const etag = d.headers.get('x-object-etag');
    assert.equal((await move({ bucket: 'drafts', key: 'posts/d1.md' }, { bucket: 'site', key: 'posts/d1.md' }, '"stale"')).status, 412);
    const published = await move({ bucket: 'drafts', key: 'posts/d1.md' }, { bucket: 'site', key: 'posts/d1.md' }, etag);
    assert.equal(published.status, 200);
    assert.equal(await env.DRAFTS.head('posts/d1.md'), null, 'draft removed');
    assert.ok(await env.SITE.head('posts/d1.md'));

    const back = await move({ bucket: 'site', key: 'posts/d1.md' }, { bucket: 'drafts', key: 'posts/d1.md' });
    assert.equal(back.status, 200);

    const onto = await move({ bucket: 'site', key: 'posts/p1.md' }, { bucket: 'site', key: 'posts/p2.md' });
    assert.equal(onto.status, 409);
    assert.equal(onto.data.code, 'exists');
    const shadow = await move({ bucket: 'site', key: 'posts/p1.md' }, { bucket: 'site', key: 'posts/d1.md' });
    assert.equal(shadow.data.code, 'draft-exists', 'renaming onto a draft slug is refused');
    assert.equal((await move({ bucket: 'site', key: 'index.html' }, { bucket: 'site', key: 'posts/x.md' })).status, 403);
    assert.equal((await move({ bucket: 'site', key: 'posts/p1.md' }, { bucket: 'site', key: 'assets/p1.png' })).status, 400);
  });

  test('delete honours If-Match', async () => {
    assert.equal((await call('DELETE', '/api/file?bucket=site&key=posts/p2.md', { headers: { 'if-match': '"stale"' } })).status, 412);
    assert.equal((await call('DELETE', '/api/file?bucket=site&key=posts/p2.md')).status, 204);
    assert.equal((await call('DELETE', '/api/file?bucket=site&key=posts/p2.md')).status, 404);
    assert.equal((await call('DELETE', '/api/file?bucket=site&key=app.js')).status, 403);
  });

  test('listing reports each file\'s kind', async () => {
    const r = await call('GET', '/api/list?bucket=site');
    const kinds = Object.fromEntries(r.data.items.map((i) => [i.key, i.kind]));
    assert.equal(kinds['posts/p1.md'], 'content');
    assert.equal(kinds['assets/a.png'], 'asset');
    assert.equal(kinds['index.html'], 'generated');
  });
});
