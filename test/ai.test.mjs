import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

// The fake AI server lives in this process, so CLI runs must not block it.
async function runCli(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const [status] = await once(child, 'exit');
  return { status, stdout, stderr };
}
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfig, askAi, cleanAnswer, explanationPrompt } from '../lib/ai.mjs';
import { analyze, projectRoot } from '../lib/project.mjs';

const codeToLife = fileURLToPath(new URL('../bin/codetolife.mjs', import.meta.url));

test('aiConfig supports OpenRouter and self-hosted OpenAI-compatible servers', () => {
  assert.equal(aiConfig({}), null);
  assert.throws(() => aiConfig({ 'ai-model': 'x' }), /needs --ai/);
  assert.throws(() => aiConfig({ ai: 'openrouter' }, {}), /OPENROUTER_API_KEY/);
  const router = aiConfig({ ai: 'OpenRouter' }, { OPENROUTER_API_KEY: 'k1' });
  assert.equal(router.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(router.model, 'openrouter/auto');
  assert.equal(router.key, 'k1');

  const local = aiConfig({ ai: 'http://100.99.57.40:8888/chat' }, { CODETOLIFE_AI_KEY: 'k2' });
  assert.equal(local.endpoint, 'http://100.99.57.40:8888/v1/chat/completions');
  assert.equal(local.model, 'default');
  assert.equal(local.key, 'k2');
  assert.equal(aiConfig({ ai: 'http://localhost:1234/v1/' }, {}).endpoint, 'http://localhost:1234/v1/chat/completions');
  assert.equal(aiConfig({ ai: 'http://localhost:11434', 'ai-model': 'qwen3' }, {}).model, 'qwen3');
  assert.equal(aiConfig({ ai: 'http://localhost:11434' }, {}).key, null);
  assert.throws(() => aiConfig({ ai: 'file:///etc' }, {}), /http or https/);
  assert.throws(() => aiConfig({ ai: 'not a url' }, {}), /openrouter/);
  assert.throws(() => aiConfig({ ai: 'http://user:secret@host' }, {}), /CODETOLIFE_AI_KEY/);
});

test('cleanAnswer removes reasoning and framing', () => {
  assert.equal(cleanAnswer('<think>hmm</think>\n\nIt starts the server.'), 'It starts the server.');
  assert.equal(cleanAnswer('long thoughts</think>It starts the server.'), 'It starts the server.');
  assert.equal(cleanAnswer('**Explanation:** It starts the server.'), 'It starts the server.');
  assert.equal(cleanAnswer('"It starts the server."'), 'It starts the server.');
  assert.equal(cleanAnswer(undefined), '');
});

test('askAi sends a chat completion and reports useful errors', async () => {
  const config = { label: 'Test', endpoint: 'http://ai.invalid/v1/chat/completions', key: 'secret', model: 'm', headers: {} };
  let sent;
  const ok = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: ' Starts things. ' } }] }));
  };
  assert.equal(await askAi(config, [{ role: 'user', content: 'hi' }], { fetchImpl: ok }), 'Starts things.');
  assert.equal(sent.init.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(sent.init.body).messages, [{ role: 'user', content: 'hi' }]);

  const denied = async () => new Response('{"detail":"no"}', { status: 401 });
  await assert.rejects(askAi(config, [], { fetchImpl: denied }), /401.*CODETOLIFE_AI_KEY/);
  const html = async () => new Response('<html>');
  await assert.rejects(askAi(config, [], { fetchImpl: html }), /OpenAI-compatible/);
  const empty = async () => new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>' } }] }));
  await assert.rejects(askAi(config, [], { fetchImpl: empty }), /empty answer/);
  const offline = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(askAi(config, [], { fetchImpl: offline }), /could not be reached \(ECONNREFUSED\)/);
});

function fixture(t) {
  const root = projectRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-ai-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'math.js'), 'import _ from "lodash";\nexport function double(n) {\n  return n * 2;\n}\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'import { double } from "./math.js";\nexport const compute = n => double(n);\n');
  return root;
}

test('explanationPrompt includes the code, packages and connections', t => {
  const root = fixture(t);
  const graph = analyze(root);
  const double = graph.nodes.find(node => node.name === 'double');
  const { key, messages } = explanationPrompt(root, graph, double.id);
  assert.equal(key, 'math.js#double');
  assert.match(messages[0].content, /new to coding/);
  assert.match(messages[1].content, /return n \* 2/);
  assert.match(messages[1].content, /Packages the file imports: lodash/);
  assert.match(messages[1].content, /Used by: compute in app\.js/);
});

test('server and explain command write explanations through an OpenAI-compatible API', { timeout: 30000 }, async t => {
  const root = fixture(t);
  const requests = [];
  const fake = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    const name = requests.at(-1).body.messages[1].content.match(/^Name: (.*)$/m)[1];
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: '<think>…</think>Explains ' + name + '.' } }] }));
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  t.after(() => {
    fake.closeAllConnections();
    fake.close();
  });
  const aiUrl = 'http://127.0.0.1:' + fake.address().port + '/chat';
  const env = { ...process.env, CODETOLIFE_AI_KEY: 'test-key' };

  const child = spawn(process.execPath, [codeToLife, root, '--port', '0', '--ai', aiUrl, '--ai-model', 'tiny'],
    { stdio: ['ignore', 'pipe', 'pipe'], env });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.on('exit', code => reject(new Error('Server exited with ' + code)));
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const info = await (await fetch(url + '/api/explanations')).json();
  assert.deepEqual(info.ai, { label: '127.0.0.1:' + fake.address().port, model: 'tiny' });
  assert.equal(JSON.stringify(info).includes('test-key'), false);

  const graph = await (await fetch(url + '/api/graph')).json();
  const double = graph.nodes.find(node => node.name === 'double');
  const endpoint = url + '/api/explain?' + new URLSearchParams({ id: double.id });
  assert.equal((await fetch(endpoint)).status, 405);
  const foreign = await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://external.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(requests.length, 0);
  const saved = await fetch(endpoint, { method: 'POST', headers: { Origin: url } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).summary, 'Explains double.');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].auth, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'tiny');
  const after = await (await fetch(url + '/api/explanations')).json();
  assert.equal(after.explanations[double.id].summary, 'Explains double.');

  const bulk = await runCli([codeToLife, 'explain', root, '--ai', aiUrl, '--limit', '2'], env);
  assert.equal(bulk.status, 0, bulk.stderr);
  assert.match(bulk.stdout, /Explaining 2 of \d+/);
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.codetolife', 'explanations.json'), 'utf8'));
  assert.equal(Object.keys(stored.entries).length, 3);
  assert.equal(stored.entries['math.js#double'].summary, 'Explains double.');

  const noAi = spawnSync(process.execPath, [codeToLife, 'explain', root], { encoding: 'utf8' });
  assert.equal(noAi.status, 2);
  assert.match(noAi.stderr, /needs --ai/);
});
