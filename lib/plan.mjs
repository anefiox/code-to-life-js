import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';

const limit = 256 * 1024;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class PlanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validPath(value) {
  return typeof value === 'string' && value.length <= 240 && value.split('/').every(part =>
    /^[A-Za-z0-9_@.-]+$/.test(part) && !part.endsWith('.') && !reserved.test(part));
}

function normalize(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.modules) || plan.modules.length > 100) {
    throw new PlanError('Expected a version 1 plan with up to 100 modules.');
  }
  const known = new Set();
  const modules = plan.modules.map(item => {
    if (!validPath(item?.file) || !/\.(?:ts|tsx)$/.test(item.file) || /\.d\.ts$/.test(item.file)) {
      throw new PlanError('Proposed modules need a project-relative .ts or .tsx path.');
    }
    const key = item.file.toLowerCase();
    if (known.has(key)) throw new PlanError('Duplicate module: ' + item.file);
    known.add(key);
    if (typeof item.name !== 'string' || !/^[A-Za-z_$][\w$]{0,79}$/.test(item.name) ||
        ts.stringToToken(item.name) !== undefined) {
      throw new PlanError('Supply a TypeScript identifier for the export name.');
    }
    if (item.kind !== 'function' && item.kind !== 'component') throw new PlanError('Unknown module kind.');
    if (item.kind === 'component' && (!item.file.endsWith('.tsx') || !/^[A-Z]/.test(item.name))) {
      throw new PlanError('A component needs a .tsx path and an export name starting with a capital letter.');
    }
    if (typeof item.note !== 'string' || item.note.length > 3000) throw new PlanError('Notes can be up to 3,000 characters.');
    if (!Array.isArray(item.dependencies) || item.dependencies.length > 50 ||
        item.dependencies.some(file => !validPath(file) || file.toLowerCase() === key)) {
      throw new PlanError('Dependencies must be project-relative paths to other modules.');
    }
    return { file: item.file, name: item.name, kind: item.kind, note: item.note,
      dependencies: [...new Set(item.dependencies)] };
  });
  return { version: 1, modules };
}

function stat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function planLocation(root) {
  const dir = path.join(root, '.codetolife');
  const dirStat = stat(dir);
  if (dirStat && !dirStat.isDirectory()) throw new PlanError('.codetolife must be a local directory.');
  const file = path.join(dir, 'plan.json');
  const fileStat = stat(file);
  if (fileStat && !fileStat.isFile()) throw new PlanError('plan.json must be a regular file.');
  if (fileStat?.size > limit) throw new PlanError('plan.json is too large.');
  return { dir, file, exists: Boolean(fileStat) };
}

function revision(text) {
  return createHash('sha256').update(text).digest('hex');
}

function loadPlan(root) {
  const { file, exists } = planLocation(root);
  if (!exists) return { version: 1, modules: [], revision: null };
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlanError('Existing plan.json contains invalid JSON.');
  }
  return { ...normalize(parsed), revision: revision(raw) };
}

function savePlan(root, input) {
  const plan = normalize(input);
  if (input.revision !== loadPlan(root).revision) {
    throw new PlanError('The plan changed on disk. Reload it before saving.', 409);
  }
  const encoded = JSON.stringify(plan, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > limit) throw new PlanError('The plan is too large.', 413);
  const { dir, file } = planLocation(root);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, '.plan-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, encoded, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { ...plan, revision: revision(encoded) };
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new PlanError('The plan is too large.', 413);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PlanError('Expected a JSON plan.');
  }
}

export async function servePlan(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.writeHead(405, { Allow: 'GET, PUT' }).end();
    return;
  }
  if (req.method === 'PUT' && req.headers.origin !== 'http://' + req.headers.host) {
    res.writeHead(403).end();
    return;
  }
  try {
    const plan = req.method === 'GET' ? loadPlan(root) : savePlan(root, await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(plan));
  } catch (error) {
    if (!(error instanceof PlanError)) throw error;
    res.writeHead(error.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
  }
}
