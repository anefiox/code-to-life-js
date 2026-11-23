import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { analyze, projectRoot } from '../lib/project.mjs';
import { readProjectFile } from '../lib/learn.mjs';
import { ExplainError, saveExplanation } from '../lib/explain.mjs';
import { settingsMap } from '../lib/settings.mjs';
import { recipes } from '../lib/recipes.mjs';
import { templateMap } from '../lib/templates.mjs';
import { conceptsFor } from '../lib/concepts.mjs';
import { testExamples } from '../lib/examples.mjs';
import { hotspots, nodeHistory } from '../lib/history.mjs';
import { onboardingGuide } from '../lib/onboarding.mjs';
import { askPrompt, askSources } from '../lib/ask.mjs';
import { folderNotesFor } from '../lib/folders.mjs';

function project(t, files) {
  const root = projectRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-guide-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const app = {
  'package.json': JSON.stringify({
    name: 'shop', description: 'A small shop.', type: 'module', main: 'src/index.js',
    scripts: { dev: 'node --watch src/index.js', test: 'vitest run' },
    dependencies: { '@hapi/hapi': '21', convict: '6', nunjucks: '3' }, devDependencies: { vitest: '3' }
  }),
  'compose.yml': 'services:\n  redis:\n    image: redis\n  shop:\n    environment:\n      PORT: 3000\n      SESSION_SECRET: hunter2\n',
  '.env': 'PORT=4000\n',
  'src/index.js': 'import { createServer } from "./server.js";\nawait createServer();\n',
  'src/config.js': 'import convict from "convict";\nconst isProduction = process.env.NODE_ENV === "production";\n' +
    'export const config = convict({\n  port: { doc: "The port.", format: "port", default: 3000, env: "PORT" },\n' +
    '  session: {\n    secret: { doc: "Signs cookies.", format: String, default: "dev", env: "SESSION_SECRET", sensitive: true },\n' +
    '    secure: { doc: "Secure cookies.", format: Boolean, default: isProduction }\n  },\n' +
    '  log: { format: { doc: "Log format.", format: ["ecs", "pretty"], default: "pretty", env: "LOG_FORMAT" } }\n});\n',
  'src/server.js': 'import { config } from "./config.js";\nimport { router } from "./plugins/router.js";\n' +
    'import { logging } from "./plugins/logging.js";\nimport { security } from "./plugins/security.js";\n' +
    'export async function createServer(server) {\n  await server.register([\n    logging,\n    security,\n    router\n  ]);\n' +
    '  return config.get("port") + Number(process.env.EXTRA_PORT);\n}\n',
  'src/plugins/logging.js': 'export const logging = { plugin: {}, options: {} };\n',
  'src/plugins/security.js': 'import { config } from "../config.js";\nexport const security = { plugin: {}, options: config.get("session") };\n',
  'src/plugins/router.js': 'import { home } from "../routes/home/index.js";\nimport { about } from "../routes/about/index.js";\n' +
    'export const router = { plugin: { register(server) {\n  server.register([home, about]);\n} } };\n',
  'src/routes/home/index.js': 'import { homeController } from "./controller.js";\n' +
    'export const home = { plugin: { register(server) { server.route({ method: "GET", path: "/", ...homeController }); } } };\n',
  'src/routes/home/controller.js': 'export const homeController = { handler(request, h) { return h.view("home/index"); } };\n',
  'src/routes/home/index.njk': '{% extends "layouts/page.njk" %}\n{% block content %}Home{% endblock %}\n',
  'src/routes/about/index.js': 'import { aboutController } from "./controller.js";\n' +
    'export const about = { plugin: { register(server) { server.route({ method: "GET", path: "/about", ...aboutController }); } } };\n',
  'src/routes/about/controller.js': 'export const aboutController = { handler(request, h) { return h.view("about/index"); } };\n',
  'src/routes/about/controller.test.js': 'import { aboutController } from "./controller.js";\n' +
    'describe("about", () => {\n  test("renders the page", () => {\n    expect(aboutController.handler({}, { view: v => v })).toBe("about/index");\n  });\n' +
    '  it("is unrelated", () => { expect(1).toBe(1); });\n});\n',
  'src/routes/about/index.njk': '{% extends "layouts/page.njk" %}\n{% from "heading/macro.njk" import appHeading %}\n' +
    '{% block content %}{{ appHeading({ text: "About" }) }}{% endblock %}\n',
  'src/views/layouts/page.njk': '{% extends "govuk/template.njk" %}\n{% include "../partials/banner.njk" %}\n{% block content %}{% endblock %}\n',
  'src/views/partials/banner.njk': '<div>Banner</div>\n',
  'src/components/heading/macro.njk': '{% macro appHeading(params) %}{%- include "./template.njk" -%}{% endmacro %}\n',
  'src/components/heading/template.njk': '<h1>{{ params.text }}</h1>\n',
  'src/styles/application.scss': '@use "heading/heading";\n',
  'src/nav.js': 'export const nav = [{ text: "About", href: "/about" }];\n',
  'src/nunjucks.js': 'import nunjucks from "nunjucks";\nimport * as filters from "./filters/filters.js";\n' +
    'const env = nunjucks.configure([]);\nfor (const [name, filter] of Object.entries(filters)) env.addFilter(name, filter);\n',
  'src/filters/filters.js': 'export { money } from "./money.js";\n',
  'src/filters/money.js': 'export function money(value) { return "£" + value; }\n',
  'src/filters/money.test.js': 'import { money } from "./money.js";\ntest("formats pounds", () => { expect(money(2)).toBe("£2"); });\n'
};

test('the settings map reads the convict schema, its uses and where each is set', t => {
  const root = project(t, app);
  const map = settingsMap(root, analyze(root));
  assert.equal(map.schema, 'src/config.js');
  assert.deepEqual(map.settings.map(setting => setting.key), ['port', 'session.secret', 'session.secure', 'log.format', 'EXTRA_PORT', 'NODE_ENV']);
  const port = map.settings.find(setting => setting.key === 'port');
  assert.equal(port.env, 'PORT');
  assert.equal(port.default, '3000');
  assert.deepEqual(port.uses.map(use => use.file + ':' + use.line), ['src/server.js:11']);
  assert.ok(port.uses[0].id.includes('#createServer'));
  // A real .env file may hold secrets, so its values are never shown.
  assert.deepEqual(port.setIn, [{ file: '.env', line: 1, value: null }, { file: 'compose.yml', line: 6, value: '3000' }]);
  const secret = map.settings.find(setting => setting.key === 'session.secret');
  assert.equal(secret.sensitive, true);
  assert.deepEqual(secret.setIn, [{ file: 'compose.yml', line: 7, value: null }]);
  assert.deepEqual(secret.uses.map(use => use.key), ['session']);
  assert.equal(map.settings.find(setting => setting.key === 'session.secure').varies, true);
  assert.equal(map.settings.find(setting => setting.key === 'EXTRA_PORT').uses.length, 1);
});

test('recipes follow the patterns the project already uses', t => {
  const root = project(t, app);
  const list = recipes(root, analyze(root));
  const byId = Object.fromEntries(list.map(recipe => [recipe.id, recipe]));
  assert.deepEqual(list.map(recipe => recipe.id), ['run', 'page', 'setting', 'component', 'filter', 'plugin', 'test']);
  const page = byId.page.steps;
  assert.match(page[0].text, /src\/routes\/your-page\//);
  assert.ok(page.some(step => step.file === 'src/routes/about/controller.js'), 'copies the page that has a test and a view');
  assert.ok(page.some(step => step.file === 'src/routes/about/index.njk'));
  const plug = page.find(step => step.text.startsWith('Plug it in'));
  assert.deepEqual([plug.file, plug.line], ['src/plugins/router.js', 4]);
  assert.equal(page.find(step => step.text.includes('menu')).file, 'src/nav.js');
  assert.equal(byId.setting.steps[0].file, 'src/config.js');
  assert.match(byId.setting.steps.at(-2).text, /compose\.yml/);
  assert.equal(byId.filter.steps[0].file, 'src/filters/money.js');
  assert.equal(byId.filter.steps[1].file, 'src/filters/money.test.js');
  assert.equal(byId.component.steps.at(-2).file, 'src/styles/application.scss');
  assert.match(byId.component.steps.at(-1).text, /appYourComponent/);
  assert.deepEqual([byId.plugin.steps[1].file, byId.plugin.steps[1].line], ['src/server.js', 6]);
  assert.match(byId.test.steps[0].text, /next to the code/);
  assert.match(byId.test.steps.at(-1).text, /Vitest/);
  assert.match(byId.run.steps.at(-1).text, /redis, shop/);
});

test('the template map links layouts, partials, macros and the routes that render them', t => {
  const root = project(t, app);
  const { templates } = templateMap(root, analyze(root));
  const get = file => templates.find(item => item.file === file);
  const layout = get('src/views/layouts/page.njk');
  assert.equal(layout.kind, 'layout');
  assert.deepEqual(layout.extends, { name: 'govuk/template.njk', file: null, external: 'GOV.UK Frontend', line: 1 });
  assert.deepEqual(layout.includes.map(ref => ref.file), ['src/views/partials/banner.njk']);
  assert.deepEqual(layout.usedBy.map(use => use.file + ' ' + use.how).sort(),
    ['src/routes/about/index.njk extends', 'src/routes/home/index.njk extends']);
  const about = get('src/routes/about/index.njk');
  assert.equal(about.kind, 'page');
  assert.deepEqual(about.imports.map(ref => [ref.file, ref.names]), [['src/components/heading/macro.njk', ['appHeading']]]);
  assert.deepEqual(about.renderedBy.map(by => [by.name, by.routes]), [['aboutController', ['GET /about']]]);
  assert.equal(get('src/components/heading/macro.njk').kind, 'component');
  assert.deepEqual(get('src/components/heading/macro.njk').includes.map(ref => ref.file), ['src/components/heading/template.njk']);
  assert.equal(get('src/views/partials/banner.njk').kind, 'partial');
});

test('test examples show the test cases that use a function', t => {
  const root = project(t, app);
  const graph = analyze(root);
  const id = graph.nodes.find(node => node.name === 'money').id;
  const { examples, testFiles } = testExamples(root, graph, id);
  assert.deepEqual(testFiles, ['src/filters/money.test.js']);
  assert.deepEqual(examples.map(example => [example.title, example.start]), [['formats pounds', 2]]);
  const about = testExamples(root, graph, 'module:src/routes/about/controller.js');
  assert.deepEqual(about.examples.map(example => example.title).sort(), ['about › is unrelated', 'about › renders the page']);
  const handler = graph.nodes.find(node => node.name === 'aboutController').id;
  assert.deepEqual(testExamples(root, graph, handler).examples.map(example => example.title), ['about › renders the page']);
  assert.throws(() => testExamples(root, graph, 'nope'), ExplainError);
});

test('history lists hotspots and the commits behind a file or function', t => {
  const root = project(t, app);
  const graph = analyze(root);
  assert.equal(hotspots(root, graph).available, false);
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args],
    { stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'Start the shop');
  fs.appendFileSync(path.join(root, 'src/server.js'), '// tweak\n');
  git('commit', '-qam', 'Tweak the server');
  const history = hotspots(root, graph);
  assert.equal(history.available, true);
  assert.equal(history.commits, 2);
  assert.deepEqual(history.hotspots[0], { file: 'src/server.js', commits: 2, churn: 13, authors: [{ name: 'Ada', commits: 2 }],
    last: history.hotspots[0].last });
  assert.ok(!history.hotspots.some(entry => entry.file.includes('.test.')), 'tests are left out');
  const file = nodeHistory(root, graph, 'module:src/server.js');
  assert.deepEqual(file.commits.map(commit => commit.subject), ['Tweak the server', 'Start the shop']);
  const fn = nodeHistory(root, graph, graph.nodes.find(node => node.name === 'createServer').id);
  assert.deepEqual(fn.commits.map(commit => commit.subject), ['Start the shop']);
});

test('the onboarding guide gathers tools, folders, the tour, pages, settings and recipes', t => {
  const root = project(t, app);
  const graph = analyze(root);
  saveExplanation(root, graph, 'module:src/server.js', 'Builds the web server.');
  const guide = onboardingGuide(root, graph, { date: new Date('2026-01-02T00:00:00Z') });
  assert.match(guide, /^# Getting started with shop\n\n_Generated by Code to Life on 2026-01-02/);
  for (const heading of ['## Tools it is built with', '## Run it', '## How the code is organised', '## Start here', '## Pages',
    '## Settings', '## How do I…', '### Add a page', '## Files explained']) {
    assert.ok(guide.includes('\n' + heading + '\n'), heading);
  }
  assert.match(guide, /\| GET \| \/about \| aboutController \(src\/routes\/about\/controller\.js\) \| src\/routes\/about\/index\.njk \|/);
  assert.match(guide, /\| session\.secret \| SESSION_SECRET \| \(secret\) \| Signs cookies\. \|/);
  assert.match(guide, /- `src\/server\.js`: Builds the web server\./);
  assert.ok(!guide.includes('hunter2'), 'secret values never appear');
});

test('ask finds the code that matches a question and builds a grounded prompt', t => {
  const root = project(t, app);
  const graph = analyze(root);
  saveExplanation(root, graph, 'module:src/plugins/security.js', 'Adds security headers and session protection.');
  const { sources } = askSources(root, graph, 'Where are the security headers added?');
  assert.equal(sources[0].file, 'src/plugins/security.js');
  assert.ok(!sources.some(node => node.file.includes('.test.')));
  const prompt = askPrompt(root, graph, 'How does the about page work?');
  assert.ok(prompt.sources.some(source => source.file === 'src/routes/about/controller.js'));
  assert.match(prompt.messages[0].content, /backticks/);
  assert.match(prompt.messages[1].content, /Question: How does the about page work\?/);
  assert.match(prompt.messages[1].content, /GET \/about \(src\/routes\/about\/index\.js\)/);
  assert.throws(() => askSources(root, graph, 'hi'), ExplainError);
  assert.throws(() => askSources(root, graph, 'how is the it?'), /Ask about something/);
});

test('project files can be read, but not secrets or files outside the project', t => {
  const root = project(t, { ...app, '.env.example': 'PORT=3000\n' });
  assert.equal(readProjectFile(root, 'compose.yml').total, 7);
  assert.equal(readProjectFile(root, '.env.example').code, 'PORT=3000');
  for (const file of ['.env', 'src/.env', '../x.js', 'node_modules/a.js', 'image.png', undefined]) {
    assert.throws(() => readProjectFile(root, file), ExplainError, String(file));
  }
});

test('concepts fit the project, and folders get notes', t => {
  const root = project(t, app);
  const terms = conceptsFor(root).map(concept => concept.term);
  assert.ok(terms.includes('onPreResponse') && terms.includes('convict') && terms.includes('CSRF'));
  assert.ok(!terms.includes('JSX'), 'React terms only for React projects');
  for (const concept of conceptsFor(root)) assert.doesNotThrow(() => new RegExp(concept.pattern));
  const notes = folderNotesFor(analyze(root));
  assert.match(notes['src/plugins'], /Plugins/);
  assert.match(notes[''], /top of the project/);
  assert.ok('src/routes/about' in notes);
});
