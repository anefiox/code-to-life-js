const byId = id => document.getElementById(id);
const state = {
  graph: null, items: new Map(), incoming: new Map(), outgoing: new Map(), changes: null, showChanges: false,
  explanations: {}, glossary: [], inspecting: null, ai: null
};
const cy = cytoscape({
  container: byId('graph'),
  style: [
    { selector: 'node', style: {
      label: 'data(label)', color: '#e6eaf1', 'font-size': 11, 'text-valign': 'bottom', 'text-margin-y': 6,
      'text-background-color': '#191f27', 'text-background-opacity': 0.94, 'text-background-padding': 2,
      'text-max-width': 130, 'text-wrap': 'ellipsis', 'min-zoomed-font-size': 4,
      'background-color': '#83e0c2', width: 18, height: 18
    } },
    { selector: 'node.module', style: { shape: 'round-rectangle', 'background-color': '#a6a5f4', width: 30, height: 22 } },
    { selector: 'node.test', style: { 'background-color': '#e4c478' } },
    { selector: 'edge', style: {
      width: 1.2, 'line-color': '#546679', 'target-arrow-color': '#546679', 'target-arrow-shape': 'triangle',
      'curve-style': 'bezier', 'arrow-scale': 0.7
    } },
    { selector: 'edge.violation', style: { width: 2.6, 'line-color': '#ff8b85', 'target-arrow-color': '#ff8b85' } },
    { selector: 'node.changed', style: { 'border-width': 3, 'border-color': '#72c5ff' } },
    { selector: 'node.changed-added', style: { 'border-color': '#83e0c2' } },
    { selector: 'node.changed-signature', style: { 'border-color': '#e4c478' } },
    { selector: 'node.changed-cosmetic', style: { 'border-color': '#a4afbf' } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': 'white' } },
    { selector: 'node.cpu-sampled', style: { 'background-color': 'data(cpuColor)' } },
    { selector: 'node.proposed', style: {
      shape: 'diamond', width: 27, height: 27, 'background-color': '#c492ee',
      'border-style': 'dashed', 'border-width': 2, 'border-color': '#efd6ff'
    } },
    { selector: 'edge.proposed', style: {
      'line-style': 'dashed', 'line-color': '#c492ee', 'target-arrow-color': '#c492ee'
    } },
    { selector: 'node.stack-frame', style: { 'background-color': '#fac072' } },
    { selector: 'node.stack-top', style: { 'background-color': '#ff895d', 'border-width': 3, 'border-color': '#ffe1bd' } },
    { selector: 'edge.stack-edge', style: { width: 3, 'line-color': '#fac072', 'target-arrow-color': '#fac072' } },
    { selector: 'node.folder', style: {
      shape: 'round-rectangle', width: 'data(size)', height: 'data(size)', 'background-color': '#26303d',
      'border-width': 2, 'border-color': '#a6a5f4', 'text-valign': 'center', 'text-margin-y': 0, 'text-wrap': 'wrap',
      'text-max-width': 150, 'font-size': 12, 'text-background-opacity': 0, 'min-zoomed-font-size': 0
    } },
    { selector: 'node.folder.test', style: { 'border-color': '#e4c478' } },
    { selector: 'edge.folder-edge', style: { width: 'data(weight)', 'arrow-scale': 0.9 } },
    { selector: 'node.tour-seen', style: { 'border-width': 3, 'border-color': '#b8954a' } },
    { selector: 'node.tour-current', style: { 'border-width': 5, 'border-color': '#ffd479' } },
    { selector: 'node.flow-step', style: { 'border-width': 2, 'border-color': '#83e0c2' } },
    { selector: '.dimmed', style: { opacity: 0.13 } }
  ],
  minZoom: 0.05, maxZoom: 3
});

function element(tag, value) {
  const item = document.createElement(tag);
  item.textContent = value;
  return item;
}

function listRow(label, action) {
  const item = document.createElement('li');
  const button = element('button', label);
  button.addEventListener('click', action);
  item.append(button);
  return item;
}

function indexEdges(graph) {
  state.items = new Map(graph.nodes.map(node => [node.id, node]));
  state.incoming.clear();
  state.outgoing.clear();
  for (const edge of graph.edges) {
    if (!state.incoming.has(edge.to)) state.incoming.set(edge.to, []);
    if (!state.outgoing.has(edge.from)) state.outgoing.set(edge.from, []);
    state.incoming.get(edge.to).push(edge);
    state.outgoing.get(edge.from).push(edge);
  }
}

function render() {
  const graph = state.graph;
  if (byId('view').value === 'folders') {
    cy.elements().remove();
    cy.add(folderElements(graph));
    arrange();
    const folders = cy.nodes().length;
    const files = graph.nodes.filter(node => node.kind === 'module').length;
    byId('status').textContent = folders + (folders === 1 ? ' folder · ' : ' folders · ') +
      files + (files === 1 ? ' file' : ' files');
    paintStack();
    paintProfile();
    overview();
    return;
  }
  const modules = byId('view').value === 'modules';
  const tests = new Set(graph.tests);
  const violations = new Set(graph.violations.map(edge => edge.id));
  const nodes = graph.nodes.filter(node => !modules || node.kind === 'module');
  const selected = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => selected.has(edge.from) && selected.has(edge.to));
  const highlights = new Map();
  if (state.showChanges && state.changes) {
    for (const file of state.changes.files) {
      if (file.moduleId) highlights.set(file.moduleId, file.cosmetic ? 'cosmetic' : file.status === 'A' ? 'added' : 'file');
      for (const change of file.changes) {
        if (change.nodeId) highlights.set(change.nodeId, change.kind);
      }
    }
  }
  const elements = nodes.map(node => ({
    group: 'nodes',
    data: { id: node.id, label: node.kind === 'module' ? node.file.split('/').at(-1) : node.name },
    classes: [
      node.kind === 'module' ? 'module' : '',
      tests.has('module:' + node.file) ? 'test' : '',
      highlights.has(node.id) ? 'changed changed-' + highlights.get(node.id) : ''
    ].join(' ')
  }));
  for (const edge of edges) {
    elements.push({ group: 'edges', data: { id: edge.id, source: edge.from, target: edge.to },
      classes: violations.has(edge.id) ? 'violation' : '' });
  }
  const proposed = planElements(selected);
  cy.elements().remove();
  cy.add([...elements, ...proposed]);
  arrange();
  byId('status').textContent = cy.nodes().length + ' nodes · ' + cy.edges().length + ' connections';
  paintStack();
  paintProfile();
  overview();
}

