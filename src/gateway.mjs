// Model gateway: seat any hosted or local model at the table through its HTTP API.
// Two wire protocols cover everything here: the OpenAI chat-completions shape and the Claude Messages API.
// Gateway agents answer from the shared context (brief, board, transcript, attachments). They have no tools.

import fs from 'node:fs/promises';
import path from 'node:path';

export const PROVIDERS = {
  anthropic: { label: 'Claude API', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', suggest: 'claude-opus-5-5' },
  openai: { label: 'OpenAI API', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  google: { label: 'Google Gemini API', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
  openrouter: { label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', headers: { 'X-OpenRouter-Title': 'Shared Table' } },
  groq: { label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  xai: { label: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY' },
  mistral: { label: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY' },
  lmstudio: { label: 'LM Studio (this computer)', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  ollama: { label: 'Ollama (this computer)', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  llamacpp: { label: 'llama.cpp server (this computer)', protocol: 'openai', baseUrl: 'http://127.0.0.1:9931/v1', local: true }, // current default port; older builds used 8080
  regesarc: { label: 'RegesARC (this computer)', protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', local: true },
  custom: { label: 'Other OpenAI-compatible server', protocol: 'openai', baseUrl: '', custom: true },
};

const ANTHROPIC_VERSION = '2026-10-21';
const clean = url => String(url || '').trim().replace(/\/+$/, '');

export function requestHeaders(protocol, key, extra = {}) {
  if (protocol === 'anthropic') return { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': ANTHROPIC_VERSION, ...extra };
  return { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...extra };
}

/** Ask a provider which models it serves. */
export async function listModels({ protocol, baseUrl, key, headers = {} }) {
  const response = await fetch(clean(baseUrl) + '/models' + (protocol === 'anthropic' ? '?limit=100' : ''), { headers: requestHeaders(protocol, key, headers), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The key was not accepted (HTTP ' + response.status + ').' : 'HTTP ' + response.status);
  const value = await response.json();
  return (value.data || value.models || []).map(item => item.id || item.name).filter(Boolean).map(id => String(id).replace(/^models\//, '')).sort();
}

/** Saved gateway agents and saved keys, kept under the data root with owner-only permissions. Keys never leave this module in a response. */
export async function createGateway(dataRoot, env = process.env) {
  const agentsFile = path.join(dataRoot, 'gateway.json'), keysFile = path.join(dataRoot, 'keys.json');
  const read = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } };
  const write = async (file, value) => { await fs.mkdir(dataRoot, { recursive: true }); const temporary = file + '.tmp'; await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, file); };
  let saved = (await read(agentsFile, [])).filter(item => item && PROVIDERS[item.provider] && typeof item.model === 'string');
  let keys = await read(keysFile, {});

  const keyFor = provider => keys[provider] || (PROVIDERS[provider]?.keyEnv ? env[PROVIDERS[provider].keyEnv] : '') || '';
  const endpoint = spec => clean(spec.baseUrl) || PROVIDERS[spec.provider].baseUrl;

  return {
    list: () => saved.map(item => ({ ...item })),
    providers: () => Object.entries(PROVIDERS).map(([id, provider]) => ({ id, label: provider.label, local: !!provider.local, custom: !!provider.custom, baseUrl: provider.baseUrl, keyEnv: provider.keyEnv || null, suggest: provider.suggest || '', hasKey: !!keyFor(id), keySource: keys[id] ? 'saved' : keyFor(id) ? 'environment' : null })),
    keyFor,
    /** Agent specs in the form src/agents.mjs httpAgent() takes. */
    specs: () => saved.map(item => ({ id: item.id, label: item.label, vendor: PROVIDERS[item.provider].label.replace(' (this computer)', ''), baseUrl: endpoint(item), model: item.model, protocol: PROVIDERS[item.provider].protocol, extraHeaders: PROVIDERS[item.provider].headers || {}, key: () => keyFor(item.provider), gateway: true })),
    models: ({ provider, baseUrl }) => { if (!PROVIDERS[provider]) throw new Error('Unknown provider.'); const url = clean(baseUrl) || PROVIDERS[provider].baseUrl; if (!url) throw new Error('Enter the server address.'); return listModels({ protocol: PROVIDERS[provider].protocol, baseUrl: url, key: keyFor(provider), headers: PROVIDERS[provider].headers }); },
    async setKey(provider, key) {
      if (!PROVIDERS[provider]) throw new Error('Unknown provider.');
      const value = String(key || '').trim();
      if (value.length > 400 || /\s/.test(value)) throw new Error('That does not look like a key.');
      if (value) keys[provider] = value; else delete keys[provider];
      await write(keysFile, keys);
    },
    async add({ provider, model, label, baseUrl }, taken) {
      const definition = PROVIDERS[provider];
      if (!definition) throw new Error('Unknown provider.');
      model = String(model || '').trim();
      if (!model || model.length > 120) throw new Error('Choose a model.');
      const url = clean(baseUrl);
      if (definition.custom || url) { let parsed; try { parsed = new URL(url); } catch { throw new Error('Enter the server address, for example http://127.0.0.1:8080/v1'); } if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The address must start with http or https.'); }
      if (saved.length >= 12) throw new Error('Twelve model agents is the limit.');
      // A short, mention-friendly id: "@sonnet", "@gpt", "@llama3" and so on, made unique.
      const base = (model.split('/').pop().toLowerCase().replace(/^claude-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 16).replace(/-+$/, '') || provider).padEnd(2, 'x');
      let id = base; for (let n = 2; taken.includes(id) || saved.some(item => item.id === id); n++) id = base.slice(0, 20) + n;
      const entry = { id, provider, model, label: String(label || '').trim().slice(0, 40) || model.split('/').pop().slice(0, 40), ...(url ? { baseUrl: url } : {}) };
      saved.push(entry); await write(agentsFile, saved);
      return entry;
    },
    async remove(id) { saved = saved.filter(item => item.id !== id); await write(agentsFile, saved); },
  };
}
