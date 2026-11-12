import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveAgents, agentEnv, policyFor, httpAgent } from './agents.mjs';
import { createGateway } from './gateway.mjs';
import { runAgent } from './runner.mjs';
import { createDemoRunner } from './demo.mjs';
import { KINDS, MAX_ENTRY, parseBoard, visibleText } from './board.mjs';
import { qrRows } from './qr.mjs';
import { lanAddresses, startTunnel, tunnelProvider } from './remote.mjs';
import { projectDataDir } from './config.mjs';
import { isRepo, changedFiles, fileDiff, revertFile, ensureWorktree, applyWorktree, discardWorktree, removeWorktrees, runCommand } from './workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
export const VERSION = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8')).version;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMITS = { attachmentsPerMessage: 10, attachmentBytes: 15 * 1024 * 1024, inlineTextBytes: 200 * 1024, messageCharacters: 8000, briefCharacters: 12000, turnsPerConversation: 200, historyTurns: 12, historyCharacters: 60000, replyInHistory: 6000, boardEntries: 200, perMinute: 10, perHour: 120, devices: 12 };
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/pet.js': ['pet.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/partners.json': ['partners.json', 'application/json; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['icon-192.png', 'image/png'],
};
const BASE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; frame-src http://localhost:* http://127.0.0.1:* https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const INLINE_IMAGES = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1 };
const TEXT_FILE = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env\.example|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|sql|sh|zsh|bash|ps1|bat|diff|patch|vue|svelte|gradle|dockerfile|conf|cfg)$/i;
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeAtomic(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';

export async function createTable({ config, runner, authenticate, now = () => Date.now(), tunnel = startTunnel } = {}) {
  const gateway = await createGateway(config.dataRoot);
  const seated = resolveAgents(config);
  const GATEWAY_COLORS = ['#1f9d74', '#b0489f', '#c98a14', '#3b93b8', '#7a5af5', '#d3546e'];
  // Everyone at the table: the CLI and config agents first, then the model agents added through the gateway.
  const withGateway = () => [...seated, ...gateway.specs().filter(spec => !seated.some(agent => agent.id === spec.id)).map((spec, i) => { const agent = httpAgent(spec); return { ...agent, color: GATEWAY_COLORS[i % GATEWAY_COLORS.length], path: agent.baseUrl }; })];
  let agents = withGateway();
  if (!agents.length) throw new Error('No agents configured.');
  const run = runner || (config.demo ? createDemoRunner() : runAgent);
  let runtime = config.dataDir, attachRoot = path.join(runtime, 'attachments'), repo = false;
  const scratch = path.join(config.dataRoot, 'workspace');
  await fs.mkdir(scratch, { recursive: true });
  const env = agentEnv(process.env, config);
  const SETTINGS = { mode: ['advise', 'read', 'build'], sessions: ['native', 'stateless'], isolation: ['shared', 'worktree'], approvals: ['ask', 'deny'], terminal: [true, false], fullHarness: [true, false], phoneApprovals: [true, false] };
  const approvals = new Map(); // id -> { turnId, agent, tool, detail, resolve }
  const terminal = []; // newest last: { id, command, output, running, exitCode, startedAt, stop }

  const uploads = new Map(); // id -> attachment waiting to be sent with a message
  const ownerCookie = randomBytes(32).toString('hex');
  const clients = new Map(); // response -> role
  const pairTokens = new Map(); // token -> expiry
  const pairAttempts = [];
  const recent = [];
  let active = null, writes = Promise.resolve(), state, index, devices = [];
  config.projectDirAtStart = config.projectDir;

  const newConversation = () => ({ id: randomUUID(), createdAt: new Date().toISOString(), brief: config.brief, board: [], turns: [], sessions: {} });

  // Load (or create) the conversation store of the current project folder.
  async function loadStore() {
  await fs.mkdir(path.join(runtime, 'conversations'), { recursive: true });
  repo = await isRepo(config.projectDir);
  try { const saved = await readJSON(path.join(runtime, 'settings.json')); for (const [key, allowed] of Object.entries(SETTINGS)) if (allowed.includes(saved[key])) config[key] = saved[key]; } catch { /* defaults */ }
  try {
    index = await readJSON(path.join(runtime, 'index.json'));
    const current = await readJSON(path.join(runtime, 'current.json'));
    if (!Array.isArray(index) || !UUID.test(current.id) || !index.some(row => row.id === current.id)) throw Object.assign(new Error('bad index'), { code: 'ENOENT' });
    state = await readJSON(path.join(runtime, 'conversations', current.id + '.json'));
    state.board ||= []; state.turns ||= [];
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    state = newConversation();
    index = [{ id: state.id, createdAt: state.createdAt, title: 'New conversation' }];
  }
  for (const turn of state.turns) for (const reply of Object.values(turn.replies)) {
    if (['queued', 'running'].includes(reply.status)) Object.assign(reply, { status: 'error', error: 'Shared Table restarted before this request finished. It was not retried.' });
  }
  }
  await loadStore();
  try { devices = await readJSON(path.join(config.dataRoot, 'devices.json')); } catch { try { devices = await readJSON(path.join(runtime, 'devices.json')); } catch { devices = []; } }

  // Known projects, newest first, for the project switcher.
  const projectsFile = path.join(config.dataRoot, 'projects.json');
  let projects = [];
  try { projects = (await readJSON(projectsFile)).filter(item => item && typeof item.folder === 'string'); } catch { /* first run */ }
  const rememberProject = async () => {
    projects = [{ folder: config.projectDir, name: config.name }, ...projects.filter(item => item.folder !== config.projectDir)].slice(0, 30);
    await writeAtomic(projectsFile, projects).catch(() => {});
  };
  await rememberProject();

  const persist = () => {
    const snapshot = structuredClone(state), rows = structuredClone(index), list = structuredClone(devices), folder = runtime;
    writes = writes.catch(() => {}).then(async () => {
      const runtime = folder;
      await writeAtomic(path.join(runtime, 'conversations', snapshot.id + '.json'), snapshot);
      await writeAtomic(path.join(runtime, 'current.json'), { id: snapshot.id });
      await writeAtomic(path.join(runtime, 'index.json'), rows);
      await writeAtomic(path.join(config.dataRoot, 'devices.json'), list);
    });
    return writes;
  };
  await persist();

  // ------------------------------------------------------------------ agent status
  let statuses = Object.fromEntries(agents.map(agent => [agent.id, { ready: false, checking: true, error: 'Checking…' }]));
  const checkAgent = async agent => {
    if (config.demo) return { ready: true, route: 'Demo: scripted replies' };
    if (authenticate) return authenticate(agent);
    if (agent.kind !== 'http' && !agent.path) return { ready: false, error: agent.install };
    return agent.auth(agent.path, env, scratch);
  };
  const updateStatus = async () => {
    statuses = Object.fromEntries(await Promise.all(agents.map(async agent => [agent.id, await checkAgent(agent).catch(error => ({ ready: false, error: String(error.message) }))])));
    broadcastState();
  };

  // ------------------------------------------------------------------ phone access
  const remote = { lan: [], tunnel: null, tunnelStatus: 'off', tunnelError: null, tunnelServer: null };
  const view = role => ({
    version: VERSION, role, demo: !!config.demo,
    project: { name: config.name, mode: config.mode, sessions: config.sessions, folder: role === 'owner' ? config.projectDir : path.basename(config.projectDir), repo },
    settings: Object.fromEntries(Object.keys(SETTINGS).map(key => [key, config[key]])),
    approvals: [...approvals.entries()].map(([id, item]) => ({ id, turnId: item.turnId, agent: item.agent, tool: item.tool, detail: item.detail })),
    canApprove: role === 'owner' || config.phoneApprovals,
    agents: agents.map(agent => ({ id: agent.id, label: agent.label, vendor: agent.vendor, color: agent.color, icon: ['claude', 'codex', 'gemini'].includes(agent.id) ? agent.id : agent.kind === 'http' ? (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(agent.baseUrl) ? 'local' : 'api') : 'cli', experimental: !!agent.experimental, approvals: !!agent.approvals, gateway: !!agent.gateway, tools: agent.kind !== 'http', ...statuses[agent.id], ...(limits[agent.id] ? { limit: limits[agent.id] } : {}),
      ...(role === 'owner' && state.sessions?.[agent.id] && agent.resumeCommand ? { session: state.sessions[agent.id], resume: agent.resumeCommand(state.sessions[agent.id], workDirFor(agent.id)) } : {}) })),
    conversation: state, conversations: index, active: active?.turnId || null, limits: LIMITS,
    ...(role === 'owner' ? { gateway: { providers: gateway.providers(), agents: gateway.list() }, projects, terminal: config.terminal ? terminal.map(({ stop, ...entry }) => ({ ...entry, output: entry.output.slice(-20000) })) : null, remote: {
      lan: remote.lan.map(entry => entry.url), lanAvailable: lanAddresses().length > 0,
      tunnel: remote.tunnel?.url || config.publicUrl || null, tunnelStatus: config.publicUrl ? 'on' : remote.tunnelStatus, tunnelError: remote.tunnelError,
      tunnelProvider: config.publicUrl ? 'Your own address' : remote.tunnel?.provider || tunnelProvider()?.label || null,
      devices: devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
    } } : {}),
  });
  const send = (res, event) => { if (!res.write('data: ' + JSON.stringify(event) + '\n\n')) { /* slow client: keep, SSE is small */ } };
  const broadcast = event => { for (const res of clients.keys()) send(res, event); };
  const broadcastState = () => { for (const [res, role] of clients) send(res, { type: 'state', ...view(role) }); };

  const limits = {}; // agent id -> latest usage-limit information reported by its CLI
  // Where an agent works: the project folder, or its own git worktree in build mode with isolation on.
  const isolated = () => config.mode === 'build' && config.isolation === 'worktree' && repo;
  const worktreeRoot = () => path.join(runtime, 'worktrees', state.id);
  const workDirFor = id => (isolated() && agents.find(agent => agent.id === id)?.kind !== 'http' ? path.join(worktreeRoot(), id) : config.projectDir);

  // Show paths relative to the project folder, not the full path on this computer.
  const relative = activity => (activity || []).map(step => ({ tool: step.tool, detail: String(step.detail || '').replace(/^.*[\\/]worktrees[\\/][a-f0-9-]{36}[\\/][a-z0-9_-]+[\\/]/, '').split(config.projectDir + path.sep).join('').replace(/^.*[\\/]attachments[\\/][a-f0-9-]{36}[\\/][a-f0-9]{18}-/, 'attached: ') }));

  // ------------------------------------------------------------------ prompt
  const mentionPattern = /(^|[\s(])@([a-z][a-z0-9_-]{1,23})\b/gi;
  const targetsFor = (message, explicit) => {
    const ids = new Set();
    if (Array.isArray(explicit)) for (const id of explicit) if (agents.some(agent => agent.id === id)) ids.add(id);
    let all = false;
    for (const match of message.matchAll(mentionPattern)) {
      const id = match[2].toLowerCase();
      if (id === 'all' || id === 'everyone') all = true;
      else if (agents.some(agent => agent.id === id)) ids.add(id);
    }
    return all || !ids.size ? agents.map(agent => agent.id) : agents.map(agent => agent.id).filter(id => ids.has(id));
  };
  const promptFor = (agent, request, turns) => {
    const history = turns.slice(-LIMITS.historyTurns).map(turn => ({
      user: turn.message, kind: turn.kind, ...(turn.attachments ? { attachedFiles: turn.attachments.map(item => item.name) } : {}),
      replies: Object.fromEntries(Object.entries(turn.replies).map(([id, reply]) => [id, reply.status === 'complete' ? reply.text.slice(0, LIMITS.replyInHistory) : '[' + reply.status + ']'])),
    }));
    const output = () => JSON.stringify({
      project: config.name, mode: config.mode, you: agent.id, agents: agents.map(a => a.id), brief: state.brief,
      board: state.board.map(({ kind, text, author, done }) => ({ kind, text, author, ...(kind === 'task' ? { done: !!done } : {}) })),
      sharedHistory: history,
      historyNote: 'At most ' + LIMITS.historyTurns + ' recent turns; long replies are shortened. Agents that were not addressed in a turn have no entry for it.',
      request,
    });
    while (history.length && output().length > LIMITS.historyCharacters) history.shift();
    return output();
  };

  // ------------------------------------------------------------------ HTTP helpers
  const json = (res, status, value, extra = {}) => { res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(value)); };
  async function readBody(req) {
    let size = 0; const chunks = [];
    const timer = setTimeout(() => req.destroy(), 8000);
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('body_too_large'); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } finally { clearTimeout(timer); }
  }
  const deviceFor = req => {
    const [id, secret] = cookieOf(req, 'st_device').split('.');
    if (!id || !secret) return null;
    const device = devices.find(item => item.id === id);
    return device && same(sha(secret), device.hash) ? device : null;
  };

  // ------------------------------------------------------------------ actions
  async function startTurn({ clientId, message, explicitTargets, kind, from, order, attachmentIds = [] }) {
    const previous = state.turns.find(turn => turn.clientId === clientId);
    if (previous) return { status: 200, body: { turnId: previous.id, duplicate: true } };
    if (state.turns.length >= LIMITS.turnsPerConversation) return { status: 409, body: { error: 'This conversation is full. Start a new one; this one stays saved.' } };
    while (recent.length && recent[0] < now() - 3600000) recent.shift();
    if (recent.length >= LIMITS.perHour || recent.filter(time => time > now() - 60000).length >= LIMITS.perMinute) return { status: 429, body: { error: 'Slow down: ' + LIMITS.perMinute + ' messages per minute, ' + LIMITS.perHour + ' per hour.' } };

    let targets;
    if (kind === 'review') {
      const last = state.turns.at(-1);
      const done = last ? Object.entries(last.replies).filter(([, reply]) => reply.status === 'complete') : [];
      if (done.length < 2) return { status: 409, body: { error: 'Cross-review needs at least two finished answers in the last turn.' } };
      targets = done.map(([id]) => id);
      message = message || 'Review each other\'s answers and converge on one plan.';
    } else targets = targetsFor(message, explicitTargets);

    const attachments = [];
    for (const id of attachmentIds.slice(0, LIMITS.attachmentsPerMessage)) {
      const item = uploads.get(id);
      if (!item || item.conversation !== state.id) continue;
      uploads.delete(id);
      attachments.push(item);
    }

    recent.push(now());
    if (targets.length < 2 || kind === 'review') order = 'parallel';
    const turn = { id: randomUUID(), clientId, createdAt: new Date().toISOString(), kind, message, from, targets, order, ...(attachments.length ? { attachments: attachments.map(({ id, name, type, size, image }) => ({ id, name, type, size, image })) } : {}), replies: Object.fromEntries(targets.map(id => [id, { status: 'queued', text: '', activity: [] }])) };
    state.turns.push(turn);
    const entry = index.find(row => row.id === state.id);
    if (state.turns.length === 1 && entry && !entry.renamed) entry.title = message.replace(/\s+/g, ' ').slice(0, 70);
    active = { turnId: turn.id, controllers: new Map(), stopped: false };
    try { await persist(); } catch { active = null; state.turns.pop(); return { status: 503, body: { error: 'The conversation could not be saved. No request was started.' } }; }
    broadcastState();
    void runTurn(turn, targets);
    return { status: 202, body: { turnId: turn.id, targets } };
  }

  /** What each addressed agent is asked in this turn. Rebuilt from the saved turn, so a retry asks exactly the same thing. */
  async function buildRequests(turn, before) {
    const requests = {};
    if (turn.kind === 'review') {
      const last = before.at(-1), done = last ? Object.entries(last.replies).filter(([, reply]) => reply.status === 'complete') : [];
      for (const id of turn.targets) requests[id] = { kind: 'review', instruction: 'Review the other answers to the last user message. Say what you agree with, what you would change and why, then give the plan you would now follow. Do not repeat your own earlier answer.', yourAnswer: (last?.replies[id]?.text || '').slice(0, LIMITS.replyInHistory), otherAnswers: Object.fromEntries(done.filter(([other]) => other !== id).map(([other, reply]) => [other, reply.text.slice(0, LIMITS.replyInHistory)])) };
    } else for (const id of turn.targets) requests[id] = { kind: 'message', userMessage: turn.message };
    // Attachments: text files travel inside the prompt; images and other files are handed over by path.
    const attachments = (turn.attachments || []).map(item => ({ ...item, path: path.join(attachRoot, state.id, item.id + '-' + item.name) }));
    if (attachments.length) {
      const listed = [];
      for (const item of attachments) {
        const entry = { name: item.name, type: item.type, bytes: item.size, path: item.path };
        if (!item.image && item.size <= LIMITS.inlineTextBytes && (item.type.startsWith('text/') || /json|xml|javascript|yaml|toml/.test(item.type) || TEXT_FILE.test(item.name))) {
          const text = await fs.readFile(item.path).then(body => body.toString('utf8'), () => '\u0000');
          if (!text.includes('\u0000')) { entry.text = text; item.inline = true; }
        }
        listed.push(entry);
      }
      for (const id of turn.targets) Object.assign(requests[id], { attachments: listed, attachmentNote: 'The user attached these files to this message. Files with a "text" field are included in full. For the others (images, PDFs and so on) open the file at "path" with your file-reading tool, or use the image if it was passed to you directly.' });
    }
    return { requests, attachments };
  }

  /** Run the given agents of a turn: all at once, or one after another. Used for new turns and for retries. */
  async function runTurn(turn, ids) {
    const conversationId = state.id;
    const before = state.turns.slice(0, state.turns.indexOf(turn));
    state.sessions ||= {};
    let prepared;
    try { prepared = await buildRequests(turn, before); }
    catch (error) { for (const id of ids) turn.replies[id] = { status: 'error', text: '', error: 'Could not prepare the request: ' + String(error.message).slice(0, 200), activity: [] }; active = null; broadcastState(); return; }
    const { requests, attachments } = prepared;
    if (isolated()) {
      const paths = {};
      for (const id of turn.targets) if (agents.find(agent => agent.id === id).kind !== 'http') paths[id] = await ensureWorktree(config.projectDir, workDirFor(id), 'shared-table/' + state.id.slice(0, 8) + '/' + id).catch(() => null);
      for (const id of turn.targets) requests[id].workspace = { note: 'Each agent edits its own git worktree of the project. The supervisor applies finished work to the project folder. You can read another agent\'s worktree to check its work, but do not edit it.', yours: paths[id] || config.projectDir, others: Object.fromEntries(Object.entries(paths).filter(([other, value]) => other !== id && value)) };
    }

    const runOne = async id => {
      const agent = agents.find(item => item.id === id);
      const controller = new AbortController();
      active.controllers.set(id, controller);
      if (active.stopped) { turn.replies[id] = { status: 'cancelled', text: '', activity: [] }; return; }
      turn.replies[id] = { status: 'running', text: '', activity: [] };
      broadcast({ type: 'reply', turnId: turn.id, agent: id, reply: turn.replies[id] });
      // One after another: later agents receive what earlier agents wrote in this same turn.
      const earlier = Object.fromEntries(turn.targets.slice(0, turn.targets.indexOf(id)).filter(other => turn.replies[other].status === 'complete').map(other => [other, turn.replies[other].text.slice(0, LIMITS.replyInHistory)]));
      const request = turn.order === 'sequence' && Object.keys(earlier).length ? { ...requests[id], earlierInThisTurn: earlier, note: 'The agents listed in earlierInThisTurn already finished their part of this message. Do your part now, taking their work into account.' } : requests[id];
      const session = config.sessions === 'native' && agent.kind !== 'http' ? { id: state.sessions[id] || randomUUID(), resume: !!state.sessions[id] } : null;
      let last = 0, allowAll = false;
      const result = await run(agent, promptFor(agent, request, before), {
        mode: config.mode, config, policy: policyFor(agent, agents, agent.kind === 'http' ? 'advise' : config.mode), cwd: workDirFor(id), signal: controller.signal, env, session, attachments, attachmentDir: attachments.length ? path.dirname(attachments[0].path) : null,
        onUpdate: change => {
          Object.assign(turn.replies[id], { text: visibleText(change.text), model: change.model, activity: relative(change.activity) });
          if (now() - last >= 90) { last = now(); broadcast({ type: 'reply', turnId: turn.id, agent: id, reply: turn.replies[id] }); }
        },
        // The agent's harness asks before a command or other sensitive action: show it in the chat and wait for the supervisor.
        onApproval: request => {
          if (allowAll) return { allow: true };
          if (controller.signal.aborted) return { allow: false, message: 'The supervisor stopped this run.' };
          return new Promise(resolve => {
            const approvalId = randomUUID();
            const detail = String(request.input.command || request.input.file_path || request.input.url || request.input.path || request.description || JSON.stringify(request.input)).slice(0, 600);
            approvals.set(approvalId, { turnId: turn.id, agent: id, tool: request.tool, detail: relative([{ tool: '', detail }])[0].detail, resolve: decision => { approvals.delete(approvalId); if (decision === 'allow_turn') allowAll = true; broadcastState(); resolve(decision === 'deny' ? { allow: false, message: 'The supervisor denied this.' } : { allow: true }); } });
            broadcastState();
          });
        },
      }).catch(error => ({ status: 'error', text: '', error: 'The agent process failed: ' + String(error.message).slice(0, 200), activity: [] }));
      for (const item of approvals.values()) if (item.turnId === turn.id && item.agent === id) item.resolve('deny');

      const parsed = parseBoard(result.text || '');
      const added = [];
      if (result.status === 'complete' && state.id === conversationId) {
        for (const item of parsed.entries) {
          if (state.board.length >= LIMITS.boardEntries || state.board.some(existing => existing.text.toLowerCase() === item.text.toLowerCase())) continue;
          const row = { id: randomUUID(), kind: item.kind, text: item.text, author: id, done: false, createdAt: new Date().toISOString(), turnId: turn.id };
          state.board.push(row); added.push(row.id);
        }
      }
      if (session && state.id === conversationId) {
        if (result.status === 'complete') state.sessions[id] = agent.id === 'claude' ? session.id : result.sessionId || (session.resume ? session.id : null);
        if (!state.sessions[id]) delete state.sessions[id];
        else if (result.status === 'error' && session.resume) { delete state.sessions[id]; result.error = (result.error || '') + ' (Its saved session was dropped; the next message starts a fresh one.)'; }
      }
      if (result.limit) limits[id] = result.limit;
      if (result.status === 'error' && /usage limit|rate limit|quota/i.test(result.error || '')) limits[id] = { ...(limits[id] || {}), status: 'reached', message: result.error.slice(0, 200) };
      turn.replies[id] = { status: result.status, text: parsed.text, ...(result.error ? { error: result.error } : {}), model: result.model || null, activity: relative(result.activity), durationMs: result.durationMs || 0, boardAdded: added.length, ...(result.usage ? { usage: result.usage } : {}), ...(session ? { session: session.resume ? 'resumed' : 'new' } : {}) };
      if (result.status === 'error' && /sign|log ?in|auth/i.test(result.error || '')) statuses[id] = { ready: false, error: result.error };
      await persist().catch(() => broadcast({ type: 'notice', error: 'The latest answers could not be saved. Download a copy now.' }));
      broadcastState();
    };
    const work = turn.order === 'sequence' ? (async () => { for (const id of ids) await runOne(id); })() : Promise.all(ids.map(runOne));
    await work.catch(() => {});
    active = null;
    await persist().catch(() => {});
    broadcast({ type: 'done', turnId: turn.id });
    broadcastState();
  }

  /** Switch to another project folder: its own conversations, same agents and paired phones. */
  async function openProject(folder) {
    const full = path.resolve(folder.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('That folder does not exist.');
    await persist();
    config.projectDir = full; config.name = path.basename(full) || 'Project';
    runtime = config.dataDirExplicit && full === config.projectDirAtStart ? config.dataDir : projectDataDir(config.dataRoot, full);
    attachRoot = path.join(runtime, 'attachments');
    uploads.clear();
    await loadStore();
    await persist(); await rememberProject();
  }

  async function setLan(enabled) {
    for (const entry of remote.lan) await new Promise(resolve => entry.server.close(resolve));
    remote.lan = [];
    if (!enabled) return;
    for (const address of lanAddresses()) {
      const server = http.createServer((req, res) => handle(req, res, 'lan'));
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(mainPort(), address, resolve); });
        remote.lan.push({ server, host: address + ':' + mainPort(), url: 'http://' + address + ':' + mainPort() });
      } catch { /* address not bindable; skip */ }
    }
    if (!remote.lan.length) throw new Error('No Wi-Fi or LAN address is available on this computer.');
  }

  async function ensureTunnelServer() {
    if (remote.tunnelServer) return remote.tunnelServer.address().port;
    const server = http.createServer((req, res) => handle(req, res, 'tunnel'));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    remote.tunnelServer = server;
    return server.address().port;
  }
  async function setTunnel(enabled) {
    remote.tunnel?.stop(); remote.tunnel = null; remote.tunnelError = null; remote.tunnelStatus = 'off';
    if (!enabled) return;
    const port = await ensureTunnelServer();
    remote.tunnelStatus = 'starting'; broadcastState();
    try {
      remote.tunnel = await tunnel(port, { onExit: () => { remote.tunnel = null; remote.tunnelStatus = 'off'; remote.tunnelError = 'The tunnel closed.'; broadcastState(); } });
      remote.tunnelStatus = 'on';
    } catch (error) { remote.tunnelStatus = 'off'; remote.tunnelError = String(error.message).slice(0, 300); throw error; }
  }

  // ------------------------------------------------------------------ request handler
  const mainPort = () => main.address().port;
  async function handle(req, res, kind) {
    try {
      const host = req.headers.host || '';
      if (kind === 'local' && !['127.0.0.1:' + mainPort(), 'localhost:' + mainPort()].includes(host)) return json(res, 403, { error: 'Open Shared Table at http://127.0.0.1:' + mainPort() });
      if (kind === 'lan' && !remote.lan.some(entry => entry.host === host)) return json(res, 403, { error: 'Unknown address.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, 'http://' + (host || 'localhost'));
      const pathname = url.pathname;
      const secure = kind === 'tunnel';

      if (req.method === 'GET' && /^\/(pets|partners)\/[a-z0-9-]+\.(webp|png|jpg)$/.test(pathname)) {
        try {
          const body = await fs.readFile(path.join(publicDir, pathname.split('/')[1], path.basename(pathname)));
          res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': pathname.endsWith('.png') ? 'image/png' : pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/webp', 'Cache-Control': 'private, max-age=86400' });
          return res.end(body);
        } catch { return json(res, 404, { error: 'Not found.' }); }
      }
      if (req.method === 'GET' && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Content-Security-Policy': CSP };
        if (pathname === '/' && kind === 'local') headers['Set-Cookie'] = `st_owner=${ownerCookie}; HttpOnly; SameSite=Strict; Path=/`;
        if (pathname !== '/' && pathname.startsWith('/icon')) headers['Cache-Control'] = 'private, max-age=86400';
        res.writeHead(200, headers);
        return res.end(await fs.readFile(path.join(publicDir, file)));
      }

      const device = kind === 'local' ? null : deviceFor(req);
      const role = kind === 'local' ? (same(cookieOf(req, 'st_owner'), ownerCookie) ? 'owner' : null) : device ? 'device' : null;
      if (device && now() - (device.seenAt || 0) > 60000) { device.seenAt = now(); device.lastSeen = new Date().toISOString(); }

      if (req.method === 'POST') {
        let origin = null;
        try { origin = new URL(req.headers.origin || '').host; } catch { /* missing */ }
        if (origin !== host) return json(res, 403, { error: 'Same-origin requests only.' });
        if (pathname !== '/api/upload' && req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON is required.' });
      }

      // Pairing a phone: the only API call that works without a session.
      if (req.method === 'POST' && pathname === '/api/pair/claim') {
        while (pairAttempts.length && pairAttempts[0] < now() - 60000) pairAttempts.shift();
        if (pairAttempts.length >= 12) return json(res, 429, { error: 'Too many pairing attempts. Wait a minute.' });
        pairAttempts.push(now());
        const value = await readBody(req);
        const expiry = typeof value.token === 'string' ? pairTokens.get(value.token) : null;
        if (!expiry || expiry < now()) return json(res, 403, { error: 'This pairing code is not valid any more. Show a new QR code on the computer.' });
        if (kind === 'local') return json(res, 400, { error: 'This browser is already on the host computer.' });
        if (devices.length >= LIMITS.devices) return json(res, 409, { error: 'Too many paired devices. Remove one on the computer first.' });
        pairTokens.delete(value.token);
        const secret = randomBytes(32).toString('hex');
        const added = { id: randomBytes(6).toString('hex'), name: String(value.name || 'Phone').replace(/[^\w .,()\-]/g, '').slice(0, 40) || 'Phone', hash: sha(secret), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
        devices.push(added); await persist(); broadcastState();
        return json(res, 200, { paired: true }, { 'Set-Cookie': `st_device=${added.id}.${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}` });
      }

      if (!role) return json(res, 401, { error: kind === 'local' ? 'Open the Shared Table page first.' : 'This device is not paired. Scan the QR code shown on the computer.', needsPairing: kind !== 'local' });
      const from = role === 'owner' ? 'you' : device.name;

      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, view(role));

      // Attachments: upload the raw file, get an id back, send the id with the message.
      if (req.method === 'POST' && pathname === '/api/upload') {
        let name = 'file';
        try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
        name = path.basename(name).replace(/[^\w .()+@,=-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
        if (Number(req.headers['content-length']) > LIMITS.attachmentBytes) return json(res, 413, { error: 'Files can be at most ' + LIMITS.attachmentBytes / 1048576 + ' MB.' });
        if (uploads.size >= 60) return json(res, 429, { error: 'Too many files waiting. Send or remove some first.' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > LIMITS.attachmentBytes) return json(res, 413, { error: 'Files can be at most ' + LIMITS.attachmentBytes / 1048576 + ' MB.' }); chunks.push(chunk); }
        if (!size) return json(res, 400, { error: 'The file is empty.' });
        const id = randomBytes(9).toString('hex'), folder = path.join(attachRoot, state.id);
        await fs.mkdir(folder, { recursive: true });
        const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase().slice(0, 80);
        const item = { id, name, type, size, image: !!INLINE_IMAGES[type], conversation: state.id, path: path.join(folder, id + '-' + name) };
        await fs.writeFile(item.path, Buffer.concat(chunks), { mode: 0o600 });
        uploads.set(id, item);
        return json(res, 201, { id, name, type, size, image: item.image });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/file/')) {
        const id = pathname.slice(10);
        const item = uploads.get(id) || state.turns.flatMap(turn => turn.attachments || []).find(entry => entry.id === id);
        if (!item || !/^[a-f0-9]{18}$/.test(id)) return json(res, 404, { error: 'Not found.' });
        const file = item.path || path.join(attachRoot, state.id, id + '-' + item.name);
        try {
          const body = await fs.readFile(file);
          res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': INLINE_IMAGES[item.type] ? item.type : 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; sandbox", ...(INLINE_IMAGES[item.type] ? {} : { 'Content-Disposition': 'attachment; filename="' + item.name.replace(/"/g, '') + '"' }) });
          return res.end(body);
        } catch { return json(res, 404, { error: 'The file is gone.' }); }
      }
      if (req.method === 'GET' && pathname === '/api/export') return json(res, 200, state, { 'Content-Disposition': 'attachment; filename="shared-table-' + state.id + '.json"' });
      if (req.method === 'GET' && pathname === '/api/events') {
        if (clients.size >= 24) return json(res, 429, { error: 'Too many open tabs.' });
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        send(res, { type: 'state', ...view(role) });
        clients.set(res, role);
        const timer = setInterval(() => res.write(': alive\n\n'), 15000);
        res.on('close', () => { clearInterval(timer); clients.delete(res); });
        return;
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
      const value = await readBody(req);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json(res, 400, { error: 'Invalid request.' });

      if (pathname === '/api/cancel') {
        if (active && typeof value.agent === 'string') active.controllers.get(value.agent)?.abort();
        else if (active) { active.stopped = true; for (const controller of active.controllers.values()) controller.abort(); }
        for (const item of approvals.values()) if (!value.agent || item.agent === value.agent) item.resolve('deny');
        return json(res, 202, { cancelRequested: !!active });
      }
      if (pathname === '/api/approve') {
        if (role !== 'owner' && !config.phoneApprovals) return json(res, 403, { error: 'Approvals from phones are switched off in Settings.' });
        const item = approvals.get(value.id);
        if (!item || !['allow', 'allow_turn', 'deny'].includes(value.decision)) return json(res, 404, { error: 'That request was already answered.' });
        item.resolve(value.decision);
        return json(res, 200, { ok: true });
      }

      // Changes made in the project (or in each agent's worktree).
      if (pathname === '/api/changes' || pathname === '/api/diff' || pathname === '/api/revert' || pathname === '/api/worktree') {
        if (!repo) return json(res, 200, { repo: false, targets: [] });
        const places = isolated() ? [...agents.filter(agent => agent.kind !== 'http').map(agent => ({ id: agent.id, label: agent.label, dir: workDirFor(agent.id) })), { id: 'project', label: 'Project folder', dir: config.projectDir }] : [{ id: 'project', label: 'Project folder', dir: config.projectDir }];
        if (pathname === '/api/changes') {
          const targets = [];
          for (const place of places) { const files = await changedFiles(place.dir).catch(() => null); if (files) targets.push({ id: place.id, label: place.label, files }); }
          return json(res, 200, { repo: true, isolated: isolated(), targets });
        }
        const place = places.find(item => item.id === value.target);
        if (!place) return json(res, 400, { error: 'Unknown place.' });
        try {
          if (pathname === '/api/diff') return json(res, 200, { text: await fileDiff(place.dir, String(value.file || '')) });
          if (role !== 'owner') return json(res, 403, { error: 'Only the host computer can change files.' });
          if (active) return json(res, 409, { error: 'Wait for the agents to finish first.' });
          if (pathname === '/api/revert') { await revertFile(place.dir, String(value.file || '')); return json(res, 200, { ok: true }); }
          if (place.id === 'project') return json(res, 400, { error: 'Choose an agent worktree.' });
          if (value.op === 'apply') return json(res, 200, { applied: await applyWorktree(config.projectDir, place.dir) });
          if (value.op === 'discard') { await discardWorktree(place.dir); return json(res, 200, { ok: true }); }
          return json(res, 400, { error: 'Unknown operation.' });
        } catch (error) { return json(res, 400, { error: String(error.message).slice(0, 400) }); }
      }

      // Command panel, settings, projects and the model gateway: host computer only.
      if (pathname.startsWith('/api/terminal') || pathname.startsWith('/api/gateway') || pathname === '/api/settings' || pathname === '/api/project') {
        if (role !== 'owner') return json(res, 403, { error: 'Only the host computer can do this.' });
        if (pathname.startsWith('/api/gateway')) {
          try {
            if (pathname === '/api/gateway/models') return json(res, 200, { models: await gateway.models({ provider: value.provider, baseUrl: value.baseUrl }) });
            if (active) return json(res, 409, { error: 'Wait for the agents to finish first.' });
            if (pathname === '/api/gateway/key') await gateway.setKey(value.provider, value.key);
            else if (pathname === '/api/gateway/agent' && value.op === 'add') await gateway.add(value, [...agents.map(agent => agent.id), 'all', 'everyone', 'you']);
            else if (pathname === '/api/gateway/agent' && value.op === 'remove') await gateway.remove(String(value.id || ''));
            else return json(res, 404, { error: 'Not found.' });
          } catch (error) { return json(res, 400, { error: String(error.cause?.code || error.message).slice(0, 300) }); }
          agents = withGateway();
          void updateStatus();
          broadcastState();
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/terminal/run') {
          const command = String(value.command || '').trim();
          if (!config.terminal) return json(res, 403, { error: 'The command panel is switched off in Settings.' });
          if (!command || command.length > 4000) return json(res, 400, { error: 'Type a command.' });
          if (terminal.filter(entry => entry.running).length >= 3) return json(res, 429, { error: 'Three commands are already running.' });
          const entry = { id: randomBytes(6).toString('hex'), command, output: '', running: true, exitCode: null, startedAt: new Date().toISOString() };
          let last = 0;
          const push = () => { for (const [client, clientRole] of clients) if (clientRole === 'owner') send(client, { type: 'terminal', entry: { id: entry.id, command, running: entry.running, exitCode: entry.exitCode, startedAt: entry.startedAt, output: entry.output.slice(-20000) } }); };
          entry.stop = runCommand(command, { cwd: config.projectDir,
            onOutput: chunk => { entry.output = (entry.output + chunk).slice(-200000); if (now() - last > 120) { last = now(); push(); } },
            onExit: code => { entry.running = false; entry.exitCode = code; push(); } });
          terminal.push(entry); while (terminal.length > 30) terminal.shift();
          push();
          return json(res, 202, { id: entry.id });
        }
        if (pathname === '/api/terminal/stop') { terminal.find(entry => entry.id === value.id)?.stop?.(); return json(res, 202, { ok: true }); }
        if (pathname === '/api/terminal/clear') { for (let i = terminal.length - 1; i >= 0; i--) if (!terminal[i].running) terminal.splice(i, 1); broadcastState(); return json(res, 200, { ok: true }); }
        if (active) return json(res, 409, { error: 'Wait for the agents to finish first.' });
        if (pathname === '/api/settings') {
          for (const [key, allowed] of Object.entries(SETTINGS)) if (value[key] !== undefined) { if (!allowed.includes(value[key])) return json(res, 400, { error: 'Invalid value for ' + key + '.' }); config[key] = value[key]; }
          if (!value.timeoutSeconds) config.timeoutSeconds = config.mode === 'build' ? 900 : config.mode === 'read' ? 420 : 180;
          await writeAtomic(path.join(runtime, 'settings.json'), Object.fromEntries(Object.keys(SETTINGS).map(key => [key, config[key]])));
          broadcastState();
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/project') {
          try { await openProject(String(value.folder || '')); } catch (error) { return json(res, 400, { error: String(error.message).slice(0, 200) }); }
          broadcastState();
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'Not found.' });
      }
      if (pathname === '/api/retry') {
        const turn = state.turns.at(-1);
        if (active) return json(res, 409, { error: 'Wait for the agents to finish, or stop them first.' });
        if (!turn || !turn.targets.includes(value.agent)) return json(res, 400, { error: 'Nothing to retry.' });
        turn.replies[value.agent] = { status: 'queued', text: '', activity: [] };
        active = { turnId: turn.id, controllers: new Map(), stopped: false };
        broadcastState();
        void runTurn(turn, [value.agent]);
        return json(res, 202, { ok: true });
      }

      if (pathname === '/api/board') {
        if (value.op === 'add') {
          const text = String(value.text || '').trim().slice(0, MAX_ENTRY);
          if (!text || !KINDS.includes(value.kind)) return json(res, 400, { error: 'A board entry needs a kind and some text.' });
          if (state.board.length >= LIMITS.boardEntries) return json(res, 409, { error: 'The board is full.' });
          state.board.push({ id: randomUUID(), kind: value.kind, text, author: 'you', done: false, createdAt: new Date().toISOString() });
        } else if (value.op === 'toggle' || value.op === 'remove') {
          const position = state.board.findIndex(item => item.id === value.id);
          if (position < 0) return json(res, 404, { error: 'That entry is gone.' });
          if (value.op === 'toggle') state.board[position].done = !state.board[position].done; else state.board.splice(position, 1);
        } else return json(res, 400, { error: 'Unknown board operation.' });
        await persist(); broadcastState();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/brief') {
        if (typeof value.brief !== 'string' || value.brief.length > LIMITS.briefCharacters) return json(res, 400, { error: 'The brief is too long.' });
        state.brief = value.brief; await persist(); broadcastState();
        return json(res, 200, { ok: true });
      }

      // Rename, pin or group a conversation.
      if (pathname === '/api/conversation') {
        const row = index.find(item => item.id === value.id);
        if (!row) return json(res, 400, { error: 'Unknown conversation.' });
        if (typeof value.title === 'string') { const title = value.title.replace(/\s+/g, ' ').trim().slice(0, 80); if (!title) return json(res, 400, { error: 'A conversation needs a name.' }); row.title = title; row.renamed = true; }
        if (typeof value.pinned === 'boolean') row.pinned = value.pinned;
        if (typeof value.group === 'string') { const group = value.group.replace(/\s+/g, ' ').trim().slice(0, 40); if (group) row.group = group; else delete row.group; }
        await persist(); broadcastState();
        return json(res, 200, { ok: true });
      }

      // Owner-only: phone access management.
      if (pathname.startsWith('/api/remote') || pathname === '/api/pair/start' || pathname === '/api/pair/revoke') {
        if (role !== 'owner') return json(res, 403, { error: 'Only the host computer can manage phone access.' });
        if (pathname === '/api/pair/revoke') {
          devices = devices.filter(item => item.id !== value.id); await persist(); broadcastState();
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/remote') {
          try {
            if (typeof value.lan === 'boolean') await setLan(value.lan);
            if (typeof value.tunnel === 'boolean') await setTunnel(value.tunnel);
          } catch (error) { broadcastState(); return json(res, 502, { error: String(error.message).slice(0, 300) }); }
          broadcastState();
          return json(res, 200, view('owner').remote);
        }
        // /api/pair/start
        const base = value.via === 'tunnel' ? (config.publicUrl || remote.tunnel?.url) : remote.lan[0]?.url;
        if (!base) return json(res, 409, { error: value.via === 'tunnel' ? 'Turn on "Anywhere" first.' : 'Turn on "Same Wi-Fi" first.' });
        for (const [token, expiry] of pairTokens) if (expiry < now()) pairTokens.delete(token);
        const token = randomBytes(18).toString('base64url');
        pairTokens.set(token, now() + 10 * 60000);
        const link = base.replace(/\/$/, '') + '/#pair=' + token;
        return json(res, 200, { url: link, qr: qrRows(link), expiresInSeconds: 600, others: value.via === 'tunnel' ? [] : remote.lan.slice(1).map(entry => entry.url + '/#pair=' + token) });
      }

      if (active) return json(res, 409, { error: 'Wait for the agents to finish, or cancel first.' });

      if (pathname === '/api/new') {
        await persist(); state = newConversation(); index.push({ id: state.id, createdAt: state.createdAt, title: 'New conversation' });
        await persist(); broadcastState();
        return json(res, 201, { id: state.id });
      }
      if (pathname === '/api/switch') {
        if (!UUID.test(value.id) || !index.some(row => row.id === value.id)) return json(res, 400, { error: 'Unknown conversation.' });
        await persist(); state = await readJSON(path.join(runtime, 'conversations', value.id + '.json')); state.board ||= [];
        await persist(); broadcastState();
        return json(res, 200, { id: state.id });
      }
      if (pathname === '/api/delete') {
        if (role !== 'owner') return json(res, 403, { error: 'Only the host computer can delete conversations.' });
        if (!UUID.test(value.id) || !index.some(row => row.id === value.id)) return json(res, 400, { error: 'Unknown conversation.' });
        index = index.filter(row => row.id !== value.id);
        await fs.rm(path.join(runtime, 'conversations', value.id + '.json'), { force: true });
        await fs.rm(path.join(attachRoot, value.id), { recursive: true, force: true });
        if (repo) await removeWorktrees(config.projectDir, path.join(runtime, 'worktrees', value.id));
        if (state.id === value.id) {
          if (index.length) state = await readJSON(path.join(runtime, 'conversations', index.at(-1).id + '.json'));
          else { state = newConversation(); index.push({ id: state.id, createdAt: state.createdAt, title: 'New conversation' }); }
          state.board ||= [];
        }
        await persist(); broadcastState();
        return json(res, 200, { id: state.id });
      }
      if (pathname === '/api/message') {
        const kind = value.kind === 'review' ? 'review' : 'message';
        const message = typeof value.message === 'string' ? value.message.trim() : '';
        const attachmentIds = Array.isArray(value.attachments) ? value.attachments.filter(item => typeof item === 'string') : [];
        if (!UUID.test(value.clientId || '') || message.length > LIMITS.messageCharacters || (kind === 'message' && !message && !attachmentIds.length)) return json(res, 400, { error: 'Write a message of at most ' + LIMITS.messageCharacters + ' characters.' });
        if (typeof value.brief === 'string' && value.brief.length <= LIMITS.briefCharacters) state.brief = value.brief;
        const result = await startTurn({ clientId: value.clientId, message: message || (attachmentIds.length ? 'See the attached file' + (attachmentIds.length > 1 ? 's' : '') + '.' : ''), explicitTargets: value.targets, kind, from, attachmentIds, order: value.order === 'sequence' ? 'sequence' : 'parallel' });
        return json(res, result.status, result.body);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) json(res, error.message === 'body_too_large' ? 413 : 400, { error: error.message === 'body_too_large' ? 'The request is too large.' : 'The request could not be processed.' });
      else res.end();
    }
  }

  const main = http.createServer((req, res) => handle(req, res, 'local'));
  main.headersTimeout = 10000; main.maxHeadersCount = 60;
  await new Promise((resolve, reject) => { main.once('error', reject); main.listen(config.port, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + mainPort();

  const warnings = [];
  if (config.lan) await setLan(true).catch(error => warnings.push('Wi-Fi access: ' + error.message));
  if (config.publicUrl) await ensureTunnelServer();
  else if (config.tunnel) await setTunnel(true).catch(error => warnings.push('Tunnel: ' + error.message));
  const ready = updateStatus();

  return {
    origin, ready, warnings, agents, runtime,
    phonePort: () => remote.tunnelServer?.address().port || null,
    lanUrls: () => remote.lan.map(entry => entry.url),
    tunnelUrl: () => remote.tunnel?.url || config.publicUrl || null,
    state: () => view('owner'),
    close: async () => {
      if (active) for (const controller of active.controllers.values()) controller.abort();
      for (const item of approvals.values()) item.resolve('deny');
      for (const entry of terminal) entry.stop?.();
      remote.tunnel?.stop();
      for (const res of clients.keys()) res.end();
      await writes.catch(() => {});
      const servers = [main, ...remote.lan.map(entry => entry.server), ...(remote.tunnelServer ? [remote.tunnelServer] : [])];
      await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })));
    },
  };
}
