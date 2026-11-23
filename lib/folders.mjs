// What common folder names are usually for, and the grouping of files into a
// handful of folders that the Folders view and the onboarding guide share.
const folderNotes = [
  [/^(routes?|pages|app)$/, 'The pages and URLs the app answers. Each one pairs a web address with the code that handles it.'],
  [/^controllers?$/, 'Request handlers: the code that runs when a page or API address is visited.'],
  [/^plugins?$/, 'Plugins add features to the web server, such as logging, sessions, security headers or sign-in.'],
  [/^middlewares?$/, 'Middleware runs on every request before it reaches a page, for example sign-in or logging.'],
  [/^(config|configuration|settings|env)$/, 'Settings such as ports, URLs and feature switches, which change between your machine, test and live.'],
  [/^(nunjucks|templates?|views?|layouts?|partials)$/, 'Page templates: the HTML the app fills in and sends to the browser.'],
  [/^(auth|authentication|login|session)$/, 'Sign-in and access control: who the user is and what they may see.'],
  [/^(logging|logger|logs|metrics|tracing)$/, 'Logging and monitoring: records what the app does so problems can be found.'],
  [/^constants?$/, 'Fixed values shared across the app, such as status codes.'],
  [/^(common|shared|lib|libs|utils?|helpers?|core)$/, 'Shared helpers used in many places across the app.'],
  [/^components?$/, 'Reusable UI pieces that screens are built from.'],
  [/^hooks?$/, 'React hooks: reusable logic that components call to share state and behaviour.'],
  [/^(store|state|redux|slices)$/, 'App-wide state that several screens share.'],
  [/^(services?|clients?|api)$/, 'Code that talks to other systems, such as APIs and databases, or holds business rules.'],
  [/^(models?|schemas?|types|entities)$/, 'The shapes of the data the app works with.'],
  [/^(client|frontend|public|assets|static|javascripts|stylesheets|styles|css)$/, 'Code and files that are sent to and run in the browser.'],
  [/^(server|backend)$/, 'Code that runs on the server, not in the browser.'],
  [/^(tests?|__tests__|test-helpers|mocks|__mocks__|fixtures|spec)$/, 'Test code and helpers. They check the app works, but do not run in the live service.'],
  [/^(scripts|bin|tools|tasks)$/, 'Command-line scripts for developers. They are not part of the running app.'],
  [/^src$/, 'The app\'s source code.']
];

export function folderNote(dir) {
  const parts = (dir || '').split('/').filter(Boolean).reverse();
  for (const part of parts) {
    const match = folderNotes.find(([pattern]) => pattern.test(part.toLowerCase()));
    if (match) return match[1];
  }
  return dir ? null : 'Files at the top of the project, usually setup and configuration for tools.';
}

// A note for every folder that holds files, and each of its parents.
export function folderNotesFor(graph) {
  const notes = { '': folderNote('') };
  for (const node of graph.nodes) {
    if (node.kind !== 'module') continue;
    const parts = node.file.split('/').slice(0, -1);
    for (let index = 1; index <= parts.length; index++) {
      const dir = parts.slice(0, index).join('/');
      if (!(dir in notes)) notes[dir] = folderNote(dir);
    }
  }
  return notes;
}

// Groups files into at most 14 folders, merging the deepest folders into
// their parents until the picture is small enough to take in at once.
export function folderGroups(graph) {
  const tests = new Set(graph.tests);
  const modules = graph.nodes.filter(node => node.kind === 'module');
  const depth = dir => dir ? dir.split('/').length : 0;
  const groupOf = new Map(modules.map(node => [node.file, node.file.includes('/') ? node.file.slice(0, node.file.lastIndexOf('/')) : '']));
  for (;;) {
    const dirs = new Set(groupOf.values());
    const deepest = Math.max(...[...dirs].map(depth));
    if (dirs.size <= 14 || deepest <= 1) break;
    for (const [file, dir] of groupOf) if (depth(dir) === deepest) groupOf.set(file, dir.split('/').slice(0, -1).join('/'));
  }
  const groups = new Map();
  for (const node of modules) {
    const dir = groupOf.get(node.file);
    if (!groups.has(dir)) groups.set(dir, { id: 'folder:' + dir, dir, files: [], tests: 0 });
    const group = groups.get(dir);
    group.files.push(node.file);
    if (tests.has(node.id)) group.tests++;
  }
  const links = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const from = groupOf.get(edge.from.slice('module:'.length));
    const to = groupOf.get(edge.to.slice('module:'.length));
    if (from === undefined || to === undefined || from === to) continue;
    const key = from + '\n' + to;
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  return { groupOf, groups, links };
}
