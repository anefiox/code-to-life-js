import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portable } from './source.mjs';

export function projectFile(root, url) {
  if (!url?.startsWith('file:')) return null;
  try {
    const local = path.relative(root, fileURLToPath(url));
    if (local && local !== '..' && !local.startsWith('..' + path.sep) && !path.isAbsolute(local)) {
      return portable(local);
    }
  } catch {
    // Virtual sources can use URLs that do not point to a local file.
  }
  return null;
}

export function frameMapper(graph, frames) {
  const activeFiles = new Set(frames.map(frame => frame.file));
  const fileNodes = new Map();
  for (const node of graph.nodes) {
    if (!activeFiles.has(node.file)) continue;
    if (!fileNodes.has(node.file)) fileNodes.set(node.file, []);
    fileNodes.get(node.file).push(node);
  }
  return frame => {
    const nodes = fileNodes.get(frame.file) ?? [];
    const module = nodes.find(node => node.kind === 'module');
    const matching = nodes.filter(node => node.kind !== 'module' && node.line <= frame.line &&
      node.endLine >= frame.line);
    const named = matching.filter(node => node.name.split('.').at(-1) === frame.name);
    const symbols = named.length ? named : matching;
    symbols.sort((a, b) => b.line - a.line || a.endLine - b.endLine);
    return { ...frame, nodeId: (symbols[0] ?? module)?.id ?? null, moduleId: module?.id ?? null };
  };
}
