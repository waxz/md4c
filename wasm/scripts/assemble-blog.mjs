// Assemble the static blog site into dist/blog/:
//
//   dist/blog/            <- blog/*            (scripts, styles; not the posts)
//   dist/blog/index.html, theme.css <- scripts/pages.mjs with blog/site.json
//                                      (publish.mjs regenerates them with posts)
//   dist/blog/lib/        <- js/*.js + dist/md4c.wasm
//   dist/blog/vendor/storagesdk-core/  <- @storagesdk/core ESM build
//   dist/blog/vendor/dompurify/        <- DOMPurify ESM build
//   dist/blog/vendor/source-serif-4/   <- Source Serif 4 web font (OFL)
//   dist/blog/vendor/katex/            <- KaTeX, loaded only for posts with math
//
// Bare imports ("@storagesdk/core") are rewritten to relative paths so the
// page needs no inline import map, which a strict CSP would block.
// Upload the result with scripts/publish.mjs --site, or host it anywhere.

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { normalizeSite } from '../blog/theme.js';
import { homePage, siteRelative, themeCss } from './pages.mjs';
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
// Posts are published separately by scripts/publish.mjs (drafts skipped).
await cp(join(root, 'blog'), out, {
  recursive: true,
  // site.json seeds index.json's "site" section; it is not a page asset.
  filter: (src) => src !== join(root, 'blog', 'posts') && src !== join(root, 'blog', 'site.json'),
});

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
// Saved as .js, not .mjs: upload tools and the R2 dashboard reliably give .js
// the JavaScript MIME type that module scripts require.
await cp(join(purifyDir, 'dist', 'purify.es.mjs'), join(out, 'vendor', 'dompurify', 'purify.es.js'));
await cp(join(purifyDir, 'LICENSE'), join(out, 'vendor', 'dompurify', 'LICENSE'));

// Fonts and math are served from the same storage as the page, so the CSP
// can stay 'self'-only and readers never contact a third-party CDN.
const fontDir = dirname(require.resolve('@fontsource-variable/source-serif-4/opsz.css'));
const fontOut = join(out, 'vendor', 'source-serif-4');
await mkdir(join(fontOut, 'files'), { recursive: true });
for (const css of ['opsz.css', 'opsz-italic.css', 'LICENSE']) await cp(join(fontDir, css), join(fontOut, css));
for (const f of await readdir(join(fontDir, 'files'))) {
  if (f.includes('-opsz-')) await cp(join(fontDir, 'files', f), join(fontOut, 'files', f));
}

const katexDir = dirname(dirname(require.resolve('katex')));
const katexOut = join(out, 'vendor', 'katex');
await mkdir(katexOut, { recursive: true });
await cp(join(katexDir, 'dist', 'katex.mjs'), join(katexOut, 'katex.mjs'));
await cp(join(katexDir, 'dist', 'katex.min.css'), join(katexOut, 'katex.min.css'));
await cp(join(katexDir, 'LICENSE'), join(katexOut, 'LICENSE'));
await cp(join(katexDir, 'dist', 'fonts'), join(katexOut, 'fonts'), {
  recursive: true,
  filter: (src) => !/\.(ttf|woff)$/.test(src), // woff2 is enough for current browsers
});

// A starter home page and theme (no posts yet); publish.mjs rebuilds both.
const rawSite = JSON.parse(await readFile(join(root, 'blog', 'site.json'), 'utf8'));
const site = normalizeSite(rawSite, 'https://site.invalid/');
site.backgroundImage = siteRelative(site.backgroundImage, 'https://site.invalid/');
site.stylesheet = siteRelative(site.stylesheet, 'https://site.invalid/');
await writeFile(join(out, 'index.html'), homePage(site, []));
await writeFile(join(out, 'theme.css'), themeCss(site));

console.log(`Blog assembled in ${out}`);
