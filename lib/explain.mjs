import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { glossaryFor } from './glossary.mjs';

const sourceLimit = 1024 * 1024;
const storeLimit = 2 * 1024 * 1024;
const summaryLimit = 2000;

export const explanationGuidance = 'Write for someone new to coding and new to this project. In 2 to 4 short ' +
  'sentences, say what this file or function is for, when it runs, and how it fits with the rest of the app. Name ' +
  'the main things it uses or is used by. Explain any framework term in passing. Avoid restating the code line by line.';

export class ExplainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Modules are keyed by file and symbols by file#name, so explanations survive
// edits that move a declaration (node IDs include a character offset).
export const explanationKey = node => node.kind === 'module' ? node.file : node.file + '#' + node.name;
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

function inside(root, file) {
  const target = path.resolve(root, file);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw new ExplainError('File is outside the project.', 403);
  return real;
}

// Third-party packages a file imports, e.g. "@hapi/hapi" or "lodash".
export function packagesIn(text) {
  const found = new Set();
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
  for (const [, specifier] of text.matchAll(pattern)) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) continue;
    const name = specifier.replace(/^node:/, '').split('/');
    found.add(specifier.startsWith('@') ? name.slice(0, 2).join('/') : name[0]);
  }
  return [...found].sort();
}

export function readSource(root, graph, id) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new ExplainError('Unknown graph node.', 404);
  const file = inside(root, node.file);
  if (fs.statSync(file).size > sourceLimit) throw new ExplainError('File is too large to show.', 413);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = node.kind === 'module' ? 1 : node.line;
  const end = node.kind === 'module' ? lines.length : Math.min(lines.length, node.endLine ?? node.line);
  const code = lines.slice(start - 1, end).join('\n');
  return { node, file: node.file, start, end, total: lines.length, code, hash: hash(code), packages: packagesIn(text) };
}

function location(root) {
  const dir = path.join(root, '.codetolife');
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat && !dirStat.isDirectory()) throw new ExplainError('.codetolife must be a local directory.');
  const file = path.join(dir, 'explanations.json');
  const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (fileStat && !fileStat.isFile()) throw new ExplainError('explanations.json must be a regular file.');
  if (fileStat?.size > storeLimit) throw new ExplainError('explanations.json is too large.');
  return { dir, file, exists: Boolean(fileStat) };
}

export function loadExplanations(root) {
  const { file, exists } = location(root);
  if (!exists) return { version: 1, entries: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ExplainError('explanations.json contains invalid JSON.');
  }
  if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new ExplainError('Expected a version 1 explanations file.');
  }
  return parsed;
}

export function saveExplanation(root, graph, id, summary) {
  if (typeof summary !== 'string' || !summary.trim() || summary.length > summaryLimit) {
    throw new ExplainError('Write a summary of 1 to ' + summaryLimit + ' characters.');
  }
  const source = readSource(root, graph, id);
  const store = loadExplanations(root);
  const key = explanationKey(source.node);
  store.entries[key] = { summary: summary.trim(), hash: source.hash, updated: new Date().toISOString() };
  const sorted = Object.fromEntries(Object.entries(store.entries).sort(([a], [b]) => a.localeCompare(b)));
  const encoded = JSON.stringify({ version: 1, entries: sorted }, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > storeLimit) throw new ExplainError('explanations.json would be too large.', 413);
  const { dir, file } = location(root);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, '.explanations-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, encoded, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { key, ...store.entries[key] };
}

// Explanations for the nodes in the current graph, each flagged as stale when
// the code it describes has changed since it was written.
export function explanationsFor(root, graph) {
  const { entries } = loadExplanations(root);
  const result = {};
  const texts = new Map();
  for (const node of graph.nodes) {
    const entry = entries[explanationKey(node)];
    if (!entry || typeof entry.summary !== 'string') continue;
    let stale = false;
    try {
      if (!texts.has(node.file)) texts.set(node.file, fs.readFileSync(inside(root, node.file), 'utf8').split(/\r?\n/));
      const lines = texts.get(node.file);
      const start = node.kind === 'module' ? 1 : node.line;
      const end = node.kind === 'module' ? lines.length : Math.min(lines.length, node.endLine ?? node.line);
      stale = entry.hash !== hash(lines.slice(start - 1, end).join('\n'));
    } catch {
      stale = true;
    }
    result[node.id] = { summary: entry.summary, stale, updated: entry.updated };
  }
  return result;
}

// Nodes that still need an explanation, most useful first: files before
// symbols, and well-connected hubs before leaves.
export function explanationQueue(root, graph) {
  const done = explanationsFor(root, graph);
  const degree = new Map();
  for (const edge of graph.edges) {
    if (edge.kind === 'contains') continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const tests = new Set(graph.tests);
  const useful = node => node.kind === 'module' || ['function', 'class', 'method'].includes(node.kind);
  return graph.nodes
    .filter(node => useful(node) && (!done[node.id] || done[node.id].stale) && !tests.has('module:' + node.file))
    .map(node => ({ node, stale: Boolean(done[node.id]), links: degree.get(node.id) ?? 0 }))
    .sort((a, b) => (a.node.kind === 'module' ? 0 : 1) - (b.node.kind === 'module' ? 0 : 1) ||
      b.links - a.links || a.node.id.localeCompare(b.node.id));
}

export function projectGlossary(root) {
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // Projects without a readable package.json simply get no glossary.
  }
  return glossaryFor(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
}
