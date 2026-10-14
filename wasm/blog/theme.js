// Blog appearance, configured by the "site" section of index.json:
//
//   {
//     "site": {
//       "title": "Notes on Computation",
//       "slogan": "Essays on parsing, compilers and the web",
//       "author": "Your Name",
//       "description": "Shown to search engines and link previews.",
//       "theme": "academic",          // academic | modern
//       "colorScheme": "auto",        // auto | light | dark
//       "accent": "#8b1e2d",          // any CSS color
//       "font": "serif",              // serif | sans (default: per theme)
//       "backgroundImage": "assets/header.jpg",
//       "backgroundMode": "hero",     // hero (masthead) | page (whole page)
//       "stylesheet": "assets/custom.css",
//       "numberedHeadings": true,     // 1, 1.1, ... in posts
//       "toc": true,                  // "Contents" box for longer posts
//       "citation": true,             // "How to cite this post" box
//       "math": true,                 // render $...$ / $$...$$ with KaTeX
//       "footer": "© 2026 Your Name. CC BY 4.0.",
//       "links": [ { "label": "About", "href": "#/post/about" } ]
//     },
//     "items": [ ... ]
//   }
//
// Every field is optional. Values are validated: unknown keys are ignored,
// colors must parse as CSS colors, URLs must be http(s) (relative ones
// resolve against the storage URL), and text is only ever set as text.
// Settings are applied through CSS custom properties and data attributes,
// never inline style markup, so the page's strict CSP stays intact.

const THEMES = ['academic', 'modern'];
const SCHEMES = ['auto', 'light', 'dark'];
const FONTS = ['serif', 'sans'];
const BG_MODES = ['hero', 'page'];

export const DEFAULT_SITE = Object.freeze({
  title: 'MD4C Blog',
  slogan: '',
  author: '',
  description: '',
  theme: 'academic',
  colorScheme: 'auto',
  accent: '',
  font: '',
  backgroundImage: '',
  backgroundMode: 'hero',
  stylesheet: '',
  numberedHeadings: true,
  toc: true,
  citation: true,
  math: true,
  footer: '',
  links: [],
});

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

function color(v) {
  return typeof v === 'string' && v.length < 64 && globalThis.CSS?.supports('color', v) ? v : '';
}

/** Validate a raw "site" object from index.json against the schema above. */
export function normalizeSite(raw, base) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const links = Array.isArray(r.links) ? r.links : [];
  return {
    title: text(r.title, 120) || DEFAULT_SITE.title,
    slogan: text(r.slogan, 200),
    author: text(r.author, 120),
    description: text(r.description, 300),
    theme: oneOf(r.theme, THEMES, DEFAULT_SITE.theme),
    colorScheme: oneOf(r.colorScheme, SCHEMES, DEFAULT_SITE.colorScheme),
    accent: color(r.accent),
    font: oneOf(r.font, FONTS, ''),
    backgroundImage: safeUrl(r.backgroundImage, base),
    backgroundMode: oneOf(r.backgroundMode, BG_MODES, DEFAULT_SITE.backgroundMode),
    stylesheet: safeUrl(r.stylesheet, base),
    numberedHeadings: bool(r.numberedHeadings, DEFAULT_SITE.numberedHeadings),
    toc: bool(r.toc, DEFAULT_SITE.toc),
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
  };
}

/** Apply a normalized site config to the page chrome. */
export function applySite(site) {
  const root = document.documentElement;
  root.dataset.theme = site.theme;
  root.dataset.scheme = site.colorScheme;
  root.dataset.font = site.font || (site.theme === 'modern' ? 'sans' : 'serif');
  root.dataset.numbered = String(site.numberedHeadings);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute(
    'content', site.colorScheme === 'auto' ? 'light dark' : site.colorScheme);

  // CSSOM property writes are not "inline style" as far as CSP is concerned.
  if (site.accent) root.style.setProperty('--accent-base', site.accent);
  if (site.backgroundImage) {
    root.style.setProperty('--bg-image', `url(${JSON.stringify(site.backgroundImage)})`);
    root.dataset.bg = site.backgroundMode;
  }
  if (site.stylesheet) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = site.stylesheet;
    document.head.append(link);
  }
  if (site.description) {
    document.querySelector('meta[name="description"]')?.setAttribute('content', site.description);
  }

  document.querySelector('.site-title').textContent = site.title;
  const slogan = document.querySelector('.site-slogan');
  slogan.textContent = site.slogan;
  slogan.hidden = !site.slogan;

  const nav = document.getElementById('nav');
  const home = document.createElement('a');
  home.href = '#/';
  home.textContent = 'Articles';
  nav.replaceChildren(home);
  for (const l of site.links) {
    const a = document.createElement('a');
    a.href = l.href;
    a.textContent = l.label;
    if (!l.href.startsWith('#')) a.rel = 'noopener noreferrer';
    nav.append(a);
  }

  const footer = document.querySelector('.footer-note');
  footer.textContent = site.footer || (site.author ? `© ${new Date().getFullYear()} ${site.author}` : '');
}
