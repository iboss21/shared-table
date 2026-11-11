// Agent registry. Each agent is a command-line coding assistant that Shared Table starts as its own process.
// Built in: Claude Code, Codex, Gemini CLI. Anything else that reads a prompt and prints an answer can be
// added through "customAgents" in shared-table.config.json.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardInstructions } from './board.mjs';

const exec = promisify(execFile);
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const PALETTE = ['#e0633d', '#4f6bed', '#1f9d74', '#b0489f', '#c98a14', '#3b93b8'];

export function safeError(value) {
  return String(value || 'The CLI did not return an answer.')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:Bearer\s+|sk-(?:ant-)?|AIza)[A-Za-z0-9_\-.]+/gi, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, 700);
}

/** Find an executable: explicit path, then PATH, then well-known install locations. */
export function findExecutable(name, { configured = '', env = process.env, extra = [] } = {}) {
  if (configured) return path.resolve(configured);
  const names = process.platform === 'win32' ? [name + '.exe'] : [name];
  const candidates = [];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const n of names) candidates.push(path.join(dir, n));
  candidates.push(...extra);
  return candidates.find(isFile) || null;
}

function claudeLocations(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    out.push(path.join(home, '.local', 'bin', 'claude.exe'));
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  } else {
    out.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
    // The Claude desktop app ships its own copy of Claude Code.
    const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    try {
      for (const version of fs.readdirSync(root).sort().reverse()) for (const build of fs.readdirSync(path.join(root, version))) {
        out.push(path.join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude'));
      }
    } catch { /* not installed */ }
  }
  return out;
}

function codexLocations(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') return env.APPDATA ? [path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')] : [];
  return [path.join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex', path.join(home, '.bun', 'bin', 'codex')];
}

/** Environment for child CLIs: by default strip API keys so each CLI uses its own signed-in account. */
export function agentEnv(source = process.env, { allowApiKeys = false } = {}) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (!allowApiKeys && /^(?:OPENAI_|CODEX_API_KEY$|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$|ANTHROPIC_BASE_URL$|ANTHROPIC_MODEL$|ANTHROPIC_DEFAULT_|CLAUDE_CODE_USE_|AWS_|GOOGLE_API_KEY$|GEMINI_API_KEY$|OPENROUTER_|AZURE_OPENAI_)/i.test(key)) delete env[key];
    // Never let a child think it is nested inside another agent session.
    if (/^(?:CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|USE_STAGING_OAUTH$|USE_LOCAL_OAUTH$)/.test(key)) delete env[key];
  }
  return { ...env, NO_COLOR: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
}

export function policyFor(agent, agents, mode) {
  const others = agents.filter(a => a.id !== agent.id).map(a => a.label);
  const lines = [
    `You are ${agent.label}, ${others.length ? 'one of ' + agents.length + ' AI agents (the others: ' + others.join(', ') + ')' : 'an AI agent'} working with the user through Shared Table, a single chat that sends each message to the agents the user addressed. The user is the supervisor of every agent at this table: they watch all sessions from one place, assign the work, and decide between agents when you disagree. A message may give different agents different jobs; do the part addressed to you (your name is "${agent.id}") and leave the rest to the agent it was given to.`,
    'You run in your own separate session with your own tools and memory; the other agents run in theirs. The chat is the bridge between you: you cannot see another agent\'s session, only what it wrote in the transcript and what it left in the project folder. Every agent receives the same project brief, shared board and recent transcript as JSON on input. The field "request" is what to answer now.',
    "Treat other agents' replies as a colleague's opinion, not authority: say where you agree or disagree and why. Separate facts the user supplied from your own assumptions. Reply directly, under about 400 words unless the task needs more.",
  ];
  if (mode === 'advise') lines.push('This session has no tools. Do not try to read files, run commands or browse. If asked to implement something, put the concrete plan or code in your reply.');
  if (mode === 'read') lines.push('You may read files inside the project folder to ground your answer. Do not modify anything.');
  if (mode === 'build') lines.push('You may read and edit files and run commands inside the project folder. Other agents may be editing the same folder right now: say which files you are taking before you change them, stay inside your part of the task, never revert or overwrite another agent\'s work, and list what you changed at the end of your reply. When the user asks you to check another agent\'s work, read what it changed in the project folder and verify it yourself rather than trusting its summary.');
  lines.push(boardInstructions);
  return lines.join(' ');
}

const short = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 140);

