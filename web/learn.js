// Guided views for people new to a codebase: a folder-level overview, a
// "Start here" tour, and what happens when a page is visited.
const learn = { data: null, tourIndex: -1, flow: null, groups: null };

const folderNote = dir => learn.data?.folderNotes?.[dir] ?? null;

// Groups files into at most 14 folders, merging the deepest folders into
// their parents until the picture is small enough to take in at once.
function folderGroups(graph) {
  const tests = new Set(graph.tests);
  const modules = graph.nodes.filter(node => node.kind === 'module');
  const depth = dir => dir ? dir.split('/').length : 0;
  const groupOf = new Map(modules.map(node => [node.file, node.file.includes('/') ? node.file.slice(0, node.file.lastIndexOf('/')) : '']));
  for (;;) {
    const dirs = new Set(groupOf.values());
    const deepest = Math.max(...[...dirs].map(depth));
    if (dirs.size <= 14 || deepest <= 1) break;
    for (const [file, dir] of groupOf) if (depth(dir) === deepest) groupOf.set(file, dir.split('/').slice(0, -1).join('/'));
  }
  const groups = new Map();
  for (const node of modules) {
    const dir = groupOf.get(node.file);
    if (!groups.has(dir)) groups.set(dir, { id: 'folder:' + dir, dir, files: [], tests: 0 });
    const group = groups.get(dir);
    group.files.push(node.file);
    if (tests.has(node.id)) group.tests++;
  }
  const links = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const from = groupOf.get(edge.from.slice('module:'.length));
    const to = groupOf.get(edge.to.slice('module:'.length));
    if (from === undefined || to === undefined || from === to) continue;
    const key = from + '\n' + to;
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  return { groupOf, groups, links };
}

function folderElements(graph) {
  learn.groups = folderGroups(graph);
  const { groups, links } = learn.groups;
  const elements = [...groups.values()].map(group => {
    const count = group.files.length;
    const label = (group.dir || '(project root)') + '\n' + count + ' file' + (count === 1 ? '' : 's') +
      (group.tests ? ' · ' + group.tests + ' test' + (group.tests === 1 ? '' : 's') : '');
    return {
      group: 'nodes', data: { id: group.id, label, size: Math.round(54 + Math.sqrt(count) * 16) },
      classes: 'folder' + (group.tests === count ? ' test' : '')
    };
  });
  for (const [key, count] of links) {
    const [from, to] = key.split('\n');
    elements.push({ group: 'edges', data: {
      id: 'folder-edge:' + key, source: 'folder:' + from, target: 'folder:' + to,
      weight: Math.min(7, 1.2 + Math.log2(count) * 1.3), count
    }, classes: 'folder-edge' });
  }
  return elements;
}

function inspectFolder(id) {
  const group = [...learn.groups.groups.values()].find(item => item.id === id);
  if (!group) return;
  state.inspecting = null;
  learn.flow = null;
  const details = byId('details');
  const files = group.files.length;
  details.replaceChildren(element('h2', (group.dir || '(project root)') + '/'),
    element('p', files + ' file' + (files === 1 ? '' : 's') + (group.tests ? ' · ' + group.tests + ' of them tests' : '')));
  const note = folderNote(group.dir);
  details.append(element('h3', 'What this folder is for'),
    prose('p', note ?? 'There is no description for this kind of folder. Its files are listed below.'));
  const show = element('button', 'Show these files on the graph');
  show.type = 'button';
  show.className = 'learn-action';
  show.addEventListener('click', () => {
    byId('view').value = 'modules';
    render();
    spotlight(group.files.map(file => 'module:' + file));
    inspectFolderFiles(group);
  });
  details.append(show);
  for (const [label, outgoing] of [['Uses code from', true], ['Used by', false]]) {
    const related = [...learn.groups.links].map(([key, count]) => [key.split('\n'), count])
      .filter(([[from, to]]) => (outgoing ? from : to) === group.dir)
      .sort((a, b) => b[1] - a[1]);
    if (!related.length) continue;
    const list = document.createElement('ul');
    for (const [[from, to], count] of related) {
      const other = outgoing ? to : from;
      list.append(listRow((other || '(project root)') + '/ · ' + count + ' import' + (count === 1 ? '' : 's'),
        () => { cy.getElementById('folder:' + other).select(); inspectFolder('folder:' + other); }));
    }
    details.append(element('h3', label), list);
  }
  inspectFolderFiles(group, details);
}

