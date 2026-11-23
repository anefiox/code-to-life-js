# Code to Life JS

Explore a JavaScript or TypeScript project as a local, interactive dependency graph. Follow calls and JSX relationships, trace static test reachability, debug Node and Chromium, and inspect CPU samples alongside your source structure. Code to Life analyzes source files without running the project or its build scripts.

## Install

You need **Node.js 22.5 or later** and npm. Git is needed to clone the repository and for the optional change overlay. Use Chrome or Edge for browser debugging.

~~~sh
git clone https://github.com/anefiox/code-to-life-js.git
cd code-to-life-js
npm ci
~~~

Run the server from the checkout. Pass the path to the project you want to analyze.

~~~sh
node ./bin/codetolife.mjs /path/to/my-frontend
~~~

On Windows, use a path such as `C:/code/my-frontend`. With no project argument the tool analyzes the current directory. Open the URL printed in the terminal. The server binds to `127.0.0.1` on port `5170` by default. Use `--port 5171` to choose another port or `--port 0` to let the OS pick one. Stop it with Ctrl+C.

For a global command from a local checkout, run `npm link` once in this repository. Then use `codetolife-js [project]` or `codetolife-js-mcp [project]`. The direct Node commands above work without linking.

## Explore the graph

- **Folders** opens first. It groups files into at most 14 folders and shows how many imports run between them. Select a folder to read what that kind of folder is usually for, see which folders it uses and is used by, and list its files.
- **Modules** shows local imports and re-exports. Switch to **Symbols** for declarations, calls, class relationships, and JSX render edges. Select a node to follow its incoming and outgoing relationships.
- **Templates** appears when the project has page templates (Nunjucks, Handlebars, EJS and the like). It shows which layout each page extends, the partials and macros it pulls in, and the handlers that render it.
- Search by file path or symbol name. Select a symbol to see test files that reach it through static calls. Use **Refresh** after editing source.
- Pass `--json` to export the graph and rule violations.
- Open **What changed** to compare the working tree, including untracked files, with the merge base. Leave the base blank to use PR Buddy’s default branch lookup or enter a branch or commit. The graph outlines changed modules and symbols. Expand a file to see its semantic changes and findings, including deleted files and changes outside the source graph.

### Learn a new codebase

**Start here** gives a guided reading order of up to 12 files. It begins where the app starts: the `main` file in `package.json`, the file a `start`, `dev` or `serve` script runs, or a conventional name such as `src/index.js`. It then follows the import that brings in the most code, tracing the app's backbone down to its pages, and finishes with the shared files most others use. Each step says why the file matters and opens its code. Use **Next** and **Back** to move through it.

**Pages** lists every page and API address the app answers, and shows what happens when someone visits one. In order, it shows:

- the request;
- what the framework does first;
- where the route is defined;
- the handler;
- the code the handler calls, up to three calls deep;
- the page template, with its source.

The graph highlights the path. Code to Life recognises Hapi route objects (`{ method, path, handler }`, including handlers spread in from controller objects) and Express-style calls such as `app.get('/path', handler)`. It finds templates from `h.view('name')` and `res.render('name')` calls. Addresses built at run time, such as `config.get('path')`, are shown as written in the code.

Select any file or function to read it in the side panel. The panel shows:

- **What it does:** a short plain-English explanation, when one has been written. If the code has changed since, the panel says the explanation may be out of date.
- **Code:** the file, or just the selected function, with line numbers.
- **Packages this file uses:** what each third-party package is for, such as Hapi, Nunjucks or Convict. The project overview lists every recognised package from `package.json`.
- **Used by** and **Uses:** the connections to follow next.
- **Examples from tests:** the test cases that call it, as worked examples of real inputs and the results they expect.
- **History:** the commits that last changed it and who made them, so you know who to ask.
- **I've read this:** ticks it off. The project overview shows how much you've read and lets you pick up the **Start here** tour where you left off. Progress is kept in your browser only.

Framework terms such as *onPreResponse*, *CSRF* or *middleware* are underlined wherever they appear in explanations, the tour and page flows. Hover over or tab to one to see what it means. The project overview lists every term that fits the project's packages.

### How do I…, Settings and Ask

