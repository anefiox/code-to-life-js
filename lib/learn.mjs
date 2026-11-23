// Guided views for people new to a codebase: what happens when a page is
// visited, and a "Start here" reading order.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ExplainError } from './explain.mjs';
import { ignoredDirectories, portable } from './source.mjs';

const templateExtensions = ['.njk', '.nunjucks', '.html', '.hbs', '.handlebars', '.ejs', '.pug', '.liquid', '.twig', '.mustache'];
const flowEdges = new Set(['calls', 'creates', 'renders']);
const flowDepth = 3;
const flowLimit = 20;
const tourLength = 12;
const templateLimit = 512 * 1024;

const frameworks = [
  ['@hapi/hapi', 'Hapi', 'For every request, Hapi first runs the server\'s plugins and lifecycle hooks, such as ' +
    'sign-in, sessions, CSRF checks and security headers. Then it calls the handler for the matching route.'],
  ['express', 'Express', 'For every request, Express first runs the middleware added with app.use, in order, such ' +
    'as body parsing, sessions and sign-in. Then it calls the handler for the matching route.'],
  ['fastify', 'Fastify', 'For every request, Fastify first runs its hooks and plugins, such as sign-in or ' +
    'validation. Then it calls the handler for the matching route.'],
  ['koa', 'Koa', 'For every request, Koa passes through each middleware added with app.use, in order. The router ' +
    'middleware then calls the handler for the matching route.']
];

function manifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function framework(root) {
  const packages = { ...manifest(root).dependencies, ...manifest(root).devDependencies };
  const match = frameworks.find(([name]) => packages[name]);
  return match ? { name: match[1], before: match[2] } : null;
}

