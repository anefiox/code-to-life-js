import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { declarations, ignoredDirectories, isGenerated, isSource, isTest, lineOf, portable } from './source.mjs';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const defaults = {
  allowJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve, skipLibCheck: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
};
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const methodPattern = /^(?:\*|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)(?:, ?(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))*$/;
const normalized = file => portable(path.resolve(file));
const fileKey = file => ts.sys.useCaseSensitiveFileNames ? normalized(file) : normalized(file).toLowerCase();

// Node subpath imports from package.json, e.g. {"#/*": "./src/*"}, as
// TypeScript paths. TypeScript does not resolve every form Node accepts
// (such as "#/"), so mapping them keeps those imports in the graph.
function subpathImports(root) {
  let imports;
  try {
    imports = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).imports;
  } catch {
    return null;
  }
  if (!imports || typeof imports !== 'object') return null;
  const target = value => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(target).find(Boolean);
    if (value && typeof value === 'object') {
      for (const condition of ['types', 'import', 'node', 'default', 'require']) {
        const found = target(value[condition]);
        if (found) return found;
      }
    }
    return null;
  };
  const paths = {};
  for (const [key, value] of Object.entries(imports)) {
    const resolved = target(value);
    if (!key.startsWith('#') || !resolved?.startsWith('./') || key.split('*').length > 2 ||
        resolved.split('*').length !== key.split('*').length) continue;
    paths[key] = [resolved];
  }
  return Object.keys(paths).length ? paths : null;
}

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
  const imports = subpathImports(root);
  const programs = configs.filter(config => config.fileNames.length).map(config => {
    const options = { ...config.options };
    if (imports) {
      options.paths = { ...imports, ...options.paths };
      if (!options.baseUrl && !options.pathsBasePath) options.pathsBasePath = root;
    }
    return ts.createProgram(config.fileNames, options);
  });
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
  const routes = [];
  const views = new Map();

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
    const file = relative(source.fileName);
    const routable = !isTest(file);
    const isFunction = node => node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node));
    // A string, a string constant, or a union of string literals; otherwise the
    // expression as written, e.g. config.get('auth.path').
    function textValue(expression) {
      if (!expression) return null;
      if (ts.isStringLiteralLike(expression)) return { text: expression.text, fixed: true };
      if (ts.isArrayLiteralExpression(expression)) {
        const parts = expression.elements.map(textValue);
        if (parts.every(part => part?.fixed)) return { text: parts.map(part => part.text).join(', '), fixed: true };
      }
      const type = checker.getTypeAtLocation(expression);
      const literals = type.isUnion() ? type.types : [type];
      if (literals.every(item => item.isStringLiteral())) {
        return { text: literals.map(item => item.value).join(', '), fixed: true };
      }
      const written = expression.getText(source).replace(/\s+/g, ' ');
      return { text: written.length > 80 ? written.slice(0, 77) + '…' : written, fixed: false };
    }
    // The declaration that handles a route: a named function or controller
    // object, or the enclosing declaration when the handler is written inline.
    function handlerOf(expression, owner) {
      if (!expression || isFunction(expression)) return owner;
      let target = targetOf(expression);
      let current = expression;
      while (!target && ts.isPropertyAccessExpression(current)) {
        current = current.expression;
        target = targetOf(current);
      }
      return target ?? owner;
    }
    function hapiRoute(node, owner) {
      const props = new Map();
      const spreads = [];
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) spreads.push(property.expression);
        else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          props.set(property.name.text, property);
        }
      }
      const valueOf = property => property && ts.isPropertyAssignment(property) ? property.initializer :
        property && ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      if (!props.has('method') || !props.has('path')) return;
      const method = textValue(valueOf(props.get('method')));
      const route = textValue(valueOf(props.get('path')));
      if (!method || !route || (method.fixed && !methodPattern.test(method.text.toUpperCase()))) return;
      if (route.fixed && !/^[/*]/.test(route.text)) return;
      let handler;
      const direct = props.get('handler');
      const options = valueOf(props.get('options'));
      const nested = options && ts.isObjectLiteralExpression(options) &&
        options.properties.find(property => property.name?.getText(source) === 'handler');
      for (const candidate of [direct, nested]) {
        if (!candidate || handler) continue;
        if (ts.isMethodDeclaration(candidate)) handler = owner;
        else if (ts.isShorthandPropertyAssignment(candidate)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(candidate);
          handler = symbol?.declarations?.map(item => declarationIds.get(declarationKey(item, item.getSourceFile())))
            .find(Boolean) ?? owner;
        } else handler = handlerOf(candidate.initializer, owner);
      }
      for (const spread of spreads) handler ??= targetOf(spread);
      routes.push({ method: method.text.toUpperCase(), path: route.text, fixedPath: route.fixed, file,
        line: lineOf(node, source), handler: handler ?? owner });
    }
    function expressRoute(node, owner) {
      const callee = node.expression;
      if (!ts.isPropertyAccessExpression(callee) || !httpMethods.has(callee.name.text)) return;
      const [first, ...rest] = node.arguments;
      if (!first || !rest.length || !ts.isStringLiteralLike(first) || !first.text.startsWith('/')) return;
      const method = callee.name.text === 'all' ? '*' : callee.name.text.toUpperCase();
      routes.push({ method, path: first.text, fixedPath: true, file, line: lineOf(node, source),
        handler: handlerOf(rest.at(-1), owner) });
    }
    function viewCall(node, owner) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (!ts.isPropertyAccessExpression(callee) || !['view', 'render'].includes(callee.name.text) ||
          !first || !ts.isStringLiteralLike(first) || !first.text || first.text.startsWith('/')) return;
      if (!views.has(owner)) views.set(owner, new Set());
      views.get(owner).add(first.text);
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
      if (routable && ts.isObjectLiteralExpression(node)) hapiRoute(node, owner);
      if (ts.isCallExpression(node)) {
        if (routable) expressRoute(node, owner);
        viewCall(node, owner);
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
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file));
  return {
    root, nodes: [...nodes.values()], edges: [...edges.values()], tests: [...testIds], warnings, routes,
    views: Object.fromEntries([...views].map(([id, names]) => [id, [...names].sort()]))
  };
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
