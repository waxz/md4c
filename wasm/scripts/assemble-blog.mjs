// Assemble the static blog site into dist/blog/:
//
//   dist/blog/            <- blog/*            (pages, styles, sample posts)
//   dist/blog/lib/        <- js/*.js + dist/md4c.wasm
//   dist/blog/vendor/storagesdk-core/  <- @storagesdk/core ESM build
//   dist/blog/vendor/dompurify/        <- DOMPurify ESM build
//
// Bare imports ("@storagesdk/core") are rewritten to relative paths so the
// page needs no inline import map, which a strict CSP would block.
// Serve the result with server/server.mjs.

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'blog');
const wasm = join(root, 'dist', 'md4c.wasm');

try {
  await stat(wasm);
} catch {
  console.error(`Missing ${wasm}; run "sh build.sh" first.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const coreDist = dirname(require.resolve('@storagesdk/core'));
// dompurify's "exports" hides package.json; its main entry lives in dist/.
const purifyDir = dirname(dirname(require.resolve('dompurify')));

const BARE_IMPORTS = {
  '@storagesdk/core/adapter': '../vendor/storagesdk-core/adapter-kit.js',
  '@storagesdk/core': '../vendor/storagesdk-core/index.js',
};

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'lib'), { recursive: true });
await cp(join(root, 'blog'), out, { recursive: true });

for (const f of await readdir(join(root, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const src = await readFile(join(root, 'js', f), 'utf8');
  const rewritten = src.replace(/from '(@storagesdk\/core(?:\/adapter)?)'/g,
    (_, spec) => `from '${BARE_IMPORTS[spec]}'`);
  await writeFile(join(out, 'lib', f), rewritten);
}
await cp(wasm, join(out, 'lib', 'md4c.wasm'));

await cp(coreDist, join(out, 'vendor', 'storagesdk-core'), {
  recursive: true,
  filter: (src) => !/\.(d\.ts|map)$/.test(src),
});

await mkdir(join(out, 'vendor', 'dompurify'), { recursive: true });
await cp(join(purifyDir, 'dist', 'purify.es.mjs'), join(out, 'vendor', 'dompurify', 'purify.es.mjs'));
await cp(join(purifyDir, 'LICENSE'), join(out, 'vendor', 'dompurify', 'LICENSE'));

console.log(`Blog assembled in ${out}`);
