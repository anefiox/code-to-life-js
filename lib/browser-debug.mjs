import fs from 'node:fs';
import path from 'node:path';
import { TraceMap, originalPositionFor, allGeneratedPositionsFor } from '@jridgewell/trace-mapping';
import { Inspector, NodeDebugger } from './debug.mjs';
import { projectFile } from './runtime-frames.mjs';

export const browserOptions = {
  'browser-port': { type: 'string' },
  'browser-url': { type: 'string' }
};

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password) throw new Error('Supply a loopback frontend URL, such as http://localhost:5173/.');
  return url;
}

export function browserDebugger(root, values) {
  const port = Number(values['browser-port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--browser-port must be a TCP port.');
  if (values['debug-entry'] !== undefined || values['debug-arg'] || !values['browser-url']) {
    throw new Error('Browser mode requires --browser-url and uses its own target.');
  }
  return new BrowserDebugger(root, port, httpUrl(values['browser-url']), values.break ?? []);
}

class BrowserDebugger extends NodeDebugger {
  constructor(root, port, target, breakpoints) {
    super(root, null, [], breakpoints);
    this.port = port;
    this.target = target;
  }

  localFile(value) {
    const file = projectFile(this.root, value);
    if (file) return file;
    try {
      const url = new URL(value);
      if (url.origin !== this.target.origin) return null;
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return null;
      const direct = pathname.startsWith('/@fs/') ? path.resolve(pathname.slice(5)) :
        path.resolve(this.root, '.' + pathname);
      const relative = path.relative(this.root, direct);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
      return fs.statSync(direct, { throwIfNoEntry: false })?.isFile() ? relative.split(path.sep).join('/') : null;
    } catch {
      return null;
    }
  }

  async loadMap(script) {
    if (!script.sourceMapURL) return null;
    const url = new URL(script.sourceMapURL, script.url);
    const generated = new URL(script.url);
    if (generated.origin !== this.target.origin ||
        (url.protocol !== 'data:' && url.origin !== this.target.origin) || url.href.length > 16 * 1024 * 1024) return null;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const base = url.protocol === 'data:' ? script.url : url.href;
    return new TraceMap(JSON.parse(Buffer.concat(chunks).toString('utf8')), base);
  }

  async registerScript(session, script) {
    try {
      script.map = await this.loadMap(script);
    } catch {
      // A missing, invalid, or inaccessible map leaves generated locations available.
    }
    if (this.session !== session || session.browserScripts.get(script.scriptId) !== script) return;
    const relative = file => path.relative(this.root, file).split(path.sep).join('/');
    const locations = new Map();
    for (const point of this.breakpoints) {
      const file = relative(point.file);
      if (script.map) {
        for (const source of script.map.resolvedSources) {
          if (this.localFile(source) !== file) continue;
          const match = allGeneratedPositionsFor(script.map, { source, line: point.line })
            .find(position => originalPositionFor(script.map, position).line === point.line);
          if (match) locations.set(file + ':' + point.line, { lineNumber: match.line - 1, columnNumber: match.column });
        }
      } else if (this.localFile(script.url) === file) {
        locations.set(file + ':' + point.line, { lineNumber: point.line - 1 });
      }
    }
    for (const [key, location] of locations) {
      if (this.session !== session) return;
      try {
        const result = await session.inspector.send('Debugger.setBreakpoint', { location: { scriptId: script.scriptId, ...location } });
        if (result.actualLocation.lineNumber === location.lineNumber) session.bound.add(key);
      } catch {
        // The script may have been replaced by navigation or a hot reload.
      }
    }
  }

  onEvent(session, method, params) {
    if (this.session !== session) return;
    super.onEvent(session, method, params);
    if (method === 'Debugger.globalObjectCleared') {
      session.scripts.clear();
      session.browserScripts.clear();
      session.bound.clear();
    }
    if (method === 'Debugger.scriptParsed' && params.url) {
      const script = { ...params };
      session.browserScripts.set(params.scriptId, script);
      script.ready = this.registerScript(session, script);
    }
  }

  frameLocation(session, url, location) {
    const script = session.browserScripts.get(location.scriptId);
    if (script?.map && location.lineNumber >= 0) {
      const source = originalPositionFor(script.map, { line: location.lineNumber + 1, column: location.columnNumber ?? 0 });
      const file = this.localFile(source.source ?? '');
      if (file) return { file, line: source.line, column: source.column + 1 };
    }
    return { file: this.localFile(url ?? ''), line: location.lineNumber + 1, column: (location.columnNumber ?? 0) + 1 };
  }


  async start() {
    if (this.session) throw new Error('Disconnect the current browser session first.');
    this.status = 'starting';
    this.frames = [];
    this.profile = null;
    this.mappedProfile = null;
    this.profileMessage = '';
    this.message = '';
    const session = { scripts: new Map(), browserScripts: new Map(), bound: new Set() };
    this.session = session;
    try {
      const response = await fetch('http://127.0.0.1:' + this.port + '/json/list', {
        redirect: 'error', signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) throw new Error('Chromium target discovery failed.');
      const targets = (await response.json()).filter(tab => tab.type === 'page' && tab.url === this.target.href);
      if (targets.length !== 1) throw new Error('Open exactly one Chromium tab at ' + this.target.href);
      const endpoint = new URL(targets[0].webSocketDebuggerUrl);
      if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
          Number(endpoint.port) !== this.port || !/^\/devtools\/page\/[a-z0-9-]+$/i.test(endpoint.pathname) ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('Chromium returned an unexpected debugging endpoint.');
      }
      session.inspector = new Inspector('ws://127.0.0.1:' + this.port + endpoint.pathname,
        (method, params) => this.onEvent(session, method, params), () => this.detach(session));
      await session.inspector.send('Debugger.enable');
      await Promise.all([...session.browserScripts.values()].map(script => script.ready));
      if (this.session !== session) throw new Error('Chromium disconnected during attachment.');
      if (this.status === 'starting') this.status = 'running';
    } catch (error) {
      this.stop();
      this.status = 'error';
      this.message = error.message;
      throw error;
    }
  }

  detach(session) {
    if (this.session !== session) return;
    this.session = null;
    this.frames = [];
    this.rawFrames = [];
    this.discardRecording('Disconnected before the recording could be collected.');
    this.status = 'exited';
    this.message = 'Disconnected from Chromium.';
  }

  stop() {
    if (!this.session) return;
    const session = this.session;
    this.detach(session);
    session.inspector?.close();
  }

  snapshot(graph) {
    if (this.session && this.status === 'paused') this.frames = this.resolveFrames(this.session, this.rawFrames);
    const snapshot = super.snapshot(graph);
    return { ...snapshot, target: 'browser', entry: this.target.href, breakpoints: snapshot.breakpoints.map(point => ({
      ...point, bound: this.session?.bound.has(point.file + ':' + point.line) ?? false
    })) };
  }
}
