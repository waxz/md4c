// The admin file API. Every route needs a verified Access identity (see
// worker.js); every write is checked here, on the server:
//
//   GET    /api/session                       who is signed in, bucket info
//   GET    /api/list?bucket=&prefix=&cursor=  objects (flat; the UI builds folders)
//   GET    /api/file?bucket=&key=             object body
//   PUT    /api/file?bucket=&key=             write; If-None-Match: * creates,
//                                             If-Match: <etag> updates
//   DELETE /api/file?bucket=&key=             delete; If-Match optional
//   POST   /api/move  {from, to, ifMatch}     move/rename/publish/unpublish
//   POST   /api/indexnow {urls}               notify IndexNow search engines
//
// Conflicts refused with 409 (code in the JSON body):
//   exists           the destination already exists
//   folder-exists    a "folder" (key prefix) already uses that name
//   file-in-path     a file already uses one of the parent folder names
//   published-exists a draft would shadow a published post with that slug
//   draft-exists     a new published post would collide with a draft
// and with 412 "changed" when If-Match no longer matches, 428 when a content
// write does not say whether it creates or updates.

import { cacheControlFor, classify, contentTypeFor, keyProblem, postSlug } from './paths.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

function bucketOf(env, name) {
  if (name === 'site') return env.SITE;
  if (name === 'drafts') {
    if (!env.DRAFTS) throw new ApiError(404, 'No drafts bucket is configured', { code: 'no-drafts' });
    return env.DRAFTS;
  }
  throw new ApiError(400, 'bucket must be "site" or "drafts"');
}

