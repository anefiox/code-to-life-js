// Helpers for understanding a codebase quickly: "How do I…" recipes, the
// settings map, the template map, framework term tooltips, examples from
// tests, Git history, step-by-step page playback, reading progress, the
// onboarding guide and "Ask the codebase".
const guide = {
  recipes: null, settings: null, templates: null, history: null, concepts: [], matchers: [],
  read: new Set(), playback: null, asking: false
};

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || 'The server said ' + response.status + '.');
  return response.json();
}

const plural = (count, word) => count + ' ' + (count === 1 ? word : word === 'person' ? 'people' : word + 's');
const nodeKey = node => node.kind === 'module' ? node.file : node.file + '#' + node.name;

// The smallest function or class around a line, so a link to file:line opens
// the code that line belongs to.
function nodeAtLine(file, line) {
  let best = null;
  for (const node of state.graph?.nodes ?? []) {
    if (node.file !== file || node.kind === 'module' || node.line > line || (node.endLine ?? node.line) < line) continue;
    if (!best || (node.endLine ?? node.line) - node.line < (best.endLine ?? best.line) - best.line) best = node;
  }
  return best?.id ?? (state.items.has('module:' + file) ? 'module:' + file : null);
}

function openFile(file, line = 1) {
  if (guide.templates?.templates.some(item => item.file === file)) {
    inspectTemplate(file, line);
    return;
  }
  const id = line > 1 ? nodeAtLine(file, line) : state.items.has('module:' + file) ? 'module:' + file : null;
  if (id) {
    guide.pendingLine = line > 1 ? { id, line } : null;
    focus(id);
    return;
  }
  showProjectFile(file, line);
}

function fileLink(file, line) {
  return link(file + (line > 1 ? ':' + line : ''), () => openFile(file, line));
}

// Highlights the line a recipe or setting pointed at once its code has loaded.
function markPendingLine(id, pre, start) {
  const pending = guide.pendingLine;
  guide.pendingLine = null;
  if (pending?.id === id) markLine(pre, start, pending.line);
}

function markLine(pre, start, line) {
  const row = pre.children[line - start];
  if (!row) return;
  row.classList.add('hit');
  requestAnimationFrame(() => { pre.scrollTop = Math.max(0, row.offsetTop - pre.clientHeight / 3); });
}

async function showProjectFile(file, line = 1) {
  state.inspecting = null;
  const details = byId('details');
  details.replaceChildren(element('h2', file), element('p', 'Loading…'));
  try {
    const source = await getJson('/api/file?' + new URLSearchParams({ file }));
    const pre = codeBlock(source);
    details.replaceChildren(element('h2', file), element('p', source.total + ' lines'), pre);
    markLine(pre, source.start, line);
  } catch (error) {
    details.replaceChildren(element('h2', file), element('p', error.message));
  }
}

// ---------- Framework terms ----------

function setConcepts(concepts) {
  guide.concepts = concepts ?? [];
  guide.matchers = guide.concepts.map(concept => ({
    concept,
    pattern: new RegExp('(?<![\\w/.#-])(?:' + concept.pattern + ')(?![\\w-])', /[A-Z]/.test(concept.pattern) ? 'g' : 'gi')
  }));
}

// Text with the first mention of each framework term underlined; hovering or
// focusing it shows what the term means.
function annotate(text) {
  const fragment = document.createDocumentFragment();
  const value = String(text ?? '');
  const hits = [];
  for (const { concept, pattern } of guide.matchers) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match) hits.push({ start: match.index, end: match.index + match[0].length, concept });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue;
    fragment.append(value.slice(at, hit.start));
    const term = element('span', value.slice(hit.start, hit.end));
    term.className = 'term';
    term.tabIndex = 0;
    term.dataset.term = hit.concept.term;
    term.dataset.meaning = hit.concept.meaning;
    term.setAttribute('aria-label', value.slice(hit.start, hit.end) + ': ' + hit.concept.meaning);
    fragment.append(term);
    at = hit.end;
  }
  fragment.append(value.slice(at));
  return fragment;
}

