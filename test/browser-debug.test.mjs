import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { prBuddyEntry } from '../lib/pr-buddy.mjs';
import { browserDebugger } from '../lib/browser-debug.mjs';
import { Inspector } from '../lib/debug.mjs';
import { buildGraph } from '../lib/graph.mjs';

async function until(read) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read();
    if (result) return result;
    await delay(50);
  }
  assert.fail('Timed out waiting for Chromium.');
}

const chrome = process.env.CODETOLIFE_TEST_CHROME;
const codeToLife = fileURLToPath(new URL('../bin/codetolife.mjs', import.meta.url));

function startChromium(profile, target) {
  return spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, target], {
    stdio: 'ignore', windowsHide: true
  });
}

async function chromiumPort(profile) {
  return until(() => {
    const active = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(active) && fs.readFileSync(active, 'utf8').split('\n')[0];
  });
}

async function pageTarget(port, target) {
  return until(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    return (await response.json()).find(tab => tab.url === target);
  });
}

async function stopChromium(browser, port) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  const closed = once(browser, 'exit');
  try {
    const version = await fetch('http://127.0.0.1:' + port + '/json/version', {
      signal: AbortSignal.timeout(2000)
    }).then(response => response.json());
    const inspector = new Inspector(version.webSocketDebuggerUrl, () => {}, () => {});
    try { await inspector.send('Browser.close'); } finally { inspector.close(); }
  } catch {
    if (browser.exitCode === null) browser.kill();
  }
  await closed;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill();
  await done;
}

const removeFixture = root => fs.promises.rm(root, { recursive: true, force: true,
  maxRetries: 15, retryDelay: 150 });