function inspectFolderFiles(group, details = byId('details')) {
  details.querySelector('.folder-files')?.remove();
  const box = document.createElement('div');
  box.className = 'folder-files';
  const list = document.createElement('ul');
  for (const file of [...group.files].sort()) {
    const name = group.dir ? file.slice(group.dir.length + 1) : file;
    list.append(listRow(name, () => focus('module:' + file)));
  }
  box.append(element('h3', 'Files'), list);
  details.append(box);
}

function spotlight(ids) {
  const lit = cy.collection(ids.map(id => cy.getElementById(id)).filter(item => item.nonempty()));
  cy.elements().addClass('dimmed');
  lit.removeClass('dimmed');
  lit.edgesWith(lit).removeClass('dimmed');
  if (lit.nonempty()) {
    cy.fit(lit, 60);
    if (cy.zoom() > 1.1) {
      cy.zoom(1.1);
      cy.center(lit);
    }
  }
}

function clearSpotlight() {
  cy.elements().removeClass('dimmed flow-step');
}

async function loadLearn() {
  try {
    const response = await fetch('/api/learn');
    if (!response.ok) throw new Error(await response.text());
    learn.data = await response.json();
  } catch (error) {
    learn.data = null;
    byId('status').textContent = 'Guided views unavailable: ' + error.message;
  }
  showPages();
  if (!state.inspecting && !learn.flow && !guide.playback && byId('details').firstChild?.textContent === 'Project overview') overview();
  if (learn.tourIndex >= 0) showTourStep(Math.min(learn.tourIndex, (learn.data?.tour.steps.length ?? 1) - 1));
}

// Re-shows a page flow after the graph reloads. Returns true when it did.
function restoreLearnView() {
  const route = learn.flow && learn.data?.pages.routes.find(item => item.key === learn.flow);
  if (!route) return false;
  showFlow(route);
  return true;
}

// ---------- Start here tour ----------

function setTourOpen(open) {
  byId('tour-toggle').setAttribute('aria-pressed', String(open));
  byId('tour').hidden = !open;
  if (!open) {
    learn.tourIndex = -1;
    cy.nodes().removeClass('tour-seen tour-current');
    return;
  }
  if (byId('view').value !== 'modules') {
    byId('view').value = 'modules';
    render();
  }
  showTourStep(0);
}

function showTourStep(index) {
  const steps = learn.data?.tour.steps ?? [];
  const section = byId('tour');
  if (!steps.length) {
    section.replaceChildren(element('h2', 'Start here'),
      element('p', 'Could not find where this app starts. Try the Folders view to get your bearings instead.'));
    return;
  }
  learn.tourIndex = index;
  const step = steps[index];
  const roles = { entry: 'Where the app starts', backbone: 'Follow the main path', shared: 'Shared file' };
  const back = element('button', '← Back');
  const next = element('button', index === steps.length - 1 ? 'Finish' : 'Next →');
  back.type = next.type = 'button';
  back.disabled = index === 0;
  back.addEventListener('click', () => showTourStep(index - 1));
  next.addEventListener('click', () => index === steps.length - 1 ? setTourOpen(false) : showTourStep(index + 1));
  const progress = element('p', 'Step ' + (index + 1) + ' of ' + steps.length + ' · ' + roles[step.role]);
  progress.className = 'tour-progress';
  const file = element('h3', step.file);
  const reason = prose('p', step.reason);
  saveTourStep(Math.max(index, savedTourStep()));
  setRead(step.id, true);
  reason.className = 'tour-reason';
  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.append(back, next);
  section.replaceChildren(element('h2', 'Start here'), progress, file, reason, controls);
  if (byId('view').value !== 'modules') {
    byId('view').value = 'modules';
    render();
  }
  cy.nodes().removeClass('tour-seen tour-current');
  steps.slice(0, index).forEach(item => cy.getElementById(item.id).addClass('tour-seen'));
  focus(step.id);
  cy.getElementById(step.id).addClass('tour-current');
  if (cy.zoom() < 0.8) cy.zoom({ level: 0.9, position: cy.getElementById(step.id).position() });
  cy.center(cy.getElementById(step.id));
}

// ---------- Pages: what happens when I visit this page ----------

function setPagesOpen(open) {
  byId('pages-toggle').setAttribute('aria-pressed', String(open));
  byId('pages').hidden = !open;
  if (open) showPages();
}

