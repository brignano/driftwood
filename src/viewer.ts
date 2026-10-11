import type { Snapshot } from './snapshot.js'

/**
 * A single HTML page that shows one snapshot, for a build platform to embed.
 *
 * Self-contained by necessity rather than taste: the page is served from
 * wherever the pipeline uploaded the store — an S3 bucket, an artifact
 * repository, a file on disk — and none of those can be relied on to serve a
 * second asset, let alone reach a CDN from inside a corporate network. So the
 * snapshot, the diagrams and the script are all inline, and the page needs
 * nothing but a browser.
 *
 * It reads what the snapshot already decided. Nothing here re-derives drift or
 * changes; the only computation is graph traversal for blast radius, which is a
 * question about the picture on screen rather than a fact worth storing.
 *
 * Every string that came from infrastructure reaches the DOM through
 * `textContent`, never `innerHTML`. Entity names are data a provider read from
 * someone's cloud account. The diagrams are the one exception, inserted as
 * markup because they are markup — produced by Graphviz, which escapes labels.
 */

/** JSON inside a <script> must not be able to close it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Graphviz output begins with an XML prolog and doctype, neither of which belongs inside HTML. */
function inlineSvg(svg: string): string {
  const start = svg.indexOf('<svg')
  return start === -1 ? '' : svg.slice(start)
}

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0;
  --accent: #2563eb; --added: #7c3aed; --changed: #0891b2; --removed: #dc2626;
  --affected: #dc2626; --depends: #2563eb; --warn: #d97706;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b1120; --panel: #111827; --ink: #e5e7eb; --muted: #94a3b8; --line: #1f2937; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { padding: 16px 20px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 18px 0 8px; }
.meta { color: var(--muted); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 12px; background: var(--bg); }
.chip b { font-weight: 600; }
.chip.warn { border-color: var(--warn); }
main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: calc(100vh - 110px); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
.stage { padding: 12px 16px; min-width: 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.tabs button { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px;
  padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.tabs button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); }
.diagram { background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: calc(100vh - 170px); }
.diagram svg { display: block; max-width: none; height: auto; }
.diagram.fit svg { max-width: 100%; height: auto; }
.toolbar { display: flex; align-items: center; gap: 12px; margin: 8px 2px 0; flex-wrap: wrap; }
.toolbar button { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px;
  padding: 2px 8px; font: inherit; font-size: 12px; cursor: pointer; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 12px; height: 8px; margin-right: 5px;
  border: 2px solid currentColor; border-radius: 3px; vertical-align: middle; }
