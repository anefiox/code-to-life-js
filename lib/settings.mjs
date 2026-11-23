// The settings map: every setting and environment variable the app reads,
// with its default, where it is set for local runs and every place the code
// reads it.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ignoredDirectories, portable } from './source.mjs';

const textLimit = 1024 * 1024;
const valueLimit = 80;

export function readText(root, file) {
  try {
    const target = path.join(root, file);
    if (fs.statSync(target).size > textLimit) return '';
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

export const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// The smallest declaration around a line, or the file itself.
export function nodeAt(graph, file, line) {
  let best = null;
  for (const node of graph.nodes) {
    if (node.file !== file || node.kind === 'module' || node.line > line || (node.endLine ?? node.line) < line) continue;
    if (!best || (node.endLine ?? node.line) - node.line < (best.endLine ?? best.line) - best.line) best = node;
  }
  return best?.id ?? 'module:' + file;
}

const literal = node => node && (ts.isStringLiteralLike(node) ? node.text : null);
const short = text => text.length > valueLimit ? text.slice(0, valueLimit - 1) + '…' : text;
const propertyName = (property, source) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ?
  property.name.text : property.name.getText(source));

// convict({ port: { doc, format, default, env }, redis: { host: {…} } })
function convictSchema(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const settings = [];
  const walk = (object, prefix) => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
      const name = propertyName(property, source);
      const key = prefix ? prefix + '.' + name : name;
      const fields = new Map(property.initializer.properties.filter(ts.isPropertyAssignment)
        .map(item => [propertyName(item, source), item.initializer]));
      const format = fields.get('format');
      if (!fields.has('default') && !(format && !ts.isObjectLiteralExpression(format))) {
        walk(property.initializer, key);
        continue;
      }
      const fallback = fields.get('default');
      const defaultText = fallback ? fallback.getText(source).replace(/\s+/g, ' ') : '';
      settings.push({
        key, doc: literal(fields.get('doc')) ?? '', default: short(defaultText), env: literal(fields.get('env')),
        sensitive: fields.get('sensitive')?.kind === ts.SyntaxKind.TrueKeyword,
        varies: /\bis(?:Production|Development|Test|Prod|Dev)\b|NODE_ENV/.test(defaultText),
        file, line: source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1
      });
    }
  };
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'convict' &&
        node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      walk(node.arguments[0], '');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return settings;
}

// Files where environment variables are set for local runs and deployments.
function envFiles(root) {
  const found = [];
  const look = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (depth < 2 && !ignoredDirectories.includes(entry.name) && !entry.name.startsWith('.')) look(file, depth + 1);
        else if (depth < 2 && entry.name === '.github') look(file + '/workflows', 2);
      } else if (/^\.env(?:\..+)?$|\.env$|compose[^/]*\.ya?ml$|^Dockerfile$|\.ya?ml$/i.test(entry.name) &&
          (/env|compose|docker/i.test(entry.name) || dir.endsWith('workflows'))) {
        found.push(file);
      }
    }
  };
  look('', 0);
  return found.sort();
}

// A real .env file may hold secrets, so only its locations are shown.
const secretFile = file => /(?:^|\/)\.env(?:\.local|\.development|\.production)?$/i.test(file);

export function settingsMap(root, graph) {
  const tests = new Set(graph.tests.map(id => id.slice('module:'.length)));
  const files = graph.nodes.filter(node => node.kind === 'module' && !tests.has(node.file)).map(node => node.file);
  const texts = new Map(files.map(file => [file, readText(root, file)]));
  let settings = [];
  let schemaFile = null;
  for (const [file, text] of texts) {
    if (!/\bconvict\s*\(/.test(text)) continue;
    settings = convictSchema(file, text);
    if (settings.length) {
      schemaFile = file;
      break;
    }
  }
  for (const setting of settings) Object.assign(setting, { uses: [], setIn: [] });

  const byEnv = new Map(settings.filter(setting => setting.env).map(setting => [setting.env, setting]));
  const envOnly = new Map();
  for (const [file, text] of texts) {
    for (const match of text.matchAll(/\b\w*[cC]onfig\.get\(\s*['"`]([\w.-]+)['"`]/g)) {
      const line = lineAt(text, match.index);
      const use = { file, line, id: nodeAt(graph, file, line), key: match[1] };
      for (const setting of settings) {
        if (setting.key === match[1] || setting.key.startsWith(match[1] + '.')) setting.uses.push(use);
      }
    }
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      const name = match[1] ?? match[2];
      const line = lineAt(text, match.index);
      const use = { file, line, id: nodeAt(graph, file, line), key: name };
      const setting = byEnv.get(name);
      if (setting) {
        if (file !== schemaFile) setting.uses.push(use);
        continue;
      }
      if (!envOnly.has(name)) {
        envOnly.set(name, { key: name, doc: '', default: '', env: name, sensitive: /SECRET|PASSWORD|TOKEN|KEY/.test(name),
          varies: false, file, line, uses: [], setIn: [] });
      }
      envOnly.get(name).uses.push(use);
    }
  }
  const all = [...settings, ...[...envOnly.values()].sort((a, b) => a.key.localeCompare(b.key))];
  const withEnv = new Map();
  for (const setting of all) if (setting.env) withEnv.set(setting.env, setting);
  const sources = envFiles(root);
  for (const file of sources) {
    const text = readText(root, file);
    text.split(/\r?\n/).forEach((row, index) => {
      const match = /^\s*(?:-\s*)?(?:export\s+|ENV\s+|ARG\s+)?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.*)$/.exec(row);
      const setting = match && withEnv.get(match[1]);
      if (!setting) return;
      const value = secretFile(file) || setting.sensitive ? null : short(match[2].trim().replace(/^['"]|['"]$/g, ''));
      setting.setIn.push({ file, line: index + 1, value });
    });
  }
  return { schema: schemaFile, envFiles: sources, settings: all };
}
