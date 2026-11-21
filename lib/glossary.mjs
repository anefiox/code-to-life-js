// Plain-English descriptions of common packages, written for someone new to
// JavaScript. Keys are package names; a trailing "/" matches a whole scope.
const entries = {
  // Web servers and their add-ons
  '@hapi/hapi': ['Hapi', 'The web server framework. It receives each browser request and hands it to the matching route.'],
  '@hapi/': ['Hapi add-on', 'An official Hapi plugin. Plugins bolt extra features (sessions, static files, templates) onto the server.'],
  '@hapi/boom': ['Boom', 'Builds HTTP error responses such as 404 Not Found or 500 Server Error.'],
  '@hapi/vision': ['Vision', 'Lets Hapi render HTML pages from templates (here, usually Nunjucks).'],
  '@hapi/inert': ['Inert', 'Lets Hapi send static files such as CSS, images and JavaScript to the browser.'],
  '@hapi/yar': ['Yar', 'Session storage for Hapi: remembers things about a user between page loads.'],
  '@hapi/crumb': ['Crumb', 'Protects forms against cross-site request forgery (CSRF) by adding a hidden token.'],
  '@hapi/catbox-redis': ['Catbox Redis', 'Stores Hapi cache and session data in Redis, a fast shared key-value database.'],
  '@hapi/catbox-memory': ['Catbox Memory', 'Stores Hapi cache and session data in the server\'s own memory (handy locally, lost on restart).'],
  '@hapi/scooter': ['Scooter', 'Reads the browser\'s user-agent so the server knows which browser is calling.'],
  express: ['Express', 'The web server framework. It matches each request URL to a handler function.'],
  koa: ['Koa', 'A small web server framework built around async middleware functions.'],
  fastify: ['Fastify', 'A fast web server framework. Routes and plugins register on a central server object.'],
  'hapi-pino': ['hapi-pino', 'Connects the Pino logger to Hapi so every request is logged.'],
  'hapi-pulse': ['hapi-pulse', 'Shuts the Hapi server down gracefully, finishing in-flight requests first.'],
  blankie: ['Blankie', 'Adds Content-Security-Policy headers, which limit what scripts and styles a page may load.'],

  // Pages and UI
  nunjucks: ['Nunjucks', 'A template language. `.njk` files are HTML with placeholders that the server fills in.'],
  'govuk-frontend': ['GOV.UK Frontend', 'The GOV.UK Design System\'s styles, components and template macros.'],
  react: ['React', 'Builds the UI from components: functions that return JSX describing what to show.'],
  'react-dom': ['React DOM', 'Puts React components onto a real web page.'],
  vue: ['Vue', 'A UI framework that builds pages from reusable components.'],
  'next': ['Next.js', 'A React framework that adds routing by folder, server rendering and build tooling.'],

  // Configuration and validation
  convict: ['Convict', 'Defines the app\'s settings in one schema and reads them from environment variables.'],
  'convict-format-with-validator': ['Convict formats', 'Extra setting types for Convict, such as URL or email.'],
  joi: ['Joi', 'Validates data against a schema, e.g. checking a submitted form or config is the right shape.'],
  zod: ['Zod', 'Validates data against a schema and gives TypeScript types for it.'],
  dotenv: ['dotenv', 'Loads settings from a `.env` file into environment variables.'],

  // Logging and monitoring
  pino: ['Pino', 'A fast logger. Code calls `logger.info(...)` and Pino writes structured JSON lines.'],
  'pino-pretty': ['pino-pretty', 'Turns Pino\'s JSON log lines into readable coloured text for local development.'],
  '@elastic/ecs-pino-format': ['ECS format', 'Formats log lines in Elastic Common Schema so log search tools understand them.'],
  '@defra/': ['DEFRA library', 'A shared package from DEFRA\'s Core Delivery Platform (CDP), used across DEFRA services.'],
  '@defra/hapi-tracing': ['CDP tracing', 'Adds a trace ID to each request so logs from one request can be linked across services.'],
  '@defra/hapi-secure-context': ['CDP secure context', 'Loads trusted TLS certificates so outgoing HTTPS calls work on the platform.'],
  '@defra/cdp-metrics': ['CDP metrics', 'Sends counts and timings to the platform\'s monitoring dashboards.'],
  '@defra/cdp-auditing': ['CDP auditing', 'Records audit events (who did what, when) on the platform.'],

  // Data and HTTP
  ioredis: ['ioredis', 'A Redis client. Redis is a fast key-value database, often used for sessions and caching.'],
  jose: ['jose', 'Creates and checks signed tokens (JWTs), often used when signing users in.'],
  axios: ['Axios', 'Makes HTTP requests to other services.'],
  'node-fetch': ['node-fetch', 'Makes HTTP requests to other services using the browser-style `fetch` API.'],
  undici: ['undici', 'Node\'s fast HTTP client, used to call other services.'],
  mongodb: ['MongoDB driver', 'Reads and writes documents in a MongoDB database.'],
  mongoose: ['Mongoose', 'Defines MongoDB document shapes as models and reads and writes them.'],
  pg: ['node-postgres', 'Runs SQL queries against a PostgreSQL database.'],

  // Utilities
  lodash: ['Lodash', 'A toolbox of helpers for objects, arrays and strings (e.g. `get`, `merge`, `debounce`).'],
  'date-fns': ['date-fns', 'Helpers for formatting and calculating dates.'],
  dayjs: ['Day.js', 'Helpers for formatting and calculating dates.'],
  uuid: ['uuid', 'Generates unique IDs.'],

  // Build and test tooling
  vite: ['Vite', 'Bundles front-end files (JS, CSS) for the browser and runs a fast dev server.'],
  webpack: ['webpack', 'Bundles front-end files (JS, CSS) for the browser.'],
  vitest: ['Vitest', 'The test runner. Files ending `.test.js` are run by it.'],
  jest: ['Jest', 'The test runner. Files ending `.test.js` are run by it.'],
  nodemon: ['nodemon', 'Restarts the server automatically whenever you save a file.'],
  eslint: ['ESLint', 'Checks code for mistakes and style problems.'],
  prettier: ['Prettier', 'Automatically formats code so everyone\'s looks the same.'],
  typescript: ['TypeScript', 'JavaScript with types. Catches mistakes before the code runs.'],
  sass: ['Sass', 'A CSS language with variables and nesting. `.scss` files compile to CSS.'],

  // Node built-ins
  fs: ['fs (Node)', 'Node\'s built-in module for reading and writing files.'],
  path: ['path (Node)', 'Node\'s built-in helpers for joining and splitting file paths.'],
  http: ['http (Node)', 'Node\'s built-in HTTP server and client.'],
  url: ['url (Node)', 'Node\'s built-in helpers for parsing and building URLs.'],
  crypto: ['crypto (Node)', 'Node\'s built-in hashing, random numbers and encryption.']
};

function lookup(name) {
  if (entries[name]) return entries[name];
  const scope = name.startsWith('@') ? name.split('/')[0] + '/' : null;
  return scope ? entries[scope] : undefined;
}

export function glossaryFor(packages) {
  const seen = new Set();
  const result = [];
  for (const name of [...new Set(packages)].sort()) {
    const entry = lookup(name);
    if (!entry || seen.has(name)) continue;
    seen.add(name);
    result.push({ package: name, term: entry[0], meaning: entry[1] });
  }
  return result;
}
