// "How do I…?" recipes: short checklists for common changes, worked out from
// the patterns the project already follows, each step pointing at a real
// example to copy.
import fs from 'node:fs';
import path from 'node:path';
import { templateFiles } from './learn.mjs';
import { lineAt, readText, settingsMap } from './settings.mjs';

const dirOf = file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
const baseOf = file => file.slice(file.lastIndexOf('/') + 1);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function manifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function filesIn(root, dir) {
  try {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

function lineOf(text, pattern) {
  const match = pattern.exec(text);
  return match ? lineAt(text, match.index) : null;
}

function role(name, routeFile, handlerFile, templates) {
  if (/\.(?:spec|test)\.[^.]+$/.test(name)) return 'a test that checks the page works';
  if (templates.has(name)) return 'the page template: the HTML that is sent to the browser';
  if (name === handlerFile && name === routeFile) return 'the route and its handler: the address and the code that answers it';
  if (name === handlerFile) return 'the handler: the code that runs when the page is visited';
  if (name === routeFile) return 'the route: connects the web address to the handler';
  if (/\.s?css$/.test(name)) return 'styles for the page';
  return null;
}

const runner = pkg => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const test = pkg.scripts?.test ?? '';
  if (all.vitest || /vitest/.test(test)) return 'Vitest';
  if (all.jest || /jest/.test(test)) return 'Jest';
  if (all.mocha || /mocha/.test(test)) return 'Mocha';
  if (/node --test/.test(test)) return 'the Node.js test runner';
  return null;
};

function pageRecipe(root, graph, context) {
  const routes = (graph.routes ?? []).filter(route => !context.tests.has(route.file));
  if (!routes.length) return null;
  const handlerFile = id => context.byId.get(id)?.file;
  // Folders that each hold one page, grouped by the folder that holds them.
  const parents = new Map();
  for (const dir of new Set(routes.map(route => dirOf(route.file)))) {
    if (!dir) continue;
    const parent = dirOf(dir);
    if (!parents.has(parent)) parents.set(parent, []);
    parents.get(parent).push(dir);
  }
  const [parent, dirs] = [...parents].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  const steps = [];
  let example;
  if (dirs?.length >= 2) {
    const counts = new Map();
    const listing = new Map(dirs.map(dir => [dir, filesIn(root, dir)]));
    for (const names of listing.values()) for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const shape = [...counts].filter(([, count]) => count >= Math.max(2, dirs.length / 2)).map(([name]) => name);
    const score = dir => {
      const names = listing.get(dir);
      const viewed = routes.some(route => dirOf(route.file) === dir && graph.views?.[route.handler]?.length);
      return shape.filter(name => names.includes(name)).length * 10 + (viewed ? 5 : 0) +
        (/health|error|cookie/i.test(dir) ? -8 : 0) + names.length;
    };
    const exampleDir = [...dirs].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
    const exampleRoute = routes.find(route => dirOf(route.file) === exampleDir) ?? routes[0];
    const names = listing.get(exampleDir).filter(name => shape.includes(name) || name === baseOf(exampleRoute.file));
    const templates = new Set(names.filter(name => context.templates.has(exampleDir + '/' + name)));
    const routeName = baseOf(exampleRoute.file);
    const handlerName = handlerFile(exampleRoute.handler) && dirOf(handlerFile(exampleRoute.handler)) === exampleDir ?
      baseOf(handlerFile(exampleRoute.handler)) : null;
    example = { dir: exampleDir, route: exampleRoute };
    steps.push({ text: 'Make a folder for the new page next to the others, for example ' + parent + '/your-page/. ' +
      'Each page here has its own folder, like ' + exampleDir + '/.' });
    for (const name of names) {
      const what = role(name, routeName, handlerName, templates);
      steps.push({ text: 'Add ' + name + (what ? ': ' + what : '') + '. Copy ' + exampleDir + '/' + name + ' and change it.',
        file: exampleDir + '/' + name, line: name === routeName ? exampleRoute.line : 1 });
    }
  } else {
    example = { dir: dirOf(routes[0].file), route: routes[0] };
    const sample = routes.find(route => route.fixedPath && route.method.startsWith('GET')) ?? routes[0];
    steps.push({ text: 'Add a route like ' + sample.method + ' ' + sample.path + ', which is defined here.', file: sample.file, line: sample.line });
    const handler = context.byId.get(sample.handler);
    if (handler && handler.file !== sample.file) {
      steps.push({ text: 'Write its handler, like ' + handler.name + '.', file: handler.file, line: handler.line });
    }
  }
  // Where the page folders are plugged in, e.g. a router that imports each one.
  const exampleModules = new Set(graph.nodes.filter(node => node.kind === 'module' && dirOf(node.file) === example.dir).map(node => node.id));
  const importers = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' || !exampleModules.has(edge.to)) continue;
    const from = edge.from.slice('module:'.length);
    if (dirOf(from) === example.dir || context.tests.has(from)) continue;
    importers.set(from, (importers.get(from) ?? 0) + 1);
  }
  const registry = [...importers.keys()].sort((a, b) => importers.get(b) - importers.get(a) || a.localeCompare(b))[0];
  if (registry) {
    const text = readText(root, registry);
    const folder = baseOf(example.dir);
    const imported = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"][^\'"]*/' + escape(folder) + '/').exec(text);
    const name = imported?.[1].split(',')[0].trim().split(/\s+as\s+/).at(-1);
    let line = imported ? lineAt(text, imported.index) : lineOf(text, new RegExp(escape(folder)));
    if (name) {
      const after = new RegExp('\\b' + escape(name) + '\\b', 'g');
      after.lastIndex = imported.index + imported[0].length;
      const use = after.exec(text);
      if (use) line = lineAt(text, use.index);
    }
    steps.push({ text: 'Plug it in: ' + registry + ' imports and registers every page, so add yours next to ' +
      (name ? name : 'the others') + '.', file: registry, line: line ?? 1 });
  }
  // A menu that links to the pages.
  const paths = routes.filter(route => route.fixedPath && route.method.includes('GET') && route.path !== '/' && route.path !== '/health')
    .map(route => route.path);
  for (const file of [...context.modules, ...context.templates]) {
    if (context.tests.has(file) || file === registry || dirOf(file) === example.dir || routes.some(route => route.file === file)) continue;
    const text = readText(root, file);
    if (!/href/.test(text)) continue;
    const hit = paths.find(item => text.includes("'" + item + "'") || text.includes('"' + item + '"'));
    if (!hit) continue;
    steps.push({ text: 'If it belongs in the menu, add a link to it in ' + baseOf(file) + ', like the one for ' + hit + '.',
      file, line: lineOf(text, new RegExp('[\'"]' + escape(hit) + '[\'"]')) ?? 1 });
    break;
  }
  const dev = context.pkg.scripts?.dev ? 'npm run dev' : context.pkg.scripts?.start ? 'npm start' : null;
  steps.push({ text: (dev ? 'Run ' + dev + ' and visit' : 'Start the app and visit') + ' your new address to check it.' +
    (context.runner ? ' Then run npm test.' : '') });
  return { id: 'page', title: 'Add a page', summary: 'Every page pairs a web address with the code that answers it. ' +
    'Copying an existing page keeps yours consistent with the rest.', steps };
}

