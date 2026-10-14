// HTTP layer of the blog server.
//
// Access rules, enforced here on the server (the browser UI only mirrors
// them; hiding a button is not a security boundary):
//
//   anyone       GET  published posts:  posts/<slug>.md
//   admin only   GET  drafts:           drafts/<slug>.md
//   admin only   PUT / DELETE / move    anything
//
// Content is stored through storagesdk; any adapter works, the default
// server uses the filesystem adapter.
//
// API (all JSON unless noted):
//   GET    /api/session                -> { admin, csrfToken? }
//   POST   /api/login   { password }   -> sets the session cookie
//   POST   /api/logout
//   GET    /api/files?prefix=&cursor=&limit=
//   GET    /api/files/<path>           -> raw file body
//   GET    /api/files/<path>?meta      -> file metadata
//   PUT    /api/files/<path>           raw body, x-storage-metadata header
//   DELETE /api/files/<path>
//   POST   /api/move    { from, to }
// Mutating requests from the admin must carry the x-csrf-token header.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { StorageError } from '@storagesdk/core';
import { LoginLimiter, Sessions, safeEqual, verifyPassword } from './auth.mjs';

const MAX_POST_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_META_BYTES = 4 * 1024;
const META_KEYS = new Set(['title', 'date', 'tags', 'excerpt']);
const COOKIE = 'blog_session';

// posts/<slug>.md or drafts/<slug>.md, nothing else can be stored.
const FILE_RE = /^(posts|drafts)\/([a-z0-9][a-z0-9-]{0,79})\.md$/;
const PUBLIC_PREFIX = 'posts/';

export const PAGE_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' allows compiling md4c.wasm, nothing else.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// API responses are data, never documents: forbid everything.
const API_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function baseHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, baseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-security-policy': API_CSP,
    'cache-control': 'no-store',
    ...extra,
  }));
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, 'request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'expected application/json');
  try {
    return JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'invalid JSON');
  }
}

function checkPath(path) {
  if (typeof path !== 'string' || !FILE_RE.test(path))
    throw new HttpError(400, 'invalid path: expected posts/<slug>.md or drafts/<slug>.md');
  return path;
}

