// Background tasks: publishing, unpublishing, deleting and site updates
// run here while the admin stays usable. Each task is listed in the
// Activity panel (a side panel, never modal) with its progress, log and
// outcome; a small indicator in the header shows how many are running.
//
//   runTask(title, fn, { key })   fn(ctx) runs now; ctx.step(text), ctx.log(line),
//                                 ctx.link(url, label). Resolves with fn's
//                                 result, or rejects (the panel shows why).
//                                 Throw new Cancelled() to end quietly.
//   requestBuild(opts, runner)    the site build, one at a time: requests made
//                                 while one waits are merged into it (full if
//                                 any asked for full; the latest settings win)
//   busyKeys()                    posts with a task running (posts list chips)
//
// A "tasks" event on window announces every change.

export class Cancelled extends Error {
  constructor(message = 'Cancelled') {
    super(message);
  }
}

const tasks = [];
let nextId = 1;
let panel = null;
let toggle = null;
let renderQueued = false;

const changed = (task) => {
  scheduleRender();
  window.dispatchEvent(new CustomEvent('tasks', { detail: { task } }));
};

export function runTask(title, fn, { key = '' } = {}) {
  const task = {
    id: nextId++, title, key, status: 'running', step: '', log: [], error: '', links: [],
    started: Date.now(), ended: 0,
  };
  tasks.unshift(task);
  changed(task);
  const ctx = {
    step(text) {
      task.step = text;
      changed(task);
    },
    log(line) {
      task.log.push(line);
      scheduleRender();
    },
    link(url, label) {
      if (url) task.links.push({ url, label });
    },
  };
  return (async () => {
    try {
      const result = await fn(ctx);
      task.status = 'done';
      task.step = '';
      return result;
    } catch (err) {
      if (err instanceof Cancelled) {
        task.status = 'cancelled';
        task.step = err.message;
        throw err;
      }
      task.status = 'failed';
      task.error = err?.message ?? String(err);
      openPanel(); // a failure is worth seeing
      throw err;
    } finally {
      task.ended = Date.now();
      changed(task);
    }
  })();
}

export const busyKeys = () => new Set(tasks.filter((t) => t.status === 'running' && t.key).map((t) => t.key));
export const running = () => tasks.filter((t) => t.status === 'running');

/* ---------- The site build: one at a time, requests merged ---------- */

let building = false;
// Waiting builds, one per blog ("site", "private"): requests for the same
// blog join the one waiting; builds run one at a time.
const pending = new Map(); // target -> { opts, runner, promise, resolve, reject }

export function requestBuild(opts, runner) {
  const target = opts.target ?? 'site';
  const waiting = pending.get(target);
  if (waiting) {
    waiting.opts = {
      ...waiting.opts, ...opts,
      full: Boolean(waiting.opts.full || opts.full),
      ...(opts.site !== undefined ? { site: opts.site } : {}),
    };
    waiting.runner = runner;
    return waiting.promise;
  }
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // reported in the panel; callers may not wait
  pending.set(target, { opts: { ...opts, target }, runner, promise, resolve, reject });
  startBuild();
  return promise;
}

async function startBuild() {
  if (building || !pending.size) return;
  const [target, job] = pending.entries().next().value;
  pending.delete(target);
  building = true;
  const title = target === 'private'
    ? (job.opts.full ? 'Rebuild every private page' : 'Update the private blog')
    : (job.opts.full ? 'Rebuild every page' : 'Update the site');
  try {
    job.resolve(await runTask(title, (ctx) => job.runner(job.opts, ctx)));
  } catch (err) {
    job.reject(err);
  } finally {
    building = false;
    startBuild();
  }
}

/* ---------- The Activity panel ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICON = { running: '', done: '✓', failed: '✕', cancelled: '–' };

function ensureUi() {
  if (panel) return;
  toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'activity-toggle';
  toggle.setAttribute('aria-controls', 'activity');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  document.querySelector('.app-bar')?.append(toggle);

  panel = document.createElement('aside');
  panel.id = 'activity';
  panel.className = 'activity';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Activity');
  panel.innerHTML = `<div class="activity-head"><h2>Activity</h2>
    <button type="button" class="btn btn-small" data-act="clear">Clear finished</button>
    <button type="button" class="activity-close" data-act="close" aria-label="Close">×</button></div>
    <ol class="activity-list" aria-live="polite"></ol>`;
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closePanel();
    if (act === 'clear') {
      for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].status !== 'running') tasks.splice(i, 1);
      render();
    }
    if (act === 'dismiss') {
      const id = Number(e.target.closest('[data-id]').dataset.id);
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0 && tasks[i].status !== 'running') tasks.splice(i, 1);
      render();
    }
  });
  document.body.append(panel);
  // Leaving the page would stop what is still running.
  window.addEventListener('beforeunload', (e) => {
    if (running().length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

export function openPanel() {
  ensureUi();
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  render();
}

function closePanel() {
  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function elapsed(t) {
  const s = Math.round(((t.ended || Date.now()) - t.started) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function render() {
  ensureUi();
  const busy = running().length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  toggle.hidden = !tasks.length;
  toggle.dataset.state = busy ? 'running' : failed ? 'failed' : 'idle';
  toggle.innerHTML = busy
    ? `<span class="spinner" aria-hidden="true"></span> ${busy} running`
    : failed ? `✕ ${failed} failed` : 'Activity';
  toggle.setAttribute('aria-label', busy ? `${busy} task(s) running; show activity` : 'Show activity');
  if (panel.hidden) return;
  const list = panel.querySelector('.activity-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.closest('[data-id]').dataset.id));
  list.innerHTML = tasks.length ? tasks.map((t) => `<li class="task task-${t.status}" data-id="${t.id}">
    <div class="task-head">
      <span class="task-icon" aria-hidden="true">${t.status === 'running' ? '<span class="spinner"></span>' : ICON[t.status]}</span>
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-time muted">${elapsed(t)}</span>
      ${t.status !== 'running' ? '<button type="button" class="task-dismiss" data-act="dismiss" aria-label="Dismiss">×</button>' : ''}
    </div>
    ${t.step ? `<p class="task-step muted">${esc(t.step)}</p>` : ''}
    ${t.error ? `<p class="task-error">${esc(t.error)}</p>` : ''}
    ${t.links.length ? `<p class="task-links">${t.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' · ')}</p>` : ''}
    ${t.log.length ? `<details${open.has(String(t.id)) ? ' open' : ''}><summary>Details (${t.log.length})</summary><pre>${esc(t.log.join('\n'))}</pre></details>` : ''}
  </li>`).join('') : '<li class="muted">Nothing yet. Publishing, unpublishing and deleting show up here.</li>';
}

// Keep the running times fresh while the panel is open.
setInterval(() => {
  if (panel && !panel.hidden && running().length) render();
}, 1000);