function stripQuotes(etag) {
  return String(etag ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function objectInfo(bucketName, obj) {
  return {
    bucket: bucketName,
    key: obj.key,
    size: obj.size,
    etag: obj.etag,
    uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded,
    contentType: obj.httpMetadata?.contentType ?? contentTypeFor(obj.key),
    kind: classify(bucketName, obj.key),
  };
}

function requireKey(key) {
  const problem = keyProblem(key);
  if (problem) throw new ApiError(400, problem, { code: 'bad-path' });
  return key;
}

function requireWritable(bucketName, key) {
  const kind = classify(bucketName, requireKey(key));
  if (kind === 'locked') {
    throw new ApiError(403, bucketName === 'drafts'
      ? 'Drafts can only be posts/<slug>.md'
      : `${key} is not editable here: posts go in posts/<slug>.md, files in posts/ or assets/; the site's code is deployed with publish.mjs --site`,
    { code: 'locked' });
  }
  return kind;
}

/**
 * Refuse a new object at `key` that would clash with what is already there.
 * `ignore` = { bucket, key } being moved away, which may share the slug.
 */
async function checkNewKey(env, bucketName, key, ignore) {
  const bucket = bucketOf(env, bucketName);
  if (await bucket.head(key)) {
    throw new ApiError(409, `${key} already exists`, { code: 'exists' });
  }
  const below = await bucket.list({ prefix: `${key}/`, limit: 1 });
  if (below.objects.length || below.delimitedPrefixes?.length) {
    throw new ApiError(409, `A folder named ${key} already exists`, { code: 'folder-exists' });
  }
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (await bucket.head(parent)) {
      throw new ApiError(409, `${parent} is a file, so it cannot be a folder`, { code: 'file-in-path' });
    }
  }
  const slug = postSlug(key);
  if (slug) {
    const other = bucketName === 'site' ? 'drafts' : 'site';
    const otherBucket = other === 'drafts' ? env.DRAFTS : env.SITE;
    const movingFromThere = ignore && ignore.bucket === other && ignore.key === key;
    if (otherBucket && !movingFromThere && (await otherBucket.head(key))) {
      throw new ApiError(409, other === 'site'
        ? `A published post already uses the slug "${slug}"`
        : `A draft already uses the slug "${slug}"; publish or delete it instead`,
      { code: other === 'site' ? 'published-exists' : 'draft-exists' });
    }
  }
}

async function readBody(request, env) {
  const limit = Number(env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024;
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) throw new ApiError(413, `Files are limited to ${env.MAX_UPLOAD_MB ?? 25} MB`);
  const body = await request.arrayBuffer();
  if (body.byteLength > limit) throw new ApiError(413, `Files are limited to ${env.MAX_UPLOAD_MB ?? 25} MB`);
  return body;
}

async function putObject(bucket, key, body, etagMatches) {
  return bucket.put(key, body, {
    httpMetadata: { contentType: contentTypeFor(key), cacheControl: cacheControlFor(key) },
    ...(etagMatches ? { onlyIf: { etagMatches } } : {}),
  });
}

async function writeFile(request, env, bucketName, key) {
  const kind = requireWritable(bucketName, key);
  const bucket = bucketOf(env, bucketName);
  const ifMatch = request.headers.get('if-match');
  const ifNoneMatch = request.headers.get('if-none-match');
  const body = await readBody(request, env);

  if (ifNoneMatch === '*') {
    await checkNewKey(env, bucketName, key);
    const obj = await putObject(bucket, key, body);
    return json(objectInfo(bucketName, obj), 201);
  }
  if (ifMatch) {
    const expected = stripQuotes(ifMatch);
    const obj = await putObject(bucket, key, body, expected);
    if (!obj) {
      const current = await bucket.head(key);
      throw new ApiError(412, current
        ? `${key} was changed elsewhere since you opened it`
        : `${key} was deleted elsewhere since you opened it`,
      { code: 'changed', current: current ? objectInfo(bucketName, current) : null });
    }
    return json(objectInfo(bucketName, obj));
  }
  if (kind !== 'generated') {
    throw new ApiError(428, 'Say whether this creates (If-None-Match: *) or updates (If-Match: <etag>) the file',
      { code: 'precondition-required' });
  }
  const obj = await putObject(bucket, key, body);
  return json(objectInfo(bucketName, obj));
}

async function deleteFile(request, env, bucketName, key) {
  requireWritable(bucketName, key);
  const bucket = bucketOf(env, bucketName);
  const current = await bucket.head(key);
  if (!current) throw new ApiError(404, `${key} not found`, { code: 'not-found' });
  const ifMatch = request.headers.get('if-match');
  if (ifMatch && stripQuotes(ifMatch) !== current.etag) {
    throw new ApiError(412, `${key} was changed elsewhere since you opened it`,
      { code: 'changed', current: objectInfo(bucketName, current) });
  }
  await bucket.delete(key);
  return new Response(null, { status: 204 });
}

async function moveFile(request, env) {
  const { from, to, ifMatch } = await request.json().catch(() => ({}));
  if (!from || !to || typeof from.key !== 'string' || typeof to.key !== 'string') {
    throw new ApiError(400, 'Body must be { from: {bucket, key}, to: {bucket, key} }');
  }
  const fromKind = requireWritable(from.bucket, from.key);
  const toKind = requireWritable(to.bucket, to.key);
  if (fromKind === 'generated' || toKind === 'generated') {
    throw new ApiError(403, 'Generated files are rebuilt, not moved', { code: 'locked' });
  }
  if ((postSlug(from.key) !== null) !== (postSlug(to.key) !== null)) {
    throw new ApiError(400, 'A post (posts/<slug>.md) can only move to another post path', { code: 'bad-path' });
  }
  if (from.bucket === to.bucket && from.key === to.key) throw new ApiError(400, 'Source and destination are the same');

  const src = bucketOf(env, from.bucket);
  const dst = bucketOf(env, to.bucket);
  const obj = await src.get(from.key);
  if (!obj) throw new ApiError(404, `${from.key} not found`, { code: 'not-found' });
  if (ifMatch && stripQuotes(ifMatch) !== obj.etag) {
    throw new ApiError(412, `${from.key} was changed elsewhere since you opened it`,
      { code: 'changed', current: objectInfo(from.bucket, obj) });
  }
  await checkNewKey(env, to.bucket, to.key, from);
  const body = await obj.arrayBuffer();
  const written = await putObject(dst, to.key, body);
  await src.delete(from.key);
  return json(objectInfo(to.bucket, written));
}

async function listFiles(env, url) {
  const bucketName = url.searchParams.get('bucket') ?? 'site';
  const bucket = bucketOf(env, bucketName);
  const prefix = url.searchParams.get('prefix') ?? '';
  const cursor = url.searchParams.get('cursor') || undefined;
  const page = await bucket.list({ prefix, cursor, limit: 1000, include: ['httpMetadata'] });
  return json({
    items: page.objects.map((o) => objectInfo(bucketName, o)),
    ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
  });
}

async function readFile(env, url) {
  const bucketName = url.searchParams.get('bucket') ?? 'site';
  const key = requireKey(url.searchParams.get('key'));
  const obj = await bucketOf(env, bucketName).get(key);
  if (!obj) throw new ApiError(404, `${key} not found`, { code: 'not-found' });
  const type = contentTypeFor(key);
  return new Response(obj.body, {
    headers: {
      // HTML and XML are shown as text in the admin, never run in its origin.
      'content-type': /^(text\/html|application\/xml)/.test(type) ? 'text/plain; charset=utf-8' : type,
      etag: obj.httpEtag ?? `"${obj.etag}"`,
      'x-object-etag': obj.etag,
    },
  });
}

async function indexNow(request, env) {
  const { urls } = await request.json().catch(() => ({}));
  const indexObj = await env.SITE.get('index.json');
  const site = indexObj ? (await indexObj.json().catch(() => ({}))).site ?? {} : {};
  const base = String(site.url ?? '').replace(/\/?$/, '/');
  const key = String(site.indexNowKey ?? '');
  if (!/^https?:\/\//.test(base) || !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new ApiError(400, 'Set "url" and "indexNowKey" in the site settings first');
  }
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u.startsWith(base)).slice(0, 1000);
  if (!list.length) throw new ApiError(400, 'No URLs of this site to submit');
  if (!(await env.SITE.head(`${key}.txt`))) {
    await env.SITE.put(`${key}.txt`, key, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  }
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(base).host, key, keyLocation: `${base}${key}.txt`, urlList: list }),
  });
  return json({ status: res.status, submitted: list.length }, res.ok ? 200 : 502);
}

