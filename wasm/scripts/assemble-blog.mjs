// Assemble the static blog site into dist/blog/:
//
//   dist/blog/            <- blog/*            (scripts, styles; not the posts)
//   dist/blog/index.html, theme.css <- js/pages.js with blog/site.json
//                                      (publish.mjs regenerates them with posts)
//   dist/blog/lib/        <- js/*.js + dist/md4c.wasm
//   dist/blog/vendor/storagesdk-core/  <- @storagesdk/core ESM build
//   dist/blog/vendor/dompurify/        <- DOMPurify ESM build
//   dist/blog/vendor/source-serif-4/   <- Source Serif 4 web font (OFL)
//   dist/blog/vendor/katex/            <- KaTeX, loaded only for posts with math
//   dist/blog/vendor/highlight/        <- highlight.js, only for posts with code
//
// Bare imports ("@storagesdk/core") are rewritten to relative paths so the
// page needs no inline import map, which a strict CSP would block.
// Upload the result with scripts/publish.mjs --site, or host it anywhere.
// Also assembles the admin app into dist/admin/ (see admin/README.md).

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homePage, themeCss } from '../js/pages.js';
import { siteSettings } from '../js/site-build.js';
import { versionAssets } from './version-assets.mjs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
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

// highlight.js, loaded only for posts with fenced code in a named language.
const hljsDir = dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
const hljsOut = join(out, 'vendor', 'highlight');
await mkdir(hljsOut, { recursive: true });
await cp(join(hljsDir, 'es', 'highlight.min.js'), join(hljsOut, 'highlight.min.js'));
await cp(join(hljsDir, 'LICENSE'), join(hljsOut, 'LICENSE'));

// Content-hashed module URLs (see version-assets.mjs). The pages link to
// app.js, style.css and unlock.js with their versions too: those are kept
// in assets.json for the site build (publish.mjs, the admin).
const jsFiles = async (dir) => {
  const found = [];
  for (const ent of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith('.js')) found.push(join(ent.parentPath ?? ent.path, ent.name));
  }
  return found.filter((f) => !f.includes(`${sep}vendor${sep}`));
};
const blogVersion = await versionAssets(out, await jsFiles(out));
const assets = {};
for (const name of ['app.js', 'style.css', 'unlock.js']) assets[name] = await blogVersion(name);
await writeFile(join(out, 'assets.json'), `${JSON.stringify(assets, null, 2)}\n`);

// A starter home page and theme (no posts yet); publish.mjs rebuilds both.
const rawSite = JSON.parse(await readFile(join(root, 'blog', 'site.json'), 'utf8'));
const site = { ...siteSettings(rawSite), assets };
await writeFile(join(out, 'index.html'), homePage(site, []));
await writeFile(join(out, 'theme.css'), themeCss(site));

console.log(`Blog assembled in ${out}`);

// The admin app (admin/ui) served by the admin Worker: shares the blog's
// lib/, vendor/, renderer and stylesheet (for previews in the blog's theme)
// and the Worker's path rules.
const adminOut = join(root, 'dist', 'admin');
await rm(adminOut, { recursive: true, force: true });
await cp(join(root, 'admin', 'ui'), adminOut, { recursive: true });
await cp(join(out, 'lib'), join(adminOut, 'lib'), { recursive: true });
await cp(join(out, 'vendor'), join(adminOut, 'vendor'), { recursive: true });
for (const f of ['render.js', 'style.css']) await cp(join(root, 'blog', f), join(adminOut, f));
// The blog's versions, for the pages the admin builds.
await cp(join(out, 'assets.json'), join(adminOut, 'site-assets.json'));
await cp(join(root, 'admin', 'src', 'paths.js'), join(adminOut, 'paths.js'));
// The admin's modules get content-hashed URLs too, and its page links them.
const adminVersion = await versionAssets(adminOut, await jsFiles(adminOut));
const adminHtml = join(adminOut, 'index.html');
let html = await readFile(adminHtml, 'utf8');
for (const file of ['admin.js', 'admin.css']) html = html.replace(`="${file}"`, `="${file}?v=${await adminVersion(file)}"`);
await writeFile(adminHtml, html);
console.log(`Admin app assembled in ${adminOut}`);
