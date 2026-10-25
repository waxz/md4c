// Static pages for search engines and link previews, written at publish time.
//
// Crawlers treat "index.html#/post/x" as the home page, and many (Bing,
// DuckDuckGo, social previews) do not run JavaScript. So the publish script
// pre-renders real pages with md4c.wasm in Node:
//
//   index.html          every article as a plain link, grouped by year
//   posts/<slug>.html   the article itself, with title, description,
//                       canonical URL, Open Graph/Twitter cards, JSON-LD
//                       (ScholarlyArticle or BlogPosting) and Google Scholar
//                       citation_* tags
//   graph.html          the links between posts as a graph (drawn by
//                       app.js from index.json), with a plain list too
//   theme.css           accent color and background image from "site"
//   feed.xml            Atom feed            (needs site.url)
//   sitemap.xml         all pages + lastmod  (needs site.url)
//   robots.txt
//
// The same app.js then upgrades each page in the browser (filters on the
// home page; contents, figures, math and citation on articles).

import { parseTags } from './post-format.js';
import { siteLinkHref } from './site-config.js';

export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; " +
  "img-src 'self' https: data:; media-src 'self' https:; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

// What the Google tag needs (Google's documented CSP for gtag.js / GA4).
const GOOGLE_TAG_CSP = {
  script: 'https://*.googletagmanager.com',
  connect: 'https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com',
};

/**
 * Google's snippet, inline as Google gives it: Search Console's "Google
 * Analytics" verification looks for exactly this in the page. The CSP
 * allows this one script by its SHA-256 hash; any other inline script
 * stays blocked.
 */
function googleTagScript(id) {
  return `
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${id}');
`;
}

/** The pages' CSP: CSP, plus Google's hosts and snippet when the site has a Google tag. */
export function cspFor(site) {
  if (!site.googleTag) return CSP;
  const hash = `'sha256-${sha256Base64(googleTagScript(site.googleTag))}'`;
  return CSP
    .replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' 'wasm-unsafe-eval' ${hash} ${GOOGLE_TAG_CSP.script}`)
    .replace("connect-src 'self'", `connect-src 'self' ${GOOGLE_TAG_CSP.connect}`);
}

/** Google's tag, as Google gives it (site.googleTag is validated: G-…, GT-…, AW-…, DC-…). */
function googleTag(site) {
  if (!site.googleTag) return '';
  return `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${site.googleTag}"></script>
<script>${googleTagScript(site.googleTag)}</script>
`;
}

