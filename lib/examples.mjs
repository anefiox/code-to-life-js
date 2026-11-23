// Worked examples from the tests: the test cases that use a file or function,
// so a newcomer can see real inputs and the results they should give.
import ts from 'typescript';
import { ExplainError } from './explain.mjs';
import { readText } from './settings.mjs';

const exampleLimit = 4;
const lineLimit = 30;
const testNames = new Set(['test', 'it']);
const groupNames = new Set(['describe', 'suite']);

function calleeName(expression) {
  // it(...), it.each(...)(...), test.only(...)
  let current = expression;
  while (ts.isCallExpression(current)) current = current.expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

function cases(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : undefined);
  const found = [];
  const visit = (node, groups) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const [title] = node.arguments;
      const label = title && (ts.isStringLiteralLike(title) ? title.text : ts.isTemplateExpression(title) ? title.getText(source).slice(1, -1) : null);
      if (label !== null && label !== undefined && (testNames.has(name) || groupNames.has(name))) {
        if (testNames.has(name)) {
          const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
          const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
          found.push({ title: [...groups, label].join(' › '), start: start + 1, end: end + 1, text: node.getText(source) });
          return;
        }
        ts.forEachChild(node, child => visit(child, [...groups, label]));
        return;
      }
    }
    ts.forEachChild(node, child => visit(child, groups));
  };
  visit(source, []);
  return found;
}

export function testExamples(root, graph, id) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new ExplainError('Unknown graph node.', 404);
  const tests = new Set(graph.tests);
  const moduleId = 'module:' + node.file;
  const files = new Set();
  for (const edge of graph.edges) {
    const from = edge.from.split('#')[0];
    if (!tests.has(from) || from === moduleId) continue;
    if (edge.to === id || edge.to === moduleId || (node.kind === 'module' && edge.to.startsWith(moduleId + '#'))) {
      files.add(from.slice('module:'.length));
    }
  }
  if (tests.has(moduleId)) return { node: id, examples: [] };
  const word = node.kind === 'module' ? null : node.name.split('.').at(-1);
  const pattern = word && new RegExp('(?<![\\w$])' + word.replace(/[$]/g, '\\$') + '(?![\\w$])');
  const examples = [];
  for (const file of [...files].sort()) {
    const text = readText(root, file);
    if (!text) continue;
    const found = cases(file, text).filter(item => !pattern || pattern.test(item.text));
    for (const item of found.slice(0, node.kind === 'module' ? 2 : 3)) {
      const lines = item.text.split(/\r?\n/);
      const code = lines.slice(0, lineLimit).join('\n') + (lines.length > lineLimit ? '\n// …' : '');
      examples.push({ file, title: item.title, start: item.start, end: item.start + Math.min(lines.length, lineLimit) - 1, code,
        truncated: lines.length > lineLimit });
    }
  }
  examples.sort((a, b) => a.code.length - b.code.length);
  return { node: id, testFiles: [...files].sort(), examples: examples.slice(0, exampleLimit) };
}