function prose(tag, text) {
  const item = document.createElement(tag);
  item.append(annotate(text));
  return item;
}

function showTip(target) {
  const tip = byId('term-tip');
  tip.replaceChildren(element('strong', target.dataset.term), element('span', target.dataset.meaning));
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 16);
  tip.style.width = width + 'px';
  tip.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + 'px';
  const below = box.bottom + 6;
  tip.style.top = (below + tip.offsetHeight > window.innerHeight ? box.top - tip.offsetHeight - 6 : below) + 'px';
}

function hideTip() {
  byId('term-tip').hidden = true;
}

// ---------- Reading progress ----------

const progressKey = () => 'codetolife:read:' + (state.graph?.root ?? '');
const tourKey = () => 'codetolife:tour:' + (state.graph?.root ?? '');

function loadProgress() {
  try {
    guide.read = new Set(JSON.parse(localStorage.getItem(progressKey()) ?? '[]'));
  } catch {
    guide.read = new Set();
  }
}

function saveProgress() {
  try {
    localStorage.setItem(progressKey(), JSON.stringify([...guide.read]));
  } catch {
    // Private windows may block storage; progress then lasts for this visit only.
  }
}

function savedTourStep() {
  try {
    return Number(localStorage.getItem(tourKey()) ?? -1);
  } catch {
    return -1;
  }
}

function saveTourStep(index) {
  try {
    localStorage.setItem(tourKey(), String(index));
  } catch {
    // See saveProgress.
  }
}

function isRead(id) {
  const node = state.items.get(id);
  return Boolean(node && guide.read.has(nodeKey(node)));
}

function setRead(id, read) {
  const node = state.items.get(id);
  if (!node) return;
  if (read) guide.read.add(nodeKey(node));
  else guide.read.delete(nodeKey(node));
  saveProgress();
  cy.getElementById(id).toggleClass('read', read);
}

function paintRead() {
  if (!guide.read.size) return;
  cy.batch(() => cy.nodes().forEach(node => { if (isRead(node.id())) node.addClass('read'); }));
}

function readToggle(id) {
  const label = document.createElement('label');
  label.className = 'read-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isRead(id);
  box.addEventListener('change', () => setRead(id, box.checked));
  label.append(box, document.createTextNode(' I\'ve read this'));
  return label;
}

// ---------- Overview and details additions ----------

function guideOverview(details) {
  const graph = state.graph;
  const tests = new Set(graph.tests);
  const files = graph.nodes.filter(node => node.kind === 'module' && !tests.has(node.id));
  const read = files.filter(node => guide.read.has(nodeKey(node))).length;
  const steps = learn.data?.tour.steps.length ?? 0;
  const reached = savedTourStep();
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.append(element('h3', 'Your progress'));
  const bar = document.createElement('progress');
  bar.max = files.length || 1;
  bar.value = read;
  bar.setAttribute('aria-label', 'Files read');
  progress.append(element('p', 'You have marked ' + read + ' of ' + plural(files.length, 'file') + ' as read.'), bar);
  if (steps) {
    const resume = element('button', reached >= 0 && reached < steps - 1 ? 'Continue Start here at step ' + (reached + 2) :
      reached >= steps - 1 ? 'Start here again' : 'Take the Start here tour');
    resume.type = 'button';
    resume.className = 'learn-action';
    resume.addEventListener('click', () => {
      byId('tour-toggle').setAttribute('aria-pressed', 'true');
      byId('tour').hidden = false;
      if (byId('view').value !== 'modules') {
        byId('view').value = 'modules';
        render();
      }
      showTourStep(reached >= 0 && reached < steps - 1 ? reached + 1 : 0);
    });
    progress.append(resume);
  }
  if (read) {
    const reset = element('button', 'Clear my progress');
    reset.type = 'button';
    reset.className = 'link';
    reset.addEventListener('click', () => {
      guide.read.clear();
      saveProgress();
      saveTourStep(-1);
      cy.nodes().removeClass('read');
      overview();
    });
    progress.append(document.createElement('br'), reset);
  }
  const download = element('button', 'Download onboarding guide (Markdown)');
  download.type = 'button';
  download.className = 'learn-action';
  download.addEventListener('click', downloadGuide);
  progress.append(element('h3', 'Share it'), element('p', 'One page with the tools, how to run it, the folders, the tour, ' +
    'pages, settings, recipes and explanations. Commit it as ONBOARDING.md for the team.'), download);
  details.append(progress);

  const hot = document.createElement('div');
  details.append(hot);
  showHotspots(hot);

  if (guide.concepts.length) {
    const terms = document.createElement('details');
    terms.className = 'terms';
    terms.append(element('summary', 'Terms you\'ll meet (' + guide.concepts.length + ')'));
    const list = document.createElement('dl');
    list.className = 'glossary';
    for (const concept of guide.concepts) list.append(element('dt', concept.term), element('dd', concept.meaning));
    terms.append(list);
    details.append(terms);
  }
}

