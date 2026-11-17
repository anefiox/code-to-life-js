import fs from 'node:fs';
import path from 'node:path';
import { architectureViolations, buildGraph } from './graph.mjs';

export function projectRoot(folder = '.') {
  const root = fs.realpathSync(path.resolve(folder));
  if (!fs.statSync(root).isDirectory()) throw new Error('Supply a project folder.');
  return root;
}

export function analyze(root) {
  const graph = buildGraph(root);
  const config = path.join(root, '.codetolife', 'rules.json');
  const rules = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : [];
  return { ...graph, violations: architectureViolations(graph, rules) };
}
