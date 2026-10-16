// Password-protected posts: keeps the unlock form from ever submitting by
// itself. A plain script with no imports, loaded before app.js, so it runs
// even when app.js cannot (still loading, or a browser holding mismatched
// copies of the site's modules). Decrypting is app.js's job; until it is
// ready (html[data-unlock-ready]) a submission only says what is going on.
// The CSP's form-action 'none' would block a real submission anyway.
document.addEventListener('submit', (e) => {
  const form = e.target.closest && e.target.closest('form.unlock');
  if (!form) return;
  e.preventDefault(); // never sent anywhere; app.js decrypts in the page
  if (document.documentElement.dataset.unlockReady === 'true') return;
  const status = form.querySelector('.unlock-status');
  status.dataset.waiting = 'true';
  status.textContent = 'Still loading… press Unlock again in a moment.';
  clearTimeout(form.unlockTimer);
  form.unlockTimer = setTimeout(() => {
    if (document.documentElement.dataset.unlockReady === 'true') return;
    status.textContent = 'This page did not finish loading. Reload it (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and try again.';
  }, 8000);
}, true);