// Lays out connected nodes with label-aware spacing, then places unconnected
// nodes in an evenly spaced grid underneath so their labels never collide.
function arrange() {
  const nodes = cy.nodes();
  const isolated = nodes.filter(node => node.degree(false) === 0);
  const connected = nodes.difference(isolated);
  const shared = { animate: false, fit: false, nodeDimensionsIncludeLabels: true };
  const group = connected.union(connected.edgesWith(connected));
  if (connected.length > 250) {
    group.layout({ ...shared, name: 'grid', avoidOverlap: true, avoidOverlapPadding: 28 }).run();
  } else if (connected.length) {
    group.layout({
      ...shared, name: 'cose', randomize: true, numIter: 2500, gravity: 0.2,
      nodeRepulsion: () => 30000, idealEdgeLength: () => 70, edgeElasticity: () => 100,
      nodeOverlap: 40, componentSpacing: 90, padding: 40
    }).run();
  }
  if (isolated.length) {
    const box = connected.length ? connected.boundingBox({ includeLabels: true }) : { x1: 0, y2: 0, w: 0 };
    const boxes = isolated.map(node => node.boundingBox({ includeLabels: true }));
    const cell = Math.max(...boxes.map(box => box.w)) + 40;
    const row = Math.max(64, Math.max(...boxes.map(box => box.h)) + 28);
    const columns = Math.max(1, Math.floor(Math.max(box.w, Math.sqrt(isolated.length) * cell * 1.5) / cell));
    const top = box.y2 + (connected.length ? 110 : 0);
    isolated.sort((a, b) => a.id().localeCompare(b.id())).forEach((node, index) => {
      node.position({ x: box.x1 + (index % columns + 0.5) * cell, y: top + Math.floor(index / columns) * row });
    });
  }
  cy.resize();
  cy.fit(undefined, 36);
}

