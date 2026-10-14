// Admin authentication: one owner account protected by a scrypt password
// hash, in-memory sessions with a CSRF token, and login rate limiting.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// 16 MiB of memory per hash: expensive to brute force, cheap for one login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, keylen, { N, r, p });
  return {
    algorithm: 'scrypt',
    N, r, p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

export async function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt' || typeof password !== 'string')
    return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scrypt(password, Buffer.from(record.salt, 'base64'),
    expected.length, { N: record.N, r: record.r, p: record.p, maxmem: 256 * record.N * record.r });
  return timingSafeEqual(actual, expected);
}

export async function readAdminRecord(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeAdminRecord(file, record) {
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** In-memory session store. Restarting the server logs the admin out. */
export class Sessions {
  #sessions = new Map();

  create() {
    const id = randomBytes(32).toString('base64url');
    const session = {
      csrfToken: randomBytes(32).toString('base64url'),
      expires: Date.now() + SESSION_TTL_MS,
    };
    this.#sessions.set(id, session);
    return { id, ...session };
  }

  get(id) {
    if (typeof id !== 'string') return null;
    const s = this.#sessions.get(id);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return s;
  }

  destroy(id) {
    this.#sessions.delete(id);
  }
}

/** Counts failed logins per client and locks it out after too many. */
export class LoginLimiter {
  #failures = new Map();

  isBlocked(key) {
    const f = this.#failures.get(key);
    if (!f) return false;
    if (f.since + FAILURE_WINDOW_MS < Date.now()) {
      this.#failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  fail(key) {
    const f = this.#failures.get(key);
    if (!f || f.since + FAILURE_WINDOW_MS < Date.now())
      this.#failures.set(key, { count: 1, since: Date.now() });
    else f.count += 1;
  }

  succeed(key) {
    this.#failures.delete(key);
  }
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