async function downloadGuide(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/onboarding');
    if (!response.ok) throw new Error(await response.text());
    const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ONBOARDING.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    byId('status').textContent = 'Could not build the guide: ' + error.message;
  } finally {
    button.disabled = false;
  }
}

async function showHotspots(slot) {
  try {
    guide.history ??= await getJson('/api/history');
  } catch {
    return;
  }
  const history = guide.history;
  if (!history.available || !history.hotspots.length || !slot.isConnected) return;
  slot.append(element('h3', 'Most changed files'), element('p', 'Where most of the work happens. ' +
    plural(history.commits, 'commit') + (history.limited ? ' (the latest)' : '') + ' by ' + plural(history.contributors, 'person') +
    (history.first ? ', ' + history.first + ' to ' + history.last : '') + '.'));
  const list = document.createElement('ul');
  for (const entry of history.hotspots.slice(0, 8)) {
    list.append(listRow(entry.file + ' · ' + plural(entry.commits, 'commit') + ' · last ' + entry.last +
      (entry.authors[0] ? ' · mostly ' + entry.authors[0].name : ''), () => openFile(entry.file)));
  }
  slot.append(list);
}

// Appended to the details of any file or function.
function guideInspect(id, details) {
  details.children[1]?.after(readToggle(id));
  const node = state.items.get(id);
  const examples = document.createElement('div');
  const history = document.createElement('div');
  details.append(examples, history);
  if (!state.graph.tests.includes('module:' + node.file)) showExamples(id, examples);
  showHistory(id, history);
}

async function showExamples(id, slot) {
  let data;
  try {
    data = await getJson('/api/examples?' + new URLSearchParams({ id }));
  } catch {
    return;
  }
  if (state.inspecting !== id) return;
  if (!data.examples.length) {
    if (state.items.get(id).kind !== 'module') {
      slot.append(element('h3', 'Examples from tests'), element('p', data.testFiles?.length ?
        'The tests that use this file don\'t mention it by name.' : 'No tests use this yet.'));
    }
    return;
  }
  slot.append(element('h3', 'Examples from tests'),
    element('p', 'How the tests use it: real inputs and the results they expect.'));
  for (const example of data.examples) {
    const title = element('p', example.title + ' · ');
    title.className = 'example-title';
    title.append(fileLink(example.file, example.start));
    slot.append(title, codeBlock({ ...example, total: example.end }));
  }
}

async function showHistory(id, slot) {
  let data;
  try {
    data = await getJson('/api/history?' + new URLSearchParams({ id }));
  } catch {
    return;
  }
  if (state.inspecting !== id || !data.available) return;
  slot.append(element('h3', 'History'));
  if (!data.commits.length) {
    slot.append(element('p', data.note ?? 'No commits found.'));
    return;
  }
  if (data.authors.length) {
    slot.append(element('p', 'Who to ask: ' + data.authors.map(author => author.name + ' (' + plural(author.commits, 'commit') + ')').join(', ') +
      ', from the latest changes.'));
  }
  const list = document.createElement('ul');
  list.className = 'commits';
  for (const commit of data.commits) {
    const item = element('li', commit.date + ' · ' + commit.subject + ' · ' + commit.author + ' ');
    item.append(element('code', commit.hash));
    list.append(item);
  }
  slot.append(list);
}