function settingRecipe(root, graph, context) {
  const { schema, settings, envFiles } = context.settings;
  if (schema) {
    const example = settings.find(setting => setting.env && setting.uses.length && setting.doc) ?? settings[0];
    const use = example?.uses.find(item => item.file !== schema);
    const steps = [
      { text: 'Add an entry to the settings in ' + baseOf(schema) + ' with a doc, a format, a default and, if it should be ' +
        'changeable per environment, an env name. ' + (example ? 'Copy ' + example.key + '.' : ''), file: schema, line: example?.line ?? 1 },
      { text: 'Read it where you need it with config.get(\'your.setting\').' + (use ? ' For example, ' + baseOf(use.file) + ' reads ' + use.key + '.' : ''),
        ...(use ? { file: use.file, line: use.line } : {}) }
    ];
    const local = envFiles.find(file => /compose|\.env\.example|\.env\.sample/i.test(file));
    if (local) steps.push({ text: 'To change it when running locally, set its environment variable in ' + local + '.', file: local, line: 1 });
    steps.push({ text: 'Settings are checked when the app starts, so a wrong value stops it with an error that names the setting.' });
    return { id: 'setting', title: 'Add a setting', summary: 'Settings such as ports, URLs and feature switches live in one ' +
      'place, with a default for your machine and environment variables to change them elsewhere.', steps };
  }
  const env = settings.find(setting => setting.uses.length);
  if (!env) return null;
  const example = envFiles.find(file => /example|sample/i.test(file));
  return { id: 'setting', title: 'Add a setting', summary: 'This project reads settings from environment variables.', steps: [
    { text: 'Read the value with process.env.YOUR_SETTING, as ' + baseOf(env.uses[0].file) + ' does with ' + env.key + '.',
      file: env.uses[0].file, line: env.uses[0].line },
    ...(example ? [{ text: 'Add it to ' + example + ' so others know it exists.', file: example, line: 1 }] : []),
    { text: 'Give it a sensible default, or fail with a clear message when it is missing.' }
  ] };
}

