const executionKinds = new Set(['calls', 'creates', 'renders']);

export class GraphQueries {
  constructor(graph) {
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map(node => [node.id, node]));
    this.tests = new Set(graph.tests);
    this.incoming = new Map();
    this.outgoing = new Map();
    for (const edge of graph.edges) {
      if (!this.incoming.has(edge.to)) this.incoming.set(edge.to, []);
      if (!this.outgoing.has(edge.from)) this.outgoing.set(edge.from, []);
      this.incoming.get(edge.to).push(edge);
      this.outgoing.get(edge.from).push(edge);
    }
  }

  find(query) {
    const key = query.toLowerCase();
    const exact = [];
    const similar = [];
    for (const node of this.nodes.values()) {
      const name = node.name.toLowerCase();
      const file = node.file.toLowerCase();
      if (name === key || file === key && node.kind === 'module') exact.push(node);
      else if (name.includes(key) || file.includes(key)) similar.push(node);
    }
    return [...exact, ...similar];
  }

  resolve(query) {
    if (this.nodes.has(query)) return { node: this.nodes.get(query) };
    const matches = this.find(query);
    const exact = matches.filter(node => node.name === query);
    if (exact.length === 1) return { node: exact[0] };
    if (matches.length === 1) return { node: matches[0] };
    return { error: matches.length ? 'Multiple nodes match. Use a node ID from the matches.' : 'No graph node matches.',
      query, matches: matches.slice(0, 15) };
  }

  neighbors(id, direction, callsOnly = false) {
    const edges = direction === 'in' ? this.incoming : this.outgoing;
    return (edges.get(id) ?? []).filter(edge => !callsOnly || executionKinds.has(edge.kind));
  }

  relationship(edge, direction) {
    return { kind: edge.kind, lines: edge.lines,
      sourceFile: this.nodes.get(edge.from).file, node: this.nodes.get(direction === 'in' ? edge.from : edge.to) };
  }

  walk(start, direction, depth, filter) {
    const visited = new Map([[start, { distance: 0, edge: null }]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const { distance } = visited.get(id);
      if (distance >= depth) continue;
      for (const edge of this.neighbors(id, direction)) {
        if (!filter(edge)) continue;
        const next = direction === 'in' ? edge.from : edge.to;
        if (visited.has(next)) continue;
        visited.set(next, { distance: distance + 1, edge });
        queue.push(next);
      }
    }
    return visited;
  }

  path(from, to, depth) {
    const visited = this.walk(from, 'out', depth, edge => executionKinds.has(edge.kind));
    if (!visited.has(to)) return null;
    const steps = [];
    for (let id = to; id !== from;) {
      const { edge } = visited.get(id);
      steps.push(this.relationship(edge, 'out'));
      id = edge.from;
    }
    return steps.reverse();
  }

  impact(id, depth) {
    const visited = this.walk(id, 'in', depth, edge => edge.kind !== 'contains');
    visited.delete(id);
    return [...visited.values()].map(({ distance, edge }) => ({ distance, ...this.relationship(edge, 'in') }));
  }

  testsFor(id) {
    const visited = this.walk(id, 'in', Infinity, edge => executionKinds.has(edge.kind));
    const files = new Set();
    for (const id of visited.keys()) {
      const { file } = this.nodes.get(id);
      if (this.tests.has('module:' + file)) files.add(file);
    }
    return [...files].sort();
  }
}
