// Blog admin Worker: serves the admin app and its file API on the admin
// hostname, behind Cloudflare Access. Readers never reach it; they read the
// public R2 bucket directly.

import { AuthError, verifyAccess } from './access.js';
import { handleApi } from './api.js';

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

// The host of a post's illustrations (embed.html, ```embed blocks): framed
// sandboxed, without the admin's origin, so its scripts (inline, or from a
// CDN) run cut off from the admin. As the page's own meta policy.
const EMBED_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; "
  + "style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; "
  + "font-src 'self' https: data:; connect-src 'self' https: data: blob:; worker-src 'self' blob: https:; "
  + "form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

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
    // A file asked for with its content hash (?v=…, see version-assets.mjs)
    // never changes at that address: the browser keeps it, so a page loads
    // its modules without a round trip each. Pages and plain addresses are
    // checked every time.
    const res = await env.ASSETS.fetch(request);
    const embed = url.pathname === '/embed' || url.pathname === '/embed.html';
    return withHeaders(res, {
      'content-security-policy': embed ? EMBED_CSP : pageCsp(env),
      'cache-control': res.status === 200 && url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-cache',
    });
  },
};
