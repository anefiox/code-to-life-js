// The template map: which page templates extend which layouts, the partials
// and macros they pull in, and the routes that render each one.
import path from 'node:path';
import { templateFiles, templateFor } from './learn.mjs';
import { lineAt, readText } from './settings.mjs';

const packages = [
  [/^govuk\//, 'GOV.UK Frontend'],
  [/^moj\//, 'MOJ Frontend'],
  [/^dfe\//, 'DfE Frontend'],
  [/^hmrc\//, 'HMRC Frontend']
];

const dirOf = file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';

function resolve(name, from, files) {
  if (name.startsWith('.')) {
    const target = path.posix.normalize(path.posix.join(dirOf(from), name));
    if (files.includes(target)) return { name, file: target };
  }
  const file = templateFor(name, files);
  if (file) return { name, file };
  const known = packages.find(([pattern]) => pattern.test(name));
  return { name, file: null, external: known ? known[1] : name.split('/')[0] };
}

export function templateMap(root, graph) {
  const files = templateFiles(root);
  const templates = new Map(files.map(file => [file, {
    file, kind: 'partial', extends: null, includes: [], imports: [], blocks: [], macros: [], usedBy: [], renderedBy: []
  }]));
  for (const file of files) {
    const text = readText(root, file);
    const item = templates.get(file);
    const reference = (pattern, add) => {
      for (const match of text.matchAll(pattern)) add({ ...resolve(match[1], file, files), line: lineAt(text, match.index) }, match);
    };
    reference(/\{%-?\s*extends\s+["']([^"']+)["']/g, ref => { item.extends ??= ref; });
    reference(/\{%-?\s*include\s+["']([^"']+)["']/g, ref => item.includes.push(ref));
    reference(/\{%-?\s*from\s+["']([^"']+)["']\s+import\s+([\w\s,]+?)\s*-?%\}/g, (ref, match) =>
      item.imports.push({ ...ref, names: match[2].split(',').map(name => name.trim()).filter(Boolean) }));
    reference(/\{%-?\s*import\s+["']([^"']+)["']\s+as\s+(\w+)/g, (ref, match) => item.imports.push({ ...ref, names: [match[2]] }));
    item.blocks = [...new Set([...text.matchAll(/\{%-?\s*block\s+(\w+)/g)].map(match => match[1]))];
    item.macros = [...new Set([...text.matchAll(/\{%-?\s*macro\s+(\w+)/g)].map(match => match[1]))];
  }
  for (const item of templates.values()) {
    for (const [ref, how] of [[item.extends, 'extends'], ...item.includes.map(ref => [ref, 'includes']),
      ...item.imports.map(ref => [ref, 'imports'])]) {
      if (ref?.file && templates.has(ref.file)) templates.get(ref.file).usedBy.push({ file: item.file, how, line: ref.line });
    }
  }
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const [owner, names] of Object.entries(graph.views ?? {})) {
    for (const name of names) {
      const file = templateFor(name, files);
      if (!file) continue;
      const node = byId.get(owner);
      const routes = (graph.routes ?? []).filter(route => route.handler === owner).map(route => route.method + ' ' + route.path);
      templates.get(file).renderedBy.push({ id: owner, name: node?.name ?? owner, file: node?.file ?? null, line: node?.line ?? null, routes });
    }
  }
  for (const item of templates.values()) {
    if (item.renderedBy.length) item.kind = 'page';
    else if (item.usedBy.some(use => use.how === 'extends')) item.kind = 'layout';
    else if (item.macros.length || /(?:^|\/)(?:macro|template)\.[^/]+$/.test(item.file)) item.kind = 'component';
    else if (item.extends) item.kind = 'page';
  }
  return { templates: [...templates.values()] };
}
