// Writes explanations with any OpenAI-compatible chat completions API:
// OpenRouter, or a self-hosted server such as Unsloth Studio, LM Studio,
// Ollama or llama.cpp. API keys come only from environment variables.
import { explanationGuidance, explanationKey, readSource } from './explain.mjs';

export const aiOptions = {
  ai: { type: 'string' },
  'ai-model': { type: 'string' }
};

const codeLimit = 12000;
const neighbourLimit = 15;

// "openrouter", or the URL of a self-hosted server. A URL may point at the
// server's web page (e.g. http://host:8888/chat); the API is assumed to live
// at /v1 on the same origin unless the URL already ends in /v1.
export function aiConfig(values, env = process.env) {
  if (values.ai === undefined) {
    if (values['ai-model'] !== undefined) throw new Error('--ai-model needs --ai.');
    return null;
  }
  const choice = values.ai.trim();
  if (choice.toLowerCase() === 'openrouter') {
    const key = env.OPENROUTER_API_KEY || env.CODETOLIFE_AI_KEY;
    if (!key) throw new Error('Set OPENROUTER_API_KEY to use OpenRouter.');
    return {
      label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', key,
      model: values['ai-model'] || 'openrouter/auto',
      headers: { 'X-Title': 'Code to Life JS' }
    };
  }
  let url;
  try {
    url = new URL(choice);
  } catch {
    throw new Error('--ai must be "openrouter" or an http(s) URL such as http://localhost:8888.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--ai URLs must use http or https.');
  if (url.username || url.password) throw new Error('Put the API key in CODETOLIFE_AI_KEY, not in the URL.');
  const trimmed = url.pathname.replace(/\/+$/, '');
  const base = trimmed.endsWith('/v1') ? url.origin + trimmed : url.origin + '/v1';
  return {
    label: url.host, endpoint: base + '/chat/completions', key: env.CODETOLIFE_AI_KEY || null,
    model: values['ai-model'] || 'default', headers: {}
  };
}

// Reasoning models may wrap their thinking in tags; keep only the answer.
export function cleanAnswer(text) {
  return String(text ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/^[\s\S]*<\/(?:think|thinking|reasoning)>/i, '')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '')
    .replace(/^(?:\*\*)?(?:summary|explanation)(?::\*\*|\*\*:|:)\s*/i, '')
    .trim()
    .slice(0, 2000)
    .trim();
}

export function explanationPrompt(root, graph, id) {
  const source = readSource(root, graph, id);
  const { node } = source;
  const names = new Map(graph.nodes.map(item => [item.id, item]));
  const describe = item => item.kind === 'module' ? item.file : item.name + ' in ' + item.file;
  const related = direction => graph.edges
    .filter(edge => edge.kind !== 'contains' && (direction === 'in' ? edge.to : edge.from) === id)
    .map(edge => names.get(direction === 'in' ? edge.from : edge.to))
    .filter(Boolean).slice(0, neighbourLimit).map(describe);
  const usedBy = related('in');
  const uses = related('out');
  const code = source.code.length > codeLimit ? source.code.slice(0, codeLimit) + '\n… (truncated)' : source.code;
  const lines = [
    'Explain this ' + (node.kind === 'module' ? 'file' : node.kind) + ' from a JavaScript project.',
    'Name: ' + node.name,
    'File: ' + node.file + ' (lines ' + source.start + '–' + source.end + ')'
  ];
  if (source.packages.length) lines.push('Packages the file imports: ' + source.packages.join(', '));
  if (usedBy.length) lines.push('Used by: ' + usedBy.join('; '));
  if (uses.length) lines.push('Uses: ' + uses.join('; '));
  lines.push('', '```js', code, '```', '', 'Reply with only the explanation, as plain text with no heading.');
  return {
    key: explanationKey(node),
    messages: [
      { role: 'system', content: explanationGuidance },
      { role: 'user', content: lines.join('\n') }
    ]
  };
}

export async function askAi(config, messages, { fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const headers = { 'Content-Type': 'application/json', ...config.headers };
  if (config.key) headers.Authorization = 'Bearer ' + config.key;
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: config.model, messages, temperature: 0.3, max_tokens: 700, stream: false })
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.cause?.code ?? error.message;
    throw new Error(config.label + ' could not be reached (' + reason + ').');
  }
  const body = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ?
      (config.label === 'OpenRouter' ? ' Check OPENROUTER_API_KEY.' : ' Set CODETOLIFE_AI_KEY to an API key for this server.') : '';
    throw new Error(config.label + ' returned ' + response.status + '.' + hint + ' ' + body.slice(0, 300));
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(config.label + ' did not return JSON. Is ' + config.endpoint + ' an OpenAI-compatible API?');
  }
  const answer = cleanAnswer(data.choices?.[0]?.message?.content);
  if (!answer) throw new Error(config.label + ' returned an empty answer.');
  return answer;
}
