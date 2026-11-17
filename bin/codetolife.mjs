#!/usr/bin/env node
import fs from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { analyze, projectRoot } from '../lib/project.mjs';
import { graphChanges } from '../lib/graph-changes.mjs';
import { configuredDebugger, debugOptions } from '../lib/debug.mjs';
import { servePlan } from '../lib/plan.mjs';
import { browserDebugger, browserOptions } from '../lib/browser-debug.mjs';

const usage = [
  'Usage: codetolife-js [project] [--port PORT | --json]',
  '       codetolife-js [project] --debug-entry FILE [--break FILE:LINE] [--debug-arg ARG]',
  '       codetolife-js [project] --browser-port PORT --browser-url URL [--break FILE:LINE]',
  '       codetolife-js check [project]'
].join('\n');
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/plan.js', ['plan.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/cytoscape.min.js', ['cytoscape.min.js', 'text/javascript']]
]);

function serve(root, port, debug) {
  const allowed = new Set();
  let graph = analyze(root);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');

    if (!allowed.has(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/plan') {
        await servePlan(root, req, res);
        return;
      }
      if (url.pathname === '/api/debug') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.writeHead(405, { Allow: 'GET, POST' }).end();
          return;
        }
        if (req.method === 'POST' && req.headers.origin !== 'http://' + req.headers.host) {
          res.writeHead(403).end();
          return;
        }
        if (!debug && req.method === 'POST') {
          res.writeHead(404).end();
          return;
        }
        if (req.method === 'POST') await debug.perform(url.searchParams.get('action'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(debug?.snapshot(graph) ?? null));
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      if (url.pathname === '/api/graph') {
        if (url.searchParams.get('refresh') === '1') graph = analyze(root);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(graph));
        return;
      }
      if (url.pathname === '/api/changes') {
        const base = url.searchParams.get('base')?.trim() || undefined;
        const current = analyze(root);
        const changes = graphChanges(current, base);
        graph = current;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ graph, changes }));
        return;
      }
      const asset = assets.get(url.pathname);
      if (!asset) {
        res.writeHead(404).end();
        return;
      }
      const [file, type] = asset;
      const data = fs.readFileSync(new URL('../web/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(data);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
    }
  });
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 2;
  });
  if (debug) {
    process.once('exit', () => debug.stop());
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
  }
  server.listen(port, '127.0.0.1', () => {
    const running = server.address().port;
    allowed.add('127.0.0.1:' + running);
    allowed.add('localhost:' + running);
    console.log('Code to Life · http://127.0.0.1:' + running);
  });
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      ...debugOptions, ...browserOptions
    }
  });
  if (values.help) {
    console.log(usage);
  } else {
    const check = positionals[0] === 'check';
    const args = check ? positionals.slice(1) : positionals;
    if (args.length > 1 || (values.port !== undefined && (check || values.json))) throw new Error(usage);
    if ((check || values.json) && Object.keys({ ...debugOptions, ...browserOptions }).some(key => values[key] !== undefined)) {
      throw new Error(usage);
    }
    const root = projectRoot(args[0]);
    if (check || values.json) {
      const graph = analyze(root);
      if (values.json) console.log(JSON.stringify(graph, null, 2));
      else {
        for (const violation of graph.violations) {
          console.log(violation.file + ':' + violation.lines[0] + ' ' + violation.kind + ' ' + violation.target +
            (violation.because ? ' · ' + violation.because : ''));
        }
        console.log(graph.violations.length + ' architecture violations.');
      }
      if (check && graph.violations.length) process.exitCode = 1;
    } else {
      const port = Number(values.port ?? 5170);
      if (!Number.isInteger(port) || port < 0 || port > 65535 || values.port === '') {
        throw new Error('--port must be an integer from 0 through 65535.');
      }
      const browser = values['browser-port'] !== undefined || values['browser-url'] !== undefined;
      serve(root, port, browser ? browserDebugger(root, values) : configuredDebugger(root, values));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
