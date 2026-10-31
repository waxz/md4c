// Cloudflare Access authentication.
//
// Access sits in front of the admin hostname and only lets the owner
// through. Every request it forwards carries a signed JWT in the
// Cf-Access-Jwt-Assertion header; the Worker verifies it (signature against
// the team's rotating public keys, issuer, audience, expiry) so that a
// request reaching the Worker any other way, such as a forgotten
// *.workers.dev route, is still refused.
//
// Environment:
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   ACCESS_AUD          the Access application's Audience (AUD) tag
//   ADMIN_EMAILS        optional comma-separated allowlist, checked in
//                       addition to the Access policy

import { createRemoteJWKSet, jwtVerify } from 'jose';

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const jwksCache = new Map();

function teamDomain(env) {
  return String(env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
}

/** Verify the Access JWT on `request`; returns { email }. Throws AuthError. */
export async function verifyAccess(request, env) {
  const team = teamDomain(env);
  const aud = String(env.ACCESS_AUD ?? '').trim();
  if (!team || !aud) throw new AuthError(500, 'Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD');

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new AuthError(401, 'Not signed in through Cloudflare Access');

  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: team,
      audience: aud,
      algorithms: ['RS256'],
      clockTolerance: 30,
    }));
  } catch {
    throw new AuthError(403, 'Invalid or expired Access token');
  }

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  const allowed = String(env.ADMIN_EMAILS ?? '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    throw new AuthError(403, 'This account is not an admin of this blog');
  }
  return { email };
}
