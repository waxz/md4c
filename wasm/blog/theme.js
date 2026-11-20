// Applies the "site" settings (see lib/site-config.js) to the page chrome.
// Settings are applied through CSS custom properties and data attributes,
// never inline style markup, so the page's strict CSP stays intact.

import { siteLinkHref } from './lib/site-config.js';

export { DEFAULT_SITE, normalizeSite } from './lib/site-config.js';

/** Apply a normalized site config to the page chrome. */
export function applySite(site) {
  const siteRoot = new URL('./', import.meta.url).href;
  const root = document.documentElement;
  root.lang = site.language;
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

  const title = document.querySelector('.site-title');
  title.textContent = site.title;
  title.href = `${siteRoot}index.html`;
  const slogan = document.querySelector('.site-slogan');
  slogan.textContent = site.slogan;
  slogan.hidden = !site.slogan;

  const nav = document.getElementById('nav');
  const home = document.createElement('a');
  home.href = `${siteRoot}index.html`;
  home.textContent = 'Articles';
  nav.replaceChildren(home);
  if (site.graph) {
    const graph = document.createElement('a');
    graph.href = `${siteRoot}graph.html`;
    graph.textContent = 'Graph';
    nav.append(graph);
  }
  for (const l of site.links) {
    const a = document.createElement('a');
    a.href = siteLinkHref(l.href, siteRoot);
    a.textContent = l.label;
    if (!l.href.startsWith('#')) a.rel = 'noopener noreferrer';
    nav.append(a);
  }

  const footer = document.querySelector('.footer-note');
  footer.textContent = site.footer || (site.author ? `© ${new Date().getFullYear()} ${site.author}` : '');
}
