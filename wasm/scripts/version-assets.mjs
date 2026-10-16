// Content-hashed module URLs, so a browser never mixes versions.
//
// Every relative import in the assembled site and admin gets the hash of
// the file it points to: `from './lib/blog-render.js'` becomes
// `from './lib/blog-render.js?v=3f2a91c0'`. Hashes are taken after a file's
// own imports are rewritten (like a Merkle tree), so a change anywhere
// changes the URL of every module that depends on it. A browser holding an
// old cached copy of a module then simply asks for a new URL: it cannot run
// a new script with an old module ("does not provide an export named …").
//
// Rewritten: static imports and exports ("from '…'", "import '…'"),
// dynamic import('…') with a literal, and new URL('…', import.meta.url).
// Files under vendor/ are hashed but not rewritten.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"?#]+)(\?[^'"#]*)?\2/g;
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 10);

/**
 * Rewrite the JavaScript under `root` (except vendor/) in place.
 * Returns version(relPath) for any file under root (e.g. for HTML links).
 */
export async function versionAssets(root, files) {
  const done = new Map(); // abs path -> hash
  const busy = new Set();
  const isVendor = (abs) => relative(root, abs).split(sep)[0] === 'vendor';

  async function version(abs) {
    if (done.has(abs)) return done.get(abs);
    let bytes;
    try {
      bytes = await readFile(abs);
    } catch {
      return null; // not part of the site (e.g. made at publish time)
    }
    if (!abs.endsWith('.js') || isVendor(abs) || busy.has(abs)) {
      const h = hashOf(bytes);
      if (!busy.has(abs)) done.set(abs, h);
      return h;
    }
    busy.add(abs);
    const text = bytes.toString('utf8');
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(SPEC_RE)) {
      const [whole, lead, quote, spec] = m;
      const v = await version(resolve(dirname(abs), spec));
      parts.push(text.slice(last, m.index), v ? `${lead}${quote}${spec}?v=${v}${quote}` : whole);
      last = m.index + whole.length;
    }
    parts.push(text.slice(last));
    const out = parts.join('');
    if (out !== text) await writeFile(abs, out);
    busy.delete(abs);
    const h = hashOf(Buffer.from(out));
    done.set(abs, h);
    return h;
  }

  for (const f of files) await version(f);
  return async (rel) => version(join(root, rel));
}
