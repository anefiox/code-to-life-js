#!/usr/bin/env node
import fs from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { analyze, projectRoot } from '../lib/project.mjs';
import { graphChanges } from '../lib/graph-changes.mjs';
import { configuredDebugger, debugOptions } from '../lib/debug.mjs';
import { servePlan } from '../lib/plan.mjs';
import { browserDebugger, browserOptions } from '../lib/browser-debug.mjs';
import { ExplainError, explanationQueue, explanationsFor, projectGlossary, readSource, saveExplanation } from '../lib/explain.mjs';
import { aiConfig, aiOptions, askAi, explanationPrompt } from '../lib/ai.mjs';
import { glossaryFor } from '../lib/glossary.mjs';
import { readProjectFile, readTemplate, routeFlows, startTour } from '../lib/learn.mjs';
import { recipes } from '../lib/recipes.mjs';
import { settingsMap } from '../lib/settings.mjs';
import { templateMap } from '../lib/templates.mjs';
import { conceptsFor } from '../lib/concepts.mjs';
import { testExamples } from '../lib/examples.mjs';
import { hotspots, nodeHistory } from '../lib/history.mjs';
import { folderNotesFor } from '../lib/folders.mjs';
import { onboardingGuide } from '../lib/onboarding.mjs';
import { askPrompt, askSources } from '../lib/ask.mjs';

const usage = [
  'Usage: codetolife-js [project] [--port PORT | --json]',
  '       codetolife-js [project] --debug-entry FILE [--break FILE:LINE] [--debug-arg ARG]',
  '       codetolife-js [project] --browser-port PORT --browser-url URL [--break FILE:LINE]',
  '       codetolife-js [project] --ai openrouter|URL [--ai-model MODEL]',
  '       codetolife-js explain [project] --ai openrouter|URL [--ai-model MODEL] [--limit N]',
  '       codetolife-js guide [project] [--out FILE]',
  '       codetolife-js check [project]'
].join('\n');
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/plan.js', ['plan.js', 'text/javascript']],
  ['/learn.js', ['learn.js', 'text/javascript']],
  ['/guide.js', ['guide.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/cytoscape.min.js', ['cytoscape.min.js', 'text/javascript']]
]);