function parseMetadata(header) {
  if (header === undefined) return undefined;
  if (header.length > MAX_META_BYTES) throw new HttpError(413, 'metadata too large');
  let meta;
  try {
    meta = JSON.parse(decodeURIComponent(header));
  } catch {
    throw new HttpError(400, 'invalid x-storage-metadata');
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
    throw new HttpError(400, 'invalid x-storage-metadata');
  for (const [k, v] of Object.entries(meta)) {
    if (!META_KEYS.has(k) || typeof v !== 'string')
      throw new HttpError(400, `metadata key not allowed: ${k}`);
  }
  return meta;
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** The same slug under the other prefix: posts/x.md <-> drafts/x.md. */
function twinPath(path) {
  return path.startsWith('posts/') ? `drafts/${path.slice(6)}` : `posts/${path.slice(7)}`;
}

function toJsonMeta(m) {
  return {
    path: m.path,
    size: m.size,
    contentType: m.contentType,
    etag: m.etag,
    lastModified: m.lastModified.toISOString(),
    ...(m.metadata ? { metadata: m.metadata } : {}),
  };
}

/**
 * @param {{ storage: import('@storagesdk/core').Storage,
 *           staticDir: string,
 *           adminFile: () => Promise<object|null>,
 *           secureCookies?: boolean,
 *           trustProxy?: boolean }} opts
 */
export function createApp(opts) {
  const { storage } = opts;
  const staticDir = resolve(opts.staticDir);
  const sessions = new Sessions();
  const limiter = new LoginLimiter();

  function clientKey(req) {
    if (opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string') return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function sessionCookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
      (opts.secureCookies ? '; Secure' : '');
  }

  function getSession(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const s = sessions.get(id);
    return s ? { id, ...s } : null;
  }

  /** Admin session plus CSRF token plus same-origin check, or throw. */
  function requireAdminWrite(req) {
    const s = getSession(req);
    if (!s) throw new HttpError(401, 'admin login required');
    if (!safeEqual(req.headers['x-csrf-token'], s.csrfToken))
      throw new HttpError(403, 'missing or invalid CSRF token');
    const origin = req.headers.origin;
    if (origin !== undefined && originHost(origin) !== req.headers.host)
      throw new HttpError(403, 'cross-origin request refused');
    return s;
  }

  /** Guests may only see published posts; hide everything else as 404. */
  function canRead(req, path) {
    return path.startsWith(PUBLIC_PREFIX) || getSession(req) !== null;
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.slice('/api'.length);

    if (route === '/session' && req.method === 'GET') {
      const s = getSession(req);
      return sendJson(res, 200, s ? { admin: true, csrfToken: s.csrfToken } : { admin: false });
    }

    if (route === '/login' && req.method === 'POST') {
      const key = clientKey(req);
      if (limiter.isBlocked(key))
        throw new HttpError(429, 'too many failed logins, try again later');
      const { password } = await readJson(req);
      const record = await opts.adminFile();
      if (!record) throw new HttpError(503, 'no admin password configured on the server');
      if (!(await verifyPassword(password, record))) {
        limiter.fail(key);
        throw new HttpError(401, 'wrong password');
      }
      limiter.succeed(key);
      const s = sessions.create();
      return sendJson(res, 200, { admin: true, csrfToken: s.csrfToken }, {
        'set-cookie': sessionCookie(s.id, Math.floor((s.expires - Date.now()) / 1000)),
      });
    }

    if (route === '/logout' && req.method === 'POST') {
      const s = requireAdminWrite(req);
      sessions.destroy(s.id);
      return sendJson(res, 200, { admin: false }, { 'set-cookie': sessionCookie('', 0) });
    }

    if (route === '/move' && req.method === 'POST') {
      requireAdminWrite(req);
      const { from, to } = await readJson(req);
      checkPath(from);
      checkPath(to);
      if (from !== to && (await exists(to))) throw new HttpError(409, `${to} already exists`);
      if (twinPath(from) !== to && (await exists(twinPath(to))))
        throw new HttpError(409, `${twinPath(to)} already exists`);
      await storage.move(from, to);
      return sendJson(res, 200, toJsonMeta(await storage.head(to)));
    }

    if (route === '/files' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      if (!prefix.startsWith(PUBLIC_PREFIX) && !getSession(req))
        throw new HttpError(403, 'guests may only list posts/');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const page = await storage.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
      // The fs adapter's list() omits metadata; head each file to include it.
      const items = await Promise.all(
        page.items.filter((m) => FILE_RE.test(m.path)).map((m) => storage.head(m.path))
      );
      return sendJson(res, 200, {
        items: items.map(toJsonMeta),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    }

    if (route.startsWith('/files/')) {
      const path = checkPath(decodeURIComponent(route.slice('/files/'.length)));

      if (req.method === 'GET') {
        if (!canRead(req, path)) throw new HttpError(404, 'not found');
        if (url.searchParams.has('meta'))
          return sendJson(res, 200, toJsonMeta(await storage.head(path)));
        const item = await storage.download(path);
        res.writeHead(200, baseHeaders({
          // Served as plain text: a stored file can never render as a page.
          'content-type': 'text/plain; charset=utf-8',
          'content-security-policy': API_CSP,
          'cache-control': 'no-store',
          etag: `"${item.etag}"`,
          'last-modified': item.lastModified.toUTCString(),
          ...(item.metadata
            ? { 'x-storage-metadata': encodeURIComponent(JSON.stringify(item.metadata)) }
            : {}),
        }));
        return res.end(Buffer.from(item.body));
      }

      if (req.method === 'PUT') {
        requireAdminWrite(req);
        if (await exists(twinPath(path)))
          throw new HttpError(409, `${twinPath(path)} already exists`);
        const metadata = parseMetadata(req.headers['x-storage-metadata']);
        const body = await readBody(req, MAX_POST_BYTES);
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          throw new HttpError(400, 'post must be UTF-8 text');
        }
        const meta = await storage.upload(path, body, {
          contentType: 'text/markdown; charset=utf-8',
          ...(metadata ? { metadata } : {}),
        });
        return sendJson(res, 200, toJsonMeta(meta));
      }

      if (req.method === 'DELETE') {
        requireAdminWrite(req);
        await storage.delete(path);
        return sendJson(res, 204);
      }
    }

    throw new HttpError(404, 'no such API route');
  }

  async function exists(path) {
    try {
      await storage.head(path);
      return true;
    } catch (err) {
      if (err instanceof StorageError && err.code === 'NotFound') return false;
      throw err;
    }
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(staticDir, rel);
    if (file !== staticDir && !file.startsWith(staticDir + sep)) throw new HttpError(404, 'not found');
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      await stat(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, baseHeaders({
      'content-type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': PAGE_CSP,
      'cache-control': 'no-cache',
    }));
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      let status = err instanceof HttpError ? err.status : 500;
      let message = err instanceof HttpError ? err.message : 'internal error';
      if (err instanceof StorageError) {
        status = { NotFound: 404, InvalidArgument: 400, Conflict: 409 }[err.code] ?? 500;
        message = status === 500 ? 'storage error' : err.message;
      }
      if (err instanceof URIError) {
        status = 400;
        message = 'bad URL encoding';
      }
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: message });
    }
  };
}
