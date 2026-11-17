import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { portable } from './source.mjs';
import { frameMapper, projectFile } from './runtime-frames.mjs';
import { mapProfile, profileSamples } from './cpu-profile.mjs';

export const debugOptions = {
  'debug-entry': { type: 'string' }, 'debug-arg': { type: 'string', multiple: true },
  break: { type: 'string', multiple: true }
};

export function configuredDebugger(root, values) {
  const entry = values['debug-entry'];
  if (entry === undefined) {
    if (values.break || values['debug-arg']) throw new Error('--break and --debug-arg require --debug-entry.');
    return null;
  }
  if (!entry.trim()) throw new Error('--debug-entry requires a script path.');
  return new NodeDebugger(root, entry, values['debug-arg'] ?? [], values.break ?? []);
}

const actions = new Map([
  ['continue', 'Debugger.resume'], ['pause', 'Debugger.pause'],
  ['over', 'Debugger.stepOver'], ['into', 'Debugger.stepInto'], ['out', 'Debugger.stepOut']
]);

function sourceFile(root, file) {
  const full = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      !fs.statSync(full).isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(full)) {
    throw new Error('Choose a JavaScript or TypeScript file inside the project.');
  }
  return full;
}

export class Inspector {
  constructor(url, event, disconnected) {
    this.socket = new WebSocket(url);
    this.requests = new Map();
    this.next = 0;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timed out.')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to the debugger.'));
      }, { once: true });
      this.socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('The debugger disconnected.'));
        for (const { reject: fail } of this.requests.values()) fail(new Error('The debugger disconnected.'));
        disconnected();
      }, { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const request = this.requests.get(message.id);
      if (request) {
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method) {
        event(message.method, message.params);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('The debugger disconnected.');
    const id = ++this.next;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(method + ' timed out.')), 5000);
        this.requests.set(id, { resolve, reject });
        this.socket.send(JSON.stringify({ id, method, params }));
      });
    } finally {
      clearTimeout(timer);
      this.requests.delete(id);
    }
  }

  close() { this.socket.close(); }
}

export class NodeDebugger {
  constructor(root, entry, args, breakpoints) {
    this.root = root;
    this.entry = entry === null ? null : sourceFile(root, entry);
    this.args = args;
    this.breakpoints = breakpoints.map(value => {
      const match = /^(.*):([1-9][0-9]*)$/.exec(value);
      if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Breakpoints use file:line.');
      return { file: sourceFile(root, match[1]), line: Number(match[2]) };
    });
    this.session = null;
    this.status = 'idle';
    this.frames = [];
    this.message = '';
    this.output = '';
    this.busy = false;
    this.pauseCount = 0;
    this.recording = false;
    this.profile = null;
    this.profileMessage = '';
    this.profileTimer = null;
  }

  log(text) {
    this.output = (this.output + text).slice(-12000);
  }

  onEvent(session, method, params) {
    if (this.session !== session || this.status === 'stopping') return;
    if (method === 'Debugger.scriptParsed') session.scripts.set(params.scriptId, params.url);
    if (method === 'Debugger.resumed') {
      this.status = 'running';
      this.frames = [];
    }
    if (method === 'Debugger.paused') {
      this.pauseCount++;
      this.status = 'paused';
      this.rawFrames = params.callFrames.slice(0, 48);
      this.frames = this.resolveFrames(session, this.rawFrames);
    }
  }

  frameLocation(session, url, location) {
    return {
      file: projectFile(this.root, url),
      line: location.lineNumber + 1, column: (location.columnNumber ?? 0) + 1
    };
  }

  resolveFrames(session, frames) {
    return frames.map(frame => ({
      name: frame.functionName || '(anonymous)',
      ...this.frameLocation(session, session.scripts.get(frame.location.scriptId) || frame.url, frame.location)
    }));
  }