.legend .l-added { color: var(--added); } .legend .l-changed { color: var(--changed); }
.legend .l-affected { color: var(--affected); } .legend .l-depends { color: var(--depends); }
.legend .l-added::before, .legend .l-changed::before { border-style: dashed; }
.diagram pre { margin: 0; padding: 12px; color: #0f172a; font-size: 12px; white-space: pre; }
.hint { color: var(--muted); font-size: 12px; margin: 0; flex: 1 1 260px; }
aside { border-left: 1px solid var(--line); background: var(--panel); padding: 4px 16px 16px; overflow: auto; }
@media (max-width: 860px) { aside { border-left: 0; border-top: 1px solid var(--line); } }
ul.list { list-style: none; margin: 0; padding: 0; }
ul.list li { padding: 3px 0; font-size: 12px; overflow-wrap: anywhere; }
ul.list button { all: unset; cursor: pointer; color: var(--accent); }
ul.list button:hover { text-decoration: underline; }
.tag { display: inline-block; min-width: 58px; font-size: 11px; font-weight: 600; }
.tag.added { color: var(--added); } .tag.removed { color: var(--removed); } .tag.changed { color: var(--changed); }
.empty { color: var(--muted); font-size: 12px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 12px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.node { cursor: pointer; }
.dw-added > path, .dw-added > polygon { stroke: var(--added) !important; stroke-width: 3 !important; stroke-dasharray: 6 3; }
.dw-changed > path, .dw-changed > polygon { stroke: var(--changed) !important; stroke-width: 3 !important; stroke-dasharray: 6 3; }
.dw-focus .node, .dw-focus .edge { opacity: .18; transition: opacity .15s; }
.dw-focus .node.dw-on, .dw-focus .edge.dw-on { opacity: 1; }
.dw-focus .node.dw-selected > path, .dw-focus .node.dw-selected > polygon { stroke: var(--ink) !important; stroke-width: 3.5 !important; }
.dw-focus .node.dw-affected > path, .dw-focus .node.dw-affected > polygon { stroke: var(--affected) !important; stroke-width: 3 !important; }
.dw-focus .node.dw-depends > path, .dw-focus .node.dw-depends > polygon { stroke: var(--depends) !important; stroke-width: 3 !important; }
`

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('driftwood-data').textContent);
  var snap = data.snapshot;
  var model = snap.observation.model;
  var byId = new Map(model.entities.map(function (e) { return [e.id, e]; }));
  var out = new Map(), into = new Map();
  model.edges.forEach(function (e) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!into.has(e.to)) into.set(e.to, []);
    out.get(e.from).push(e.to);
    into.get(e.to).push(e.from);
  });
  var changes = snap.changes;
  var added = new Set(changes ? changes.entities.added : []);
  var changed = new Map();
  if (changes) changes.entities.changed.forEach(function (c) {
    if (!changed.has(c.id)) changed.set(c.id, []);
    changed.get(c.id).push(c);
  });

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  // Edges point from the dependent to its dependency, so whatever can reach a
  // node depends on it: if it fails, they are affected.
  function walk(start, next) {
    var seen = new Set(), queue = [start];
    while (queue.length) {
      var id = queue.shift();
      (next.get(id) || []).forEach(function (n) {
        if (n !== start && !seen.has(n)) { seen.add(n); queue.push(n); }
      });
    }
    return seen;
  }

  var stage = document.getElementById('diagram');
  var panel = document.getElementById('selection');
  var current = null, selected = null;

  function nodesIn(root) {
    var map = new Map();
    root.querySelectorAll('g.node').forEach(function (g) {
      var t = g.querySelector('title');
      if (t) map.set(t.textContent, g);
    });
    return map;
  }

  function show(index) {
    var d = data.diagrams[index];
    document.querySelectorAll('.tabs button').forEach(function (b, i) {
      b.setAttribute('aria-selected', String(i === index));
    });
    stage.innerHTML = '';
    var tpl = document.getElementById('diagram-' + index);
    stage.appendChild(tpl.content.cloneNode(true));
    current = nodesIn(stage);
    current.forEach(function (g, id) {
      if (added.has(id)) g.classList.add('dw-added');
      else if (changed.has(id)) g.classList.add('dw-changed');
      g.addEventListener('click', function (ev) { ev.stopPropagation(); select(id); });
    });
    var svg = stage.querySelector('svg');
    if (svg) {
      svg.addEventListener('click', function () { select(null); });
    }
    document.getElementById('hint').textContent = current.size
      ? 'Click a component to see what depends on it, as far as the sources record dependencies. Click empty space to clear.'
      : d.renderer === 'mermaid'
        ? 'This snapshot was rendered as Mermaid, shown here as source. Snapshots rendered with Graphviz are interactive.'
        : '';
    if (selected && !byId.has(selected)) selected = null;
    select(selected);
  }

  function select(id) {
    selected = id;
    var svg = stage.querySelector('svg');
    if (svg) {
      svg.classList.toggle('dw-focus', !!id);
      svg.querySelectorAll('.dw-on, .dw-selected, .dw-affected, .dw-depends').forEach(function (n) {
        n.classList.remove('dw-on', 'dw-selected', 'dw-affected', 'dw-depends');
      });
    }
    panel.innerHTML = '';
    if (!id) {
      panel.appendChild(el('p', 'Select a component in the diagram, or from the lists below.', 'empty'));
      return;
    }
    var e = byId.get(id);
    var affected = walk(id, into), depends = walk(id, out);
    if (svg && current) {
      var mark = function (ids, cls) {
        ids.forEach(function (n) { var g = current.get(n); if (g) g.classList.add('dw-on', cls); });
      };
      mark([id], 'dw-selected'); mark(affected, 'dw-affected'); mark(depends, 'dw-depends');
      var lit = new Set([id].concat(Array.from(affected), Array.from(depends)));
      svg.querySelectorAll('g.edge').forEach(function (g) {
        var t = g.querySelector('title');
        if (!t) return;
        var parts = t.textContent.split('->');
        if (parts.length === 2 && lit.has(parts[0]) && lit.has(parts[1])) g.classList.add('dw-on');
      });
    }
    panel.appendChild(el('h2', e && e.name ? e.name : id));
    var dl = el('dl');
    var row = function (k, v) { if (v) { dl.appendChild(el('dt', k)); dl.appendChild(el('dd', v)); } };
    row('id', id);
    if (e) { row('kind', e.kind); row('group', e.group); row('platform', e.platform); row('source', e.source); }
    if (snap.health && snap.health[id]) row('health', snap.health[id]);
    if (added.has(id)) row('this deploy', 'added');
    (changed.get(id) || []).forEach(function (c) {
      row('this deploy', c.field + ': ' + (c.before || '-') + ' \\u2192 ' + (c.after || '-'));
    });
    panel.appendChild(dl);
    panel.appendChild(el('h2', 'Affected if this fails (' + affected.size + ')'));
    panel.appendChild(idList(affected));
    panel.appendChild(el('h2', 'Depends on (' + depends.size + ')'));
    panel.appendChild(idList(depends));
  }

  function idList(ids) {
    if (!ids.size) return el('p', 'Nothing.', 'empty');
    var ul = el('ul', null, 'list');
    Array.from(ids).sort().forEach(function (id) {
      var li = el('li'), b = el('button', id);
      b.addEventListener('click', function () { select(id); });
      li.appendChild(b); ul.appendChild(li);
    });
    return ul;
  }

  var zoom = document.getElementById('zoom');
  zoom.addEventListener('click', function () {
    // Fitting only ever shrinks: a small view drawn at its natural size is
    // already readable, and blowing it up to the panel's width is not.
    var fit = stage.classList.toggle('fit');
    zoom.textContent = fit ? 'Actual size' : 'Fit to width';
  });

  var tabs = document.getElementById('tabs');
  data.diagrams.forEach(function (d, i) {
    var b = el('button', d.title);
    b.setAttribute('role', 'tab');
    b.addEventListener('click', function () { show(i); });
    tabs.appendChild(b);
  });

  var list = document.getElementById('changes');
  if (!changes) {
    list.appendChild(el('p', 'No previous deploy to compare against.', 'empty'));
  } else {
    var ul = el('ul', null, 'list'), any = false;
    var item = function (tag, id, text, clickable) {
      any = true;
      var li = el('li');
      li.appendChild(el('span', tag, 'tag ' + tag));
      if (clickable) {
        var b = el('button', text);
        b.addEventListener('click', function () { select(id); });
        li.appendChild(b);
      } else li.appendChild(el('span', text));
      ul.appendChild(li);
    };
    changes.entities.added.forEach(function (id) { item('added', id, id, byId.has(id)); });
    changed.forEach(function (cs, id) {
      item('changed', id, id + ' (' + cs.map(function (c) { return c.field; }).join(', ') + ')', byId.has(id));
    });
    changes.entities.removed.forEach(function (e) { item('removed', e.id, e.id, false); });
    var edges = changes.edges.added.length + changes.edges.removed.length;
    if (edges) {
      var li = el('li', changes.edges.added.length + ' relationships added, ' + changes.edges.removed.length + ' removed', 'empty');
      ul.appendChild(li); any = true;
    }
    list.appendChild(any ? ul : el('p', 'No structural change since the previous deploy.', 'empty'));
  }

  show(0);
})();
`

function chips(snapshot: Snapshot): string {
  const out: string[] = []
  const model = snapshot.observation.model
  out.push(`<span class="chip"><b>${model.entities.length}</b> entities</span>`)
  out.push(`<span class="chip"><b>${model.edges.length}</b> relationships</span>`)
  const c = snapshot.changes
  if (c) {
    const n =
      c.entities.added.length + c.entities.removed.length + c.entities.changed.length + c.edges.added.length + c.edges.removed.length
    out.push(`<span class="chip${n ? ' warn' : ''}"><b>${n}</b> ${n === 1 ? 'change' : 'changes'} since the last deploy</span>`)
  }
  const d = snapshot.drift
  if (d) {
    out.push(
      d.hasDrift
        ? '<span class="chip warn">differs from the committed design</span>'
        : '<span class="chip">matches the committed design</span>',
    )
    if (d.entities.unverifiable.length) {
      out.push(`<span class="chip"><b>${d.entities.unverifiable.length}</b> in a blind spot, not checked</span>`)
    }
  }
  if (snapshot.health) {
    const counts = { healthy: 0, degraded: 0, down: 0 }
    for (const s of Object.values(snapshot.health)) counts[s]++
    if (counts.down) out.push(`<span class="chip warn"><b>${counts.down}</b> down</span>`)
    if (counts.degraded) out.push(`<span class="chip warn"><b>${counts.degraded}</b> degraded</span>`)
  }
  return out.join('')
}

/**
 * Renders the page. `files` holds the diagrams the snapshot lists, keyed by
 * file name, exactly as `takeSnapshot` produced them.
 */
export function renderViewer(snapshot: Snapshot, files: Record<string, string>): string {
  const { app, environment, build } = snapshot.subject
  const title = `${app} · ${environment}${build ? ` · ${build}` : ''}`
  const origin = Object.entries(snapshot.observation.origin).map(([k, v]) => `${k}=${v}`)
  const sources = snapshot.observation.sources.map((s) => `${s.provider} (${s.entities}/${s.edges})`)
  const meta = [`Observed ${snapshot.observation.observedAt}`, sources.length ? `via ${sources.join(', ')}` : '', ...origin]
    .filter(Boolean)
    .join(' · ')

  const templates = snapshot.diagrams
    .map((d, i) => {
      const body = files[d.file] ?? ''
      const inner = d.file.endsWith('.svg') ? inlineSvg(body) : `<pre>${escapeHtml(body)}</pre>`
      return `<template id="diagram-${i}">${inner}</template>`
    })
    .join('\n')

  // The page needs the model, changes and health, not the diagrams twice.
  const data = { snapshot, diagrams: snapshot.diagrams.map((d) => ({ title: d.title, renderer: d.renderer })) }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · driftwood</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
  <div class="chips">${chips(snapshot)}</div>
</header>
<main>
  <section class="stage">
    <div class="tabs" id="tabs" role="tablist"></div>
    <div class="diagram fit" id="diagram"></div>
    <div class="toolbar">
      <button type="button" id="zoom">Actual size</button>
      <p class="hint" id="hint"></p>
    </div>
    <div class="legend">
      <span class="l-added">added by this deploy</span><span class="l-changed">changed by this deploy</span>
      <span class="l-affected">affected if the selection fails</span><span class="l-depends">what the selection depends on</span>
    </div>
  </section>
  <aside>
    <h2>Selected</h2>
    <div id="selection"></div>
    <h2>Changed by this deploy</h2>
    <div id="changes"></div>
  </aside>
</main>
${templates}
<script type="application/json" id="driftwood-data">${scriptJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}
