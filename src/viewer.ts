import { TOKENS_CSS } from './design.js'
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

/**
 * The page is styled by @brignano/design: its stylesheet is inlined ahead of
 * this one (the page must stay self-contained) and everything below uses its
 * tokens, so the viewer follows the system's light and dark themes and a
 * host's `data-theme`. That includes the diagrams: Graphviz drew them in the
 * light theme's literal colours, so the rules under "Diagram" repaint every
 * part of the SVG from tokens, and a dark page gets a dark diagram.
 *
 * Layout follows DESIGN.md §9: the verdict first, then the pills that back it
 * up, then the picture, which is neutral except where something changed or is
 * unhealthy.
 */
const STYLE = `
${TOKENS_CSS}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: var(--text-base)/1.45 var(--sans); font-feature-settings: "tnum"; }
:focus-visible { outline: 2px solid var(--i-ink); outline-offset: 2px; }
.eyebrow { font: 500 var(--text-xs)/1.4 var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft); margin: 0; }
header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--s4) var(--s6);
  padding: var(--s5) var(--s5) var(--s4); border-bottom: 1px solid var(--line); background: var(--card); }
header .lead { display: flex; flex-direction: column; gap: 6px; flex: 1 1 520px; min-width: 0; }
h1 { font-size: var(--text-xl); font-weight: 600; letter-spacing: -.01em; margin: 0; }
h2 { font: 500 var(--text-xs)/1.4 var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft); margin: var(--s5) 0 var(--s2); }
.meta { color: var(--ink-soft); font: var(--text-xs)/1.5 var(--mono); margin: 0; overflow-wrap: anywhere; }
.pills { display: flex; flex-wrap: wrap; gap: var(--s2); }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
  padding: 2px 10px; font-size: var(--text-sm); background: var(--card); }
.pill b { font-weight: 600; }
.pill.warn { border-color: var(--attention-line); background: var(--attention-surface); }
.pill.warn::before { content: "\\25B2"; color: var(--attention-ink); font-size: .75em; }
.pill.danger { border-color: var(--danger-line); background: var(--danger-surface); }
.pill.danger::before { content: "\\2715"; color: var(--danger-ink); font-size: .8em; }
main { display: flex; flex-wrap: wrap; min-height: calc(100vh - 120px); }
nav { flex: 1 1 200px; max-width: 240px; padding: var(--s4) var(--s3); border-right: 1px solid var(--line); }
nav .eyebrow { padding: 0 10px var(--s2); }
.views { display: flex; flex-direction: column; gap: 2px; }
.views button { all: unset; box-sizing: border-box; display: flex; justify-content: space-between; align-items: center; gap: var(--s2);
  width: 100%; min-height: 36px; padding: 6px 10px; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--ink); cursor: pointer; }
.views button:hover { background: var(--surface-hover); }
.views button:active { background: var(--surface-active); }
.views button[aria-selected="true"] { background: var(--i-surface); color: var(--i-ink); font-weight: 500; }
.views button:focus-visible { outline: 2px solid var(--i-ink); outline-offset: 2px; }
.views .count { font: var(--text-xs) var(--mono); color: var(--ink-soft); }
.views .dot { display: inline-block; width: 6px; height: 6px; border-radius: 3px; background: var(--attention); margin-right: 6px; vertical-align: middle; }
.stage { flex: 999 1 560px; min-width: 0; padding: var(--s4) var(--s5); display: flex; flex-direction: column; gap: var(--s3); }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
.toolbar button { border: 1px solid var(--line-strong); background: var(--card); color: var(--ink); border-radius: var(--radius-sm);
  padding: 4px 10px; font: inherit; font-size: var(--text-sm); cursor: pointer; }
.toolbar button:hover { background: var(--surface-hover); }
.legend { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: center; font-size: var(--text-sm); color: var(--ink-soft); }
.tag { display: inline-block; font: 500 10px/1.5 var(--mono); padding: 0 6px; border-radius: 4px; border: 1px solid var(--line-strong);
  color: var(--ink-soft); background: var(--card); white-space: nowrap; }
.tag.added { color: var(--diff-added-ink); border-color: var(--diff-added); }
.tag.changed { color: var(--diff-changed-ink); border-color: var(--diff-changed); }
.tag.removed { border-style: dashed; }
.tag.down { color: var(--danger-ink); border-color: var(--danger); }
.tag.degraded { color: var(--attention-ink); border-color: var(--attention); }
.diagram { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); overflow: auto; max-height: calc(100vh - 200px);
  background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 16px 16px; }
.diagram svg { display: block; max-width: none; height: auto; margin: 0 auto; }
.diagram.fit svg { max-width: 100%; height: auto; }
.diagram pre { margin: 0; padding: 12px; color: var(--ink); font: var(--text-sm)/1.5 var(--mono); white-space: pre; }
.hint { color: var(--ink-soft); font-size: var(--text-sm); margin: 0; }
aside { flex: 1 1 300px; max-width: 380px; border-left: 1px solid var(--line); background: var(--card); padding: var(--s1) var(--s5) var(--s5); overflow: auto; }
@media (max-width: 860px) { nav { max-width: none; border-right: 0; border-bottom: 1px solid var(--line); } aside { max-width: none; border-left: 0; border-top: 1px solid var(--line); } }
aside .name { font-size: var(--text-lg); font-weight: 600; margin: 0; overflow-wrap: anywhere; }
ul.list { list-style: none; margin: 0; padding: 0; }
ul.list li { display: flex; gap: var(--s2); align-items: baseline; padding: 4px 0; font-size: var(--text-sm); overflow-wrap: anywhere; border-bottom: 1px solid var(--line); }
ul.list li:last-child { border-bottom: 0; }
ul.list button { all: unset; cursor: pointer; color: var(--i-ink); }
ul.list button:hover { text-decoration: underline; }
ul.list button:focus-visible { outline: 2px solid var(--i-ink); outline-offset: 2px; }
.empty { color: var(--ink-soft); font-size: var(--text-sm); margin: 0; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: var(--text-sm); margin: var(--s2) 0 0; }
dt { color: var(--ink-soft); } dd { margin: 0; overflow-wrap: anywhere; }

/* Diagram: repaint Graphviz's light-theme literals from tokens. */
.diagram .graph > polygon { fill: transparent; stroke: none; }
.diagram .cluster > path, .diagram .cluster > polygon { fill: var(--line-soft); stroke: var(--line); }
.diagram .cluster > text { fill: var(--ink-soft); }
.diagram .node { cursor: pointer; transition: opacity var(--dur-fast) var(--ease); }
.diagram .node > path, .diagram .node > polygon { fill: var(--card); stroke: var(--line-strong); stroke-width: 1.2; }
.diagram .node > text { fill: var(--ink); }
.diagram .node > text ~ text { fill: var(--ink-soft); }
.diagram .node .driftwood-icon { stroke: var(--ink-soft); color: var(--ink-soft); }
.diagram .edge { transition: opacity var(--dur-fast) var(--ease); }
.diagram .edge > path { stroke: var(--slate); }
.diagram .edge > polygon { fill: var(--slate); stroke: var(--slate); }
.diagram .edge > text { fill: var(--ink-soft); }
.diagram .dw-degraded > path, .diagram .dw-degraded > polygon { fill: var(--attention-surface); stroke: var(--attention); stroke-width: 2; }
.diagram .dw-down > path, .diagram .dw-down > polygon { fill: var(--danger-surface); stroke: var(--danger); stroke-width: 2; }
.diagram .dw-added > path, .diagram .dw-added > polygon { stroke: var(--diff-added); stroke-width: 2.5; }
.diagram .dw-changed > path, .diagram .dw-changed > polygon { stroke: var(--diff-changed); stroke-width: 2.5; }
.dw-focus .node, .dw-focus .edge { opacity: .3; }
.dw-focus .node.dw-on, .dw-focus .edge.dw-on { opacity: 1; }
.dw-focus .edge.dw-on > path { stroke: var(--ink); stroke-width: 1.6; }
.dw-focus .edge.dw-on > polygon { fill: var(--ink); stroke: var(--ink); }
.diagram .node.dw-selected > path, .diagram .node.dw-selected > polygon { stroke: var(--i-ink); stroke-width: 3.5; }
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
  // A collapsed Terraform module is one node standing for several entities.
  // members maps its node id to them, and owner maps each of them back.
  var members = {}, owner = new Map();
  var inside = function (id) { return members[id] || [id]; };
  var drawn = function (id) { return owner.get(id) || id; };
  var HEALTH_RANK = { healthy: 0, degraded: 1, down: 2 };
  function worstHealth(ids) {
    var worst = null;
    ids.forEach(function (n) {
      var h = snap.health && snap.health[n];
      if (h && (worst === null || HEALTH_RANK[h] > HEALTH_RANK[worst])) worst = h;
    });
    return worst;
  }

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
    document.querySelectorAll('.views button').forEach(function (b, i) {
      b.setAttribute('aria-selected', String(i === index));
    });
    stage.innerHTML = '';
    var tpl = document.getElementById('diagram-' + index);
    stage.appendChild(tpl.content.cloneNode(true));
    members = d.members || {};
    owner = new Map();
    Object.keys(members).forEach(function (m) { members[m].forEach(function (n) { owner.set(n, m); }); });
    current = nodesIn(stage);
    current.forEach(function (g, id) {
      var ids = inside(id);
      if (ids.every(function (n) { return added.has(n); })) g.classList.add('dw-added');
      else if (ids.some(function (n) { return added.has(n) || changed.has(n); })) g.classList.add('dw-changed');
      var h = worstHealth(ids);
      if (h === 'down' || h === 'degraded') g.classList.add('dw-' + h);
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
    if (selected && !byId.has(selected) && !members[selected]) selected = null;
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
    // For a collapsed module: everything outside it that reaches, or is
    // reached from, anything inside it.
    var self = inside(id), affected = new Set(), depends = new Set();
    self.forEach(function (n) {
      walk(n, into).forEach(function (x) { if (self.indexOf(x) < 0) affected.add(x); });
      walk(n, out).forEach(function (x) { if (self.indexOf(x) < 0) depends.add(x); });
    });
    if (svg && current) {
      var mark = function (ids, cls) {
        ids.forEach(function (n) { var g = current.get(drawn(n)); if (g) g.classList.add('dw-on', cls); });
      };
      mark(affected, 'dw-affected'); mark(depends, 'dw-depends'); mark([id], 'dw-selected');
      var lit = new Set([id].concat(Array.from(affected), Array.from(depends)).map(drawn));
      svg.querySelectorAll('g.edge').forEach(function (g) {
        var t = g.querySelector('title');
        if (!t) return;
        var parts = t.textContent.split('->');
        if (parts.length === 2 && lit.has(parts[0]) && lit.has(parts[1])) g.classList.add('dw-on');
      });
    }
    var label = members[id] ? id.replace(/(^|\\.)module\\./g, '$1') : id;
    panel.appendChild(el('p', e && e.name ? e.name : label, 'name'));
    var dl = el('dl');
    var row = function (k, v) { if (v) { dl.appendChild(el('dt', k)); dl.appendChild(el('dd', v)); } };
    row('id', id);
    if (e) { row('kind', e.kind); row('group', e.group); row('platform', e.platform); row('source', e.source); }
    if (members[id]) row('kind', 'Terraform module, ' + self.length + (self.length === 1 ? ' resource' : ' resources'));
    var health = worstHealth(self);
    if (health) row('health', health);
    if (added.has(id)) row('this deploy', 'added');
    if (members[id]) {
      var a = self.filter(function (n) { return added.has(n); }).length;
      var c = self.filter(function (n) { return changed.has(n); }).length;
      if (a || c) row('this deploy', a + ' added, ' + c + ' changed inside');
    }
    (changed.get(id) || []).forEach(function (c) {
      row('this deploy', c.field + ': ' + (c.before || '-') + ' \\u2192 ' + (c.after || '-'));
    });
    panel.appendChild(dl);
    if (members[id]) {
      panel.appendChild(el('h2', 'Inside (' + self.length + ')'));
      panel.appendChild(idList(new Set(self)));
    }
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

  // One entry per view, with how much it holds and a dot when this deploy
  // touched something in it, so a reader knows which view to open first.
  var views = document.getElementById('views');
  data.diagrams.forEach(function (d, i) {
    var ids = Array.from(nodesIn(document.getElementById('diagram-' + i).content).keys());
    var held = [].concat.apply([], ids.map(function (id) { return (d.members || {})[id] || [id]; }));
    var touched = held.some(function (id) { return added.has(id) || changed.has(id); });
    var b = el('button');
    b.setAttribute('role', 'tab');
    var name = el('span');
    if (touched) {
      var dot = el('span', null, 'dot');
      dot.setAttribute('aria-hidden', 'true');
      name.appendChild(dot);
    }
    name.appendChild(document.createTextNode(d.title));
    b.appendChild(name);
    if (ids.length) b.appendChild(el('span', String(ids.length), 'count'));
    if (touched) b.setAttribute('aria-label', d.title + ', changed by this deploy');
    b.addEventListener('click', function () { show(i); });
    views.appendChild(b);
  });

  var list = document.getElementById('changes');
  if (!changes) {
    list.appendChild(el('p', 'No previous deploy to compare against.', 'empty'));
  } else {
    var ul = el('ul', null, 'list'), any = false;
    var item = function (tag, id, text, clickable) {
      any = true;
      var li = el('li');
      li.appendChild(el('span', { added: '+ added', changed: '~ changed', removed: '\u2212 removed' }[tag], 'tag ' + tag));
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

function healthCounts(snapshot: Snapshot): { healthy: number; degraded: number; down: number } {
  const counts = { healthy: 0, degraded: 0, down: 0 }
  for (const s of Object.values(snapshot.health ?? {})) counts[s]++
  return counts
}

function changeCount(snapshot: Snapshot): number | undefined {
  const c = snapshot.changes
  if (!c) return undefined
  return c.entities.added.length + c.entities.removed.length + c.entities.changed.length + c.edges.added.length + c.edges.removed.length
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * One sentence saying what this deploy left behind and what, if anything,
 * wants the reader. It only restates facts the pills below it carry.
 */
export function verdict(snapshot: Snapshot): string {
  const { environment, build } = snapshot.subject
  const subject = `${build ? `Build ${build}` : 'This deploy'} on ${environment}`
  const { down, degraded } = healthCounts(snapshot)
  const problems: string[] = []
  if (down) problems.push(`${plural(down, 'resource is', 'resources are')} down`)
  if (degraded) problems.push(`${plural(degraded, 'resource is', 'resources are')} degraded`)
  if (snapshot.drift?.hasDrift) problems.push('it differs from the committed design')
  if (problems.length) {
    const last = problems.pop()!
    return `${subject}: ${problems.length ? `${problems.join(', ')} and ${last}` : last}.`
  }
  const fine: string[] = []
  if (snapshot.health) fine.push('is healthy')
  if (snapshot.drift) fine.push('matches the committed design')
  if (fine.length) return `${subject} ${fine.join(' and ')}.`
  const n = changeCount(snapshot)
  return n === undefined ? `${subject}.` : `${subject}: ${plural(n, 'change', 'changes')} since the last deploy.`
}

function pills(snapshot: Snapshot): string {
  const out: string[] = []
  const { down, degraded } = healthCounts(snapshot)
  if (down) out.push(`<span class="pill danger"><b>${down}</b> down</span>`)
  if (degraded) out.push(`<span class="pill warn"><b>${degraded}</b> degraded</span>`)
  const d = snapshot.drift
  if (d) {
    out.push(
      d.hasDrift
        ? '<span class="pill warn">differs from the committed design</span>'
        : '<span class="pill">matches the committed design</span>',
    )
  }
  const n = changeCount(snapshot)
  // A count, not a request: neutral, so the pills that do want attention stand out.
  if (n !== undefined) out.push(`<span class="pill"><b>${n}</b> ${n === 1 ? 'change' : 'changes'} since the last deploy</span>`)
  if (d?.entities.unverifiable.length) {
    out.push(`<span class="pill"><b>${d.entities.unverifiable.length}</b> in a blind spot, not checked</span>`)
  }
  const model = snapshot.observation.model
  out.push(`<span class="pill"><b>${model.entities.length}</b> entities</span>`)
  out.push(`<span class="pill"><b>${model.edges.length}</b> relationships</span>`)
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
  const data = {
    snapshot,
    diagrams: snapshot.diagrams.map((d) => ({ title: d.title, renderer: d.renderer, members: d.members })),
  }

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
  <div class="lead">
    <p class="eyebrow">${escapeHtml(title)}</p>
    <h1>${escapeHtml(verdict(snapshot))}</h1>
    <p class="meta">${escapeHtml(meta)}</p>
  </div>
  <div class="pills">${pills(snapshot)}</div>
</header>
<main>
  <nav aria-label="Views">
    <h2 class="eyebrow">Views</h2>
    <div class="views" id="views" role="tablist"></div>
  </nav>
  <section class="stage">
    <div class="toolbar">
      <div class="legend">
        <span class="tag added">+ added</span><span class="tag changed">~ changed</span>
        <span class="tag down">\u2715 down</span><span class="tag degraded">\u25B2 degraded</span>
        <p class="hint" id="hint"></p>
      </div>
      <button type="button" id="zoom">Actual size</button>
    </div>
    <div class="diagram fit" id="diagram"></div>
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