function overview() {
  const graph = state.graph;
  if (!graph) return;
  state.inspecting = null;
  const details = byId('details');
  details.replaceChildren(element('h2', 'Project overview'),
    element('p', graph.nodes.filter(node => node.kind === 'module').length + ' files · ' +
      graph.tests.length + ' test files · ' + graph.violations.length + ' architecture violations'));
  for (const warning of graph.warnings) details.append(element('p', warning));
  const explained = Object.keys(state.explanations).length;
  details.append(element('h3', 'Explanations'), element('p', explained ?
    explained + ' files and functions have a plain-English explanation. Select one on the graph to read it.' :
    'No explanations yet. Select any file or function to read its code.'));
  if (state.ai) {
    details.append(element('p', 'Select a file or function and choose Explain with AI to have ' + state.ai.label +
      ' write one (model ' + state.ai.model + ').'));
  } else if (!explained) {
    details.append(explainHint());
  }
  if (state.glossary.length) {
    details.append(element('h3', 'Tools this project uses'), glossaryList(state.glossary));
  }
}

function aiButton(id, existing) {
  const box = document.createElement('div');
  box.className = 'ai-explain';
  const button = element('button', (existing ? 'Rewrite' : 'Explain') + ' with AI');
  button.type = 'button';
  const status = element('p', '');
  status.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Asking ' + state.ai.label + '… this can take a minute on a local model.';
    try {
      const response = await fetch('/api/explain?' + new URLSearchParams({ id }), { method: 'POST' });
      if (!response.ok) throw new Error(await response.text());
      const saved = await response.json();
      state.explanations[id] = { summary: saved.summary, stale: false, updated: saved.updated };
      if (state.inspecting === id) inspect(id);
    } catch (error) {
      button.disabled = false;
      status.textContent = error.message;
    }
  });
  box.append(button, status);
  return box;
}

function explainHint() {
  const hint = element('p', 'To add explanations, connect the codetolife-js MCP server to Claude Code and ask: ');
  hint.className = 'hint';
  hint.append(element('q', 'Use explain_next and save_explanation to explain this project for a new developer.'));
  return hint;
}

function glossaryList(items) {
  const list = document.createElement('dl');
  list.className = 'glossary';
  for (const item of items) {
    const term = element('dt', item.term + ' ');
    term.append(element('code', item.package));
    list.append(term, element('dd', item.meaning));
  }
  return list;
}

async function loadExplanations() {
  try {
    const response = await fetch('/api/explanations');
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    state.explanations = data.explanations;
    state.glossary = data.glossary;
    state.ai = data.ai;
  } catch (error) {
    state.explanations = {};
    state.glossary = [];
    state.ai = null;
    byId('status').textContent = 'Explanations unavailable: ' + error.message;
  }
  if (state.inspecting && state.items.has(state.inspecting)) inspect(state.inspecting);
  else if (!restoreLearnView()) overview();
}

function codeBlock(source) {
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Source of ' + source.file + ', lines ' + source.start + ' to ' + source.end);
  const width = String(source.end).length;
  source.code.split('\n').forEach((text, index) => {
    const row = document.createElement('span');
    row.className = 'line';
    const number = element('span', String(source.start + index).padStart(width));
    number.className = 'ln';
    number.setAttribute('aria-hidden', 'true');
    row.append(number, document.createTextNode(text + '\n'));
    pre.append(row);
  });
  return pre;
}

