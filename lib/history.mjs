// History and hotspots from Git: which files change most, who has worked on
// them, and the commits that last touched a file or function.
import { execFileSync } from 'node:child_process';
import { ExplainError } from './explain.mjs';

const logLimit = 3000;
const hotspotLimit = 15;
let cached = null;

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true
  });
}

function head(root) {
  try {
    return { head: git(root, ['rev-parse', 'HEAD']).trim(), prefix: git(root, ['rev-parse', '--show-prefix']).trim() };
  } catch {
    return null;
  }
}

const topAuthors = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
  .map(([name, commits]) => ({ name, commits }));

export function hotspots(root, graph, files = null) {
  const repo = head(root);
  if (!repo) return { available: false, reason: 'This folder is not a Git repository, or Git is not installed.' };
  const tests = new Set(graph.tests);
  const known = new Set(files ?? graph.nodes.filter(node => node.kind === 'module' && !tests.has(node.id)).map(node => node.file));
  const key = root + '\n' + repo.head + '\n' + [...known].sort().join('\n');
  if (cached?.key === key) return cached.value;
  let output = '';
  try {
    output = git(root, ['log', '--no-merges', '-n', String(logLimit), '--date=short', '--numstat',
      '--format=%x1e%h%x1f%an%x1f%ad%x1f%s', '--', '.']);
  } catch {
    return { available: false, reason: 'Git could not read the history.' };
  }
  const stats = new Map();
  let commits = 0;
  let first = null;
  let last = null;
  const people = new Set();
  for (const record of output.split('\x1e').slice(1)) {
    const [header, ...rows] = record.split('\n');
    const [, author, date] = header.split('\x1f');
    commits++;
    people.add(author);
    last ??= date;
    first = date;
    for (const row of rows) {
      const parts = row.split('\t');
      if (parts.length < 3) continue;
      let file = parts[2];
      // Renames look like "src/{old => new}/file.js".
      file = file.replace(/\{[^}]*? => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
      if (repo.prefix && file.startsWith(repo.prefix)) file = file.slice(repo.prefix.length);
      if (!known.has(file)) continue;
      if (!stats.has(file)) stats.set(file, { file, commits: 0, churn: 0, authors: new Map(), last: date });
      const entry = stats.get(file);
      entry.commits++;
      entry.churn += (Number(parts[0]) || 0) + (Number(parts[1]) || 0);
      entry.authors.set(author, (entry.authors.get(author) ?? 0) + 1);
    }
  }
  const files_ = [...stats.values()].sort((a, b) => b.commits - a.commits || b.churn - a.churn || a.file.localeCompare(b.file));
  const value = {
    available: true, commits, contributors: people.size, first, last, limited: commits >= logLimit,
    hotspots: files_.slice(0, hotspotLimit).map(entry => ({ ...entry, authors: topAuthors(entry.authors) })),
    byFile: Object.fromEntries(files_.map(entry => [entry.file, { commits: entry.commits, last: entry.last }]))
  };
  cached = { key, value };
  return value;
}

export function nodeHistory(root, graph, id) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new ExplainError('Unknown graph node.', 404);
  if (!head(root)) return { available: false, reason: 'This folder is not a Git repository, or Git is not installed.' };
  const format = '--format=%h%x1f%an%x1f%ad%x1f%s';
  const args = node.kind === 'module' ?
    ['log', '--no-merges', '-n', '8', '--date=short', format, '--follow', '--', node.file] :
    ['log', '--no-merges', '-n', '8', '--date=short', format, '-s', '-L', node.line + ',' + (node.endLine ?? node.line) + ':' + node.file];
  let output = '';
  try {
    output = git(root, args);
  } catch {
    return { available: true, commits: [], note: 'No commits yet: this code may be new or not committed.' };
  }
  const commits = output.split('\n').filter(line => line.includes('\x1f')).map(line => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
  const counts = new Map();
  for (const commit of commits) counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
  return { available: true, commits, authors: topAuthors(counts) };
}
