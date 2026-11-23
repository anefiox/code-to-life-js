import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prBuddyEntry } from '../lib/pr-buddy.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../bin/codetolife-mcp.mjs', import.meta.url));

test('opt-in MCP debugger launches a script, maps a breakpoint, steps, and stops', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-mcp-debug-'));
  const client = new Client({ name: 'codetolife-debug-test', version: '1.0.0' });
  try {
    fs.writeFileSync(path.join(root, 'sample.mjs'), [
      'function greet() {',
      '  const word = process.argv[2];',
      '  console.log(word);',
      '  return word;',
      '}',
      'greet();',
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [
      entry, root, '--debug-entry', 'sample.mjs', '--break', 'sample.mjs:2', '--debug-arg', 'hello MCP'
    ] });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    assert.equal(tools.find(tool => tool.name === 'debug_launch').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'debug_where').annotations.readOnlyHint, true);

    async function debug(name, args = {}) {
      const response = await client.callTool({ name: 'debug_' + name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return response.structuredContent;
    }

    assert.equal((await debug('where')).status, 'idle');
    const launched = await debug('launch', { waitMs: 3000 });
    assert.equal(launched.status, 'paused');
    assert.deepEqual(launched.breakpoints, [{ file: 'sample.mjs', line: 2 }]);
    const stoppedAt = await debug('continue', { waitMs: 3000 });
    assert.equal(stoppedAt.frames[0].line, 2);
    assert.equal(stoppedAt.frames[0].name, 'greet');
    assert.match(stoppedAt.frames[0].nodeId, /^module:sample\.mjs#greet@/);
    const stepped = await debug('step', { direction: 'over', waitMs: 3000 });
    assert.equal(stepped.frames[0].line, 3);
    const running = await debug('continue', { waitMs: 200 });
    assert.equal(running.status, 'running');
    assert.match(running.output, /hello MCP/);
    assert.equal((await debug('stop', { waitMs: 3000 })).status, 'exited');
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stdio MCP client can query a project and use the optional Git review', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-mcp-'));
  const put = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  const client = new Client({ name: 'codetolife-test', version: '1.0.0' });
  const companion = process.env.PRBUDDY_JS_ENTRY;
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry, root],
    env: companion !== undefined ? { PRBUDDY_JS_ENTRY: companion } : undefined
  });

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tool Test');
    git('config', 'user.email', 'tool-test@example.invalid');
    put('math.js', 'export function double(n) { return n * 2; }\n');
    put('app.js', 'import { double } from "./math.js";\nexport const compute = n => double(n);\n');
    put('app.test.js', 'import { compute } from "./app.js";\nit("works", () => compute(2));\n');
    put('other.js', 'export function double(n) { return n + n; }\n');
    put('.codetolife/rules.json', '[{"from":"app.js","notTo":"math.js","kinds":["imports"]}]');
    git('add', '.');
    git('commit', '-qm', 'Initial');

    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 18);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint || tool.name === 'save_explanation'));
    assert.equal(tools.find(tool => tool.name === 'save_explanation').annotations.destructiveHint, false);
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return response.structuredContent;
    };

    assert.equal((await call('overview')).modules, 4);
    const search = await call('find', { query: 'double', limit: 1, offset: 1 });
    assert.equal(search.total, 2);
    assert.equal(search.items.length, 1);
    const ambiguous = await client.callTool({ name: 'describe', arguments: { node: 'double' } });
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.structuredContent.matches.length, 2);
    const matches = await call('find', { query: 'double' });
    const target = matches.items.find(node => node.file === 'math.js').id;
    assert.equal((await call('describe', { node: target })).node.name, 'double');
    assert.equal((await call('callers', { node: target })).items[0].node.name, 'compute');
    assert.equal((await call('callees', { node: 'compute' })).items[0].node.id, target);
    const route = await call('path_between', { from: 'app.test.js', to: target });
    assert.deepEqual(route.steps.map(step => step.node.name), ['compute', 'double']);
    assert.deepEqual((await call('tests_for', { node: target })).items, ['app.test.js']);
    assert.deepEqual((await call('impact', { node: target })).items.map(item => item.distance), [1, 2]);
    assert.equal((await call('check_architecture')).items[0].target, 'math.js');
    const next = await call('explain_next', { limit: 2 });
    assert.match(next.guidance, /new to coding/);
    assert.equal(next.items[0].kind, 'module');
    assert.equal(next.items.length, 2);
    assert.ok(next.items.every(item => typeof item.code === 'string'));
    const saved = await call('save_explanation', { node: target, summary: 'Doubles a number.' });
    assert.equal(saved.key, 'math.js#double');
    assert.ok(!(await call('explain_next', { limit: 20 })).items.some(item => item.id === target));
    const unknown = await client.callTool({ name: 'save_explanation', arguments: { node: 'missing', summary: 'x' } });
    assert.equal(unknown.isError, true);

    put('math.js', 'export function double(n) { return n * 3; }\n');
    put('new.ts', 'export const ready = (): boolean => true;\n');
    if (prBuddyEntry()) {
      const changed = await call('what_changed');
      assert.ok(changed.items.find(file => file.file === 'math.js').changes.some(change => change.kind === 'behavior'));
      assert.ok(changed.items.some(file => file.file === 'new.ts'));
    } else {
      const response = await client.callTool({ name: 'what_changed', arguments: {} });
      assert.equal(response.isError, true);
      assert.match(response.structuredContent.error, /needs PR Buddy JS/);
      await call('overview', { refresh: true });
    }
    assert.equal((await call('overview')).modules, 5);
    fs.unlinkSync(path.join(root, 'new.ts'));
    assert.equal((await call('overview', { refresh: true })).modules, 4);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
