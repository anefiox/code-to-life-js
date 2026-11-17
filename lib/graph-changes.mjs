import fs from 'node:fs';
import path from 'node:path';
import { reviewChanges } from './pr-buddy.mjs';
import { portable } from './source.mjs';

export function graphChanges(graph, base) {
  const report = reviewChanges(graph.root, base);
  const project = portable(path.relative(fs.realpathSync(report.root), graph.root));
  const prefix = project ? project + '/' : '';
  const inProject = file => Boolean(file?.startsWith(prefix));
  const relative = file => inProject(file) ? file.slice(prefix.length) : file;
  const nodes = new Map();
  const modules = new Map();
  for (const node of graph.nodes) {
    if (node.kind === 'module') modules.set(node.file, node.id);
    else {
      const key = JSON.stringify([node.file, node.name, node.line]);
      nodes.set(key, node.id);
    }
  }

  const findings = new Map();
  for (const finding of [...report.findings, ...report.suppressed]) {
    if (!findings.has(finding.file)) findings.set(finding.file, []);
    findings.get(finding.file).push({ ...finding, file: relative(finding.file) });
  }
  const files = report.files.filter(file => inProject(file.file) || inProject(file.oldFile)).map(file => {
    const name = relative(file.file);
    const visible = inProject(file.file) && file.status !== 'D';
    return {
      ...file,
      file: name,
      oldFile: relative(file.oldFile),
      moduleId: visible ? modules.get(name) ?? null : null,
      changes: file.changes.map(change => ({
        ...change,
        nodeId: visible && ['added', 'behavior', 'signature'].includes(change.kind)
          ? nodes.get(JSON.stringify([name, change.name, change.line])) ?? null : null
      })),
      findings: findings.get(file.file) ?? []
    };
  });
  return { baseline: report.baseline, files };
}
