import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prBuddyEntry } from '../lib/pr-buddy.mjs';

const codeToLife = fileURLToPath(new URL('../bin/codetolife.mjs', import.meta.url));
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-code-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(file, value) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    },
    git(...args) { return execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }); }
  };
};

function run(entry, ...args) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

test('graph resolves a referenced tsconfig, aliases, JSX, and test calls', t => {
  const { root, put } = fixture(t);
  put('tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
  put('tsconfig.app.json', '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","jsx":"preserve","paths":{"@/*":["./src/*"]}},"include":["src"]}');
  put('src/Badge.tsx', 'export function Badge() { return <span>OK</span>; }\n');
  put('src/App.tsx', 'import { Badge } from "@/Badge";\nexport const App = () => <Badge />;\n');
  put('src/App.test.ts', 'import { App } from "./App";\ntest("renders", () => App());\n');
  put('dist/output.js', 'function generated() {}');
  put('.codetolife/rules.json', '[{"from":"src/App.tsx","notTo":"src/Badge.tsx","kinds":["renders"]}]');
  const result = run(codeToLife, root, '--json');
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  const id = name => graph.nodes.find(node => node.name === name)?.id;
  assert.ok(graph.edges.some(edge => edge.from === id('App') && edge.to === id('Badge') && edge.kind === 'renders'));
  assert.ok(graph.edges.some(edge => edge.from === id('src/App.test.ts') && edge.to === id('App') && edge.kind === 'calls'));
  assert.ok(!graph.nodes.some(node => node.file.startsWith('dist/')));
  assert.equal(graph.violations.length, 1);
  assert.equal(run(codeToLife, 'check', root).status, 1);
});

test('browser entry point serves the local graph and blocks cross-origin requests', { timeout: 20000 }, async t => {
  const { root, put } = fixture(t);
  put('main.js', 'export function main() { return 1; }\n');
  put('debug.mjs', [
    'function greet() {',
    '  const answer = 42;',
    '  console.log(answer, process.argv[2]);',
    '}',
    'function burnCpu() {',
    '  const until = Date.now() + 350;',
    '  let result = 0;',
    '  while (Date.now() < until) result += Math.sqrt(Date.now() % 137);',
    '  return result;',
    '}',
    'greet();',
    'burnCpu();',
    'debugger;'
  ].join('\n'));
  const child = spawn(process.execPath, [
    codeToLife, root, '--port', '0', '--debug-entry', 'debug.mjs',
    '--break', 'debug.mjs:2', '--debug-arg', 'hello'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.on('exit', code => reject(new Error('Server exited with ' + code)));
    child.stdout.on('data', data => {
      output += data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Code to Life<\/title>/);
  for (const asset of ['/style.css', '/app.js', '/plan.js', '/learn.js', '/cytoscape.min.js']) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const graphResponse = await fetch(url + '/api/graph');
  assert.equal(graphResponse.status, 200);
  assert.ok((await graphResponse.json()).nodes.some(node => node.name === 'main'));
  put('main.js', 'export function replaced() { return 1; }\n');
  const refreshed = await fetch(url + '/api/graph?refresh=1');
  const refreshedGraph = await refreshed.json();
  assert.ok(refreshedGraph.nodes.some(node => node.name === 'replaced'));
  const foreign = await fetch(url + '/api/graph', { headers: { Origin: 'https://external.example' } });
  assert.equal(foreign.status, 403);

  const replaced = refreshedGraph.nodes.find(node => node.name === 'replaced');
  const sourceResponse = await fetch(url + '/api/source?' + new URLSearchParams({ id: replaced.id }));
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.code, 'export function replaced() { return 1; }');
  assert.deepEqual(source.glossary, []);
  for (const id of ['module:../outside.js', '']) {
    const missing = await fetch(url + '/api/source?' + new URLSearchParams({ id }));
    assert.equal(missing.status, 404);
    await missing.text();
  }
  const explanations = await (await fetch(url + '/api/explanations')).json();
  assert.deepEqual({ ...explanations, concepts: undefined }, { explanations: {}, glossary: [], ai: null, concepts: undefined });
  assert.ok(explanations.concepts.some(concept => concept.term === 'CSRF'));
  const guided = await (await fetch(url + '/api/learn')).json();
  assert.equal(guided.tour.steps[0].file, 'main.js');
  assert.equal(typeof guided.folderNotes[''], 'string');
  assert.ok(Array.isArray((await (await fetch(url + '/api/recipes')).json()).recipes));
  assert.ok(Array.isArray((await (await fetch(url + '/api/settings')).json()).settings));
  assert.deepEqual(await (await fetch(url + '/api/templates')).json(), { templates: [] });
  assert.equal((await (await fetch(url + '/api/file?file=main.js')).json()).code, 'export function replaced() { return 1; }');
  put('.env', 'SECRET=1\n');
  const secret = await fetch(url + '/api/file?file=.env');
  assert.equal(secret.status, 404);
  await secret.text();
  const guideResponse = await fetch(url + '/api/onboarding');
  assert.match(guideResponse.headers.get('content-type'), /text\/markdown/);
  assert.match(await guideResponse.text(), /^# Getting started with /);
  const asked = await fetch(url + '/api/ask', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What does replaced do?' }) });
  const answer = await asked.json();
  assert.equal(answer.answer, null, 'without --ai, ask only finds the matching code');
  assert.equal(answer.sources[0].name, 'replaced');
  for (const headers of [{ Origin: url }, { 'Content-Type': 'application/json' }]) {
    const refused = await fetch(url + '/api/ask', { method: 'POST', headers, body: '{"question":"replaced?"}' });
    assert.equal(refused.status, 403);
    await refused.text();
  }
  assert.deepEqual(guided.pages, { framework: null, before: null, routes: [] });
  for (const file of ['main.js', '../secret.njk']) {
    const template = await fetch(url + '/api/template?' + new URLSearchParams({ file }));
    assert.equal(template.status, 404);
    await template.text();
  }
  put('.codetolife/explanations.json', '{ not json');
  const corrupt = await fetch(url + '/api/explanations');
  assert.equal(corrupt.status, 400);
  assert.match(await corrupt.text(), /invalid JSON/);
  assert.equal((await fetch(url + '/api/learn')).status, 200, 'server survives a bad explanations file');
  fs.rmSync(path.join(root, '.codetolife', 'explanations.json'));
  const noAi = await fetch(url + '/api/explain?id=x', { method: 'POST', headers: { Origin: url } });
  assert.equal(noAi.status, 404);
  assert.match(await noAi.text(), /--ai/);

  const planUrl = url + '/api/plan';
  const emptyPlan = await (await fetch(planUrl)).json();
  assert.deepEqual(emptyPlan, { version: 1, modules: [], revision: null });
  const savePlan = (plan, origin = url) => fetch(planUrl, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(plan)
  });
  const draft = { ...emptyPlan, modules: [
    { file: 'src/Checkout.tsx', name: 'Checkout', kind: 'component', note: 'Confirm payment', dependencies: ['main.js'] }
  ] };
  assert.equal((await savePlan(draft, 'https://external.example')).status, 403);
  const traversal = { ...draft, modules: [{ ...draft.modules[0], file: '../Checkout.tsx' }] };
  assert.equal((await savePlan(traversal)).status, 400);
  const saved = await savePlan(draft);
  assert.equal(saved.status, 200);
  const stored = await saved.json();
  assert.match(stored.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.codetolife', 'plan.json'), 'utf8')),
    { version: 1, modules: draft.modules });
  assert.equal(fs.existsSync(path.join(root, draft.modules[0].file)), false);
  assert.equal((await savePlan(draft)).status, 409);
  assert.deepEqual(await (await fetch(planUrl)).json(), stored);
  assert.equal((await savePlan({ ...stored, modules: [] })).status, 200);
  assert.deepEqual((await (await fetch(planUrl)).json()).modules, []);

  const noGit = await fetch(url + '/api/changes');
  assert.equal(noGit.status, 500);
  await noGit.text();
  assert.equal((await fetch(url + '/api/graph')).status, 200);

  if (prBuddyEntry()) {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'tool-test@example.invalid');
    git('config', 'user.name', 'Tool Test');
    put('main.js', 'export function main() { return 1; }\n');
    put('removed.js', 'export function deleted() {}\n');
    git('add', '.');
    git('commit', '-qm', 'Initial');
    git('branch', 'baseline');
    git('switch', '-qc', 'feature');
    fs.unlinkSync(path.join(root, 'removed.js'));
    put('main.js', 'export function main() { return 2; }\ndebugger;\n');
    put('new.ts', 'export const newValue = 1;\n');
    const overlay = await fetch(url + '/api/changes?base=baseline');
    assert.equal(overlay.status, 200);
    const { graph, changes } = await overlay.json();
    const main = changes.files.find(file => file.file === 'main.js');
    const behavior = main.changes.find(change => change.kind === 'behavior');
    assert.equal(behavior.nodeId, graph.nodes.find(node => node.name === 'main').id);
    assert.equal(main.moduleId, 'module:main.js');
    assert.ok(main.findings.some(finding => finding.id === 'PRB011'));
    assert.ok(changes.files.some(file => file.file === 'new.ts' && file.moduleId === 'module:new.ts'));
    assert.ok(changes.files.some(file => file.file === 'removed.js' && file.status === 'D' && !file.moduleId));
  }
  const blocked = await fetch(url + '/api/changes', { headers: { Origin: 'https://external.example' } });
  assert.equal(blocked.status, 403);

  const status = () => fetch(url + '/api/debug').then(response => response.json());
  const until = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await status();
      if (predicate(snapshot)) return snapshot;
      if (['error', 'exited'].includes(snapshot.status)) assert.fail(JSON.stringify(snapshot));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Timed out waiting for debugger state.');
  };
  const command = async action => {
    const response = await fetch(url + '/api/debug?action=' + action, {
      method: 'POST', headers: { Origin: url }
    });
    assert.equal(response.status, 200, await response.text());
  };
  assert.equal((await status()).status, 'idle');
  const unsafe = await fetch(url + '/api/debug?action=start', { method: 'POST' });
  assert.equal(unsafe.status, 403);
  await command('start');
  await until(snapshot => snapshot.status === 'paused');
  await command('continue');
  const breakpoint = await until(snapshot => snapshot.status === 'paused' && snapshot.frames[0]?.line === 2);
  assert.equal(breakpoint.frames[0].name, 'greet');
  assert.equal(breakpoint.frames[0].nodeId, refreshedGraph.nodes.find(node => node.name === 'greet').id);
  await command('over');
  await until(snapshot => snapshot.status === 'paused' && snapshot.frames[0]?.line === 3);
  await command('profile-start');
  assert.equal((await status()).recording, true);
  await command('continue');
  await until(snapshot => snapshot.status === 'paused' && snapshot.frames[0]?.line === 13);
  await command('profile-stop');
  const collected = await status();
  assert.equal(collected.recording, false);
  assert.ok(collected.profile.durationMs >= 300);
  const hot = collected.profile.symbols.find(row => row.name === 'burnCpu');
  assert.ok(hot?.samples > 0, JSON.stringify(collected.profile));
  assert.equal(hot.id, refreshedGraph.nodes.find(node => node.name === 'burnCpu').id);
  assert.ok(collected.profile.samples >= collected.profile.projectSamples);
  assert.equal(collected.profile.modules[0].id, 'module:debug.mjs');
  await command('continue');
  const exited = await until(snapshot => snapshot.status === 'exited');
  assert.match(exited.output, /42 hello/);
  assert.deepEqual(exited.profile, collected.profile);
  await command('start');
  await until(snapshot => snapshot.status === 'paused');
  await command('profile-start');
  await command('stop');
  const stopped = await until(snapshot => snapshot.status === 'exited');
  assert.equal(stopped.recording, false);
  assert.equal(stopped.profile, null);
  assert.match(stopped.profileMessage, /stopped before/);
});