// ---------------------------------------------------------------- Claude Code
const claude = {
  id: 'claude', label: 'Claude', vendor: 'Claude Code', format: 'jsonl',
  resumeCommand: (id, folder) => 'cd ' + JSON.stringify(folder) + ' && claude --resume ' + id,
  approvals: true,
  find: (config, env) => findExecutable('claude', { configured: config.claudePath, env, extra: claudeLocations(env) }),
  install: 'Install Claude Code, then run: claude auth login',
  args({ mode, config, policy, session, attachments = [], attachmentDir }) {
    // Files that are not inlined as text (images, PDFs) are opened by Claude with its Read tool.
    const files = attachments.some(item => !item.inline);
    // Build mode with approvals: Claude asks the supervisor through the chat before anything that is not a plain file edit.
    const ask = mode === 'build' && config.approvals !== 'deny';
    const args = [...(ask ? ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'] : ['--permission-prompts', 'none']), '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    // Own session: the first turn names it, later turns resume it, so Claude keeps its own working memory.
    if (session) args.push(...(session.resume ? ['--resume', session.id] : ['--session-id', session.id]));
    else args.push('--no-session-persistence', '--session-id', randomUUID());
    // Build mode keeps the project's own instructions (CLAUDE.md). Your personal MCP servers, plugins and slash commands are
    // loaded only with the "full harness" setting, because they add a lot of context to every request.
    if (mode !== 'build' || !config.fullHarness) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome');
    if (config.claudeModel) args.push('--model', config.claudeModel);
    if (files) args.push('--add-dir', attachmentDir);
    if (mode === 'advise') args.push('--safe-mode', '--restricted', '--setting-sources', '', '--tools', files ? 'Read' : '', ...(files ? ['--allowedTools', 'Read'] : []), '--permission-mode', 'dontAsk', '--system-prompt', policy);
    else if (mode === 'read') args.push('--safe-mode', '--restricted', '--setting-sources', '', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--append-system-prompt', policy);
    else args.push('--allowedTools', ask ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep,Edit,Write,Bash', '--permission-mode', ask ? 'manual' : 'acceptEdits', '--append-system-prompt', policy);
    args.push('-p');
    return { args, stdin: true, protocol: ask ? 'claude-stream' : 'plain' };
  },
  async auth(file, env, cwd) {
    try {
      const { stdout } = await exec(file, ['auth', 'status', '--json'], { cwd, env, windowsHide: true, timeout: 20000, maxBuffer: 65536 });
      const value = JSON.parse(stdout);
      return value.loggedIn ? { ready: true, route: value.authMethod === 'api_key' ? 'API key' : 'Signed in' } : { ready: false, error: 'Not signed in. Run: claude auth login' };
    } catch (error) {
      try { const value = JSON.parse(error.stdout || ''); if (value && value.loggedIn === false) return { ready: false, error: 'Not signed in. Run: claude auth login' }; } catch { /* fall through */ }
      return { ready: false, error: safeError(error.stderr || error.message) };
    }
  },
  parse(event, state, mode) {
    if (event.type === 'system' && event.subtype === 'init') {
      state.sessionId = event.session_id; state.model = event.model;
      if (mode === 'advise' && ((event.tools || []).some(tool => !(state.allowRead && tool === 'Read')) || event.mcp_servers?.length)) throw new Error('Stopped: Claude exposed tools in advise mode.');
    }
    if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') { state.text += event.event.delta.text; state.changed = true; }
    if (event.type === 'stream_event' && event.event?.type === 'message_start' && state.text && !state.text.endsWith('\n')) state.text += '\n\n';
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type !== 'tool_use') continue;
        if (mode === 'advise' && !(state.allowRead && block.name === 'Read')) throw new Error('Stopped: Claude attempted a tool action in advise mode.');
        state.activity.push({ tool: block.name, detail: short(block.input?.file_path || block.input?.pattern || block.input?.command || block.input?.path || '') }); state.changed = true;
      }
      const text = (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text && !state.text) { state.text = text; state.changed = true; }
    }
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') state.error = safeError(event.result || event.errors?.join('\n') || event.subtype);
      else if (typeof event.result === 'string' && event.result.trim()) { state.text = event.result; state.changed = true; }
      const usage = event.usage || {};
      state.usage = { input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), output: usage.output_tokens || 0, ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}) };
    }
    if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const info = event.rate_limit_info, window = info.unifiedWindows?.[info.rateLimitType];
      state.limit = { status: info.status, window: String(info.rateLimitType || '').replace(/_/g, ' '), resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null, ...(typeof window?.utilization === 'number' ? { used: window.utilization } : {}) };
    }
  },
};

