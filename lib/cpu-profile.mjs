import { frameMapper } from './runtime-frames.mjs';

export function profileSamples(profile, locate) {
  const counts = new Map();
  for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  let samples = 0;
  const frames = [];
  for (const node of profile.nodes) {
    const hits = profile.samples ? counts.get(node.id) ?? 0 : node.hitCount ?? 0;
    samples += hits;
    if (!hits) continue;
    const { file, line } = locate(node.callFrame);
    if (file) {
      frames.push({ name: node.callFrame.functionName || '(anonymous)', file, line, samples: hits });
    }
  }
  return { samples, durationMs: Math.round((profile.endTime - profile.startTime) / 1000), frames };
}

export function mapProfile(graph, profile) {
  const mapFrame = frameMapper(graph, profile.frames);
  const symbols = new Map();
  const modules = new Map();
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  let projectSamples = 0;
  function count(target, id, amount) {
    if (!id) return;
    const item = target.get(id);
    if (item) item.samples += amount;
    else {
      const node = nodes.get(id);
      target.set(id, { id, name: node.name, file: node.file, samples: amount });
    }
  }
  for (const frame of profile.frames) {
    const { nodeId, moduleId } = mapFrame(frame);
    if (!moduleId) continue;
    projectSamples += frame.samples;
    count(modules, moduleId, frame.samples);
    if (nodeId !== moduleId) count(symbols, nodeId, frame.samples);
  }
  const ranked = items => [...items.values()].sort((a, b) => b.samples - a.samples || a.id.localeCompare(b.id));
  return {
    durationMs: profile.durationMs, samples: profile.samples, projectSamples,
    modules: ranked(modules), symbols: ranked(symbols)
  };
}
