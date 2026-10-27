// Blog admin Worker: serves the admin app and its file API on the admin
// hostname, behind Cloudflare Access. Readers never reach it; they read the
// public R2 bucket directly.

import { AuthError, verifyAccess } from './access.js';
import { handleApi, servePrivateBlog } from './api.js';

/** The admin pages' CSP; images may also come from the public blog (previews). */
function pageCsp(env) {
  let blog = '';
  try {
    blog = env.PUBLIC_URL ? ` ${new URL(env.PUBLIC_URL).origin}` : '';
  } catch {}
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    `img-src 'self' blob: data:${blog}`,
    `media-src 'self'${blog}`,
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // The editor frames its own preview page; nothing else may frame the admin.
    "frame-ancestors 'self'",
  ].join('; ');
}

// API responses are data: never rendered as a document in the admin origin.
const API_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

function withHeaders(response, extra) {
  const res = new Response(response.body, response);
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('cross-origin-opener-policy', 'same-origin');
  res.headers.set('permissions-policy', 'geolocation=(), microphone=()');
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
  return res;
}

export default {
  async fetch(request, env) {
    let user;
    try {
      user = await verifyAccess(request, env);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 500;
      return withHeaders(new Response(err.message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
        { 'cache-control': 'no-store' });
    }
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return withHeaders(await handleApi(request, env, user),
        { 'content-security-policy': API_CSP, 'cache-control': 'no-store' });
    }
    if (url.pathname === '/blog') return Response.redirect(new URL('/blog/', url).href, 301);
    if (url.pathname.startsWith('/blog/')) {
      // The private blog: never indexed, never cached by a shared cache.
      return withHeaders(await servePrivateBlog(request, env), {
        'content-security-policy': pageCsp(env), 'cache-control': 'private, no-cache', 'x-robots-tag': 'noindex, nofollow',
      });
    }
    return withHeaders(await env.ASSETS.fetch(request),
      { 'content-security-policy': pageCsp(env), 'cache-control': 'no-cache' });
  },
};