export function templateFiles(root) {
  return ts.sys.readDirectory(root, templateExtensions, ignoredDirectories.map(dir => '**/' + dir + '/**'))
    .map(file => portable(path.relative(root, file)))
    .filter(file => !file.startsWith('../'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

// "home/index" → "src/server/routes/home/index.njk"
export function templateFor(name, files) {
  const wanted = name.replace(/^\.?\//, '');
  const hasExtension = templateExtensions.some(extension => wanted.endsWith(extension));
  return files.find(file => {
    const bare = hasExtension ? file : file.slice(0, file.length - path.extname(file).length);
    return bare === wanted || bare.endsWith('/' + wanted);
  }) ?? null;
}

export function routeFlows(root, graph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const tests = new Set(graph.tests.map(id => id.slice('module:'.length)));
  const outgoing = new Map();
  for (const edge of graph.edges) {
    if (!flowEdges.has(edge.kind)) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const files = templateFiles(root);
  const found = framework(root);
  const routes = (graph.routes ?? []).map(route => {
    const steps = [];
    const seen = new Set([route.handler]);
    const queue = [{ id: route.handler, depth: 0 }];
    for (let index = 0; index < queue.length && steps.length < flowLimit; index++) {
      const { id, depth } = queue[index];
      if (depth >= flowDepth) continue;
      for (const next of outgoing.get(id) ?? []) {
        const node = byId.get(next);
        if (seen.has(next) || !node || tests.has(node.file)) continue;
        seen.add(next);
        steps.push({ id: next, from: id, depth: depth + 1 });
        queue.push({ id: next, depth: depth + 1 });
        if (steps.length >= flowLimit) break;
      }
    }
    const names = new Set([route.handler, ...steps.map(step => step.id)].flatMap(id => graph.views?.[id] ?? []));
    return {
      ...route, key: route.method + ' ' + route.path + ' ' + route.file + ':' + route.line,
      steps, templates: [...names].map(name => ({ name, file: templateFor(name, files) }))
    };
  });
  return { framework: found?.name ?? null, before: found?.before ?? null, routes };
}

export function readTemplate(root, file) {
  if (typeof file !== 'string' || !templateFiles(root).includes(file)) throw new ExplainError('Unknown template.', 404);
  const target = fs.realpathSync(path.resolve(root, file));
  if (!target.startsWith(root + path.sep)) throw new ExplainError('File is outside the project.', 403);
  if (fs.statSync(target).size > templateLimit) throw new ExplainError('Template is too large to show.', 413);
  const code = fs.readFileSync(target, 'utf8').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const total = code.split('\n').length;
  return { file, start: 1, end: total, total, code };
}

// Any readable text file in the project, so recipe and settings steps can show
// the file they point at. Secrets files such as .env are never shown.
const readableFile = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|s?css|less|njk|nunjucks|html?|hbs|ejs|pug|liquid|twig|mustache|txt|sh|cs|cshtml|razor|csproj|props|targets|xml|config)$|(?:^|\/)(?:Dockerfile|Makefile|\.env\.(?:example|sample|template))$/i;

export function readProjectFile(root, file) {
  if (typeof file !== 'string' || !readableFile.test(file) || /(?:^|\/)\.env(?:$|\.(?!example|sample|template))/i.test(file) ||
      file.split('/').some(part => part === '..' || ignoredDirectories.includes(part))) {
    throw new ExplainError('That file cannot be shown.', 404);
  }
  let target;
  try {
    target = fs.realpathSync(path.resolve(root, file));
  } catch {
    throw new ExplainError('File not found.', 404);
  }
  if (!target.startsWith(root + path.sep)) throw new ExplainError('File is outside the project.', 403);
  if (fs.statSync(target).size > templateLimit) throw new ExplainError('File is too large to show.', 413);
  const code = fs.readFileSync(target, 'utf8').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const total = code.split('\n').length;
  return { file, start: 1, end: total, total, code };
}

function resolveModule(candidate, modules) {
  const clean = portable(path.normalize(candidate)).replace(/^\.\/?/, '').replace(/\/$/, '');
  if (modules.has(clean)) return clean;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
  for (const extension of extensions) if (modules.has(clean + extension)) return clean + extension;
  for (const extension of extensions) {
    const index = (clean ? clean + '/' : '') + 'index' + extension;
    if (modules.has(index)) return index;
  }
  return null;
}

// Where the app starts: package.json "main", the file a start script runs,
// or a conventional name.
export function entryPoint(root, graph) {
  const tests = new Set(graph.tests);
  const modules = new Set(graph.nodes.filter(node => node.kind === 'module' && !tests.has(node.id)).map(node => node.file));
  const pkg = manifest(root);
  const candidates = [];
  if (typeof pkg.main === 'string') candidates.push([pkg.main, 'package.json says "main" is this file, so Node starts here.']);
  for (const script of ['start', 'dev', 'serve']) {
    const command = pkg.scripts?.[script];
    if (typeof command !== 'string') continue;
    for (const token of command.split(/\s+/)) {
      if (token.startsWith('-') || token.includes('=') || !/^\.|\/|\.[cm]?[jt]sx?$/.test(token)) continue;
      candidates.push([token === '.' && pkg.main ? pkg.main : token, 'The "' + script + '" script in package.json runs this file.']);
    }
  }
  for (const name of ['src/index', 'src/main', 'src/server', 'src/app', 'index', 'main', 'server', 'app']) {
    candidates.push([name, 'Apps conventionally start from a file with this name.']);
  }
  for (const [candidate, reason] of candidates) {
    const file = resolveModule(candidate, modules);
    if (file) return { file, reason };
  }
  const imports = new Map();
  for (const edge of graph.edges) if (edge.kind === 'imports') imports.set(edge.from, (imports.get(edge.from) ?? 0) + 1);
  const busiest = [...modules].sort((a, b) => (imports.get('module:' + b) ?? 0) - (imports.get('module:' + a) ?? 0))[0];
  return busiest ? { file: busiest, reason: 'There is no clear starting file, so the tour begins with the file that imports the most others.' } : null;
}

export function startTour(root, graph) {
  const entry = entryPoint(root, graph);
  if (!entry) return { steps: [] };
  const tests = new Set(graph.tests);
  const children = new Map();
  const parents = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' || tests.has(edge.from) || tests.has(edge.to) || edge.from === edge.to) continue;
    const from = edge.from.slice('module:'.length);
    const to = edge.to.slice('module:'.length);
    if (!children.has(from)) children.set(from, new Set());
    if (!parents.has(to)) parents.set(to, new Set());
    children.get(from).add(to);
    parents.get(to).add(from);
  }
  const reachCache = new Map();
  const reach = file => {
    if (reachCache.has(file)) return reachCache.get(file);
    const seen = new Set();
    const stack = [file];
    while (stack.length) for (const next of children.get(stack.pop()) ?? []) {
      if (next !== file && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
    reachCache.set(file, seen.size);
    return seen.size;
  };
  const users = file => parents.get(file)?.size ?? 0;
  const routesIn = new Map();
  for (const route of graph.routes ?? []) {
    if (!routesIn.has(route.file)) routesIn.set(route.file, []);
    routesIn.get(route.file).push(route.method + ' ' + route.path);
  }
  const pages = file => {
    const list = routesIn.get(file);
    if (!list) return '';
    return ' It defines ' + (list.length === 1 ? 'the page ' : list.length + ' pages: ') + list.slice(0, 4).join(', ') +
      (list.length > 4 ? ' and more' : '') + '.';
  };

  const steps = [{ file: entry.file, role: 'entry', reason: entry.reason + pages(entry.file) }];
  const visited = new Set([entry.file]);
  // Follow the import that brings in the most code, so the first steps trace
  // the backbone of the app from its starting file down to its pages.
  let current = entry.file;
  while (steps.length < Math.ceil(tourLength / 2)) {
    const next = [...(children.get(current) ?? [])].filter(file => !visited.has(file))
      .sort((a, b) => reach(b) - reach(a) || users(b) - users(a) || a.localeCompare(b))[0];
    if (!next) break;
    const size = reach(next);
    steps.push({ file: next, role: 'backbone', reason: 'Imported by ' + current + '.' +
      (size ? ' It brings in ' + size + ' other file' + (size === 1 ? '' : 's') + ', so a big part of the app hangs off it.' : '') +
      pages(next) });
    visited.add(next);
    current = next;
    if (!size) break;
  }
  // Then the shared files that almost everything uses.
  const hubs = [...children.keys(), ...parents.keys()].filter((file, index, all) => all.indexOf(file) === index)
    .filter(file => !visited.has(file) && users(file) >= 2)
    .sort((a, b) => users(b) - users(a) || reach(b) - reach(a) || a.localeCompare(b));
  for (const file of hubs) {
    if (steps.length >= tourLength) break;
    steps.push({ file, role: 'shared', reason: 'Used by ' + users(file) + ' files, so you will see it all over the app.' + pages(file) });
    visited.add(file);
  }
  return { steps: steps.map(step => ({ ...step, id: 'module:' + step.file })) };
}