// ---------- How do I… ----------

function setPanel(name, open) {
  byId(name + '-toggle').setAttribute('aria-pressed', String(open));
  byId(name).hidden = !open;
}

async function showRecipes() {
  const section = byId('recipes');
  if (section.hidden) return;
  section.replaceChildren(element('h2', 'How do I…'));
  try {
    guide.recipes ??= (await getJson('/api/recipes')).recipes;
  } catch (error) {
    section.append(element('p', error.message));
    return;
  }
  if (!guide.recipes.length) {
    section.append(element('p', 'No common patterns found yet in this project.'));
    return;
  }
  section.append(element('p', 'Checklists for common changes, worked out from what this project already does. Each step links to an example to copy.'));
  for (const recipe of guide.recipes) {
    const box = document.createElement('details');
    box.className = 'recipe';
    box.append(element('summary', recipe.title), prose('p', recipe.summary));
    const steps = document.createElement('ol');
    for (const step of recipe.steps) {
      const item = prose('li', step.text);
      if (step.file) {
        item.append(' ');
        item.append(fileLink(step.file, step.line));
      }
      steps.append(item);
    }
    box.append(steps);
    section.append(box);
  }
}

// ---------- Settings ----------

async function showSettings() {
  const section = byId('settings');
  if (section.hidden) return;
  try {
    guide.settings ??= await getJson('/api/settings');
  } catch (error) {
    section.replaceChildren(element('h2', 'Settings'), element('p', error.message));
    return;
  }
  const { settings, schema } = guide.settings;
  const filter = section.querySelector('input')?.value ?? '';
  section.replaceChildren(element('h2', 'Settings'));
  if (!settings.length) {
    section.append(element('p', 'No settings found. Code to Life looks for a convict schema and process.env.'));
    return;
  }
  section.append(element('p', plural(settings.length, 'setting') + (schema ? ', defined in ' : '.')));
  if (schema) section.lastChild.append(fileLink(schema), '. Environment variables change them without changing code.');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filter settings';
  search.setAttribute('aria-label', 'Filter settings');
  search.value = filter;
  const list = document.createElement('div');
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    list.replaceChildren(...settings.filter(setting => !term ||
      (setting.key + ' ' + (setting.env ?? '') + ' ' + setting.doc).toLowerCase().includes(term)).map(settingRow));
  };
  search.addEventListener('input', draw);
  section.append(search, list);
  draw();
}

function settingRow(setting) {
  const box = document.createElement('details');
  box.className = 'setting';
  const summary = document.createElement('summary');
  summary.append(element('code', setting.key));
  if (setting.env && setting.env !== setting.key) {
    const env = element('span', setting.env);
    env.className = 'env';
    summary.append(' ', env);
  }
  if (setting.varies) {
    const tag = element('span', 'differs in production');
    tag.className = 'tag';
    summary.append(' ', tag);
  }
  box.append(summary);
  if (setting.doc) box.append(element('p', setting.doc));
  const facts = document.createElement('dl');
  facts.className = 'facts';
  const fact = (label, value) => {
    const dd = document.createElement('dd');
    dd.append(value);
    facts.append(element('dt', label), dd);
  };
  fact('Default', setting.sensitive ? element('span', '(secret, not shown)') : element('code', setting.default || '(none)'));
  if (setting.env) fact('Environment variable', element('code', setting.env));
  fact('Defined in', fileLink(setting.file, setting.line));
  if (setting.setIn.length) {
    const where = document.createElement('span');
    setting.setIn.forEach((item, index) => {
      if (index) where.append(', ');
      where.append(fileLink(item.file, item.line));
      if (item.value !== null && item.value !== undefined) where.append(' = ', element('code', item.value));
    });
    fact('Set for local runs in', where);
  }
  box.append(facts);
  if (setting.uses.length) {
    box.append(element('p', 'Read by:'));
    const list = document.createElement('ul');
    for (const use of setting.uses) {
      const node = state.items.get(use.id);
      list.append(listRow((node && node.kind !== 'module' ? node.name + ' · ' : '') + use.file + ':' + use.line +
        (use.key !== setting.key ? ' (reads ' + use.key + ')' : ''), () => openFile(use.file, use.line)));
    }
    box.append(list);
  } else {
    box.append(element('p', 'Nothing in the code reads this directly.'));
  }
  return box;
}