/** Base64 SHA-256 of a string's UTF-8 bytes (synchronous: pages are built synchronously). */
export function sha256Base64(text) {
  const K = [];
  const H = [];
  let n = 2;
  for (let found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (found < 8) H[found] = (Math.pow(n, 1 / 2) * 2 ** 32) | 0;
    K[found++] = (Math.pow(n, 1 / 3) * 2 ** 32) | 0;
  }
  const bytes = [...new TextEncoder().encode(text)];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const w = new Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  const out = H.flatMap((v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  return btoa(String.fromCharCode(...out));
}

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%238b1e2d'/%3E%3Cpath d='M4.5 12V4h2.2c2.2 0 3.3 1.3 3.3 4s-1.1 4-3.3 4z' stroke='white' fill='none' stroke-width='1.3'/%3E%3C/svg%3E";

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const escXml = esc;

/** JSON for a <script type="application/ld+json"> block (a data block, not run, so CSP allows it). */
function jsonLd(obj) {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

function formatDate(iso, month = 'long') {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { year: 'numeric', month, day: 'numeric', timeZone: 'UTC' });
}

/**
 * Absolute http(s) URL for a site-relative `path` ("posts/a.html"), or
 * `fallback` when site.url is unknown. Other schemes are refused.
 */
function abs(site, path, fallback = '') {
  if (!path) return fallback;
  if (/^https?:\/\//.test(path)) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return fallback;
  return site.url ? new URL(path.replace(/^\//, ''), site.url).href : fallback;
}

/** A URL from normalizeSite(raw, siteBase), made site-relative when it is ours. */
export function siteRelative(url, siteBase) {
  return url.startsWith(siteBase) ? url.slice(siteBase.length) : url;
}

/** href for a site-relative or absolute URL, from a page at `root`. */
function hrefFrom(root, url) {
  return /^https?:\/\//.test(url) ? url : `${root}${url}`;
}

/** Social preview image for a post: front matter `image` resolves next to the post. */
function postImage(site, post) {
  const own = post.image || post.banner;
  if (own) {
    const resolved = new URL(own, 'https://site.invalid/posts/');
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return '';
    return resolved.host === 'site.invalid' ? abs(site, resolved.pathname.slice(1)) : resolved.href;
  }
  return site.backgroundImage ? abs(site, site.backgroundImage) : '';
}

/**
 * An image a post names in its front matter (relative to posts/, or an
 * http(s) URL), as an href from a page at `root`; '' if not usable.
 */
function postAssetHref(ref, root) {
  if (!ref) return '';
  let resolved;
  try {
    resolved = new URL(ref, 'https://site.invalid/posts/');
  } catch {
    return '';
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return '';
  return resolved.host === 'site.invalid' ? `${root}${resolved.pathname.slice(1)}` : resolved.href;
}

export function themeCss(site) {
  const lines = ['/* Generated from index.json "site" by scripts/publish.mjs. */', ':root {'];
  if (site.accent) lines.push(`  --accent-base: ${site.accent};`);
  if (site.backgroundImage) {
    lines.push(`  --bg-image: url(${JSON.stringify(site.backgroundImage)});`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function masthead(site, root) {
  const links = [`<a href="${root}index.html">Articles</a>`]
    .concat(site.graph ? [`<a href="${root}graph.html">Graph</a>`] : [])
    .concat(site.links.map((l) => {
      const href = siteLinkHref(l.href, root);
      return `<a href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener noreferrer"' : ''}>${esc(l.label)}</a>`;
    }));
  return `<header class="masthead">
  <div class="masthead-inner">
    <a class="site-title" href="${root}index.html">${esc(site.title)}</a>
    <p class="site-slogan"${site.slogan ? '' : ' hidden'}>${esc(site.slogan)}</p>
    <nav id="nav" aria-label="Site">${links.join('')}</nav>
  </div>
</header>`;
}

function footer(site) {
  const note = site.footer || (site.author ? `© ${new Date().getFullYear()} ${site.author}` : '');
  return `<footer class="site-footer">
  <div class="page">
    <p class="footer-note">${esc(note)}</p>
    <p class="colophon">Typeset by MD4C (WebAssembly) · Served from read-only storage via storagesdk${site.url ? ` · <a href="${esc(site.url)}feed.xml">Atom feed</a>` : ''}</p>
  </div>
</footer>`;
}

/**
 * The address of one of the site's own files, with its content version
 * (site.assets, from assets.json made by scripts/assemble-blog.mjs): a
 * changed file gets a new address, so no browser keeps an old copy.
 */
function asset(site, root, name) {
  const v = site.assets?.[name];
  return `${root}${name}${v && /^[0-9a-f]{6,64}$/.test(v) ? `?v=${v}` : ''}`;
}

/** A complete HTML document sharing one head/masthead/footer layout. */
function documentHtml({ site, root, page, title, description, canonical, head = '', main, robots }) {
  const html = document_attrs(site);
  return `<!DOCTYPE html>
<html ${html}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cspFor(site)}">
${googleTag(site)}<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="${site.colorScheme === 'auto' ? 'light dark' : site.colorScheme}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${robots}">\n` : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}${site.url ? `<link rel="alternate" type="application/atom+xml" title="${esc(site.title)}" href="${esc(site.url)}feed.xml">\n` : ''}${Object.entries(site.verification).map(([k, v]) => `<meta name="${{ google: 'google-site-verification', bing: 'msvalidate.01', yandex: 'yandex-verification' }[k]}" content="${esc(v)}">\n`).join('')}<link rel="icon" href="${FAVICON}">
<link rel="preload" href="${root}vendor/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}vendor/source-serif-4/opsz.css">
<link rel="stylesheet" href="${root}vendor/source-serif-4/opsz-italic.css">
<link rel="stylesheet" href="${asset(site, root, 'style.css')}">
<link rel="stylesheet" href="${root}theme.css">
${site.stylesheet ? `<link rel="stylesheet" href="${esc(hrefFrom(root, site.stylesheet))}">\n` : ''}${head}<script type="module" src="${asset(site, root, 'app.js')}"></script>
</head>
<body data-page="${page}">
<a class="skip-link" href="#app">Skip to content</a>
${masthead(site, root)}

<main id="app" class="page" tabindex="-1">
${main}
</main>

${footer(site)}
</body>
</html>
`;
}

function document_attrs(site) {
  const attrs = {
    lang: site.language,
    'data-theme': site.theme,
    'data-scheme': site.colorScheme,
    'data-font': site.font || (site.theme === 'modern' ? 'sans' : 'serif'),
    'data-numbered': String(site.numberedHeadings),
    ...(site.backgroundImage ? { 'data-bg': site.backgroundMode } : {}),
  };
  return Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
}

function entryHtml(p, root) {
  const tags = parseTags(p.tags);
  return `<li class="entry" data-date="${esc(p.date)}" data-tags="${esc(tags.join(','))}">
  <time class="sc" datetime="${esc(p.date)}">${esc(formatDate(p.date, 'short'))}</time>
  <div>
    <h2><a href="${root}${esc(p.page)}">${esc(p.title)}</a></h2>
    ${p.protected ? '<p class="abstract protected-note">🔒 Password-protected</p>' : p.excerpt ? `<p class="abstract">${esc(p.excerpt)}</p>` : ''}
    ${tags.length ? `<p class="keywords sc">${tags.map((t) => `<a href="${root}index.html?tag=${encodeURIComponent(t)}" rel="tag">${esc(t)}</a>`).join('')}</p>` : ''}
  </div>
</li>`;
}

/**
 * The body of a protected article: the encrypted text and an unlock form,
 * which app.js wires up (the page's CSP allows no inline script). If the
 * script ever fails to run, the form must not send the password anywhere:
 * method="post" keeps it out of the address (and history and logs), and
 * the CSP's form-action 'none' blocks the request itself.
 */
export function protectedArticle(envelope) {
  return `<div class="protected" data-envelope="${esc(JSON.stringify(envelope))}">
  <p>🔒 This post is password-protected.</p>
  <form class="unlock" method="post" autocomplete="off">
    <label for="unlock-password">Password</label>
    <input id="unlock-password" name="password" type="password" required autocomplete="current-password">
    <button type="submit">Unlock</button>
    <p class="unlock-status" role="status" aria-live="polite"></p>
  </form>
  <noscript><p>Unlocking needs JavaScript.</p></noscript>
</div>`;
}

/** Home page: every published article as a crawlable link, newest first, by year. */
export function homePage(site, posts) {
  const byYear = new Map();
  for (const p of posts) {
    const y = p.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const list = posts.length
    ? [...byYear].map(([y, ps]) =>
        `<section class="year-group"><h2 class="year-heading sc">${esc(y)}</h2>\n<ol class="entries">\n${ps.map((p) => entryHtml(p, '')).join('\n')}\n</ol></section>`
      ).join('\n')
    : '<p class="muted">No articles yet.</p>';
  const description = site.description || site.slogan || `Articles from ${site.title}`;
  const head = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(site.title)}">`,
    `<meta property="og:title" content="${esc(site.title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    site.url ? `<meta property="og:url" content="${esc(site.url)}index.html">` : '',
    site.backgroundImage && site.url ? `<meta property="og:image" content="${esc(abs(site, site.backgroundImage))}">` : '',
    `<meta name="twitter:card" content="summary">`,
    `<script type="application/ld+json">${jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: site.title,
      ...(site.description || site.slogan ? { description } : {}),
      ...(site.url ? { url: `${site.url}index.html` } : {}),
      inLanguage: site.language,
      ...(site.author ? { author: { '@type': 'Person', name: site.author } } : {}),
      blogPost: posts.slice(0, 50).map((p) => ({
        '@type': 'BlogPosting',
        headline: p.title,
        datePublished: p.date,
        ...(site.url ? { url: abs(site, p.page) } : {}),
      })),
    })}</script>`,
  ].filter(Boolean).join('\n') + '\n';
  const banner = site.banner ? hrefFrom('', site.banner) : '';
  const main = `${banner ? `<figure class="home-banner"><img src="${esc(banner)}" alt="" decoding="async"></figure>\n` : ''}<p class="section-label sc">Latest articles</p>
<div id="filters"></div>
<div id="entries">
${list}
</div>`;
  return documentHtml({
    site, root: '', page: 'home',
    title: site.slogan ? `${site.title} — ${site.slogan}` : site.title,
    description,
    canonical: site.url ? `${site.url}index.html` : '',
    head, main,
  });
}

/** One article page, posts/<slug>.html. `html` is the MD4C output for the body. */
export function postPage(site, post, html) {
  const root = '../';
  const tags = parseTags(post.tags);
  const author = post.author || site.author;
  const locked = post.protected === 'true';
  const description = locked ? 'This post is password-protected.' : post.description || post.excerpt || site.description;
  const url = site.url ? abs(site, post.page) : '';
  const image = locked ? '' : postImage(site, post);
  const words = locked ? 0 : html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const scholarly = site.theme === 'academic';
  const dateSlash = post.date.replace(/-/g, '/');

  const head = [
    `<meta name="author" content="${esc(author)}">`,
    tags.length ? `<meta name="keywords" content="${esc(tags.join(', '))}">` : '',
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(site.title)}">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta property="og:locale" content="${esc(site.language.replace('-', '_'))}">`,
    `<meta property="article:published_time" content="${esc(post.date)}">`,
    post.updated ? `<meta property="article:modified_time" content="${esc(post.updated)}">` : '',
    ...tags.map((t) => `<meta property="article:tag" content="${esc(t)}">`),
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(post.title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : '',
    // Google Scholar (Highwire Press) tags
    `<meta name="citation_title" content="${esc(post.title)}">`,
    author ? `<meta name="citation_author" content="${esc(author)}">` : '',
    `<meta name="citation_publication_date" content="${esc(dateSlash)}">`,
    `<meta name="citation_online_date" content="${esc(dateSlash)}">`,
    `<meta name="citation_journal_title" content="${esc(site.title)}">`,
    url ? `<meta name="citation_abstract_html_url" content="${esc(url)}">` : '',
    `<meta name="citation_language" content="${esc(site.language)}">`,
    `<script type="application/ld+json">${jsonLd({
      '@context': 'https://schema.org',
      '@type': scholarly ? 'ScholarlyArticle' : 'BlogPosting',
      headline: post.title.slice(0, 110),
      description,
      datePublished: post.date,
      dateModified: post.updated || post.date,
      ...(author ? { author: { '@type': 'Person', name: author } } : {}),
      ...(tags.length ? { keywords: tags.join(', ') } : {}),
      ...(image ? { image } : {}),
      inLanguage: site.language,
      wordCount: words,
      isPartOf: { '@type': 'Blog', name: site.title, ...(site.url ? { url: `${site.url}index.html` } : {}) },
      ...(url ? { url, mainEntityOfPage: { '@type': 'WebPage', '@id': url } } : {}),
    })}</script>`,
  ].filter(Boolean).join('\n') + '\n';

  const banner = locked ? '' : postAssetHref(post.banner, root);
  // The post's own front matter wins over the site's settings.
  const numbered = post.numbered === 'true' ? true : post.numbered === 'false' ? false : site.numberedHeadings;
  const background = locked ? '' : postAssetHref(post.background, root);
  const main = `<a class="back-link sc" href="${root}index.html">← All articles</a>
<article data-slug="${esc(post.slug)}" data-title="${esc(post.title)}" data-date="${esc(post.date)}" data-author="${esc(post.author ?? '')}" data-numbered="${numbered}"${
  post.toc ? ` data-toc="${esc(post.toc)}"` : ''}${
  background ? ` data-background="${esc(background)}" data-background-mode="${esc(post.backgroundMode || 'page')}"` : ''}>
  ${banner ? `<figure class="post-banner"><img src="${esc(banner)}" alt="" decoding="async"></figure>` : ''}
  <header class="article-header">
    <h1 class="article-title">${esc(post.title)}</h1>
    <p class="byline sc">${author ? `<span class="author">${esc(author)}</span> · ` : ''}<time datetime="${esc(post.date)}">${esc(formatDate(post.date))}</time>${post.updated ? ` · updated <time datetime="${esc(post.updated)}">${esc(formatDate(post.updated))}</time>` : ''}${locked ? ' · 🔒' : ` · ${Math.max(1, Math.round(words / 230))} min read`}</p>
    ${tags.length ? `<p class="keywords sc">${tags.map((t) => `<a href="${root}index.html?tag=${encodeURIComponent(t)}" rel="tag">${esc(t)}</a>`).join('')}</p>` : ''}
  </header>
  <div class="prose">
${html}
  </div>
</article>`;

  return documentHtml({
    site: { ...site, numberedHeadings: numbered }, root, page: 'post',
    title: `${post.title} · ${site.title}`,
    description, canonical: url,
    // unlock.js guards the unlock form even if app.js cannot run.
    head: (post.type === 'paper' ? `<link rel="stylesheet" href="${asset(site, root, 'paper.css')}">\n` : '')
      + (locked ? `<script src="${asset(site, root, 'unlock.js')}"></script>\n` : head), main,
    // Search engines would only see the unlock form.
    robots: locked ? 'noindex' : '',
  });
}

/**
 * graph.html: app.js draws the posts and the links between them from
 * index.json. Not for search engines, which already have every link.
 */
export function graphPage(site) {
  const main = `<p class="section-label sc">Graph</p>
<p class="graph-help muted">Each dot is an article; lines are links between articles. Drag to move, scroll or pinch to zoom, click to open.</p>
<div id="graph-view"><noscript><p>The graph needs JavaScript. <a href="index.html">All articles</a></p></noscript></div>`;
  return documentHtml({
    site, root: '', page: 'graph',
    title: `Graph · ${site.title}`,
    description: `How the articles of ${site.title} link to each other`,
    canonical: site.url ? `${site.url}graph.html` : '',
    main, robots: 'noindex, follow',
  });
}

export function atomFeed(site, posts, htmlBySlug) {
  const updated = posts.reduce((m, p) => ((p.updated || p.date) > m ? (p.updated || p.date) : m), '1970-01-01');
  const entries = posts.slice(0, 30).map((p) => {
    const url = abs(site, p.page);
    const author = p.author || site.author;
    return `  <entry>
    <title>${escXml(p.title)}</title>
    <link href="${escXml(url)}"/>
    <id>${escXml(url)}</id>
    <published>${p.date}T00:00:00Z</published>
    <updated>${p.updated || p.date}T00:00:00Z</updated>
${author ? `    <author><name>${escXml(author)}</name></author>\n` : ''}${parseTags(p.tags).map((t) => `    <category term="${escXml(t)}"/>\n`).join('')}    <summary>${escXml(p.protected ? 'Password-protected' : p.description || p.excerpt)}</summary>
    <content type="html" xml:base="${escXml(url)}">${escXml(p.protected ? '<p>This post is password-protected.</p>' : htmlBySlug.get(p.slug) ?? '')}</content>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escXml(site.language)}">
  <title>${escXml(site.title)}</title>
${site.slogan ? `  <subtitle>${escXml(site.slogan)}</subtitle>\n` : ''}  <link href="${escXml(site.url)}index.html"/>
  <link rel="self" href="${escXml(site.url)}feed.xml"/>
  <id>${escXml(site.url)}</id>
  <updated>${updated}T00:00:00Z</updated>
${site.author ? `  <author><name>${escXml(site.author)}</name></author>\n` : ''}${entries.join('\n')}
</feed>
`;
}

export function sitemap(site, posts) {
  const latest = posts.reduce((m, p) => ((p.updated || p.date) > m ? (p.updated || p.date) : m), '');
  const urls = [
    `  <url><loc>${escXml(site.url)}index.html</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}</url>`,
    ...posts.filter((p) => !p.protected).map((p) => `  <url><loc>${escXml(abs(site, p.page))}</loc><lastmod>${p.updated || p.date}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export function robotsTxt(site) {
  return `# Everything here is public; let all crawlers in.
User-agent: *
Allow: /
${site.url ? `\nSitemap: ${site.url}sitemap.xml\n` : ''}`;
}