  async start() {
    if (this.session) throw new Error('Stop the current debug session first.');
    this.status = 'starting';
    this.frames = [];
    this.message = '';
    this.output = '';
    this.profile = null;
    this.profileMessage = '';
    this.profileGraph = null;
    this.mappedProfile = null;
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', this.entry, ...this.args], {
      cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const session = { child, inspector: null, scripts: new Map() };
    this.session = session;

    try {
      const url = await new Promise((resolve, reject) => {
        let stderr = '';
        let endpointFound = false;
        let waitingTail = '';
        const timer = setTimeout(() => reject(new Error('Node did not start its inspector.')), 5000);
        child.stdout.setEncoding('utf8').on('data', text => this.log(text));
        child.stderr.setEncoding('utf8').on('data', text => {
          waitingTail = (waitingTail + text).slice(-512);
          if (waitingTail.includes('Waiting for the debugger to disconnect...')) session.inspector?.close();
          if (endpointFound) {
            this.log(text);
            return;
          }
          stderr = (stderr + text).slice(-12000);
          const match = /^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/m.exec(stderr);
          if (match) {
            endpointFound = true;
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        const finish = (message, error) => {
          clearTimeout(timer);
          reject(error ?? new Error(message));
          if (this.session !== session) return;
          session.inspector?.close();
          this.session = null;
          this.discardRecording('The process ended before the recording was collected.');
          this.status = error ? 'error' : 'exited';
          this.message = this.message || message;
          this.frames = [];
          if (!endpointFound && stderr) this.log(stderr);
        };
        child.once('error', error => finish(error.message, error));
        child.once('close', (code, signal) => finish(signal ? 'Process stopped (' + signal + ').' : 'Process exited with code ' + code + '.'));
      });

      if (this.session !== session || this.status === 'stopping') throw new Error('Debug launch stopped.');
      const inspector = new Inspector(url, (method, params) => this.onEvent(session, method, params), () => {
        if (this.session === session && ['starting', 'paused', 'running'].includes(this.status)) {
          this.discardRecording('The inspector disconnected before the recording was collected.');
          this.status = 'finishing';
          this.frames = [];
        }
      });
      session.inspector = inspector;
      await inspector.send('Debugger.enable');
      for (const breakpoint of this.breakpoints) {
        await inspector.send('Debugger.setBreakpointByUrl', {
          url: pathToFileURL(breakpoint.file).href, lineNumber: breakpoint.line - 1
        });
      }
      await inspector.send('Runtime.runIfWaitingForDebugger');
      if (this.session === session && this.status === 'starting') this.status = 'running';
    } catch (error) {
      this.message = error.message;
      this.stop();
      throw error;
    }
  }

  async startProfile() {
    if (this.recording || !['running', 'paused'].includes(this.status) || !this.session?.inspector) {
      throw new Error('Start a debug session before recording a CPU profile.');
    }
    const session = this.session;
    await session.inspector.send('Profiler.enable');
    await session.inspector.send('Profiler.setSamplingInterval', { interval: 1000 });
    await session.inspector.send('Profiler.start');
    if (this.session !== session || !['running', 'paused'].includes(this.status)) {
      throw new Error('The Node process exited before the recording could start.');
    }
    this.recording = true;
    this.profileMessage = '';
    this.profileTimer = setTimeout(() => this.autoStopProfile(), 30000);
  }

  autoStopProfile() {
    if (!this.recording) return;
    if (this.busy) {
      this.profileTimer = setTimeout(() => this.autoStopProfile(), 100);
      return;
    }
    this.perform('profile-stop').catch(error => this.discardRecording(error.message));
  }

  async stopProfile() {
    if (!this.recording || !this.session?.inspector) throw new Error('There is no CPU recording to collect.');
    try {
      const session = this.session;
      const { profile } = await session.inspector.send('Profiler.stop');
      this.profile = profileSamples(profile, frame =>
        this.frameLocation(session, session.scripts.get(frame.scriptId) || frame.url, frame));
      this.profileGraph = null;
      this.mappedProfile = null;
      this.profileMessage = '';
    } catch (error) {
      this.profileMessage = error.message;
      throw error;
    } finally {
      this.recording = false;
      clearTimeout(this.profileTimer);
    }
  }

  discardRecording(message) {
    if (!this.recording) return;
    this.recording = false;
    clearTimeout(this.profileTimer);
    this.profileMessage = message;
  }

  stop() {
    if (!this.session) return;
    this.discardRecording('The process was stopped before the recording was collected.');
    this.status = 'stopping';
    this.frames = [];
    this.session.child.kill();
    this.session.inspector?.close();
  }

  async perform(action) {
    if (this.busy) throw new Error('A debugger command is in progress.');
    this.busy = true;
    try {
      if (action === 'start') await this.start();
      else if (action === 'stop') this.stop();
      else if (action === 'profile-start') await this.startProfile();
      else if (action === 'profile-stop') await this.stopProfile();
      else {
        const expected = action === 'pause' ? 'running' : 'paused';
        if (!actions.has(action) || this.status !== expected || !this.session?.inspector) {
          throw new Error('This command is unavailable in the current debugger state.');
        }
        await this.session.inspector.send(actions.get(action));
      }
    } finally {
      this.busy = false;
    }
  }

  snapshot(graph) {
    const frames = this.frames.length ? this.frames.map(frameMapper(graph, this.frames)) : [];
    if (this.profile && this.profileGraph !== graph) {
      this.profileGraph = graph;
      this.mappedProfile = mapProfile(graph, this.profile);
    }
    return {
      entry: this.entry ? portable(path.relative(this.root, this.entry)) : '', status: this.status, busy: this.busy,
      message: this.message, output: this.output, frames,
      recording: this.recording, profile: this.mappedProfile, profileMessage: this.profileMessage,
      breakpoints: this.breakpoints.map(({ file, line }) => ({ file: portable(path.relative(this.root, file)), line }))
    };
  }
}