async function showSource(id, slot) {
  slot.replaceChildren(element('p', 'Loading code…'));
  try {
    const response = await fetch('/api/source?' + new URLSearchParams({ id }));
    if (!response.ok) throw new Error(await response.text());
    const source = await response.json();
    if (state.inspecting !== id) return;
    const label = source.start === 1 && source.end === source.total ?
      source.total + ' lines' : 'Lines ' + source.start + '–' + source.end + ' of ' + source.total;
    slot.replaceChildren(element('h3', 'Code'), element('p', label), codeBlock(source));
    if (source.glossary.length) slot.append(element('h3', 'Packages this file uses'), glossaryList(source.glossary));
  } catch (error) {
    if (state.inspecting === id) slot.replaceChildren(element('h3', 'Code'), element('p', error.message));
  }
}

function upstreamTests(id) {
  const callable = new Set(['calls', 'creates', 'renders']);
  const visited = new Set([id]);
  const reached = new Set();
  const queue = [id];
  for (let index = 0; index < queue.length; index++) {
    const target = queue[index];
    const file = state.items.get(target).file;
    if (state.graph.tests.includes('module:' + file)) reached.add(file);
    for (const edge of state.incoming.get(target) ?? []) {
      if (callable.has(edge.kind) && !visited.has(edge.from)) {
        visited.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return [...reached].sort();
}

function focus(id) {
  const data = state.items.get(id);
  if (!data) return;
  if (cy.getElementById(id).empty()) {
    byId('view').value = data.kind === 'module' ? 'modules' : 'symbols';
    render();
  }
  const node = cy.getElementById(id);
  cy.elements().unselect();
  node.select();
  cy.center(node);
  inspect(id);
}

function inspect(id) {
  const node = state.items.get(id);
  const details = byId('details');
  state.inspecting = id;
  details.replaceChildren(element('h2', node.name), element('p', node.kind + ' · ' + node.file + ':' + node.line));
  const explanation = state.explanations[id];
  const about = document.createElement('div');
  about.className = 'explanation';
  about.append(element('h3', 'What it does'));
  if (explanation) {
    about.append(element('p', explanation.summary));
    if (explanation.stale) {
      const stale = element('p', 'The code has changed since this was written, so it may be out of date.');
      stale.className = 'stale';
      about.append(stale);
    }
  } else {
    about.append(element('p', 'No explanation yet. Read the code below, or follow the connections to see how it is used.'));
  }
  if (state.ai && (!explanation || explanation.stale)) about.append(aiButton(id, explanation));
  const code = document.createElement('div');
  details.append(about, code);
  showSource(id, code);
  for (const [label, edges, end] of [
    ['Used by (incoming)', state.incoming.get(id) ?? [], 'from'],
    ['Uses (outgoing)', state.outgoing.get(id) ?? [], 'to']
  ]) {
    if (!edges.length) continue;
    const list = document.createElement('ul');
    for (const edge of edges) {
      list.append(listRow(edge.kind + ' · ' + state.items.get(edge[end]).name, () => focus(edge[end])));
    }
    details.append(element('h3', label), list);
  }
  const changedFile = state.showChanges && state.changes?.files.find(file => file.file === node.file);
  if (changedFile) {
    const matching = node.kind === 'module' ? changedFile.changes :
      changedFile.changes.filter(change => change.nodeId === id);
    details.append(element('h3', 'Git changes'));
    for (const change of matching) {
      details.append(element('p', change.kind + ' · ' + change.name + ' · line ' + change.line));
    }
    for (const finding of changedFile.findings) {
      details.append(element('p', (finding.reason ? 'suppressed' : finding.severity) + ' ' + finding.id + ' · line ' + finding.line +
        ' · ' + (finding.reason ?? finding.message)));
    }
    if (changedFile.cosmetic) details.append(element('p', 'Formatting or comments changed.'));
  }
  if (node.kind !== 'module') {
    const tests = upstreamTests(id);
    details.append(element('h3', 'Tests reaching this symbol'),
      element('p', tests.length ? tests.join(' · ') : 'No static call paths from test files.'));
  }
}

function search() {
  const term = byId('search').value.trim().toLowerCase();
  const section = byId('matches');
  const results = byId('results');
  section.hidden = !term;
  results.replaceChildren();
  if (!term) return;
  const matching = state.graph.nodes.filter(node => (node.name + ' ' + node.file).toLowerCase().includes(term));
  for (const node of matching.slice(0, 30)) {
    results.append(listRow(node.name + (node.kind === 'module' ? '' : ' · ' + node.file), () => focus(node.id)));
  }
  if (!matching.length) results.append(element('li', 'No matches.'));
  if (matching.length > 30) results.append(element('li', 'Showing 30 of ' + matching.length + ' matches.'));
}

function showChangeFiles(changes) {
  const count = changes.files.reduce((total, file) => total + file.findings.filter(finding => !finding.reason).length, 0);
  byId('changes-status').textContent = changes.files.length + ' changed files · ' + count +
    ' findings · working tree vs. ' + changes.baseline.slice(0, 8);
  const files = changes.files.map(file => {
    const group = document.createElement('details');
    const previous = file.oldFile && file.oldFile !== file.file ? file.oldFile + ' → ' : '';
    const status = { A: 'added', D: 'deleted', R: 'renamed' }[file.status];
    const label = status ?? (file.cosmetic ? 'cosmetic' : 'modified');
    const summary = element('summary', previous + file.file + ' · ' + label);
    group.append(summary);
    const list = document.createElement('ul');
    if (file.moduleId) list.append(listRow('Show file on graph', () => focus(file.moduleId)));
    for (const change of file.changes) {
      const text = change.kind + ' · ' + change.name + ' · line ' + change.line;
      list.append(change.nodeId ? listRow(text, () => focus(change.nodeId)) : element('li', text));
    }
    for (const finding of file.findings) {
      list.append(element('li', (finding.reason ? 'suppressed' : finding.severity) + ' ' + finding.id + ' · line ' + finding.line +
        ' · ' + (finding.reason ?? finding.message)));
    }
    group.append(list);
    return group;
  });
  byId('changes-files').replaceChildren(...files);
}

function applyGraph(graph) {
  state.graph = graph;
  byId('project').textContent = graph.root;
  indexEdges(graph);
  render();
  search();
  loadExplanations();
  loadLearn();
  byId('rules').hidden = !graph.violations.length;
  byId('violations').replaceChildren(...graph.violations.map(edge =>
    listRow(edge.file + ' → ' + edge.target + (edge.because ? ' · ' + edge.because : ''), () => focus(edge.from))));
}

let debugSnapshot = null;
let debugPending = false;
let debugOpen = false;
let debugTimer;

function paintStack() {
  cy.elements().removeClass('stack-frame stack-top stack-edge');
  if (!debugOpen || !debugSnapshot) return;
  const modules = byId('view').value === 'modules';
  const frames = debugSnapshot.frames.map(frame => modules ? frame.moduleId : frame.nodeId);
  const trail = new Map();
  frames.forEach((id, index) => {
    if (id) cy.getElementById(id).addClass(index === 0 ? 'stack-top' : 'stack-frame');
    if (id && frames[index + 1]) {
      const caller = frames[index + 1];
      if (!trail.has(caller)) trail.set(caller, new Set());
      trail.get(caller).add(id);
    }
  });
  if (trail.size) cy.edges().filter(edge => trail.get(edge.data('source'))?.has(edge.data('target')))
    .addClass('stack-edge');
}

function paintProfile() {
  cy.nodes('.cpu-sampled').removeClass('cpu-sampled').removeData('cpuColor');
  const profile = debugOpen && debugSnapshot?.profile;
  if (!profile) return;
  const rows = byId('view').value === 'modules' ? profile.modules : profile.symbols;
  const max = rows[0]?.samples ?? 1;
  cy.batch(() => {
    for (const row of rows) {
      const intensity = Math.sqrt(row.samples / max);
      cy.getElementById(row.id).data('cpuColor', 'rgb(255,' + Math.round(207 - intensity * 110) +
        ',' + Math.round(138 - intensity * 76) + ')').addClass('cpu-sampled');
    }
  });
}

function showProfile(snapshot, changed) {
  const available = ['running', 'paused'].includes(snapshot.status) && !debugPending && !snapshot.busy;
  byId('profile-start').disabled = !available || snapshot.recording;
  byId('profile-stop').disabled = !available || !snapshot.recording;
  if (!changed) return;
  const profile = snapshot.profile;
  const summary = profile ? profile.projectSamples + ' of ' + profile.samples +
    ' samples mapped to the project · ' + (profile.durationMs / 1000).toFixed(2) + ' s' : '';
  byId('profile-status').textContent = snapshot.recording ? 'Recording CPU samples…' :
    snapshot.profileMessage || summary || 'Ready when the debugger connects.';
  const rows = byId('view').value === 'modules' ? profile?.modules : profile?.symbols;
  byId('profile-results').replaceChildren(...(rows ?? []).slice(0, 12).map(row =>
    listRow(row.name + ' · ' + row.samples + ' samples', () => focus(row.id))));
  paintProfile();
}

function showDebug(snapshot) {
  const stackChanged = JSON.stringify(debugSnapshot?.frames) !== JSON.stringify(snapshot.frames);
  const updateList = stackChanged || !debugSnapshot ||
    JSON.stringify(debugSnapshot.breakpoints) !== JSON.stringify(snapshot.breakpoints);
  const profileChanged = snapshot.recording !== debugSnapshot?.recording ||
    snapshot.profileMessage !== debugSnapshot?.profileMessage ||
    JSON.stringify(snapshot.profile) !== JSON.stringify(debugSnapshot?.profile);
  debugSnapshot = snapshot;
  const browser = snapshot.target === 'browser';
  byId('debug-title').textContent = browser ? 'Chromium debugger' : 'Node.js debugger';
  byId('debug-actions').querySelector('[data-action="start"]').textContent = browser ? 'Connect' : 'Start';
  byId('debug-actions').querySelector('[data-action="stop"]').textContent = browser ? 'Disconnect' : 'Stop';
  byId('debug-log').hidden = browser;
  byId('debug-entry').textContent = snapshot.entry;
  byId('debug-status').textContent = snapshot.status + (snapshot.message ? ' · ' + snapshot.message : '');
  byId('debug-output').textContent = snapshot.output;
  const active = ['running', 'paused'].includes(snapshot.status);
  for (const button of byId('debug-actions').querySelectorAll('button')) {
    const action = button.dataset.action;
    button.disabled = debugPending || snapshot.busy || (action === 'start' ?
      !['idle', 'exited', 'error'].includes(snapshot.status) : action === 'pause' ?
        snapshot.status !== 'running' : action === 'stop' ? !active : snapshot.status !== 'paused');
  }
  showProfile(snapshot, profileChanged);
  if (!updateList) return;
  byId('debug-breakpoint-heading').hidden = !snapshot.breakpoints.length;
  byId('debug-breakpoints').replaceChildren(...snapshot.breakpoints.map(point =>
    element('li', point.file + ':' + point.line +
      (browser ? point.bound ? ' · bound' : ' · pending' : ''))));
  byId('debug-stack-heading').hidden = !snapshot.frames.length;
  byId('debug-frames').replaceChildren(...snapshot.frames.map(frame => {
    const label = frame.name + (frame.file ? ' · ' + frame.file + ':' + frame.line : '');
    return frame.nodeId ? listRow(label, () => focus(frame.nodeId)) : element('li', label);
  }));
  paintStack();
}

async function debugRequest(action) {
  if (debugPending) return;
  debugPending = true;
  if (debugSnapshot) showDebug(debugSnapshot);
  try {
    const response = await fetch('/api/debug' + (action ? '?action=' + action : ''),
      { method: action ? 'POST' : 'GET' });
    if (!response.ok) throw new Error(await response.text());
    const snapshot = await response.json();
    if (snapshot) {
      debugPending = false;
      byId('debug-toggle').hidden = false;
      showDebug(snapshot);
    }
  } catch (error) {
    debugPending = false;
    if (debugSnapshot) showDebug(debugSnapshot);
    byId('debug-status').textContent = error.message;
  } finally {
    debugPending = false;
  }
}

async function refresh(force = false) {
  if (byId('refresh').disabled) return;
  const includeChanges = state.showChanges;
  for (const id of ['refresh', 'changes-run', 'changes-toggle']) byId(id).disabled = true;
  try {
    if (includeChanges) {
      byId('changes-status').textContent = 'Comparing Git changes…';
      const query = new URLSearchParams({ base: byId('changes-base').value });
      const response = await fetch('/api/changes?' + query);
      if (!response.ok) {
        state.changes = null;
        byId('changes-status').textContent = await response.text();
        byId('changes-files').replaceChildren();
      } else {
        const { graph, changes } = await response.json();
        state.changes = changes;
        applyGraph(graph);
        showChangeFiles(changes);
        return;
      }
    }
    const response = await fetch('/api/graph' + (force ? '?refresh=1' : ''));
    if (!response.ok) throw new Error(await response.text());
    applyGraph(await response.json());
  } catch (error) {
    if (includeChanges) {
      state.changes = null;
      byId('changes-status').textContent = error.message;
      byId('changes-files').replaceChildren();
      if (state.graph) render();
    } else {
      byId('status').textContent = error.message;
    }
  } finally {
    for (const id of ['refresh', 'changes-run', 'changes-toggle']) byId(id).disabled = false;
  }
}

cy.on('tap', 'node', event => {
  const id = event.target.id();
  if (id.startsWith('folder:')) inspectFolder(id);
  else if (state.items.has(id)) inspect(id);
});
initPlan();
cy.on('tap', event => {
  if (event.target !== cy) return;
  learn.flow = null;
  clearSpotlight();
  showPages();
  overview();
});
byId('tour-toggle').addEventListener('click', () => setTourOpen(byId('tour').hidden));
byId('pages-toggle').addEventListener('click', () => setPagesOpen(byId('pages').hidden));
byId('fit').addEventListener('click', () => cy.fit(undefined, 36));
byId('view').addEventListener('change', () => {
  if (state.graph) render();
  if (debugSnapshot) showProfile(debugSnapshot, true);
});
byId('search').addEventListener('input', () => { if (state.graph) search(); });
byId('refresh').addEventListener('click', () => refresh(true));
byId('changes-toggle').addEventListener('click', () => {
  state.showChanges = !state.showChanges;
  byId('changes-toggle').setAttribute('aria-pressed', String(state.showChanges));
  byId('changes').hidden = !state.showChanges;
  if (state.showChanges) refresh();
  else if (state.graph) render();
});
byId('changes-form').addEventListener('submit', event => {
  event.preventDefault();
  refresh();
});
refresh();
debugRequest();
byId('debug-toggle').addEventListener('click', () => {
  debugOpen = !debugOpen;
  byId('debug-toggle').setAttribute('aria-pressed', String(debugOpen));
  byId('debug').hidden = !debugOpen;
  if (debugOpen) {
    debugRequest();
    debugTimer = setInterval(() => debugRequest(), 600);
  } else {
    clearInterval(debugTimer);
  }
  paintStack();
  paintProfile();
});
byId('profile-start').addEventListener('click', () => debugRequest('profile-start'));
byId('profile-stop').addEventListener('click', () => debugRequest('profile-stop'));
byId('debug-actions').addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action;
  if (action) debugRequest(action);
});
