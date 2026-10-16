// Google tag (gtag.js) setup, for site.googleTag ("G-XXXXXXXXXX").
//
// Google's snippet sets up gtag() in an inline <script>, which the pages'
// CSP does not allow; this file does the same from the site's own storage,
// with the ID in its data-id attribute. Pages include it, after Google's
// loader, only when the site settings have a Google tag.
(function () {
  var id = document.currentScript && document.currentScript.getAttribute('data-id');
  if (!id) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id);
})();