**How do I…** has short checklists for common changes, worked out from the patterns the project already follows: run and test it, add a page, add a setting, add a component, add a template filter, add a server plugin or middleware, and add a test. Each step links to a real example to copy, at the right line. For example, *Add a page* finds the folder each page lives in, the files every page has, the router that registers them and the menu that links to them.

**Settings** lists every setting the app reads: each entry in a [convict](https://github.com/mozilla/node-convict) schema, and any other `process.env` variable. For each one it shows the default (marked when it differs in production), its environment variable, where it is set for local runs (Compose files, `Dockerfile`, `.env.example` and workflows) and every place the code reads it. Values from `.env` files and settings marked `sensitive` are never shown.

**Ask** answers questions such as *Where is cookie consent checked?* It finds the files and functions whose names, paths, routes and explanations best match, and lists them. Started with `--ai`, Code to Life also sends that code to the AI for a short written answer, with every file and function it mentions linked to the graph.

**▶ Play it step by step** on any page in **Pages** walks through the request one step at a time, highlighting each function on the graph with its explanation and code, and ending with the template it fills in. Press **Play** to step through automatically.

### Hotspots and the onboarding guide

The project overview lists the **most changed files** from Git, with who changed them most. **Download onboarding guide** builds one Markdown page with the tools the project uses, how to run it, the folders, the Start here tour, every page, the settings, the recipes, the file explanations and the hotspots. Commit it as `ONBOARDING.md`, or build it from the command line:

~~~powershell
node .in\codetolife.mjs guide C:\code\my-frontend --out C:\code\my-frontend\ONBOARDING.md
~~~

Explanations live in `.codetolife/explanations.json` in the analyzed project. Files are keyed by path and functions by `path#name`, so moving code keeps its explanation. To write them, connect the [MCP server](#mcp-server) to Claude Code and ask it to explain the project for a new developer. It calls `explain_next` to get the most connected files and functions first, then `save_explanation` for each one. Select **Refresh** in the browser to see new explanations. You can also have [OpenRouter or your own AI server](#explanations-from-openrouter-or-a-local-ai-server) write them. Commit the file to share them with your team, or add `.codetolife/explanations.json` to `.gitignore` to keep them to yourself.

### Explanations from OpenRouter or a local AI server

Code to Life can write explanations with any OpenAI-compatible chat API, such as [OpenRouter](https://openrouter.ai), Unsloth Studio, LM Studio, Ollama or llama.cpp. Add `--ai` when you start it. An **Explain with AI** button then appears in the side panel for anything without an explanation, or with an out-of-date one.

API keys are read from environment variables only, so they never appear in your shell history or in the browser.

For OpenRouter, set `OPENROUTER_API_KEY`. The default model is `openrouter/auto`; choose another with `--ai-model`.

~~~powershell
$env:OPENROUTER_API_KEY = '<your OpenRouter key>'
node .\bin\codetolife.mjs C:\code\my-frontend --ai openrouter --ai-model <model ID from openrouter.ai/models>
~~~

For your own server, pass its address. If the URL doesn't end in `/v1`, Code to Life calls `/v1/chat/completions` on the same host, so a web UI address such as `http://my-gpu-box:8888/chat` works too. Set `CODETOLIFE_AI_KEY` if the server needs an API key. In Unsloth Studio, create one under its API key settings. Servers that run one loaded model, such as Unsloth Studio, ignore `--ai-model`.

~~~powershell
$env:CODETOLIFE_AI_KEY = '<your server key>'
node .\bin\codetolife.mjs C:\code\my-frontend --ai http://my-gpu-box:8888
~~~

To explain many things at once, use `explain`. It writes up to `--limit` explanations (10 by default), most connected first, and skips anything already explained and still current. Run it again to continue.

~~~powershell
node .\bin\codetolife.mjs explain C:\code\my-frontend --ai http://my-gpu-box:8888 --limit 25
~~~

Each request sends the selected code, its file path, the packages it imports and the names of its connections to the server you chose. **Ask** sends your question, the list of pages, and the code and explanations of up to 10 matching files and functions. Use a local server for code that must not leave your network.

The analyzer reads the root `tsconfig.json` or `jsconfig.json` and follows TypeScript project references. It also maps Node subpath imports from `package.json` `"imports"`, such as `"#/*": "./src/*"`. It also scans source files outside those configurations. TypeScript path aliases and package resolution follow those compiler settings. Framework-specific virtual modules, bundler-only aliases, Vue and Svelte single-file components, and dynamic dispatch may leave gaps. Test reachability is inferred from source and cannot measure execution or assertions.

### Git changes with PR Buddy JS

The graph, rules, plan editor, debugger, and profiler run independently. To enable **What changed** and the MCP `what_changed` tool, install [PR Buddy JS](https://github.com/anefiox/pr-buddy-js) alongside Code to Life. From the Code to Life checkout:

~~~sh
git clone https://github.com/anefiox/pr-buddy-js.git ../pr-buddy-js
npm --prefix ../pr-buddy-js ci
~~~

Code to Life automatically looks for `../pr-buddy-js/bin/prbuddy.mjs` relative to its repository. If PR Buddy lives elsewhere, set `PRBUDDY_JS_ENTRY` to the absolute path of its CLI file before launching Code to Life or its MCP server.

~~~powershell
$env:PRBUDDY_JS_ENTRY = 'C:/tools/pr-buddy-js/bin/prbuddy.mjs'
node ./bin/codetolife.mjs C:/code/my-frontend
~~~

On macOS or Linux, use `export PRBUDDY_JS_ENTRY=/path/to/pr-buddy-js/bin/prbuddy.mjs`. The review runs locally against the target project's Git history and working tree. A first commit and a base ref are required. Enter a branch or commit in the overlay if your repository uses a different default branch.

### Node.js debugger

Launch Code to Life with an explicit project-relative entry and optional breakpoints. Use a separate `--break` per `file:line` and a separate `--debug-arg` per script argument.

~~~powershell
node .\bin\codetolife.mjs C:\code\my-frontend --debug-entry src/server.mjs --break src/server.mjs:42
~~~

Open **Debugger** and click **Start**. Node pauses at startup so you can continue to a breakpoint, step through code, or pause and inspect the call stack. The graph highlights mapped frames and connections present in the static graph. Click a frame to locate its symbol. Use **Stop** before starting another session.

The debugger runs the specified script directly with the installed Node executable. Native TypeScript is available where supported by Node. Browser execution, source-map translation, attaching to other processes, and scripts that need a custom loader or package script are outside this debugger’s scope.

### Chromium debugger

Start your frontend dev server. Open the frontend in a dedicated Chrome or Edge profile with a loopback DevTools port. For example, in PowerShell:

~~~powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 "--user-data-dir=$env:TEMP\codetolife-chrome" http://localhost:5173/
node .\bin\codetolife.mjs C:\code\my-frontend --browser-port 9222 --browser-url http://localhost:5173/ --break src/App.tsx:42
~~~

Open **Debugger** and click **Connect**. Keep exactly one tab at the configured URL. Breakpoints bind when matching scripts and their maps load. For a breakpoint in a component or event handler, wait for **bound** before triggering the code. You can also use a `debugger` statement or the **Pause** button. **Disconnect** leaves Chromium open.

Browser mode maps paused frames and CPU samples for the selected tab’s main thread. It supports flat inline source maps and same-origin map files when their source URLs resolve to files under the project, including Vite-style source paths. Workers, cross-origin and indexed source maps, and breakpoints before initial page execution are outside this mode’s scope. The MCP debugger uses Node scripts.

### CPU profiling

In **Debugger**, start the Node process or connect to the Chromium tab, then select **Record CPU**. Continue execution if it is paused and exercise the workload. Select **Finish recording** while the target is still open. For browser recordings, stay on the same page so Code to Life can resolve samples against the current scripts. Recordings stop after about 30 seconds if left running. Short-lived scripts can record from the startup pause and use a breakpoint near the end so the profile can be collected before exit.

The graph colors project modules or symbols by the number of samples attributed to them at the top of the CPU stack. Select a ranked result to jump to it. The total includes idle time and samples outside the project, so it can exceed the number mapped. Profiling covers the main thread of the launched Node process or selected Chromium tab.

### Plan editor

Open **Plan** to propose a TypeScript function or component. Enter a project-relative file and an export name, add notes, and list existing or proposed modules it will depend on. Shift-click an existing module on the graph to add its path. Click a proposed node to edit it.

**Save module** updates `.codetolife/plan.json`. The graph draws proposed modules and their resolved dependency arrows in purple. **Preview stub** shows a copyable TypeScript skeleton. It leaves source files alone. Reload the plan before retrying a save if another tab has updated it.

### Architecture rules

To prohibit dependencies from one path into another, put rules in the project's `.codetolife/rules.json`. Paths use forward slashes and match a file or directory prefix. Use `"."` for the project root. Omit `kinds` to check all cross-file relationships.

~~~json
[
  {
    "from": "src/domain",
    "notTo": "src/ui",
    "kinds": ["imports", "imports type", "calls", "renders"],
    "because": "Domain code is shared by the server and browser."
  }
]
~~~

Run the same checks in CI.

~~~powershell
node C:\code\code-to-life-js\bin\codetolife.mjs check .
~~~

Exit codes are 0 for a clean check, 1 for violations, and 2 for invalid input or configuration.

## MCP server

Register a local **stdio** server in any MCP client. Pass your project folder as a positional argument. Run `npm ci` in the tools folder first.

~~~json
{
  "command": "node",
  "args": [
    "C:/code/code-to-life-js/bin/codetolife-mcp.mjs",
    "C:/code/my-frontend"
  ]
}
~~~

The server offers `overview`, `find`, `describe`, `callers`, `callees`, `path_between`, `impact`, `tests_for`, `check_architecture`, `what_changed`, `explain_next`, and `save_explanation`. For onboarding it also offers `how_to` (the recipes), `settings`, `templates`, `test_examples`, `history` (hotspots, or the commits behind one file or function) and `onboarding_guide`.
Use graph node IDs from `find` when names are ambiguous. The graph is cached for the session. Call `overview` with `{"refresh": true}` after editing files. `what_changed` also rebuilds the graph before comparing Git changes. All tools use the project selected at launch. Only `save_explanation` writes, and only to `.codetolife/explanations.json`.

With Claude Code, register the server from a terminal:

~~~powershell
claude mcp add codetolife-js -- node C:/code/code-to-life-js/bin/codetolife-mcp.mjs C:/code/my-frontend
~~~

### Optional MCP debugger

Append `--debug-entry` and the project-relative script path to the MCP server's arguments. Use `--break file:line` and `--debug-arg value` for each breakpoint and script argument.

~~~json
[
  "C:/code/code-to-life-js/bin/codetolife-mcp.mjs",
  "C:/code/my-frontend",
  "--debug-entry", "src/server.mjs",
  "--break", "src/server.mjs:42"
]
~~~

This enables `debug_launch`, `debug_step`, `debug_continue`, `debug_pause`, `debug_where`, and `debug_stop`. Commands with `waitMs` wait up to one second by default for the next pause or exit. Call `debug_where` again if the target is still running. Frames include graph node IDs when the source can be mapped. The MCP server manages its own Node process.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The graph is empty or an import edge is missing | Point the CLI at the application root, check its TypeScript configuration, and install the application's own dependencies if its imports require them. |
| **What changed** asks for PR Buddy JS | Install dependencies in the sibling PR Buddy checkout or set `PRBUDDY_JS_ENTRY` before launching. |
| Chromium reports no matching tab | Use the exact localhost URL of one tab, including the port, path, and trailing slash where applicable. |
| A browser breakpoint stays pending | Load the component or route that owns the script and verify the dev server provides a supported source map. |
| A profile has no project samples | Exercise the workload while recording and check that its scripts can be mapped back to the project. |

## Development

Run `npm test` from the checkout. Install the sibling PR Buddy JS checkout to exercise the cross-repository overlay. Set `CODETOLIFE_TEST_CHROME` to a Chromium executable to run the browser UI, debugger, and profiler tests.

~~~powershell
$env:CODETOLIFE_TEST_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm test
~~~

The graph uses the MIT-licensed Cytoscape.js bundled with the original [Code to Life](https://github.com/anefiox/code-to-life) project. Its license notice is preserved in the vendored file.