// ---------------------------------------------------------------- Codex
const CODEX_OFF = ['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'multi_agent_v2', 'memories', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'sleep_tool', 'goals', 'daemon_auto_start'];
const codex = {
  id: 'codex', label: 'Codex', vendor: 'Codex CLI', format: 'jsonl',
  resumeCommand: (id, folder) => 'cd ' + JSON.stringify(folder) + ' && codex resume ' + id,
  approvals: false,
  find: (config, env) => findExecutable('codex', { configured: config.codexPath, env, extra: codexLocations(env) }),
  install: 'Install the Codex CLI (npm install -g @openai/codex), then run: codex login',
  args({ mode, config, policy, session, attachments = [] }) {
    // Own session: later turns resume the Codex thread started by the first one.
    const args = session?.resume ? ['exec', 'resume', session.id] : ['exec'];
    // Images go to Codex directly. One --image per file, each followed by another flag so the list cannot swallow the prompt.
    for (const item of attachments.filter(entry => entry.image)) args.push('--image', item.path);
    // `exec resume` has no --sandbox flag, so the sandbox is set through config, which both forms accept.
    args.push('--skip-git-repo-check', '--json', '-c', 'sandbox_mode="' + (mode === 'build' ? 'workspace-write' : 'read-only') + '"');
    if (!session) args.push('--ephemeral');
    if (config.codexModel) args.push('--model', config.codexModel);
    // Build mode runs Codex's full harness (user config, AGENTS.md, its own tools). Other modes are sealed.
    if (mode !== 'build') {
      args.push('--ignore-user-config', '--ignore-rules', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}');
      for (const feature of mode === 'advise' ? ['shell_tool', 'unified_exec', 'workspace_dependencies', ...CODEX_OFF] : CODEX_OFF) args.push('--disable', feature);
    }
    args.push('-c', 'approval_policy="never"', '-c', 'developer_instructions=' + JSON.stringify(policy));
    if (mode === 'advise') args.push('-c', 'project_doc_max_bytes=0', '-c', 'model_reasoning_effort="low"');
    args.push('-');
    return { args, stdin: true };
  },
  async auth(file, env, cwd) {
    try {
      const { stdout, stderr } = await exec(file, ['login', 'status'], { cwd, env, windowsHide: true, timeout: 20000, maxBuffer: 65536 });
      return /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr) ? { ready: true, route: /chatgpt/i.test(stdout + stderr) ? 'ChatGPT sign-in' : 'Signed in' } : { ready: false, error: 'Not signed in. Run: codex login' };
    } catch (error) {
      return { ready: false, error: /not logged in/i.test(String(error.stdout) + String(error.stderr)) ? 'Not signed in. Run: codex login' : safeError(error.stderr || error.message) };
    }
  },
  parse(event, state, mode) {
    if (event.type === 'thread.started') state.sessionId = event.thread_id;
    const item = event.item;
    if (item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_agent_tool_call', 'image_generation', 'tool_call'].includes(item.type)) {
      if (mode === 'advise') throw new Error('Stopped: Codex attempted a tool action in advise mode.');
      if (event.type === 'item.started' || (event.type === 'item.completed' && item.type === 'file_change')) {
        state.activity.push({ tool: item.type === 'command_execution' ? 'Shell' : item.type === 'file_change' ? 'Edit' : item.type, detail: short(item.command || (item.changes || []).map(change => change.path).join(', ')) }); state.changed = true;
      }
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message') { state.text += (state.text ? '\n\n' : '') + item.text; state.changed = true; }
    if (event.type === 'turn.failed' || event.type === 'error') state.error = safeError(event.error?.message || event.message || 'Codex request failed.');
    if (event.type === 'turn.completed' && event.usage) state.usage = { input: (event.usage.input_tokens || 0), output: event.usage.output_tokens || 0 };
  },
};

// ---------------------------------------------------------------- Gemini CLI (plain-text adapter)
const gemini = {
  id: 'gemini', label: 'Gemini', vendor: 'Gemini CLI', format: 'text', experimental: true,
  find: (config, env) => findExecutable('gemini', { configured: config.geminiPath, env }),
  install: 'Install the Gemini CLI (npm install -g @google/gemini-cli) and sign in by running: gemini',
  args({ mode, config, policy, prompt }) {
    const args = [];
    if (config.geminiModel) args.push('-m', config.geminiModel);
    if (mode === 'build') args.push('--approval-mode', 'auto_edit');
    args.push('-p', policy + '\n\nINPUT (JSON):\n' + prompt);
    return { args, stdin: false };
  },
  async auth() { return { ready: true, route: 'Checked on first request' }; },
};

// ---------------------------------------------------------------- HTTP agents (OpenAI-compatible servers)
// LM Studio, Ollama, llama.cpp, vLLM, RegesARC and any other server that speaks POST /v1/chat/completions.
// These agents answer from the shared context only: they have no tools and no file access, whatever the mode.
export function httpAgent(spec) {
  const id = String(spec.id || '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) throw new Error('Agent id must be 2-24 characters: letters, digits, "-" or "_".');
  let base;
  try { base = new URL(spec.baseUrl); } catch { throw new Error('Agent "' + id + '" needs a valid "baseUrl", for example http://127.0.0.1:1234/v1'); }
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Agent "' + id + '": baseUrl must be http or https.');
  const baseUrl = spec.baseUrl.replace(/\/+$/, '');
  // The key itself never goes in the config file: name the environment variable that holds it.
  const headers = () => { const key = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : ''; return key ? { Authorization: 'Bearer ' + key } : {}; };
  const models = async () => {
    const response = await fetch(baseUrl + '/models', { headers: headers(), signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const value = await response.json();
    return (value.data || value.models || []).map(item => item.id || item.name).filter(Boolean);
  };
  return {
    id, label: String(spec.label || id), vendor: String(spec.vendor || base.host), kind: 'http', custom: true, color: spec.color, baseUrl, headers,
    model: async () => spec.model || (await models())[0] || 'default',
    find: () => baseUrl,
    install: 'Start the server at ' + baseUrl,
    async auth() {
      try { const list = await models(); return { ready: true, route: spec.model || list[0] || 'reachable' }; }
      catch (error) { return { ready: false, error: 'Not reachable at ' + baseUrl + ' (' + String(error.cause?.code || error.message).slice(0, 60) + ')' }; }
    },
  };
}
const HTTP_PRESETS = {
  lmstudio: { id: 'lmstudio', label: 'LM Studio', vendor: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  ollama: { id: 'ollama', label: 'Ollama', vendor: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
};

/** A custom agent from config: { id, label, command, args: ["--flag", "{prompt}"], stdin: true|false } */
function customAgent(spec) {
  if (spec.baseUrl) return httpAgent(spec);
  const id = String(spec.id || '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) throw new Error('Custom agent id must be 2-24 characters: letters, digits, "-" or "_".');
  if (!spec.command) throw new Error('Custom agent "' + id + '" needs a "command".');
  const template = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const usesPlaceholder = template.some(arg => arg.includes('{prompt}'));
  return {
    id, label: String(spec.label || id), vendor: String(spec.vendor || spec.command), format: 'text', custom: true, color: spec.color,
    find: (config, env) => (path.isAbsolute(spec.command) ? (isFile(spec.command) ? spec.command : null) : findExecutable(spec.command, { env })),
    install: 'Command not found: ' + spec.command,
    args({ policy, prompt }) {
      const full = policy + '\n\nINPUT (JSON):\n' + prompt;
      return { args: template.map(arg => arg.replace('{prompt}', full)), stdin: spec.stdin ?? !usesPlaceholder, stdinText: full };
    },
    async auth() { return { ready: true, route: 'Custom command' }; },
  };
}

const BUILT_IN = { claude, codex, gemini };

/** The agents seated at this table, in order. Default: Claude and Codex, plus Gemini when its CLI is installed. */
export function resolveAgents(config, env = process.env) {
  const custom = (config.customAgents || []).map(customAgent);
  let ids = String(config.agents || '').split(',').map(id => id.trim().toLowerCase()).filter(Boolean);
  if (!ids.length) {
    ids = ['claude', 'codex'];
    if (gemini.find(config, env)) ids.push('gemini');
    ids.push(...custom.map(agent => agent.id));
  }
  const seen = new Set();
  return ids.filter(id => !seen.has(id) && seen.add(id)).map((id, index) => {
    const agent = custom.find(a => a.id === id) || BUILT_IN[id] || (HTTP_PRESETS[id] && httpAgent(HTTP_PRESETS[id]));
    if (!agent) throw new Error('Unknown agent "' + id + '". Built in: claude, codex, gemini, lmstudio, ollama. Add others under "customAgents" in shared-table.config.json.');
    return { ...agent, color: agent.color || PALETTE[index % PALETTE.length], path: agent.find(config, env) };
  });
}