test('Chromium maps a source breakpoint, paused frame, and CPU profile', { skip: !chrome, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-chromium-'));
  const profile = path.join(root, 'chrome');
  const source = [
    '',
    'function work() {',
    '  const end = Date.now() + 150;',
    '  while (Date.now() < end) Math.sqrt(Date.now());',
    '  return end;',
    '}',
    'globalThis.fixtureTimer = setInterval(work, 700);',
    'function renderRows() {',
    '  const until = performance.now() + 1600;',
    '  const list = document.createElement("ul");',
    '  document.body.append(list);',
    '  while (performance.now() < until) {',
    '    const row = document.createElement("li");',
    '    row.textContent = String(Math.random());',
    '    list.append(row);',
    '    if (list.childElementCount >= 200) list.replaceChildren();',
    '  }',
    '  return list.childElementCount;',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(root, 'work.ts'), source);
  const graph = buildGraph(root);
  const map = Buffer.from(JSON.stringify({
    version: 3, sources: ['work.ts'], names: [],
    mappings: ';;;' + Array.from({ length: source.split('\n').length - 1 }, () => 'AACA').join(';')
  })).toString('base64');
  const frontend = createServer((request, response) => {
    if (request.url === '/work.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('\n\n' + source + '\n//# sourceMappingURL=data:application/json;base64,' + map);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<script src="/work.js"></script>');
    }
  });
  frontend.listen(0, '127.0.0.1');
  await once(frontend, 'listening');
  const target = 'http://127.0.0.1:' + frontend.address().port + '/';
  const browser = startChromium(profile, target);
  let debug;
  let port;
  try {
    port = await chromiumPort(profile);
    await pageTarget(port, target);
    debug = browserDebugger(root, { 'browser-port': port, 'browser-url': target, break: ['work.ts:5'] });
    await debug.perform('start');
    const paused = await until(() => {
      const snapshot = debug.snapshot(graph);
      return snapshot.status === 'paused' && snapshot;
    });
    assert.equal(paused.breakpoints[0].bound, true);
    assert.equal(paused.frames[0].file, 'work.ts');
    assert.equal(paused.frames[0].line, 5);
    assert.match(paused.frames[0].nodeId, /^module:work\.ts#work@/);
    const connection = debug.session.inspector;

    await debug.perform('continue');
    await until(() => debug.status === 'running');
    await connection.send('Runtime.evaluate', { expression: 'clearInterval(globalThis.fixtureTimer)' });
    await debug.perform('profile-start');
    assert.equal(debug.snapshot(graph).recording, true);
    const run = await connection.send('Runtime.evaluate', { expression: 'renderRows()', returnByValue: true });
    assert.equal(typeof run.result.value, 'number', JSON.stringify(run));
    await debug.perform('profile-stop');
    const collected = debug.snapshot(graph);
    assert.equal(collected.recording, false);
    assert.ok(collected.profile.durationMs >= 1500);
    const hot = collected.profile.symbols.find(entry => entry.name === 'renderRows');
    assert.ok(hot?.samples > 0, JSON.stringify(collected.profile));
    assert.equal(hot.id, graph.nodes.find(node => node.name === 'renderRows').id);
    assert.ok(collected.profile.modules.some(entry => entry.file === 'work.ts' && entry.samples >= hot.samples));
    await debug.perform('stop');
    assert.equal(debug.status, 'exited');
    assert.equal(browser.exitCode, null);
  } finally {
    debug?.stop();
    await stopChromium(browser, port);
    await new Promise(resolve => frontend.close(resolve));
    await removeFixture(root);
  }
});

test('Code to Life browser UI searches JSX, highlights changes, and saves a plan', { skip: !chrome, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-ui-'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'chrome');
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  let server;
  let browser;
  let inspector;
  let port;
  try {
    fs.mkdirSync(project);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'tool-test@example.invalid');
    git('config', 'user.name', 'Tool Test');
    fs.writeFileSync(path.join(project, 'Badge.tsx'), 'export function Badge() { return <span>Ready</span>; }\n');
    const app = path.join(project, 'App.tsx');
    fs.writeFileSync(app, 'import { Badge } from "./Badge";\nexport function App() { return <Badge />; }\n');
    git('add', '.');
    git('commit', '-qm', 'Frontend fixture');
    fs.writeFileSync(app, 'import { Badge } from "./Badge";\nexport function App() { return <main><Badge /></main>; }\ndebugger;\n');

    server = spawn(process.execPath, [codeToLife, project, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: server.stdout });
    const [line] = await once(lines, 'line');
    lines.close();
    const target = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] + '/';
    assert.match(target, /^http:/);
    browser = startChromium(profile, target);
    port = await chromiumPort(profile);
    const page = await pageTarget(port, target);
    const errors = [];
    inspector = new Inspector(page.webSocketDebuggerUrl, (method, params) => {
      if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails);
    }, () => {});
    await inspector.send('Runtime.enable');
    const evaluate = async expression => {
      const reply = await inspector.send('Runtime.evaluate', { expression, returnByValue: true });
      assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    };

    await until(() => evaluate('document.querySelector("#status")?.textContent.includes("1 folder · 2 files")'));
    assert.ok(await evaluate('Boolean(document.querySelector("#graph canvas"))'));
    await evaluate('document.querySelector("#view").value = "symbols";' +
      'document.querySelector("#view").dispatchEvent(new Event("change"))');
    await evaluate('document.querySelector("#search").value = "Badge";' +
      'document.querySelector("#search").dispatchEvent(new Event("input"))');
    await evaluate('[...document.querySelectorAll("#results button")].find(x => x.textContent.startsWith("Badge · ")).click()');
    assert.match(await evaluate('document.querySelector("#details").textContent'), /renders · App/);

    await evaluate('document.querySelector("#changes-toggle").click()');
    if (prBuddyEntry()) {
      await until(() => evaluate('document.querySelector("#changes-status").textContent.includes("1 changed files")'));
      await evaluate('document.querySelector("#changes-files summary").click()');
      assert.match(await evaluate('document.querySelector("#changes-files").textContent'), /PRB011/);
      await evaluate('[...document.querySelectorAll("#changes-files button")].find(x => x.textContent.startsWith("behavior")).click()');
      assert.match(await evaluate('document.querySelector("#details").textContent'), /behavior · App/);
      assert.ok(await evaluate('cy.nodes(".changed").some(node => node.data("label") === "App")'));
    } else {
      await until(() => evaluate('document.querySelector("#changes-status").textContent.includes("needs PR Buddy JS")'));
    }
    await evaluate('document.querySelector("#changes-toggle").click()');

    await evaluate('document.querySelector("#plan-toggle").click()');
    await until(() => evaluate('document.querySelector("#plan-status").textContent.includes("No proposed modules")'));
    await evaluate([
      'document.querySelector("#plan-file").value = "Checkout.tsx"',
      'document.querySelector("#plan-name").value = "Checkout"',
      'document.querySelector("#plan-kind").value = "component"',
      'document.querySelector("#plan-note").value = "Proposed checkout component"',
      'document.querySelector("#plan-dependencies").value = "Badge.tsx"',
      'document.querySelector("#plan-save").click()'
    ].join(';'));
    await until(() => evaluate('document.querySelector("#plan-status").textContent.includes("Saved to")'));
    assert.ok(await evaluate('cy.getElementById("plan:Checkout.tsx").outgoers("edge.proposed").length === 1'));
    await evaluate('document.querySelector("#plan-stub").click()');
    assert.match(await evaluate('document.querySelector("#plan-preview").value'), /export function Checkout/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.codetolife', 'plan.json'), 'utf8')).modules[0].dependencies,
      ['Badge.tsx']);
    await evaluate('document.querySelector("#plan-delete").click()');
    await until(() => evaluate('!document.querySelector("#plan-modules button")'));
    assert.ok(await evaluate('cy.getElementById("plan:Checkout.tsx").empty()'));
    assert.deepEqual(errors, []);
  } finally {
    inspector?.close();
    if (browser) await stopChromium(browser, port);
    if (server) await stopProcess(server);
    await removeFixture(root);
  }
});