function serve(root, port, debug, ai) {
  const allowed = new Set();
  let graph = analyze(root);
  // Ask the model one question at a time; local servers usually run one model.
  let aiQueue = Promise.resolve();
  const explainWithAi = id => {
    const run = aiQueue.then(async () => {
      const { messages } = explanationPrompt(root, graph, id);
      return saveExplanation(root, graph, id, await askAi(ai, messages));
    });
    aiQueue = run.catch(() => {});
    return run;
  };
  const askWithAi = question => {
    const run = aiQueue.then(async () => {
      const { messages, sources } = askPrompt(root, graph, question);
      return { answer: await askAi(ai, messages, { maxTokens: 1200 }), sources };
    });
    aiQueue = run.catch(() => {});
    return run;
  };
  const json = (res, value) => res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
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
      if (url.pathname === '/api/explain') {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        if (req.headers.origin !== 'http://' + req.headers.host) {
          res.writeHead(403).end();
          return;
        }
        if (!ai) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('Start Code to Life with --ai to write explanations here.');
          return;
        }
        try {
          const saved = await explainWithAi(url.searchParams.get('id') ?? '');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(saved));
        } catch (error) {
          if (error instanceof ExplainError) throw error;
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
        }
        return;
      }
      if (url.pathname === '/api/ask') {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        if (req.headers.origin !== 'http://' + req.headers.host || !/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
          res.writeHead(403).end();
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) {
            res.writeHead(413).end();
            return;
          }
        }
        let question;
        try {
          question = JSON.parse(body).question;
        } catch {
          throw new ExplainError('Send JSON like {"question": "…"}.');
        }
        if (!ai) {
          const { sources } = askSources(root, graph, question);
          json(res, { answer: null, sources: sources.map(node => ({ id: node.id, name: node.name, file: node.file, kind: node.kind })) });
          return;
        }
        try {
          json(res, await askWithAi(question));
        } catch (error) {
          if (error instanceof ExplainError) throw error;
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
        }
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
      if (url.pathname === '/api/source') {
        const source = readSource(root, graph, url.searchParams.get('id') ?? '');
        source.glossary = glossaryFor(source.packages);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(source));
        return;
      }
      if (url.pathname === '/api/learn') {
        json(res, { tour: startTour(root, graph), pages: routeFlows(root, graph), folderNotes: folderNotesFor(graph) });
        return;
      }
      if (url.pathname === '/api/recipes') {
        json(res, { recipes: recipes(root, graph) });
        return;
      }
      if (url.pathname === '/api/settings') {
        json(res, settingsMap(root, graph));
        return;
      }
      if (url.pathname === '/api/templates') {
        json(res, templateMap(root, graph));
        return;
      }
      if (url.pathname === '/api/file') {
        json(res, readProjectFile(root, url.searchParams.get('file')));
        return;
      }
      if (url.pathname === '/api/examples') {
        json(res, testExamples(root, graph, url.searchParams.get('id') ?? ''));
        return;
      }
      if (url.pathname === '/api/history') {
        const id = url.searchParams.get('id');
        json(res, id ? nodeHistory(root, graph, id) : hotspots(root, graph));
        return;
      }
      if (url.pathname === '/api/onboarding') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(onboardingGuide(root, graph));
        return;
      }
      if (url.pathname === '/api/template') {
        const body = JSON.stringify(readTemplate(root, url.searchParams.get('file')));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
        return;
      }
      if (url.pathname === '/api/explanations') {
        const body = JSON.stringify({
          explanations: explanationsFor(root, graph), glossary: projectGlossary(root), concepts: conceptsFor(root),
          ai: ai ? { label: ai.label, model: ai.model } : null
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
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
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error instanceof ExplainError) {
        res.writeHead(error.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
        return;
      }
      res.writeHead(500,{ 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
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
    if (ai) console.log('Explanations by ' + ai.label + ' · model ' + ai.model);
  });
}

// Explains the most connected files and functions that have no explanation yet.
async function explainProject(root, ai, limitValue = '10') {
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit must be an integer from 1 through 500.');
  const graph = analyze(root);
  const queue = explanationQueue(root, graph);
  const batch = queue.slice(0, limit);
  console.log('Explaining ' + batch.length + ' of ' + queue.length + ' with ' + ai.label + ' (model ' + ai.model + ')…');
  let failures = 0;
  for (const [index, { node }] of batch.entries()) {
    const label = '[' + (index + 1) + '/' + batch.length + '] ' + (node.kind === 'module' ? node.file : node.file + ' › ' + node.name);
    try {
      const { messages } = explanationPrompt(root, graph, node.id);
      saveExplanation(root, graph, node.id, await askAi(ai, messages));
      console.log(label);
    } catch (error) {
      failures++;
      console.error(label + ' failed: ' + error.message);
      if (failures >= 3 && failures === index + 1) throw new Error('Stopping after 3 failures in a row.');
    }
  }
  console.log('Saved to .codetolife/explanations.json. ' + (queue.length - batch.length + failures) + ' still to explain.');
  if (failures) process.exitCode = 1;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      limit: { type: 'string' }, out: { type: 'string' }, ...debugOptions, ...browserOptions, ...aiOptions
    }
  });
  if (values.help) {
    console.log(usage);
  } else {
    const check = positionals[0] === 'check';
    const bulk = positionals[0] === 'explain';
    const guide = positionals[0] === 'guide';
    const args = check || bulk || guide ? positionals.slice(1) : positionals;
    if (values.out !== undefined && !guide) throw new Error(usage);
    const ai = aiConfig(values);
    if ((check || values.json) && ai) throw new Error(usage);
    if (values.limit !== undefined && !bulk) throw new Error(usage);
    if (bulk && (values.port !== undefined || values.json ||
        Object.keys({ ...debugOptions, ...browserOptions }).some(key => values[key] !== undefined))) {
      throw new Error(usage);
    }
    if (args.length > 1 || (values.port !== undefined && (check || values.json))) throw new Error(usage);
    if ((check || values.json) && Object.keys({ ...debugOptions, ...browserOptions }).some(key => values[key] !== undefined)) {
      throw new Error(usage);
    }
    const root = projectRoot(args[0]);
    if (guide) {
      if (args.length > 1 || values.port !== undefined || values.json || ai) throw new Error(usage);
      const text = onboardingGuide(root, analyze(root));
      if (values.out) {
        fs.writeFileSync(values.out, text);
        console.log('Wrote ' + values.out + '.');
      } else {
        process.stdout.write(text);
      }
    } else if (bulk) {
      if (!ai) throw new Error('explain needs --ai openrouter or --ai URL.');
      await explainProject(root, ai, values.limit);
    } else if (check || values.json) {
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
      serve(root, port, browser ? browserDebugger(root, values) : configuredDebugger(root, values), ai);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
