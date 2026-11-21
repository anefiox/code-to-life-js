import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, projectRoot } from '../lib/project.mjs';
import {
  ExplainError, explanationQueue, explanationsFor, packagesIn, projectGlossary, readSource, saveExplanation
} from '../lib/explain.mjs';

function project(t) {
  const root = projectRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'codetolife-explain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  return { root, put };
}

test('packagesIn finds third-party imports and requires', () => {
  const text = [
    "import Hapi from '@hapi/hapi'",
    "import { get } from 'lodash/get.js'",
    "import local from './local.js'",
    "const fs = require('node:fs')",
    "const later = await import('pino')"
  ].join('\n');
  assert.deepEqual(packagesIn(text), ['@hapi/hapi', 'fs', 'lodash', 'pino']);
});

test('explanations are saved, read back, flagged stale, and queued hubs first', t => {
  const { root, put } = project(t);
  put('package.json', JSON.stringify({ dependencies: { '@hapi/hapi': '1', '@defra/unknown-lib': '1', leftpad: '1' } }));
  put('math.js', 'export function double(n) {\n  return n * 2;\n}\n');
  put('app.js', 'import { double } from "./math.js";\nexport function compute(n) {\n  return double(n);\n}\n');
  put('app.test.js', 'import { compute } from "./app.js";\nit("works", () => compute(2));\n');
  let graph = analyze(root);
  const double = graph.nodes.find(node => node.name === 'double');

  const source = readSource(root, graph, double.id);
  assert.equal(source.code, 'export function double(n) {\n  return n * 2;\n}');
  assert.deepEqual([source.start, source.end, source.total], [1, 3, 4]);
  assert.throws(() => readSource(root, graph, 'module:../outside.js'), ExplainError);

  const queue = explanationQueue(root, graph);
  assert.equal(queue[0].node.kind, 'module');
  assert.ok(queue.every(item => item.node.file !== 'app.test.js'));
  assert.ok(queue.some(item => item.node.id === double.id));

  assert.throws(() => saveExplanation(root, graph, double.id, '   '), ExplainError);
  saveExplanation(root, graph, double.id, 'Doubles a number.');
  assert.deepEqual(explanationsFor(root, graph)[double.id].summary, 'Doubles a number.');
  assert.equal(explanationsFor(root, graph)[double.id].stale, false);
  assert.ok(!explanationQueue(root, graph).some(item => item.node.id === double.id));

  // Moving the function keeps its explanation; changing its body marks it stale.
  put('math.js', '// helpers\nexport function double(n) {\n  return n * 2;\n}\n');
  graph = analyze(root);
  const moved = graph.nodes.find(node => node.name === 'double');
  assert.notEqual(moved.id, double.id);
  assert.equal(explanationsFor(root, graph)[moved.id].stale, false);
  put('math.js', '// helpers\nexport function double(n) {\n  return n + n;\n}\n');
  graph = analyze(root);
  const changed = graph.nodes.find(node => node.name === 'double');
  assert.equal(explanationsFor(root, graph)[changed.id].stale, true);
  assert.ok(explanationQueue(root, graph).find(item => item.node.id === changed.id).stale);

  const glossary = projectGlossary(root);
  assert.deepEqual(glossary.map(item => item.package), ['@defra/unknown-lib', '@hapi/hapi']);
  assert.equal(glossary[0].term, 'DEFRA library');
});
