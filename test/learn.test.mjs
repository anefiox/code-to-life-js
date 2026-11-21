import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, projectRoot } from '../lib/project.mjs';
import { entryPoint, readTemplate, routeFlows, startTour } from '../lib/learn.mjs';
import { ExplainError } from '../lib/explain.mjs';

function project(t, files) {
  const root = projectRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-learn-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const hapiApp = {
  'package.json': JSON.stringify({
    type: 'module', main: 'src/index.js', imports: { '#/*': './src/*' },
    dependencies: { '@hapi/hapi': '21' }
  }),
  'src/index.js': 'import { start } from "#/server.js";\nawait start();\n',
  'src/server.js': 'import { router } from "./plugins/router.js";\nimport { config } from "#/config.js";\n' +
    'export async function start() { return [router, config]; }\n',
  'src/config.js': 'export const config = { port: 3000 };\n',
  'src/plugins/router.js': 'import { home } from "../routes/home/index.js";\nimport { about } from "../routes/about.js";\n' +
    'import { config } from "#/config.js";\nexport const router = [home, about, config];\n',
  'src/routes/home/controller.js': 'import { config } from "#/config.js";\nexport function greeting() { return config.port; }\n' +
    'export const homeController = {\n  handler(request, h) {\n    return h.view("home/index", { text: greeting() });\n  }\n};\n',
  'src/routes/home/index.js': 'import { homeController } from "./controller.js";\nexport const LOGIN = "/login";\n' +
    'export const home = { register(server) {\n  server.route([\n    { method: "GET", path: "/", ...homeController },\n' +
    '    { method: ["GET", "POST"], path: LOGIN, options: { handler: homeController.handler } }\n  ]);\n} };\n',
  'src/routes/about.js': 'import { config } from "#/config.js";\nfunction show(request, h) { return h.view("about"); }\n' +
    'export const about = { method: "GET", path: config.path, handler: show };\n' +
    'export const inline = { method: "POST", path: "/about", handler: (request, h) => h.redirect("/") };\n' +
    'export const notARoute = { method: "fetch", path: "relative" };\n',
  'src/routes/home/index.njk': '<h1>{{ text }}</h1>\r\n',
  'src/views/about.html': '<p>About</p>\n',
  'src/routes/home/controller.test.js': 'import { homeController } from "./controller.js";\n' +
    'const fake = { method: "GET", path: "/test-only" };\n'
};

test('graph finds Hapi routes, their handlers, templates and subpath imports', t => {
  const root = project(t, hapiApp);
  const graph = analyze(root);
  const imports = graph.edges.filter(edge => edge.kind === 'imports').map(edge => edge.from + ' → ' + edge.to);
  assert.ok(imports.includes('module:src/index.js → module:src/server.js'), 'resolves #/ subpath imports');

  const routes = graph.routes.map(route => [route.method, route.path, route.fixedPath, route.handler.replace(/@\d+$/, '')]);
  assert.deepEqual(routes, [
    ['GET', '/', true, 'module:src/routes/home/controller.js#homeController'],
    ['POST', '/about', true, 'module:src/routes/about.js#inline'],
    ['GET, POST', '/login', true, 'module:src/routes/home/controller.js#homeController'],
    ['GET', 'config.path', false, 'module:src/routes/about.js#show']
  ]);
  const views = Object.entries(graph.views).map(([id, names]) => [id.replace(/@\d+$/, ''), names]);
  assert.deepEqual(views.sort(), [
    ['module:src/routes/about.js#show', ['about']],
    ['module:src/routes/home/controller.js#homeController', ['home/index']]
  ]);
});

test('graph finds Express-style routes', t => {
  const root = project(t, {
    'app.js': 'import express from "express";\nconst app = express();\n' +
      'function list(req, res) { res.render("users/list"); }\nfunction auth(req, res, next) { next(); }\n' +
      'app.get("/users", auth, list);\napp.all("/ping", (req, res) => res.send("ok"));\napp.get("not-a-path", list);\n'
  });
  const graph = analyze(root);
  assert.deepEqual(graph.routes.map(route => [route.method, route.path, route.handler.replace(/@\d+$/, '')]), [
    ['*', '/ping', 'module:app.js'],
    ['GET', '/users', 'module:app.js#list']
  ]);
});

test('page flows follow calls to templates, and only known templates can be read', t => {
  const root = project(t, hapiApp);
  const flows = routeFlows(root, analyze(root));
  assert.equal(flows.framework, 'Hapi');
  assert.match(flows.before, /plugins/);
  const home = flows.routes.find(route => route.path === '/');
  assert.deepEqual(home.steps.map(step => step.id.replace(/@\d+$/, '')), ['module:src/routes/home/controller.js#greeting']);
  assert.deepEqual(home.templates, [{ name: 'home/index', file: 'src/routes/home/index.njk' }]);
  const about = flows.routes.find(route => route.path === 'config.path');
  assert.deepEqual(about.templates, [{ name: 'about', file: 'src/views/about.html' }]);

  const template = readTemplate(root, 'src/routes/home/index.njk');
  assert.equal(template.code, '<h1>{{ text }}</h1>');
  for (const file of ['package.json', '../outside.njk', 'src/routes/home/controller.js', undefined]) {
    assert.throws(() => readTemplate(root, file), ExplainError);
  }
});

test('the tour starts at the entry point, follows the backbone, then shared files', t => {
  const root = project(t, hapiApp);
  const graph = analyze(root);
  assert.deepEqual(entryPoint(root, graph), {
    file: 'src/index.js', reason: 'package.json says "main" is this file, so Node starts here.'
  });
  const { steps } = startTour(root, graph);
  assert.deepEqual(steps.map(step => [step.role, step.file]), [
    ['entry', 'src/index.js'],
    ['backbone', 'src/server.js'],
    ['backbone', 'src/plugins/router.js'],
    ['backbone', 'src/routes/home/index.js'],
    ['backbone', 'src/routes/home/controller.js'],
    ['backbone', 'src/config.js'],
  ]);
  assert.match(steps[3].reason, /defines 2 pages: GET \/, GET, POST \/login/);
  assert.ok(steps.every(step => step.id === 'module:' + step.file));
  assert.ok(!steps.some(step => step.file.includes('.test.')));
});

test('the tour finds an entry from scripts or conventional names', t => {
  const scripted = project(t, {
    'package.json': JSON.stringify({ scripts: { start: 'NODE_ENV=production node --watch ./lib/boot.mjs' } }),
    'lib/boot.mjs': 'import "./app.mjs";\n', 'lib/app.mjs': 'export {};\n'
  });
  assert.equal(entryPoint(scripted, analyze(scripted)).file, 'lib/boot.mjs');
  const conventional = project(t, { 'src/main.ts': 'export {};\n', 'src/other.ts': 'export {};\n' });
  assert.equal(entryPoint(conventional, analyze(conventional)).file, 'src/main.ts');
  const unclear = project(t, { 'a.js': 'import "./b.js";\nimport "./c.js";\n', 'b.js': 'export {};\n', 'c.js': 'export {};\n' });
  assert.equal(entryPoint(unclear, analyze(unclear)).file, 'a.js');
});
