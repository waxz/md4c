// Blog settings: the "site" section of index.json.
//
//   {
//     "site": {
//       "title": "Notes on Computation",
//       "url": "https://blog.example.com/",   // public address: needed for
//                                             // canonical links and sitemap
//       "language": "en",
//       "slogan": "Essays on parsing, compilers and the web",
//       "author": "Your Name",
//       "description": "Shown to search engines and link previews.",
//       "theme": "academic",          // academic | modern
//       "colorScheme": "auto",        // auto | light | dark
//       "accent": "#8b1e2d",          // any CSS color
//       "font": "serif",              // serif | sans (default: per theme)
//       "backgroundImage": "assets/header.jpg",
//       "backgroundMode": "hero",     // hero (masthead) | page (whole page)
//       "banner": "assets/banner.jpg", // wide image at the top of the home page
//       "stylesheet": "assets/custom.css",
//       "numberedHeadings": true,     // 1, 1.1, ... in posts
//       "toc": true,                  // "Contents" box for longer posts
//       "graph": true,                // links between posts: a Graph page,
//                                     // and "Linked from" under each post
//       "citation": true,             // "How to cite this post" box
//       "math": true,                 // render $...$ / $$...$$ with KaTeX
//       "footer": "© 2026 Your Name. CC BY 4.0.",
//       "links": [ { "label": "About", "href": "#/post/about" } ],
//       "verification": { "google": "...", "bing": "..." },  // search consoles
//       "indexNowKey": "0123456789abcdef0123456789abcdef",    // publish --indexnow
//       "search": "google"            // full-text search of the posts on the
//                                     // web: google | bing | duckduckgo | none
//     },
//     "items": [ ... ]
//   }
//
// Every field is optional. Values are validated: unknown keys are ignored,
// colors must parse as CSS colors, URLs must be http(s) (relative ones
// resolve against the storage URL), and text is only ever set as text.
// Settings are applied through CSS custom properties and data attributes,
// never inline style markup, so the page's strict CSP stays intact.
//
// Shared by the browser (blog/theme.js, the admin) and the site build
// (js/site-build.js in Node or the browser), so it must not touch the DOM.

const THEMES = ['academic', 'modern'];
const SCHEMES = ['auto', 'light', 'dark'];
const FONTS = ['serif', 'sans'];
const BG_MODES = ['hero', 'page'];

export const DEFAULT_SITE = Object.freeze({
  title: 'MD4C Blog',
  url: '',
  language: 'en',
  slogan: '',
  author: '',
  description: '',
  theme: 'academic',
  colorScheme: 'auto',
  accent: '',
  font: '',
  backgroundImage: '',
  backgroundMode: 'hero',
  banner: '',
  stylesheet: '',
  numberedHeadings: true,
  toc: true,
  graph: true,
  citation: true,
  math: true,
  footer: '',
  links: [],
  verification: {},
  indexNowKey: '',
  search: 'google',
});

const SEARCH_ENGINES = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};

/**
 * { label, href } searching the full text of this blog's posts on the web
 * engine set in `site.search` (a "site:" query), or null when off.
 */
export function webSearch(site, query, host) {
  const engine = SEARCH_ENGINES[site?.search];
  const q = String(query ?? '').trim();
  if (!engine || !q || !host) return null;
  return { label: engine.label, href: `${engine.url}${encodeURIComponent(`${q} site:${host}`)}` };
}

function text(v, max = 300) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/** http(s) URL resolved against `base`, or '' if unsafe/invalid. */
export function safeUrl(v, base) {
  if (typeof v !== 'string' || !v.trim()) return '';
  try {
    const url = new URL(v.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

// Without CSS.supports (Node), accept only plain hex/rgb/hsl/named colors.
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/+-]+\)|[a-z]{3,20})$/i;

function color(v) {
  if (typeof v !== 'string' || v.length >= 64) return '';
  if (globalThis.CSS?.supports) return CSS.supports('color', v) ? v : '';
  return COLOR_RE.test(v.trim()) ? v.trim() : '';
}

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Where a site link points from a page at `root`: #/post/x -> posts/x.html. */
export function siteLinkHref(href, root) {
  const post = /^#\/post\/([a-z0-9][a-z0-9-]{0,79})$/.exec(href);
  if (post) return `${root}posts/${post[1]}.html`;
  if (href.startsWith('#/')) return `${root}index.html${href}`;
  return href;
}

/** Validate a raw "site" object from index.json against the schema above. */
export function normalizeSite(raw, base) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const links = Array.isArray(r.links) ? r.links : [];
  const url = safeUrl(r.url, 'https://invalid.invalid/');
  const verification = r.verification && typeof r.verification === 'object' ? r.verification : {};
  return {
    title: text(r.title, 120) || DEFAULT_SITE.title,
    url: url && !url.startsWith('https://invalid.invalid/') ? url.replace(/[?#].*$/, '').replace(/\/?$/, '/') : '',
    language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(r.language ?? '') ? r.language : DEFAULT_SITE.language,
    slogan: text(r.slogan, 200),
    author: text(r.author, 120),
    description: text(r.description, 300),
    theme: oneOf(r.theme, THEMES, DEFAULT_SITE.theme),
    colorScheme: oneOf(r.colorScheme, SCHEMES, DEFAULT_SITE.colorScheme),
    accent: color(r.accent),
    font: oneOf(r.font, FONTS, ''),
    backgroundImage: safeUrl(r.backgroundImage, base),
    banner: safeUrl(r.banner, base),
    backgroundMode: oneOf(r.backgroundMode, BG_MODES, DEFAULT_SITE.backgroundMode),
    stylesheet: safeUrl(r.stylesheet, base),
    numberedHeadings: bool(r.numberedHeadings, DEFAULT_SITE.numberedHeadings),
    toc: bool(r.toc, DEFAULT_SITE.toc),
    graph: bool(r.graph, DEFAULT_SITE.graph),
    citation: bool(r.citation, DEFAULT_SITE.citation),
    math: bool(r.math, DEFAULT_SITE.math),
    footer: text(r.footer, 300),
    links: links
      .slice(0, 8)
      .map((l) => ({
        label: text(l?.label, 40),
        href: typeof l?.href === 'string' && /^#\//.test(l.href) ? l.href : safeUrl(l?.href, base),
      }))
      .filter((l) => l.label && l.href),
    verification: Object.fromEntries(
      ['google', 'bing', 'yandex']
        .filter((k) => TOKEN_RE.test(verification[k] ?? ''))
        .map((k) => [k, verification[k]])
    ),
    indexNowKey: /^[A-Za-z0-9-]{8,128}$/.test(r.indexNowKey ?? '') ? r.indexNowKey : '',
    search: r.search === 'none' || SEARCH_ENGINES[r.search] ? r.search : DEFAULT_SITE.search,
  };
}
