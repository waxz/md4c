// The links between posts as a graph, in the manner of Obsidian's graph
// view: a force-directed layout drawn on a <canvas>, no dependencies.
//
//   graphData(items, opts)   nodes and edges from index.json's items
//                            (each item's "links" lists the posts it links to)
//   neighbourhood(g, id, d)  the part of a graph within d links of one node
//   drawGraph(box, g, opts)  draw it: drag nodes, drag the background to pan,
//                            scroll or pinch to zoom, hover to highlight a
//                            node's links, click to open its post
//
// Links count both ways: a post's node joins the posts it links to and the
// posts that link to it (its backlinks). Colours come from the page's CSS
// variables, so the graph follows the theme and dark mode.

const POST = 'post';
const TAG = 'tag';
const MISSING = 'missing';

/**
 * { nodes: [{ id, kind, label, href, slug }], edges: [[a, b]] } from
 * index.json items. `postHref(slug)` makes a post's link; with `tags`,
 * each tag is a node joined to its posts. Links to posts that do not
 * exist become dim "missing" nodes, as in Obsidian.
 */
export function graphData(items, { postHref, tags = false, tagHref } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const posts = items.filter((e) => e && typeof e === 'object' && /^posts\/[^/]+\.md$/.test(e.path ?? '') && e.metadata);
  const slugOf = (e) => e.path.slice('posts/'.length, -'.md'.length);
  for (const e of posts) {
    const slug = slugOf(e);
    nodes.set(`p:${slug}`, {
      id: `p:${slug}`, kind: POST, slug, label: e.metadata.title || slug,
      href: postHref(slug, e), protected: e.metadata.protected === 'true',
    });
  }
  const join = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (!edges.has(key)) edges.set(key, a < b ? [a, b] : [b, a]);
  };
  for (const e of posts) {
    const from = `p:${slugOf(e)}`;
    for (const slug of Array.isArray(e.links) ? e.links : []) {
      if (typeof slug !== 'string' || !slug) continue;
      const to = `p:${slug}`;
      if (!nodes.has(to)) nodes.set(to, { id: to, kind: MISSING, slug, label: slug, href: '' });
      join(from, to);
    }
    if (tags) {
      for (const t of String(e.metadata.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const id = `t:${t}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: TAG, label: `#${t}`, href: tagHref ? tagHref(t) : '' });
        join(from, id);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Adjacency: node id -> Set of neighbour ids. */
function adjacency(g) {
  const adj = new Map(g.nodes.map((n) => [n.id, new Set()]));
  for (const [a, b] of g.edges) {
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  }
  return adj;
}

/** The nodes within `depth` links of `id`, and the edges among them. */
export function neighbourhood(g, id, depth = 1) {
  const adj = adjacency(g);
  const keep = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!keep.has(m)) {
          keep.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: g.nodes.filter((n) => keep.has(n.id)),
    edges: g.edges.filter(([a, b]) => keep.has(a) && keep.has(b)),
  };
}

/** A stable pseudo-random number in [0, 1) for a string. */
function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return ((h >>> 0) % 100000) / 100000;
}

/** A CSS colour variable resolved to rgb(), which a canvas understands (color-mix() it may not). */
function cssColour(el, name, fallback) {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.color = `var(${name}, ${fallback})`;
  el.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || fallback;
}

/**
 * Draw graph `g` into `box`. Options:
 *   focus    node id drawn larger and in the accent colour (a post's own node)
 *   onOpen   (node) => void, on click; default: follow node.href
 *   label    'auto' (labels fade in as you zoom) | 'always'
 * Returns { destroy() }.
 */
export function drawGraph(box, g, { focus = '', onOpen, label = 'auto' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Graph of ${g.nodes.length} article${g.nodes.length === 1 ? '' : 's'} and their links`);
  box.append(canvas);
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const adj = adjacency(g);
  const byId = new Map();
  const n = g.nodes.length;
  const spread = 40 * Math.sqrt(n + 1);
  const nodes = g.nodes.map((node) => {
    const a = hash01(node.id) * Math.PI * 2;
    const r = spread * (0.3 + 0.7 * hash01(`${node.id}#r`));
    const sim = {
      ...node, x: node.id === focus ? 0 : Math.cos(a) * r, y: node.id === focus ? 0 : Math.sin(a) * r,
      vx: 0, vy: 0, degree: adj.get(node.id).size, fixed: false,
    };
    sim.radius = (node.id === focus ? 6 : 3.5) + Math.sqrt(sim.degree) * 1.6;
    byId.set(node.id, sim);
    return sim;
  });
  const edges = g.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(([a, b]) => a && b);

  // View: world -> screen is (x * scale + tx, y * scale + ty), in CSS pixels.
  const view = { scale: 1, tx: 0, ty: 0, width: 0, height: 0 };
  let colours;
  const readColours = () => {
    colours = {
      ink: cssColour(box, '--ink', '#222'),
      muted: cssColour(box, '--muted', '#777'),
      rule: cssColour(box, '--rule-graph', '#bbb'),
      accent: cssColour(box, '--accent', '#8b1e2d'),
      paper: cssColour(box, '--paper', '#fff'),
      font: getComputedStyle(box).fontFamily || 'sans-serif',
    };
  };
  readColours();

  /* ---------- Layout: a small force simulation ---------- */

  let alpha = 1;
  const LINK = 70;
  function tick() {
    // Repulsion between every pair (fine for a blog's few hundred posts).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = hash01(a.id + b.id) - 0.5;
          dy = hash01(b.id + a.id) - 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        if (d2 > 250000) continue; // too far apart to matter
        const f = (900 * alpha) / d2;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }
    // Links pull their ends to about LINK apart.
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - LINK) / d) * 0.06 * alpha;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const p of nodes) {
      // A gentle pull to the centre keeps unlinked posts in view.
      p.vx -= p.x * 0.012 * alpha;
      p.vy -= p.y * 0.012 * alpha;
      if (p.fixed) {
        p.vx = p.vy = 0;
        continue;
      }
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x += p.vx;
      p.y += p.vy;
    }
    alpha *= 0.985;
  }

  function fit() {
    if (!nodes.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of nodes) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    // Room for the labels: wider at the sides, and below the lowest node.
    const padX = Math.min(90, view.width / 5);
    const padY = 30;
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    view.scale = Math.min(2, (view.width - padX * 2) / w, (view.height - padY * 2 - 14) / h);
    view.tx = view.width / 2 - ((minX + maxX) / 2) * view.scale;
    view.ty = (view.height - 14) / 2 - ((minY + maxY) / 2) * view.scale;
  }

  /* ---------- Drawing ---------- */

  let hover = null;
  let dragging = null;
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    const lit = hover ? new Set([hover.id, ...adj.get(hover.id)]) : null;

    ctx.lineWidth = 1 / view.scale;
    for (const [a, b] of edges) {
      const on = lit && (a === hover || b === hover);
      ctx.strokeStyle = on ? colours.accent : colours.rule;
      ctx.globalAlpha = lit && !on ? 0.25 : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const p of nodes) {
      const dim = lit && !lit.has(p.id);
      ctx.globalAlpha = dim ? 0.25 : p.kind === MISSING ? 0.55 : 1;
      ctx.fillStyle = p === hover || p.id === focus ? colours.accent
        : p.kind === TAG ? colours.muted : p.kind === MISSING ? colours.rule : colours.ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      if (p.kind === MISSING) {
        ctx.strokeStyle = colours.muted;
        ctx.stroke();
      }
    }
    // Labels: always for the highlighted nodes; others fade in with zoom.
    const fade = label === 'always' ? 1 : Math.max(0, Math.min(1, (view.scale - 0.3) / 0.35));
    const size = 12 / view.scale;
    ctx.font = `${size}px ${colours.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const p of nodes) {
      const strong = (lit && lit.has(p.id)) || p.id === focus;
      const a = strong ? 1 : lit ? fade * 0.2 : fade;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const text = p.label.length > 40 ? `${p.label.slice(0, 39)}…` : p.label;
      ctx.lineWidth = 3 / view.scale;
      ctx.strokeStyle = colours.paper;
      ctx.strokeText(text, p.x, p.y + p.radius + 3 / view.scale);
      ctx.fillStyle = p === hover ? colours.accent : colours.ink;
      ctx.fillText(text, p.x, p.y + p.radius + 3 / view.scale);
    }
    ctx.globalAlpha = 1;
  }

  let frame = 0;
  let userMoved = false;
  function loop() {
    frame = 0;
    tick();
    if (!userMoved) fit();
    draw();
    if (alpha > 0.02 || dragging) frame = requestAnimationFrame(loop);
  }
  const reheat = (to = 0.3) => {
    alpha = Math.max(alpha, to);
    if (!frame && !reduceMotion) frame = requestAnimationFrame(loop);
  };
  const redraw = () => {
    if (!frame) draw();
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    view.width = rect.width;
    view.height = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (!userMoved) fit();
    redraw();
  }

  // Lay most of it out before the first frame, so it appears nearly settled.
  for (let i = 0; i < (reduceMotion ? 400 : 120); i++) tick();
  if (reduceMotion) alpha = 0;

  /* ---------- Interaction ---------- */

  const toWorld = (sx, sy) => ({ x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale });
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function nodeAt(sx, sy) {
    const w = toWorld(sx, sy);
    let best = null;
    let bestD = Infinity;
    for (const p of nodes) {
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      const reach = p.radius + 6 / view.scale; // easier to hit with a finger
      if (d < reach && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }
  function zoomAt(sx, sy, factor) {
    const s = Math.max(0.15, Math.min(6, view.scale * factor));
    const w = toWorld(sx, sy);
    view.scale = s;
    view.tx = sx - w.x * s;
    view.ty = sy - w.y * s;
    userMoved = true;
    redraw();
  }

  const pointers = new Map();
  let press = null; // { node, x, y, moved, tx, ty }
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const at = local(e);
    pointers.set(e.pointerId, at);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      if (dragging) dragging.fixed = false;
      dragging = null;
      press = null;
      return;
    }
    const node = nodeAt(at.x, at.y);
    press = { node, x: at.x, y: at.y, moved: false, tx: view.tx, ty: view.ty };
    if (node) {
      dragging = node;
      node.fixed = true;
      hover = node;
      reheat();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const at = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, at);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.scale * d) / pinch.d / view.scale);
      return;
    }
    if (press) {
      if (Math.hypot(at.x - press.x, at.y - press.y) > 4) press.moved = true;
      if (dragging) {
        const w = toWorld(at.x, at.y);
        dragging.x = w.x;
        dragging.y = w.y;
        userMoved = true;
        reheat();
        if (reduceMotion) redraw();
      } else if (press.moved) {
        view.tx = press.tx + at.x - press.x;
        view.ty = press.ty + at.y - press.y;
        userMoved = true;
        redraw();
      }
      return;
    }
    if (e.pointerType === 'mouse') {
      const over = nodeAt(at.x, at.y);
      if (over !== hover) {
        hover = over;
        canvas.style.cursor = over && over.href ? 'pointer' : 'grab';
        redraw();
      }
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!press) return;
    const { node, moved } = press;
    press = null;
    if (dragging) {
      dragging.fixed = false;
      dragging = null;
      reheat(0.1);
    }
    if (e.type === 'pointerup' && node && !moved && node.href) {
      if (onOpen) onOpen(node);
      else location.href = node.href;
      return;
    }
    if (e.pointerType !== 'mouse') {
      hover = null;
      redraw();
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !press && hover) {
      hover = null;
      redraw();
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const at = local(e);
    zoomAt(at.x, at.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    userMoved = false;
    fit();
    redraw();
  });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    readColours();
    redraw();
  };
  scheme.addEventListener('change', onScheme);
  // Fonts loading late change the label font.
  document.fonts?.ready.then(onScheme);

  resize();
  if (!reduceMotion) reheat(alpha);

  return {
    destroy() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      scheme.removeEventListener('change', onScheme);
      canvas.remove();
    },
  };
}