/** Route an /api request. `user` is the verified Access identity. */
export async function handleApi(request, env, user) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // CSRF: a cross-site page cannot add this header, and browsers mark
      // cross-site requests in Sec-Fetch-Site / Origin.
      const site = request.headers.get('sec-fetch-site');
      const origin = request.headers.get('origin');
      if (request.headers.get('x-admin-request') !== '1' || (site && site !== 'same-origin') ||
          (origin && origin !== url.origin)) {
        throw new ApiError(403, 'Cross-site request refused', { code: 'csrf' });
      }
    }
    switch (route) {
      case 'GET /api/session':
        return json({
          email: user.email,
          publicUrl: String(env.PUBLIC_URL ?? ''),
          drafts: Boolean(env.DRAFTS),
          maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 25),
        });
      case 'GET /api/list':
        return await listFiles(env, url);
      case 'GET /api/file':
        return await readFile(env, url);
      case 'PUT /api/file':
        return await writeFile(request, env, url.searchParams.get('bucket') ?? 'site', url.searchParams.get('key'));
      case 'DELETE /api/file':
        return await deleteFile(request, env, url.searchParams.get('bucket') ?? 'site', url.searchParams.get('key'));
      case 'POST /api/move':
        return await moveFile(request, env);
      case 'POST /api/indexnow':
        return await indexNow(request, env);
      default:
        throw new ApiError(404, 'No such API route');
    }
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message, ...err.extra }, err.status);
    console.error(err);
    return json({ error: 'Internal error' }, 500);
  }
}
