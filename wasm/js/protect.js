// Password-protected posts.
//
// A post whose front matter has `password: …` is published encrypted. The
// public bucket never holds its text: posts/<slug>.md becomes an envelope
// with only the title, date, tags and author in the clear, plus the
// rendered article encrypted with the password:
//
//   key = PBKDF2-SHA256(password, random 16-byte salt, 600 000 iterations)
//   ciphertext = AES-256-GCM(key, random 12-byte IV, rendered HTML)
//
// The site build turns the envelope into a page with an unlock form, and
// the reader's browser decrypts it with the password typed there (asked
// for on every visit, never stored). A wrong
// password fails AES-GCM's integrity check, so no password hash is stored
// anywhere: a public hash would only give guessers a faster target. The
// password itself stays in the private draft, where the admin keeps it.
//
// Runs wherever Web Crypto does: browsers, Node 20+, Workers.

import { parseFrontMatter } from './post-format.js';

export const PROTECTED_MARK = 'md4c-protected-v1';
const ITERATIONS = 600000;
const subtle = () => globalThis.crypto.subtle;

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt `text` with `password`: { v, kdf, iter, salt, iv, ct } (base64 fields). */
export async function encryptText(text, password) {
  if (!password) throw new Error('A password is required');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypt an envelope from encryptText; throws on a wrong password. */
export async function decryptText(envelope, password) {
  if (envelope?.v !== 1 || envelope.kdf !== 'PBKDF2-SHA256') throw new Error('Unknown encryption format');
  const iter = Number(envelope.iter);
  if (!Number.isInteger(iter) || iter < 100000 || iter > 10000000) throw new Error('Unexpected key-derivation settings');
  const key = await deriveKey(password, fromB64(envelope.salt), iter);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
    return new TextDecoder().decode(plain);
  } catch {
    throw new WrongPasswordError();
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
  }
}

/** Hex SHA-256 of `text`: lets the admin tell whether a draft was published as is. */
export async function digest(text) {
  const hash = new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when a post's front matter asks for password protection. */
export const wantsPassword = (meta) => Boolean(String(meta?.password ?? '').trim());

const PUBLIC_FIELDS = ['title', 'date', 'updated', 'tags', 'author', 'toc', 'numbered', 'type'];
const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * The public, encrypted form of a protected post's source.
 * `renderHtml(body, meta)` = the article HTML exactly as the site build
 * makes it (articleHtml in blog-render.js).
 */
export async function protectPost(source, renderHtml) {
  const { meta, body } = parseFrontMatter(source);
  const password = String(meta.password ?? '').trim();
  if (!password) throw new Error('This post has no password');
  const envelope = await encryptText(renderHtml(body, meta), password);
  const lines = ['---'];
  for (const k of PUBLIC_FIELDS) if (clean(meta[k])) lines.push(`${k}: ${clean(meta[k])}`);
  lines.push('protected: true', `source: ${await digest(source)}`, '---', '',
    '<!-- This post is password-protected: its text is encrypted below. -->',
    '```' + PROTECTED_MARK, JSON.stringify(envelope), '```', '');
  return lines.join('\n');
}

/** { meta, envelope } of a protected post's public form, or null for any other source. */
export function readProtected(source) {
  const { meta, body } = parseFrontMatter(source);
  if (!/^(true|yes|1)$/i.test(meta.protected ?? '')) return null;
  const m = new RegExp('```' + PROTECTED_MARK + '\\r?\\n(.+)\\r?\\n```').exec(body);
  if (!m) return null;
  try {
    return { meta, envelope: JSON.parse(m[1]) };
  } catch {
    return null;
  }
}