// ---------- Templates ----------

async function loadTemplates() {
  try {
    guide.templates = await getJson('/api/templates');
  } catch {
    guide.templates = { templates: [] };
  }
  const option = byId('view').querySelector('option[value="templates"]');
  option.hidden = !guide.templates.templates.length;
  if (byId('view').value === 'templates') render();
}

const templateKinds = {
  page: 'A page template: a route\'s handler fills it in and sends it to the browser.',
  layout: 'A layout: pages extend it to share the header, footer and the other parts every page has.',
  component: 'A component: a reusable piece of page that other templates call like a function (a macro).',
  partial: 'A partial: a piece of page that other templates include.'
};

function templateElements() {
  const items = guide.templates?.templates ?? [];
  const elements = [];
  const external = new Set();
  const add = (from, ref, how) => {
    if (!ref) return;
    let target = ref.file ? 'template:' + ref.file : 'template-ext:' + ref.external;
    if (!ref.file) external.add(ref.external);
    elements.push({ group: 'edges', data: { id: 'tedge:' + from + '>' + target + ':' + how, source: 'template:' + from, target },
      classes: 'template-edge ' + how });
  };
  for (const item of items) {
    elements.push({ group: 'nodes', data: { id: 'template:' + item.file, label: item.file.split('/').slice(-2).join('/') },
      classes: 'template template-' + item.kind });
    add(item.file, item.extends, 'extends');
    for (const ref of item.includes) add(item.file, ref, 'includes');
    for (const ref of item.imports) add(item.file, ref, 'imports');
    for (const by of item.renderedBy) {
      const id = 'thandler:' + by.id;
      if (!elements.some(entry => entry.data.id === id)) {
        elements.push({ group: 'nodes', data: { id, label: (by.routes[0] ?? by.name) + (by.routes.length > 1 ? ' +' + (by.routes.length - 1) : '') },
          classes: 'template-handler' });
      }
      elements.push({ group: 'edges', data: { id: 'tedge:' + id + '>' + item.file, source: id, target: 'template:' + item.file },
        classes: 'template-edge renders' });
    }
  }
  for (const name of external) {
    elements.push({ group: 'nodes', data: { id: 'template-ext:' + name, label: name }, classes: 'template-external' });
  }
  // Several references between the same pair collapse into one arrow.
  const seen = new Set();
  return elements.filter(entry => {
    if (entry.group !== 'edges') return true;
    const key = entry.data.source + '>' + entry.data.target;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderTemplates() {
  cy.elements().remove();
  cy.add(templateElements());
  arrange();
  const count = guide.templates?.templates.length ?? 0;
  byId('status').textContent = plural(count, 'template') + ' · arrows point from a template to what it extends or uses';
}

function inspectTemplate(file, line = 1) {
  const item = guide.templates?.templates.find(entry => entry.file === file);
  if (!item) return;
  state.inspecting = null;
  if (byId('view').value === 'templates') {
    cy.elements().unselect();
    cy.getElementById('template:' + file).select();
  }
  const details = byId('details');
  details.replaceChildren(element('h2', file), prose('p', templateKinds[item.kind]));
  const refLink = ref => ref.file ? fileLink(ref.file) : element('span', ref.name + ' (from ' + ref.external + ')');
  if (item.extends) {
    const row = element('p', 'Extends ');
    row.append(refLink(item.extends), item.blocks.length ? ' and fills in its ' + item.blocks.join(', ') + ' block' +
      (item.blocks.length === 1 ? '' : 's') + '.' : '.');
    details.append(element('h3', 'Layout'), row);
  } else if (item.blocks.length) {
    details.append(element('h3', 'Blocks'), element('p', 'Defines ' + item.blocks.join(', ') + ', which pages that extend it can fill in.'));
  }
  const uses = [...item.includes.map(ref => [ref, 'includes']), ...item.imports.map(ref => [ref, 'imports ' + ref.names.join(', ') + ' from'])];
  if (uses.length) {
    const list = document.createElement('ul');
    for (const [ref, how] of uses) {
      const row = element('li', how + ' ');
      row.append(refLink(ref));
      list.append(row);
    }
    details.append(element('h3', 'Uses'), list);
  }
  if (item.usedBy.length) {
    const list = document.createElement('ul');
    for (const use of item.usedBy) {
      const row = document.createElement('li');
      row.append(fileLink(use.file), ' ' + use.how + ' it');
      list.append(row);
    }
    details.append(element('h3', 'Used by'), list);
  }
  if (item.renderedBy.length) {
    const list = document.createElement('ul');
    for (const by of item.renderedBy) {
      const row = document.createElement('li');
      row.append(link(by.name + (by.file ? ' · ' + by.file : ''), () => focus(by.id)));
      if (by.routes.length) row.append(' for ' + by.routes.join(', '));
      list.append(row);
    }
    details.append(element('h3', 'Rendered by'), list);
  }
  const slot = document.createElement('div');
  details.append(slot);
  showTemplate(file, slot).then(() => {
    const pre = slot.querySelector('pre');
    if (pre && line > 1) markLine(pre, 1, line);
  });
}

// ---------- Play a page step by step ----------

function playFlow(route) {
  const frames = [{ kind: 'request' }];
  if (learn.data.pages.before) frames.push({ kind: 'before' });
  frames.push({ kind: 'route' });
  if (state.items.has(route.handler)) frames.push({ kind: 'code', id: route.handler, title: 'The handler runs' });
  const children = new Map();
  for (const step of route.steps) {
    if (!children.has(step.from)) children.set(step.from, []);
    children.get(step.from).push(step);
  }
  // Depth first, so each call is followed by the calls it makes.
  const walk = from => {
    for (const step of children.get(from) ?? []) {
      if (!state.items.has(step.id)) continue;
      const caller = state.items.get(step.from);
      frames.push({ kind: 'code', id: step.id, title: 'It calls ' + state.items.get(step.id).name +
        (caller ? ' (from ' + caller.name + ')' : '') });
      walk(step.id);
    }
  };
  walk(route.handler);
  for (const template of route.templates) if (template.file) frames.push({ kind: 'template', file: template.file });
  frames.push({ kind: 'done' });
  guide.playback = { route, frames, index: 0, timer: null };
  showFrame();
}

function stopPlayback(back = true) {
  if (!guide.playback) return;
  clearInterval(guide.playback.timer);
  const { route } = guide.playback;
  guide.playback = null;
  cy.nodes().removeClass('flow-now');
  if (back) showFlow(route);
}

function showFrame() {
  const play = guide.playback;
  if (!play) return;
  const { route, frames, index } = play;
  const frame = frames[index];
  const details = byId('details');
  state.inspecting = null;
  const progress = element('p', 'Step ' + (index + 1) + ' of ' + frames.length);
  progress.className = 'tour-progress';
  const box = document.createElement('div');
  box.className = 'player';
  const body = document.createElement('div');
  const method = route.method.split(',')[0];
  let title;
  if (frame.kind === 'request') {
    title = 'The browser asks for ' + route.path;
    body.append(prose('p', 'Someone ' + (method === 'GET' ? 'follows a link or types the address' : 'submits a form') +
      ', so the browser sends a ' + method + ' request for ' + route.path + ' to the server.'));
  } else if (frame.kind === 'before') {
    title = 'The server gets it ready';
    body.append(prose('p', learn.data.pages.before));
  } else if (frame.kind === 'route') {
    title = 'The route matches the address';
    body.append(prose('p', 'The server finds the route for ' + route.method + ' ' + route.path + ' and hands the request to its handler.'));
    const where = element('p', 'Defined in ');
    where.append(fileLink(route.file, route.line));
    body.append(where);
  } else if (frame.kind === 'code') {
    const node = state.items.get(frame.id);
    title = frame.title;
    const explained = state.explanations[frame.id];
    body.append(prose('p', explained?.summary ?? 'No explanation yet. Read the code below to see what it does.'));
    const where = element('p', '');
    where.append(link(node.name + ' · ' + node.file + ':' + node.line, () => { stopPlayback(false); focus(frame.id); }));
    body.append(where);
    const code = document.createElement('div');
    body.append(code);
    getJson('/api/source?' + new URLSearchParams({ id: frame.id })).then(source => {
      if (guide.playback === play && play.index === index) code.append(codeBlock(source));
    }).catch(() => {});
  } else if (frame.kind === 'template') {
    title = 'It fills in the page template';
    body.append(prose('p', 'The handler passes its values to the template, which turns them into the HTML the browser shows.'));
    const slot = document.createElement('div');
    body.append(slot);
    showTemplate(frame.file, slot);
  } else {
    title = 'The response goes back to the browser';
    body.append(prose('p', 'The server sends the page (or a redirect, or data) back, and the browser shows it. That is the whole journey of ' +
      route.method + ' ' + route.path + '.'));
  }
  const back = element('button', '← Back');
  const next = element('button', index === frames.length - 1 ? 'Finish' : 'Next →');
  const auto = element('button', play.timer ? 'Pause' : 'Play');
  for (const button of [back, next, auto]) button.type = 'button';
  back.disabled = index === 0;
  back.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => index === frames.length - 1 ? stopPlayback() : move(1));
  auto.addEventListener('click', () => {
    if (play.timer) {
      clearInterval(play.timer);
      play.timer = null;
    } else {
      play.timer = setInterval(() => play.index < play.frames.length - 1 ? move(1, true) : stopPlayback(false), 6000);
    }
    showFrame();
  });
  const close = element('button', 'Stop');
  close.type = 'button';
  close.addEventListener('click', () => stopPlayback());
  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.append(back, next, auto, close);
  box.append(progress, element('h3', title), body, controls);
  details.replaceChildren(element('h2', route.method + ' ' + route.path), box);
  if (index === 0) details.scrollIntoView({ block: 'start' });

  cy.nodes().removeClass('flow-now');
  const visited = frames.slice(0, index + 1).filter(item => item.kind === 'code').map(item => item.id);
  for (const id of visited) cy.getElementById(id).addClass('flow-step');
  if (frame.kind === 'code') {
    const node = cy.getElementById(frame.id);
    node.addClass('flow-now');
    cy.animate({ center: { eles: node }, duration: 300 });
  }
}

function move(delta, automatic = false) {
  const play = guide.playback;
  if (!play) return;
  if (!automatic && play.timer) {
    clearInterval(play.timer);
    play.timer = null;
  }
  play.index = Math.max(0, Math.min(play.frames.length - 1, play.index + delta));
  showFrame();
}

// ---------- Ask the codebase ----------

function showAsk() {
  const section = byId('ask');
  if (section.hidden || section.querySelector('form')) return;
  const form = document.createElement('form');
  form.className = 'ask-form';
  const label = element('label', 'Ask a question about this code');
  label.htmlFor = 'ask-question';
  const input = document.createElement('textarea');
  input.id = 'ask-question';
  input.rows = 2;
  input.maxLength = 500;
  input.placeholder = 'Where is cookie consent checked? What happens on POST /cookies?';
  const submit = element('button', 'Ask');
  submit.type = 'submit';
  const note = element('p', state.ai ? 'Answers come from ' + state.ai.label + ', using the code and explanations that best match.' :
    'Start Code to Life with --ai to get written answers. For now, Ask shows the code that best matches your question.');
  note.className = 'hint';
  const answer = document.createElement('div');
  answer.className = 'answer';
  answer.setAttribute('aria-live', 'polite');
  form.append(label, input, submit, note);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (guide.asking) return;
    guide.asking = true;
    submit.disabled = true;
    answer.replaceChildren(element('p', state.ai ? 'Thinking… a local model can take a minute.' : 'Searching…'));
    try {
      const data = await getJson('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: input.value }) });
      showAnswer(answer, data);
    } catch (error) {
      answer.replaceChildren(element('p', error.message));
    } finally {
      guide.asking = false;
      submit.disabled = false;
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  section.replaceChildren(element('h2', 'Ask the codebase'), form, answer);
}

// Turns `file` and `name` references in an answer into links to the graph.
function linkify(text) {
  const fragment = document.createDocumentFragment();
  const byFile = new Map();
  const byName = new Map();
  const tests = new Set(state.graph.tests);
  for (const node of state.graph.nodes) {
    if (node.kind === 'module') byFile.set(node.file, node.id);
    else if (!tests.has('module:' + node.file)) {
      for (const name of [node.name, node.name.split('.').at(-1)]) if (!byName.has(name)) byName.set(name, node.id);
    }
  }
  String(text).split(/(`[^`\n]+`)/).forEach(part => {
    if (!part.startsWith('`') || part.length < 3) {
      fragment.append(annotate(part));
      return;
    }
    const value = part.slice(1, -1).trim();
    const bare = value.replace(/\(\)$/, '').replace(/:\d+(?:-\d+)?$/, '');
    // A short path such as `server.js` links when only one file ends with it.
    const suffix = list => {
      const found = list.filter(file => file === bare || file.endsWith('/' + bare));
      return found.length === 1 ? found[0] : null;
    };
    const file = byFile.get(bare) ? bare : suffix([...byFile.keys()]);
    const id = (file && byFile.get(file)) ?? byName.get(bare);
    const template = !id && suffix((guide.templates?.templates ?? []).map(item => item.file));
    if (id) fragment.append(link(value, () => focus(id)));
    else if (template) fragment.append(link(value, () => inspectTemplate(template)));
    else fragment.append(element('code', value));
  });
  return fragment;
}

function showAnswer(slot, data) {
  slot.replaceChildren();
  if (data.answer) {
    for (const paragraph of data.answer.split(/\n{2,}/)) {
      const item = document.createElement('p');
      item.className = 'answer-text';
      item.append(linkify(paragraph));
      slot.append(item);
    }
  }
  if (!data.sources.length) {
    if (!data.answer) slot.append(element('p', 'Nothing in the code matched. Try the words you would expect in a file or function name.'));
    return;
  }
  slot.append(element('h3', data.answer ? 'Based on' : 'The code that best matches'));
  const list = document.createElement('ul');
  for (const source of data.sources) {
    list.append(listRow(source.kind === 'module' ? source.file : source.name + ' · ' + source.file, () => focus(source.id)));
  }
  slot.append(list);
  const show = element('button', 'Highlight these on the graph');
  show.type = 'button';
  show.className = 'learn-action';
  show.addEventListener('click', () => {
    if (byId('view').value !== 'symbols') {
      byId('view').value = 'symbols';
      render();
    }
    spotlight(data.sources.map(source => source.id));
  });
  slot.append(show);
}

// ---------- Wiring ----------

function resetGuide() {
  guide.recipes = null;
  guide.settings = null;
  guide.history = null;
  loadProgress();
  showRecipes();
  showSettings();
  loadTemplates();
}

function initGuide() {
  const tip = document.createElement('div');
  tip.id = 'term-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  document.addEventListener('mouseover', event => {
    const term = event.target.closest?.('.term');
    if (term) showTip(term);
  });
  document.addEventListener('mouseout', event => { if (event.target.closest?.('.term')) hideTip(); });
  document.addEventListener('focusin', event => {
    if (event.target.classList?.contains('term')) showTip(event.target);
    else hideTip();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTip(); });
  document.querySelector('aside')?.addEventListener('scroll', hideTip);
  byId('recipes-toggle').addEventListener('click', () => {
    setPanel('recipes', byId('recipes').hidden);
    showRecipes();
  });
  byId('settings-toggle').addEventListener('click', () => {
    setPanel('settings', byId('settings').hidden);
    showSettings();
  });
  byId('ask-toggle').addEventListener('click', () => {
    setPanel('ask', byId('ask').hidden);
    showAsk();
    if (!byId('ask').hidden) byId('ask-question')?.focus();
  });
}
