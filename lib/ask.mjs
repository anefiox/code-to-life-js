// "Ask the codebase": finds the files and functions that best match a
// question, using names, paths, routes and saved explanations, and builds a
// prompt that answers from them with references the page can link.
import { ExplainError, explanationsFor, readSource } from './explain.mjs';

const stopWords = new Set(('a an and are as at be by can do does for from how i in is it its of on or so that the ' +
  'their there this to was what when where which who why will with you your me my we our get gets use used uses work ' +
  'works happen happens code app file files function functions').split(' '));
const sourceLimit = 10;
const contextLimit = 24000;
const codeLines = 60;

export const askGuidance = 'You answer questions about one codebase for a developer who is new to it. Use only the ' +
  'context you are given. Whenever you mention a file or function, write its path or name in backticks exactly as it ' +
  'appears in the context, for example `src/server/server.js` or `createServer`, so it can be linked. If the context ' +
  'does not answer the question, say so and suggest where to look. Keep the answer under 200 words, in plain English.';

const words = text => String(text).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  .filter(word => word.length > 1 && !stopWords.has(word)).map(word => word.length > 4 ? word.replace(/(?:es|s)$/, '') : word);

export function askSources(root, graph, question) {
  if (typeof question !== 'string' || question.trim().length < 3 || question.length > 500) {
    throw new ExplainError('Ask a question of 3 to 500 characters.');
  }
  const wanted = new Set(words(question));
  if (!wanted.size) throw new ExplainError('Ask about something in the code, such as a page, a setting or a feature.');
  const explanations = explanationsFor(root, graph);
  const tests = new Set(graph.tests);
  const routesBy = new Map();
  for (const route of graph.routes ?? []) {
    if (!routesBy.has(route.handler)) routesBy.set(route.handler, []);
    routesBy.get(route.handler).push(route.method + ' ' + route.path);
  }
  const scored = [];
  for (const node of graph.nodes) {
    if (tests.has('module:' + node.file) || !['module', 'function', 'class', 'method'].includes(node.kind)) continue;
    const name = new Set(words(node.kind === 'module' ? node.file.split('/').at(-1) : node.name));
    const file = new Set(words(node.file));
    const about = new Set(words(explanations[node.id]?.summary ?? ''));
    const routes = new Set(words((routesBy.get(node.id) ?? []).join(' ')));
    let score = 0;
    for (const word of wanted) {
      if (name.has(word)) score += 4;
      else if (file.has(word)) score += 2;
      if (routes.has(word)) score += 3;
      if (about.has(word)) score += 1.5;
    }
    if (score > 0) scored.push({ node, score: score + (explanations[node.id] ? 0.5 : 0) + (node.kind === 'module' ? 0.25 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return { explanations, sources: scored.slice(0, sourceLimit).map(item => item.node) };
}

export function askPrompt(root, graph, question) {
  const { explanations, sources } = askSources(root, graph, question);
  const blocks = [];
  let used = 0;
  for (const node of sources) {
    let code = '';
    try {
      code = readSource(root, graph, node.id).code.split('\n').slice(0, codeLines).join('\n');
    } catch {
      // Unreadable files still contribute their explanation.
    }
    const label = node.kind === 'module' ? node.file : node.name + ' in ' + node.file + ':' + node.line;
    const block = '### ' + label + '\n' + (explanations[node.id] ? 'Explanation: ' + explanations[node.id].summary + '\n' : '') +
      (code ? '```\n' + code + '\n```\n' : '');
    if (used + block.length > contextLimit) break;
    blocks.push(block);
    used += block.length;
  }
  const routes = (graph.routes ?? []).slice(0, 40).map(route => route.method + ' ' + route.path + ' (' + route.file + ')');
  const user = ['Question: ' + question.trim(), '', 'Pages in the app: ' + (routes.join('; ') || 'none found'), '',
    'The most relevant code:', '', ...blocks].join('\n');
  return {
    sources: sources.map(node => ({ id: node.id, name: node.name, file: node.file, kind: node.kind })),
    messages: [{ role: 'system', content: askGuidance }, { role: 'user', content: user }]
  };
}
