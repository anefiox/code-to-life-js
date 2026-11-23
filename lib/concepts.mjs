// Framework terms a newcomer will meet, shown as tooltips wherever they appear
// in explanations, tour steps and page flows. Only the terms that fit the
// project's packages are sent.
import fs from 'node:fs';
import path from 'node:path';

const always = [];
const terms = [
  // Hapi
  ['hapi plugin', 'plugins?', ['@hapi/hapi'], 'A bundle of routes, settings or hooks added to a Hapi server with server.register. Most features in a Hapi app are plugins.'],
  ['handler', 'handlers?', always, 'The function that runs when a request matches a route. It builds the response: a page, a redirect or some data.'],
  ['route', 'routes?', always, 'A pairing of a web address and method (such as GET /about) with the code that answers it.'],
  ['h (response toolkit)', 'h\\.view|h\\.redirect|h\\.response|response toolkit', ['@hapi/hapi'], 'h is the toolkit Hapi passes to every handler: h.view renders a template, h.redirect sends the browser elsewhere and h.response builds a custom reply.'],
  ['onPreResponse', 'onPreResponse', ['@hapi/hapi'], 'A Hapi lifecycle hook that runs after the handler and just before the response is sent, so it can change or replace any response.'],
  ['lifecycle hook', 'lifecycle(?: hooks?)?|server\\.ext', ['@hapi/hapi'], 'A point in the handling of every request (such as onRequest or onPreResponse) where a plugin can run its own code.'],
  ['Boom', 'Boom', ['@hapi/hapi', '@hapi/boom'], 'Hapi\'s way of representing HTTP errors such as 404 Not Found. Throwing a Boom error makes Hapi send that status code.'],
  ['Catbox', 'Catbox', ['@hapi/catbox-redis', '@hapi/catbox-memory', '@hapi/hapi'], 'Hapi\'s caching layer. It stores data in memory or in Redis behind one interface.'],
  ['yar', 'yar|request\\.yar', ['@hapi/yar'], 'The Hapi plugin for sessions: request.yar reads and writes data remembered about one visitor between pages.'],
  ['crumb', 'crumb', ['@hapi/crumb'], 'The Hapi plugin for CSRF protection. It puts a secret token in each form and rejects posts without it.'],
  ['Vision', 'Vision|@hapi/vision', ['@hapi/vision'], 'The Hapi plugin that renders templates, which gives handlers h.view().'],
  ['Inert', 'Inert|@hapi/inert', ['@hapi/inert'], 'The Hapi plugin that serves static files such as CSS, JavaScript and images.'],
  ['Joi', 'Joi', ['joi'], 'A library for checking data has the right shape, for example that a form field is a boolean. Hapi uses it to validate requests.'],
  // Express and friends
  ['middleware', 'middlewares?', always, 'Code that runs on every request before it reaches a page, such as logging, sessions or sign-in. Each piece passes the request on to the next.'],
  ['next()', 'next\\(\\)', ['express', 'koa'], 'Called by middleware when it has finished, to hand the request to the next middleware or route.'],
  // Templates
  ['Nunjucks', 'Nunjucks', ['nunjucks'], 'The templating language used for the .njk files: HTML with {{ values }} and {% tags %} filled in on the server.'],
  ['template', 'templates?', always, 'An HTML file with gaps that the server fills in with values before sending the page.'],
  ['layout', 'layouts?', always, 'A template that holds what every page shares, such as the header and footer. Pages extend it and fill in its blocks.'],
  ['partial', 'partials?', always, 'A small template included in other templates, such as a banner.'],
  ['macro', 'macros?', ['nunjucks'], 'A reusable piece of template that you call like a function, with options. Components are macros.'],
  ['filter', 'filters?', ['nunjucks'], 'A function used in a template after a | to change a value as it is shown, like {{ date | formatDate }}.'],
  ['GOV.UK Frontend', 'GOV\\.UK Frontend|govuk-frontend', ['govuk-frontend'], 'The GOV.UK Design System\'s code: the styles, templates and scripts behind GOV.UK buttons, forms and layouts.'],
  // Web basics
  ['CSRF', 'CSRF|cross-site request forgery', always, 'Cross-site request forgery: another website secretly making your browser submit a form to this one. A token in each form stops it.'],
  ['CSP', 'CSP|Content Security Policy', always, 'Content Security Policy: a header listing the places a page may load scripts and styles from. Anything else is blocked.'],
  ['HSTS', 'HSTS', always, 'A header telling browsers to only ever use HTTPS for this site.'],
  ['session', 'sessions?', always, 'Data remembered about one visitor between pages. The browser holds a cookie that identifies it; the data usually stays on the server.'],
  ['cookie', 'cookies?', always, 'A small piece of data the browser stores for a site and sends back with every request.'],
  ['redirect', 'redirects?|open redirect', always, 'A response that tells the browser to go to another address instead.'],
  ['status code', 'status codes?|\\b[45]0[0-9]\\b', always, 'The number at the start of every response: 200 means OK, 302 a redirect, 404 not found and 500 a server error.'],
  ['environment variable', 'environment variables?|env vars?|process\\.env', always, 'A setting given to the app by whatever starts it, such as PORT=3000, so the same code can run differently on your machine and in production.'],
  ['nonce', 'nonces?', always, 'A random value made fresh for each page. Here it marks the inline scripts the Content Security Policy should allow.'],
  ['Redis', 'Redis', always, 'A fast shared data store, often used to keep sessions or cached data so every copy of the app sees the same values.'],
  ['TLS', 'TLS', always, 'The encryption behind HTTPS, also used to secure connections between services.'],
  ['health check', 'health[- ]checks?|/health', always, 'An address the hosting platform calls regularly to check the app is running.'],
  ['trace id', 'trace ids?|tracing', always, 'An id given to one request and passed along to every service and log line it touches, so its journey can be followed.'],
  ['back/forward cache', 'back/forward cache|bfcache', always, 'A browser feature that restores a page instantly when you press Back, without asking the server again.'],
  ['XHR', 'XHR|XMLHttpRequest|fetch\\(\\)', always, 'A request made by JavaScript in the page without reloading it.'],
  // JavaScript and tooling
  ['async/await', 'async|await', always, 'A way to write code that waits for something slow, such as a network call, without blocking everything else.'],
  ['promise', 'promises?', always, 'An object for a result that will arrive later. await waits for it.'],
  ['module', 'ES modules?|import/export', always, 'A JavaScript file that shares code with import and export.'],
  ['mock', 'mocks?|mocked|fakes?', always, 'A stand-in used in tests instead of the real thing, such as a fake network call.'],
  ['coverage', 'coverage', always, 'A report of which lines of code the tests ran, to show what is untested.'],
  ['lint', 'lint(?:ing|er)?|ESLint', always, 'A tool that checks code for mistakes and style problems without running it.'],
  ['Vite', 'Vite', ['vite'], 'The build tool that bundles the browser code and styles, and serves them with live reload while you develop.'],
  ['Vitest', 'Vitest', ['vitest'], 'The test runner: it finds the .test files, runs them and reports what failed.'],
  ['Babel', 'Babel', ['@babel/core', '@babel/preset-env'], 'A tool that rewrites modern JavaScript so older browsers can run it.'],
  ['bundle', 'bundles?|bundler', always, 'One or a few files built from many source files, so the browser can load them quickly.'],
  ['pino', 'pino', ['pino', 'hapi-pino'], 'A fast logging library that writes each log line as JSON.'],
  ['ECS', 'ECS', ['@elastic/ecs-pino-format'], 'Elastic Common Schema: a standard JSON layout for log lines that log search tools understand.'],
  ['convict', 'convict', ['convict'], 'A library that declares every setting in one schema, with defaults and environment variables, and checks the values at startup.'],
  // React
  ['component', 'components?', always, 'A reusable piece of user interface, such as a button or a banner, that pages are built from.'],
  ['props', 'props', ['react', 'preact'], 'The values a parent passes into a React component, like arguments to a function.'],
  ['hook', 'hooks?|useState|useEffect', ['react', 'preact'], 'A React function starting with use, such as useState, that lets a component keep state or react to changes.'],
  ['JSX', 'JSX', ['react', 'preact'], 'HTML-like syntax inside JavaScript that React turns into elements.'],
  ['state', 'state', ['react', 'preact', 'redux', '@reduxjs/toolkit'], 'Data that can change while the page is open. When it changes, the parts of the page that use it update.']
];

export function conceptsFor(root) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // No package.json: only the general terms apply.
  }
  const installed = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  return terms.filter(([, , when]) => !when.length || when.some(name => installed.has(name)))
    .map(([term, pattern, , meaning]) => ({ term, pattern, meaning }));
}
