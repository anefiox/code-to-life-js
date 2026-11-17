#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { analyze, projectRoot } from '../lib/project.mjs';
import { GraphQueries } from '../lib/graph-queries.mjs';
import { graphChanges } from '../lib/graph-changes.mjs';
import { configuredDebugger, debugOptions } from '../lib/debug.mjs';

const selector = z.string().trim().min(1).max(4096).describe('Exact graph node ID, symbol name, or project-relative file.');
const count = z.number().int().min(1).max(100).default(25);
const offset = z.number().int().min(0).default(0);
const paging = { limit: count, offset };
const depth = z.number().int().min(1).max(30).default(8);

function page(items, { limit, offset }) {
  return { total: items.length, offset, items: items.slice(offset, offset + limit) };
}

function result(data, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function createServer(root, debug) {
  let queries;
  const server = new McpServer({ name: 'codetolife-js', version: '0.1.0' });
  const graph = () => queries ??= new GraphQueries(analyze(root));
  function tool(name, description, input, handler, readOnly = true) {
    server.registerTool(name, {
      description, inputSchema: z.object(input).strict(),
      annotations: readOnly ?
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } :
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      try {
        const value = await handler(args);
        return result(value, Boolean(value.error));
      } catch (error) {
        return result({ error: error.message }, true);
      }
    });
  }

  function overview({ refresh }) {
    if (refresh) queries = new GraphQueries(analyze(root));
    const { nodes, edges, tests, violations, warnings } = graph().graph;
    const modules = nodes.filter(node => node.kind === 'module').length;
    return { root, modules, declarations: nodes.length - modules, edges: edges.length,
      tests: tests.length, violations: violations.length, warnings };
  }
  tool('overview', 'Summarize one JS/TS project. Set refresh to rebuild the static graph after source edits.',
    { refresh: z.boolean().default(false) }, overview);

  tool('find', 'Search files and symbols. Pass the returned node ID to other tools to disambiguate.',
    { query: selector, ...paging }, ({ query, ...options }) => page(graph().find(query), options));

  function single(args, handler) {
    const index = graph();
    const resolved = index.resolve(args.node);
    return resolved.error ? resolved : handler(index, resolved.node);
  }

  tool('describe', 'Describe a graph node and list its immediate incoming and outgoing relationships.',
    { node: selector, ...paging }, args => single(args, (index, node) => ({
      node,
      incoming: page(index.neighbors(node.id, 'in').map(edge => index.relationship(edge, 'in')), args),
      outgoing: page(index.neighbors(node.id, 'out').map(edge => index.relationship(edge, 'out')), args)
    })));

  for (const [name, direction, description] of [
    ['callers', 'in', 'Find direct callers and components that create or render this symbol.'],
    ['callees', 'out', 'Find symbols that this declaration directly calls, creates, or renders.']
  ]) {
    tool(name, description, { node: selector, ...paging }, args => single(args, (index, node) => ({
      node, ...page(index.neighbors(node.id, direction, true).map(edge => index.relationship(edge, direction)), args)
    })));
  }

  tool('path_between', 'Find a shortest directed static call, creation, or JSX render path between two nodes.',
    { from: selector, to: selector, maxDepth: depth }, ({ from, to, maxDepth }) => {
      const index = graph();
      const start = index.resolve(from);
      if (start.error) return start;
      const end = index.resolve(to);
      if (end.error) return end;
      return { from: start.node, to: end.node, steps: index.path(start.node.id, end.node.id, maxDepth) };
    });

  tool('impact', 'List upstream static dependencies by distance, excluding declaration containment.',
    { node: selector, maxDepth: depth, ...paging }, args => single(args, (index, node) => ({
      node, ...page(index.impact(node.id, args.maxDepth), args)
    })));

  tool('tests_for', 'Find test files that reach the symbol through statically resolved calls, construction, or JSX.',
    { node: selector, ...paging }, args => single(args, (index, node) => ({
      node, ...page(index.testsFor(node.id), args)
    })));

  tool('check_architecture', 'List violations of the project architecture rules.',
    paging, args => page(graph().graph.violations, args));

  tool('what_changed', 'Review committed and uncommitted work against the merge base using PR Buddy. Refreshes the graph.',
    { base: selector.optional(), ...paging }, ({ base, ...options }) => {
      queries = new GraphQueries(analyze(root));
      const { baseline, files } = graphChanges(queries.graph, base);
      return { baseline, ...page(files, options) };
    });

  if (debug) {
    const snapshot = () => debug.snapshot(graph().graph);
    const waitMs = z.number().int().min(0).max(5000).default(1000);
    let runningCommand = false;

    async function command(action, timeout) {
      if (runningCommand) throw new Error('A debugger command is in progress.');
      runningCommand = true;
      try {
        graph();
        const pauseCount = debug.pauseCount;
        await debug.perform(action);
        if (timeout) {
          const deadline = Date.now() + timeout;
          const terminal = ['idle', 'error', 'exited'];
          while (!terminal.includes(debug.status) && (action === 'stop' || debug.pauseCount === pauseCount) &&
              Date.now() < deadline) {
            await delay(25);
          }
        }
        return snapshot();
      } finally {
        runningCommand = false;
      }
    }

    tool('debug_launch', 'Run the Node script configured at server launch and wait briefly for the startup pause.',
      { waitMs }, ({ waitMs }) => command('start', waitMs), false);
    tool('debug_step', 'Step over, into, or out from a pause. Returns the session state and mapped stack.',
      { direction: z.enum(['over', 'into', 'out']), waitMs },
      ({ direction, waitMs }) => command(direction, waitMs), false);
    tool('debug_continue', 'Resume the paused script and wait briefly for its next pause or exit.',
      { waitMs }, ({ waitMs }) => command('continue', waitMs), false);
    tool('debug_pause', 'Pause the running script and return the mapped stack when available.',
      { waitMs }, ({ waitMs }) => command('pause', waitMs), false);
    tool('debug_where', 'Read session state, configured breakpoints, recent process output, and the mapped paused stack.',
      {}, snapshot);
    tool('debug_stop', 'Terminate the Node process launched by this MCP server.',
      { waitMs }, ({ waitMs }) => command('stop', waitMs), false);
  }

  return server;
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: debugOptions });
  if (positionals.length > 1) {
    throw new Error('Usage: codetolife-js-mcp [project] [--debug-entry FILE] [--break FILE:LINE] [--debug-arg ARG]');
  }
  const root = projectRoot(positionals[0]);
  const debug = configuredDebugger(root, values);
  if (debug) {
    const stop = () => debug.stop();
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
    process.once('exit', stop);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
  }
  serveStdio(() => createServer(root, debug));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
