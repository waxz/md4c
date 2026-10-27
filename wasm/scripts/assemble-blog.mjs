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
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

// pdf.js, for paper notes (blog/paper.js), loaded only on paper posts:
// the library and its worker (its "legacy" build, which runs in current
// browsers, not only the newest; as .js, so storage serves them as
// JavaScript), and the data it fetches as needed (character maps, standard
// fonts, image decoders, colour profiles). Not its JavaScript-in-PDF engine.
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjsOut = join(out, 'vendor', 'pdfjs');
await mkdir(pdfjsOut, { recursive: true });
await cp(join(pdfjsDir, 'legacy', 'build', 'pdf.min.mjs'), join(pdfjsOut, 'pdf.min.js'));
await cp(join(pdfjsDir, 'legacy', 'build', 'pdf.worker.min.mjs'), join(pdfjsOut, 'pdf.worker.min.js'));
await cp(join(pdfjsDir, 'LICENSE'), join(pdfjsOut, 'LICENSE'));
for (const dir of ['cmaps', 'standard_fonts', 'iccs']) await cp(join(pdfjsDir, dir), join(pdfjsOut, dir), { recursive: true });
await cp(join(pdfjsDir, 'wasm'), join(pdfjsOut, 'wasm'), { recursive: true, filter: (src) => !/quickjs/.test(src) });

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
for (const name of ['app.js', 'style.css', 'unlock.js', 'paper.css']) assets[name] = await blogVersion(name);
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
for (const f of ['render.js', 'style.css', 'paper.js', 'paper.css', 'highlights.js', 'graph.js']) await cp(join(root, 'blog', f), join(adminOut, f));
// The blog's versions, for the pages the admin builds.
await cp(join(out, 'assets.json'), join(adminOut, 'site-assets.json'));
await cp(join(root, 'admin', 'src', 'paths.js'), join(adminOut, 'paths.js'));
// The admin's modules get content-hashed URLs too, and its page links them.
const adminVersion = await versionAssets(adminOut, await jsFiles(adminOut));
// Its pages link their files with versions too, and name every module the
// entry imports up front (modulepreload): the browser then fetches them all
// at once, not one level of imports after another.
/** The versioned modules `entry` imports statically, all levels down. */
async function staticImports(entry) {
  const seen = new Set();
  const visit = async (rel) => {
    const text = await readFile(join(adminOut, rel), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?#]+)\?v=([^'"#]+)\1/g)) {
      const dep = relative(adminOut, resolve(dirname(join(adminOut, rel)), m[2])).split(sep).join('/');
      const url = `${dep}?v=${m[3]}`;
      if (seen.has(url)) continue;
      seen.add(url);
      await visit(dep);
    }
  };
  await visit(entry);
  return [...seen].sort();
}
for (const [page, entry, links] of [
  ['index.html', 'admin.js', ['admin.css']],
  ['read.html', 'read.js', ['style.css', 'paper.css', 'reader.css', 'vendor/source-serif-4/opsz.css', 'vendor/source-serif-4/opsz-italic.css']],
]) {
  const file = join(adminOut, page);
  let html = await readFile(file, 'utf8');
  for (const f of [entry, ...links]) html = html.replace(`="${f}"`, `="${f}?v=${await adminVersion(f)}"`);
  const preload = (await staticImports(entry)).map((u) => `<link rel="modulepreload" href="${u}">`).join('\n');
  html = html.replace(/(<script type="module" src="[^"]+"><\/script>)/, `${preload}\n$1`);
  await writeFile(file, html);
}

// What the service worker (sw.js) caches so the admin opens even when
// Cloudflare Access has signed it out: the app's files at the addresses the
// app asks for (modules and stylesheets with their ?v= versions). Fonts are
// cached as they are used. The build id makes every deploy reinstall it.
const offline = [];
for (const ent of await readdir(adminOut, { withFileTypes: true, recursive: true })) {
  if (!ent.isFile()) continue;
  const rel = relative(adminOut, join(ent.parentPath ?? ent.path, ent.name)).split(sep).join('/');
  if (['sw.js', 'offline.json', 'site-assets.json'].includes(rel) || /^vendor\/(katex\/fonts|source-serif-4\/files|pdfjs\/(cmaps|standard_fonts|iccs|wasm))\//.test(rel)) continue;
  if (/\.(js|mjs|css|wasm)$/.test(rel)) offline.push(`${rel}?v=${await adminVersion(rel)}`);
  if (!/\.(js|mjs)$/.test(rel)) offline.push(rel); // pages, stylesheets the preview links plainly, …
}
offline.sort();
const offlineJson = `${JSON.stringify(offline, null, 1)}\n`;
await writeFile(join(adminOut, 'offline.json'), offlineJson);
const swPath = join(adminOut, 'sw.js');
const sw = await readFile(swPath, 'utf8');
await writeFile(swPath, sw.replace("'__BUILD__'", `'${createHash('sha256').update(offlineJson + sw).digest('hex').slice(0, 12)}'`));
console.log(`Admin app assembled in ${adminOut}`);
