// Assemble the static blog site into dist/blog/:
//
//   dist/blog/            <- blog/*            (pages, styles, sample posts)
//   dist/blog/lib/        <- js/*.js + dist/md4c.wasm
//   dist/blog/vendor/storagesdk-core/  <- @storagesdk/core ESM build
//
// The result is plain static files; host it on any web server.

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
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

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'lib'), { recursive: true });
await cp(join(root, 'blog'), out, { recursive: true });

for (const f of await readdir(join(root, 'js'))) {
  if (f.endsWith('.js')) await cp(join(root, 'js', f), join(out, 'lib', f));
}
await cp(wasm, join(out, 'lib', 'md4c.wasm'));

await cp(coreDist, join(out, 'vendor', 'storagesdk-core'), {
  recursive: true,
  filter: (src) => !/\.(d\.ts|map)$/.test(src),
});

console.log(`Blog assembled in ${out}`);
