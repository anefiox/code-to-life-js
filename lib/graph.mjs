import path from 'node:path';
import ts from 'typescript';
import { declarations, ignoredDirectories, isGenerated, isSource, isTest, lineOf, portable } from './source.mjs';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const defaults = {
  allowJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve, skipLibCheck: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
};
const normalized = file => portable(path.resolve(file));
const fileKey = file => ts.sys.useCaseSensitiveFileNames ? normalized(file) : normalized(file).toLowerCase();

function programsFor(root) {
  const seen = new Set();
  const configs = [];
  const warnings = [];
  function load(file) {
    if (seen.has(fileKey(file))) return;
    seen.add(fileKey(file));
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) {
      warnings.push(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
      return;
    }
    const config = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file), { noEmit: true }, file);
    for (const error of config.errors) {
      warnings.push(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    }
    configs.push(config);
    for (const reference of config.projectReferences ?? []) load(ts.resolveProjectReferencePath(reference));
  }

  const config = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(root, name)).find(ts.sys.fileExists);
  if (config) load(config);
  const allFiles = ts.sys.readDirectory(root, sourceExtensions, ignoredDirectories.map(dir => '**/' + dir + '/**'))
    .filter(isSource);
  const covered = new Set(configs.flatMap(config => config.fileNames.map(fileKey)));
  const uncovered = allFiles.filter(file => !covered.has(fileKey(file)));
  if (uncovered.length) configs.push({ fileNames: uncovered, options: { ...defaults, ...configs[0]?.options, allowJs: true } });
  const programs = configs.filter(config => config.fileNames.length)
    .map(config => ts.createProgram(config.fileNames, config.options));
  return { programs, warnings };
}

export function buildGraph(root) {
  const { programs, warnings } = programsFor(root);
  const nodes = new Map();
  const edges = new Map();
  const contexts = [];
  const declarationIds = new Map();
  const sourceIds = new Set();
  const relative = file => portable(path.relative(root, file));
  const moduleId = file => 'module:' + relative(file);
  const declarationKey = (node, source) => fileKey(source.fileName) + '#' + node.pos;
  const testIds = new Set();

  for (const program of programs) {
    const checker = program.getTypeChecker();
    for (const source of program.getSourceFiles()) {
      const file = relative(source.fileName);
      if (!file || file.startsWith('../') || path.isAbsolute(file) || !isSource(file) || isGenerated(file)) continue;
      const module = moduleId(source.fileName);
      if (sourceIds.has(module)) continue;
      sourceIds.add(module);
      nodes.set(module, { id: module, name: file, kind: 'module', file, line: 1 });
      if (isTest(file)) testIds.add(module);
      const entries = declarations(source);
      const owners = new Map();
      for (const entry of entries) {
        const id = module + '#' + entry.name + '@' + entry.node.getStart(source);
        declarationIds.set(declarationKey(entry.node, source), id);
        owners.set(entry.node, id);
        nodes.set(id, {
          id, name: entry.name, kind: entry.kind, file, line: entry.line,
          endLine: source.getLineAndCharacterOfPosition(entry.node.getEnd() - 1).line + 1
        });
      }
      contexts.push({ checker, source, module, owners });
    }
  }

  function add(from, to, kind, line) {
    if (!to || !nodes.has(to) || (from === to && kind !== 'calls')) return;
    const key = JSON.stringify([from, to, kind]);
    const edge = edges.get(key);
    if (edge) {
      if (!edge.lines.includes(line)) edge.lines.push(line);
    } else {
      edges.set(key, { id: 'edge:' + edges.size, from, to, kind, lines: [line] });
    }
  }

  for (const { checker, source, module, owners } of contexts) {
    function resolve(expression) {
      const symbol = checker.getSymbolAtLocation(expression);
      return symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
    function targetOf(expression) {
      const symbol = resolve(expression);
      for (const node of symbol?.declarations ?? []) {
        const id = declarationIds.get(declarationKey(node, node.getSourceFile()));
        if (id) return id;
      }
    }
    function visit(node, owner) {
      const current = owners.get(node);
      if (current) {
        add(owner, current, 'contains', lineOf(node, source));
        owner = current;
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        for (const target of resolve(node.moduleSpecifier)?.declarations ?? []) {
          if (ts.isSourceFile(target)) {
            const typeOnly = node.isTypeOnly || node.importClause?.isTypeOnly;
            add(module, moduleId(target.fileName), typeOnly ? 'imports type' : 'imports', lineOf(node, source));
          }
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const line = lineOf(node, source);
        add(owner, targetOf(node.expression), ts.isNewExpression(node) ? 'creates' : 'calls', line);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') {
          const argument = node.arguments?.[0];
          if (argument && ts.isStringLiteralLike(argument)) {
            for (const target of resolve(argument)?.declarations ?? []) {
              if (ts.isSourceFile(target)) add(module, moduleId(target.fileName), 'imports', line);
            }
          }
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        add(owner, targetOf(node.tagName), 'renders', lineOf(node, source));
      }
      if (ts.isHeritageClause(node)) {
        for (const type of node.types) {
          add(owner, targetOf(type.expression), node.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements',
            lineOf(type, source));
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(source, module);
  }
  return { root, nodes: [...nodes.values()], edges: [...edges.values()], tests: [...testIds], warnings };
}

export function architectureViolations(graph, rules) {
  if (!Array.isArray(rules)) throw new Error('Architecture rules must be an array.');
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const validatePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !value.startsWith('/') && !value.split('/').includes('..');
  const matches = (file, prefix) => prefix === '.' || file === prefix || file.startsWith(prefix + '/');
  return rules.flatMap(rule => {
    if (!rule || !validatePath(rule.from) || !validatePath(rule.notTo) ||
        (rule.kinds !== undefined && (!Array.isArray(rule.kinds) || !rule.kinds.every(kind => typeof kind === 'string')))) {
      throw new Error('Each architecture rule needs relative from and notTo paths and optionally a kinds array.');
    }
    const from = rule.from.replace(/\/+$/, '');
    const to = rule.notTo.replace(/\/+$/, '');
    return graph.edges.flatMap(edge => {
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (edge.kind === 'contains' || source.file === target.file ||
          (rule.kinds && !rule.kinds.includes(edge.kind)) ||
          !matches(source.file, from) || !matches(target.file, to)) return [];
      return [{ ...edge, file: source.file, target: target.file, because: rule.because }];
    });
  });
}
