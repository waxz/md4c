#!/usr/bin/env node
// Local development server for the admin. NOT for production.
//
//   npm run build && npm run admin:dev
//   admin:  http://127.0.0.1:8787/   (the real Worker, running in Node)
//   blog:   http://127.0.0.1:8788/index.html  (dist/public, the "bucket")
//
// It stands in for Cloudflare: R2 buckets are folders (dist/public for the
// site, dist/drafts for drafts), the SETTINGS KV namespace is
// dist/kv-settings.json, a second draft store is an embedded WebDAV server
// (files in dist/webdav, user "dev", password "dev-password"), and
// Cloudflare Access is simulated by signing an Access-style JWT for every
// request, so the Worker's real token check runs. Because of that, anyone who can reach the port is "signed in": the
// server only listens on 127.0.0.1.

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { v2 as webdav } from 'webdav-server';
import worker from '../src/worker.js';
import { kvNamespace } from './kv-shim.mjs';
import { r2Bucket } from './r2-shim.mjs';
import { normalizeStore, readSaved, writeSaved } from '../src/stores.js';
import { cacheControlFor } from '../src/paths.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dist = join(root, 'dist');
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8787);
const BLOG_PORT = Number(process.env.BLOG_PORT ?? 8788);
const HOST = '127.0.0.1';
const team = `http://${HOST}:${ADMIN_PORT}`;
const EMAIL = process.env.ADMIN_EMAIL ?? 'owner@example.com';
const DAV_PORT = Number(process.env.DAV_PORT ?? 8789);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

async function fileResponse(dir, pathname) {
  const file = normalize(join(dir, decodeURIComponent(pathname)));
  if (!file.startsWith(dir + sep) && file !== dir) return new Response('Forbidden', { status: 403 });
  try {
    let path = file;
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    return new Response(await readFile(path), { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

await mkdir(join(dist, 'public'), { recursive: true });
await mkdir(join(dist, 'drafts'), { recursive: true });
await mkdir(join(dist, 'webdav', 'blog-drafts'), { recursive: true });

// A WebDAV share standing in for a NAS / Nextcloud draft store.
const davUsers = new webdav.SimpleUserManager();
const davUser = davUsers.addUser('dev', 'dev-password', false);
const davRights = new webdav.SimplePathPrivilegeManager();
davRights.setRights(davUser, '/', ['all']);
const dav = new webdav.WebDAVServer({
  port: DAV_PORT, hostname: HOST, privilegeManager: davRights,
  httpAuthentication: new webdav.HTTPBasicAuthentication(davUsers, 'dev'),
});
await new Promise((r) => dav.setFileSystem('/', new webdav.PhysicalFileSystem(join(dist, 'webdav')), () => r()));
await new Promise((r) => dav.start(r));
const keys = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'dev', alg: 'RS256', use: 'sig' };
const env = {
  SITE: r2Bucket(dist, 'public'),
  DRAFTS: r2Bucket(dist, 'drafts'),
  SETTINGS: kvNamespace(join(dist, 'kv-settings.json')),
  ASSETS: { fetch: (req) => cloudflareAssets(join(dist, 'admin'), new URL(req.url)) },
  ACCESS_TEAM_DOMAIN: team,
  ACCESS_AUD: 'local-dev',
  ADMIN_EMAILS: EMAIL,
  PUBLIC_URL: `http://${HOST}:${BLOG_PORT}/`,
  MAX_UPLOAD_MB: '100',
};

/**
 * Static files as Cloudflare Workers Assets serves them by default
 * (html_handling "auto-trailing-slash"): /page.html redirects to /page,
 * which serves page.html; /index.html redirects to /.
 */
async function cloudflareAssets(dir, url) {
  const m = /^(.*\/)([^/]+)\.html$/.exec(url.pathname);
  if (m) {
    const to = m[2] === 'index' ? m[1] : `${m[1]}${m[2]}`;
    return new Response(null, { status: 307, headers: { location: `${to}${url.search}` } });
  }
  if (!/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith('/')) {
    const html = await fileResponse(dir, `${url.pathname}.html`);
    if (html.status === 200) return html;
  }
  return fileResponse(dir, url.pathname);
}

// The WebDAV share is added the way you would add yours: as a store saved
// in KV (what the admin's Storage page writes), on the first start only.
if (!(await readSaved(env)).version) {
  await writeSaved(env, [normalizeStore({ id: 'nas', label: 'NAS (WebDAV)', type: 'webdav', baseUrl: `http://${HOST}:${DAV_PORT}`,
    root: '/', folder: 'blog-drafts', username: 'dev', secrets: { password: 'dev-password' } })], 0);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

// To try the admin signed out: GET /__dev/signout makes every request
// answer as Cloudflare Access does for an expired session (a redirect to its
// login page on another origin) until GET /__dev/signin.
let signedOut = false;

createServer(async (req, res) => {
  if (req.url === '/__dev/signout' || req.url === '/__dev/signin') {
    signedOut = req.url === '/__dev/signout';
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(signedOut ? 'signed out' : 'signed in');
    return;
  }
  if (signedOut && !new URL(req.url, 'http://x').searchParams.has('signin')) {
    // Another origin, as Access's login page is (fetch cannot follow it there).
    res.writeHead(302, { location: `http://localhost:${BLOG_PORT}/cdn-cgi/access/login` });
    res.end();
    return;
  }
  if (req.url === '/cdn-cgi/access/certs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  // What Cloudflare Access would add after the owner signs in.
  const token = await new SignJWT({ email: EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
    .setIssuer(team).setAudience('local-dev').setIssuedAt().setExpirationTime('10m')
    .sign(keys.privateKey);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-access-jwt-assertion', token);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const response = await worker.fetch(new Request(`${team}${req.url}`, { method: req.method, headers, body }), env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(ADMIN_PORT, HOST, () => console.log(`Admin (dev, auto sign-in as ${EMAIL}): http://${HOST}:${ADMIN_PORT}/`));

createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const response = await fileResponse(join(dist, 'public'), pathname);
  // Cache headers as R2 serves them, so stale-page problems show up here too.
  const key = pathname.replace(/^\//, '') || 'index.html';
  if (response.ok) response.headers.set('cache-control', cacheControlFor(key));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(BLOG_PORT, HOST, () => console.log(`Blog (dist/public): http://${HOST}:${BLOG_PORT}/index.html`));