function filterRecipe(root, graph, context) {
  const setup = context.modules.find(file => /\.addFilter\(/.test(readText(root, file)));
  if (!setup) return null;
  const text = readText(root, setup);
  const imported = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]*filters[^'"]*)['"]/.exec(text);
  const index = imported && context.modules.find(file => file.endsWith(imported[2].replace(/^[./]+/, '')));
  const steps = [];
  const examples = index ? graph.edges.filter(edge => edge.kind === 'imports' && edge.from === 'module:' + index)
    .map(edge => edge.to.slice('module:'.length)).filter(file => !context.tests.has(file)) : [];
  const example = examples[0];
  if (example) {
    steps.push({ text: 'Write the filter as a function in its own file next to ' + baseOf(example) + '. It gets the value ' +
      'before the | and returns what to show.', file: example, line: 1 });
    const test = filesIn(root, dirOf(example)).find(name => name.startsWith(baseOf(example).replace(/\.[^.]+$/, '') + '.test.'));
    if (test) steps.push({ text: 'Add a test like ' + test + '.', file: dirOf(example) + '/' + test, line: 1 });
  }
  if (index) {
    const indexText = readText(root, index);
    steps.push({ text: 'Export it from ' + baseOf(index) + ', which ' + baseOf(setup) + ' adds to Nunjucks in one go.',
      file: index, line: lineOf(indexText, /export\s*\{/) ?? 1 });
  } else {
    steps.push({ text: 'Register it with addFilter, as ' + baseOf(setup) + ' does.', file: setup, line: lineOf(text, /\.addFilter\(/) ?? 1 });
  }
  steps.push({ text: 'Use it in any template: {{ value | yourFilter }}.' });
  return { id: 'filter', title: 'Add a template filter', summary: 'A filter changes a value as a template shows it, such as ' +
    'formatting a date or an amount of money.', steps };
}

function componentRecipe(root, graph, context) {
  const dirs = [...new Set([...context.templates].filter(file => baseOf(file) === 'macro.njk').map(dirOf))];
  if (!dirs.length) return null;
  const listing = new Map(dirs.map(dir => [dir, filesIn(root, dir)]));
  const example = [...dirs].sort((a, b) => listing.get(b).length - listing.get(a).length || a.localeCompare(b))[0];
  const name = baseOf(example);
  const steps = [{ text: 'Make a folder next to ' + example + '/ for the new component.' }];
  const roles = { 'macro.njk': 'the macro other templates call, which passes its options to the template',
    'template.njk': 'the component\'s HTML' };
  for (const file of listing.get(example)) {
    const what = roles[file] ?? (/\.s?css$/.test(file) ? 'its styles' : /\.test\./.test(file) ? 'a test that renders it and checks the HTML' : null);
    steps.push({ text: 'Add ' + file + (what ? ': ' + what : '') + '. Copy ' + example + '/' + file + '.', file: example + '/' + file, line: 1 });
  }
  const styles = context.styles.find(file => readText(root, file).includes(name + '/'));
  if (styles) {
    steps.push({ text: 'Import its styles in ' + baseOf(styles) + ', like ' + name + '.', file: styles,
      line: lineOf(readText(root, styles), new RegExp(escape(name) + '/')) ?? 1 });
  }
  const macro = readText(root, example + '/macro.njk');
  const macroName = /\{%-?\s*macro\s+(\w+)/.exec(macro)?.[1];
  const prefix = /^[a-z]+(?=[A-Z])/.exec(macroName ?? '')?.[0] ?? '';
  steps.push({ text: 'Use it in a page with {% from "your-component/macro.njk" import ' +
    (prefix ? prefix + 'YourComponent' : 'yourComponent') + ' %}' + (macroName ? ', the way ' + macroName + ' is used.' : '.') });
  return { id: 'component', title: 'Add a component', summary: 'Components are reusable pieces of page, such as a heading ' +
    'or a banner. Each one has its own folder.', steps };
}

function pluginRecipe(root, graph, context) {
  for (const file of context.modules) {
    const text = readText(root, file);
    const match = /\bserver\.register\(\s*\[([\s\S]*?)\]/.exec(text);
    const names = match?.[1].split(',').map(item => item.replace(/\/\/.*$/m, '').trim()).filter(item => /^\w+$/.test(item));
    if (!names || names.length < 3) continue;
    const pluginsDir = context.modules.map(dirOf).find(dir => /(?:^|\/)plugins$/.test(dir));
    const sizes = context.modules.filter(item => dirOf(item) === pluginsDir).map(item => [item, readText(root, item).length])
      .sort((a, b) => a[1] - b[1]);
    const example = sizes.find(([item]) => !context.tests.has(item))?.[0];
    return { id: 'plugin', title: 'Add a server plugin', summary: 'Hapi plugins add behaviour to every request, such as ' +
      'logging, sessions or security headers. The order they are registered in matters.', steps: [
      ...(example ? [{ text: 'Create a file in ' + pluginsDir + '/ that exports { plugin, options }, like ' + baseOf(example) + '.',
        file: example, line: 1 }] : []),
      { text: 'Add it to the server.register list in ' + baseOf(file) + '. Plugins run in this order, and the router comes last.',
        file, line: lineAt(text, match.index) },
      { text: 'Restart the app: plugins are set up once, when the server starts.' }
    ] };
  }
  for (const file of context.modules) {
    const text = readText(root, file);
    const use = /\bapp\.use\(/.exec(text);
    if (!use) continue;
    return { id: 'plugin', title: 'Add middleware', summary: 'Middleware runs on every request before it reaches a page.', steps: [
      { text: 'Write a function (req, res, next) that does its work and then calls next().' },
      { text: 'Add it with app.use(…) in ' + baseOf(file) + '. Middleware runs in the order it is added.', file, line: lineAt(text, use.index) }
    ] };
  }
  return null;
}

function testRecipe(root, graph, context) {
  const tests = [...context.tests].filter(file => context.modules.includes(file));
  if (!tests.length) return null;
  const beside = tests.filter(file => {
    const bare = file.replace(/\.(?:spec|test)(\.[^.]+)$/, '$1');
    return bare !== file && context.modules.includes(bare);
  });
  const example = (beside.length ? beside : tests).map(file => [file, readText(root, file)])
    .sort((a, b) => a[1].length - b[1].length).find(([, text]) => text.length > 120)?.[0] ?? tests[0];
  const steps = [];
  if (beside.length >= tests.length / 2) {
    steps.push({ text: 'Tests live next to the code they check: for thing.js, create thing.test.js in the same folder.' });
  } else {
    steps.push({ text: 'Tests live in ' + dirOf(tests[0]) + '/. Add a new .test file there.' });
  }
  steps.push({ text: 'Start from a small existing test such as ' + baseOf(example) + '.', file: example, line: 1 });
  const command = context.pkg.scripts?.test;
  steps.push({ text: 'Run npm test' + (command ? ' (' + command + ')' : '') + (context.runner ? ', which uses ' + context.runner : '') + '.' });
  const setup = context.modules.find(file => /setup/i.test(baseOf(file)) && /mock/i.test(readText(root, file)));
  if (setup) steps.push({ text: baseOf(setup) + ' runs before every test and replaces some things with fakes (mocks).', file: setup, line: 1 });
  return { id: 'test', title: 'Add a test', summary: 'Tests check the code still works after a change. Copy the style of the ones already here.', steps };
}

function runRecipe(root, graph, context) {
  const scripts = context.pkg.scripts ?? {};
  const known = [
    ['dev', 'Starts the app for development; it usually reloads when you save'],
    ['start', 'Starts the app the way it runs when deployed'],
    ['test', 'Runs the tests'],
    ['lint', 'Checks the code for mistakes and style problems'],
    ['format', 'Formats the code'],
    ['build', 'Builds the files that are deployed']
  ];
  const steps = known.filter(([name]) => scripts[name]).map(([name, what]) => ({
    text: 'npm ' + (name === 'start' || name === 'test' ? '' : 'run ') + name + ': ' + what + '. Runs ' + scripts[name] + '.' }));
  if (fs.existsSync(path.join(root, 'package.json'))) steps.unshift({ text: 'Install the packages first with npm install (or npm ci).' });
  const compose = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'].find(file => fs.existsSync(path.join(root, file)));
  if (compose) {
    const text = readText(root, compose);
    const block = /^services:\s*$([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(text)?.[1] ?? '';
    const services = [...block.matchAll(/^ {2}([\w.-]+):\s*$/gm)].map(match => match[1]);
    steps.push({ text: 'docker compose up starts ' + (services.length ? 'the services in ' + compose + ': ' + services.join(', ') :
      'everything in ' + compose) + '.', file: compose, line: 1 });
  }
  if (!steps.length) return null;
  return { id: 'run', title: 'Run, test and check it', summary: 'The commands developers use every day, from package.json.', steps };
}

export function recipes(root, graph) {
  const tests = new Set(graph.tests.map(id => id.slice('module:'.length)));
  const modules = graph.nodes.filter(node => node.kind === 'module').map(node => node.file).sort();
  const context = {
    tests, modules, pkg: manifest(root), byId: new Map(graph.nodes.map(node => [node.id, node])),
    templates: new Set(templateFiles(root)), settings: settingsMap(root, graph),
    styles: listStyles(root)
  };
  context.runner = runner(context.pkg);
  return [runRecipe, pageRecipe, settingRecipe, componentRecipe, filterRecipe, pluginRecipe, testRecipe]
    .map(make => {
      try {
        return make(root, graph, context);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listStyles(root) {
  const found = [];
  const look = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (depth < 6 && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) look(file, depth + 1);
      } else if (/\.(?:s[ac]ss|css|less)$/.test(entry.name)) {
        found.push(file);
      }
    }
  };
  look('', 0);
  return found.sort((a, b) => a.length - b.length);
}