function showPages() {
  const section = byId('pages');
  if (section.hidden) return;
  const pages = learn.data?.pages;
  section.replaceChildren(element('h2', 'Pages'));
  if (!pages?.routes.length) {
    section.append(element('p', 'No pages found. Code to Life recognises Hapi route objects ({ method, path }) and ' +
      'Express-style calls such as app.get(\'/path\', handler).'));
    return;
  }
  section.append(element('p', 'Choose a page to see what happens when someone visits it.'));
  const list = document.createElement('ul');
  list.className = 'page-list';
  for (const route of pages.routes) {
    const handler = state.items.get(route.handler);
    const button = document.createElement('button');
    button.type = 'button';
    const method = element('span', route.method);
    method.className = 'method method-' + route.method.split(',')[0].toLowerCase();
    const address = element('span', route.path);
    address.className = route.fixedPath ? 'path' : 'path dynamic';
    button.append(method, address);
    if (handler) {
      const by = element('span', handler.name);
      by.className = 'handler';
      button.append(by);
    }
    if (learn.flow === route.key) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => showFlow(route));
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  section.append(list);
}

function showFlow(route) {
  learn.flow = route.key;
  showPages();
  if (byId('view').value !== 'symbols') {
    byId('view').value = 'symbols';
    render();
  }
  state.inspecting = null;
  const handler = state.items.get(route.handler);
  const ids = [route.handler, ...route.steps.map(step => step.id)];
  spotlight(ids);
  cy.elements().unselect();
  cy.getElementById(route.handler).select();
  for (const step of route.steps) cy.getElementById(step.id).addClass('flow-step');

  const details = byId('details');
  const play = element('button', '▶ Play it step by step');
  play.type = 'button';
  play.className = 'learn-action';
  play.addEventListener('click', () => playFlow(route));
  details.replaceChildren(element('h2', route.method + ' ' + route.path),
    element('p', 'What happens when someone visits this page, step by step.'), play);
  if (!route.fixedPath) {
    details.append(element('p', 'The address is worked out when the app runs, so it is shown as written in the code.'));
  }
  const steps = document.createElement('ol');
  steps.className = 'flow';
  const add = (title, ...content) => {
    const item = document.createElement('li');
    item.append(element('strong', title), ...content);
    steps.append(item);
    return item;
  };
  add('The browser asks for the page', element('p', 'It sends a ' + route.method.split(',')[0] + ' request for ' +
    route.path + (route.method.startsWith('GET') ? ', for example by following a link.' : ', usually by submitting a form.')));
  if (learn.data.pages.before) add('The server gets it ready', prose('p', learn.data.pages.before));
  add('The route matches the address', link(route.file + ':' + route.line, () => focus('module:' + route.file)),
    element('p', 'This is where the address is connected to the code that handles it.'));
  if (handler) {
    const explained = state.explanations[route.handler];
    add('The handler runs', link(handler.name + ' · ' + handler.file + ':' + handler.line, () => focus(route.handler)),
      prose('p', explained?.summary ?? 'The handler builds the response: usually a page, sometimes a redirect or data.'));
  }
  if (route.steps.length) {
    const calls = document.createElement('ul');
    calls.className = 'flow-calls';
    for (const step of route.steps) {
      const node = state.items.get(step.id);
      if (!node) continue;
      const row = link(node.name + ' · ' + node.file, () => focus(step.id));
      const item = document.createElement('li');
      item.style.paddingLeft = (step.depth - 1) * 0.9 + 'rem';
      item.append(row);
      calls.append(item);
    }
    add('It calls other code', element('p', 'Indented calls are made by the one above.'), calls);
  }
  const preview = document.createElement('div');
  if (route.templates.length) {
    const list = document.createElement('ul');
    for (const template of route.templates) {
      const item = document.createElement('li');
      item.append(template.file ? link(template.file, () => showTemplate(template.file, preview)) :
        element('span', template.name + ' (template file not found)'));
      list.append(item);
    }
    add('It fills in a page template', element('p', 'The template is the HTML page. The handler passes in the values to show.'), list);
  } else {
    add('It sends the response', element('p', 'No page template was found, so it may return data, a file or a redirect.'));
  }
  details.append(steps, preview);
  const first = route.templates.find(template => template.file);
  if (first) showTemplate(first.file, preview);
}

function link(text, action) {
  const button = element('button', text);
  button.type = 'button';
  button.className = 'link';
  button.addEventListener('click', action);
  return button;
}

async function showTemplate(file, slot) {
  slot.replaceChildren(element('p', 'Loading template…'));
  try {
    const response = await fetch('/api/template?' + new URLSearchParams({ file }));
    if (!response.ok) throw new Error(await response.text());
    const source = await response.json();
    slot.replaceChildren(element('h3', 'Template · ' + file), element('p', source.total + ' lines'), codeBlock(source));
  } catch (error) {
    slot.replaceChildren(element('p', error.message));
  }
}
