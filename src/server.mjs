import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveAgents, agentEnv, policyFor } from './agents.mjs';
import { runAgent } from './runner.mjs';
import { createDemoRunner } from './demo.mjs';
import { KINDS, MAX_ENTRY, parseBoard, visibleText } from './board.mjs';
import { qrRows } from './qr.mjs';
import { lanAddresses, startTunnel, tunnelProvider } from './remote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
export const VERSION = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8')).version;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMITS = { messageCharacters: 8000, briefCharacters: 12000, turnsPerConversation: 200, historyTurns: 12, historyCharacters: 60000, replyInHistory: 6000, boardEntries: 200, perMinute: 10, perHour: 120, devices: 12 };
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['icon-192.png', 'image/png'],
};
const BASE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

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
  const agents = resolveAgents(config);
  if (!agents.length) throw new Error('No agents configured.');
  const run = runner || (config.demo ? createDemoRunner() : runAgent);
  const runtime = config.dataDir;
  const scratch = path.join(runtime, 'workspace');
  await fs.mkdir(path.join(runtime, 'conversations'), { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  // Agents always start in the project folder, so their sessions show up under that project in their own apps.
  const workDir = config.projectDir;
  const env = agentEnv(process.env, config);

  const ownerCookie = randomBytes(32).toString('hex');
  const clients = new Map(); // response -> role
  const pairTokens = new Map(); // token -> expiry
  const pairAttempts = [];
  const recent = [];
  let active = null, writes = Promise.resolve(), state, index, devices = [];

  const newConversation = () => ({ id: randomUUID(), createdAt: new Date().toISOString(), brief: config.brief, board: [], turns: [], sessions: {} });

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
  try { devices = await readJSON(path.join(runtime, 'devices.json')); } catch { devices = []; }
  for (const turn of state.turns) for (const reply of Object.values(turn.replies)) {
    if (['queued', 'running'].includes(reply.status)) Object.assign(reply, { status: 'error', error: 'Shared Table restarted before this request finished. It was not retried.' });
  }

  const persist = () => {
    const snapshot = structuredClone(state), rows = structuredClone(index), list = structuredClone(devices);
    writes = writes.catch(() => {}).then(async () => {
      await writeAtomic(path.join(runtime, 'conversations', snapshot.id + '.json'), snapshot);
      await writeAtomic(path.join(runtime, 'current.json'), { id: snapshot.id });
      await writeAtomic(path.join(runtime, 'index.json'), rows);
      await writeAtomic(path.join(runtime, 'devices.json'), list);
    });
    return writes;
  };
  await persist();

  // ------------------------------------------------------------------ agent status
  let statuses = Object.fromEntries(agents.map(agent => [agent.id, { ready: false, checking: true, error: 'Checking…' }]));
  const checkAgent = async agent => {
    if (config.demo) return { ready: true, route: 'Demo: scripted replies' };
    if (authenticate) return authenticate(agent);
    if (!agent.path) return { ready: false, error: agent.install };
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
    project: { name: config.name, mode: config.mode, sessions: config.sessions, folder: role === 'owner' ? config.projectDir : path.basename(config.projectDir) },
    agents: agents.map(agent => ({ id: agent.id, label: agent.label, vendor: agent.vendor, color: agent.color, experimental: !!agent.experimental, ...statuses[agent.id],
      ...(role === 'owner' && state.sessions?.[agent.id] && agent.resumeCommand ? { session: state.sessions[agent.id], resume: agent.resumeCommand(state.sessions[agent.id], config.projectDir) } : {}) })),
    conversation: state, conversations: index, active: active?.turnId || null, limits: LIMITS,
    ...(role === 'owner' ? { remote: {
      lan: remote.lan.map(entry => entry.url), lanAvailable: lanAddresses().length > 0,
      tunnel: remote.tunnel?.url || config.publicUrl || null, tunnelStatus: config.publicUrl ? 'on' : remote.tunnelStatus, tunnelError: remote.tunnelError,
      tunnelProvider: config.publicUrl ? 'Your own address' : remote.tunnel?.provider || tunnelProvider()?.label || null,
      devices: devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
    } } : {}),
  });
  const send = (res, event) => { if (!res.write('data: ' + JSON.stringify(event) + '\n\n')) { /* slow client: keep, SSE is small */ } };
  const broadcast = event => { for (const res of clients.keys()) send(res, event); };
  const broadcastState = () => { for (const [res, role] of clients) send(res, { type: 'state', ...view(role) }); };

  // Show paths relative to the project folder, not the full path on this computer.
  const relative = activity => (activity || []).map(step => ({ tool: step.tool, detail: String(step.detail || '').split(config.projectDir + path.sep).join('') }));

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
      user: turn.message, kind: turn.kind,
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
  async function startTurn({ clientId, message, explicitTargets, kind, from, order }) {
    const previous = state.turns.find(turn => turn.clientId === clientId);
    if (previous) return { status: 200, body: { turnId: previous.id, duplicate: true } };
    if (state.turns.length >= LIMITS.turnsPerConversation) return { status: 409, body: { error: 'This conversation is full. Start a new one; this one stays saved.' } };
    while (recent.length && recent[0] < now() - 3600000) recent.shift();
    if (recent.length >= LIMITS.perHour || recent.filter(time => time > now() - 60000).length >= LIMITS.perMinute) return { status: 429, body: { error: 'Slow down: ' + LIMITS.perMinute + ' messages per minute, ' + LIMITS.perHour + ' per hour.' } };

    let targets, requests = {};
    if (kind === 'review') {
      const last = state.turns.at(-1);
      const done = last ? Object.entries(last.replies).filter(([, reply]) => reply.status === 'complete') : [];
      if (done.length < 2) return { status: 409, body: { error: 'Cross-review needs at least two finished answers in the last turn.' } };
      targets = done.map(([id]) => id);
      for (const id of targets) requests[id] = { kind: 'review', instruction: 'Review the other answers to the last user message. Say what you agree with, what you would change and why, then give the plan you would now follow. Do not repeat your own earlier answer.', yourAnswer: last.replies[id].text.slice(0, LIMITS.replyInHistory), otherAnswers: Object.fromEntries(done.filter(([other]) => other !== id).map(([other, reply]) => [other, reply.text.slice(0, LIMITS.replyInHistory)])) };
      message = message || 'Review each other\'s answers and converge on one plan.';
    } else {
      targets = targetsFor(message, explicitTargets);
      for (const id of targets) requests[id] = { kind: 'message', userMessage: message };
    }

    recent.push(now());
    if (targets.length < 2 || kind === 'review') order = 'parallel';
    const before = state.turns.slice();
    const turn = { id: randomUUID(), clientId, createdAt: new Date().toISOString(), kind, message, from, targets, order, replies: Object.fromEntries(targets.map(id => [id, { status: 'queued', text: '', activity: [] }])) };
    state.turns.push(turn);
    const entry = index.find(row => row.id === state.id);
    if (state.turns.length === 1 && entry) entry.title = message.replace(/\s+/g, ' ').slice(0, 70);
    const controller = new AbortController();
    active = { turnId: turn.id, controller };
    try { await persist(); } catch { active = null; state.turns.pop(); return { status: 503, body: { error: 'The conversation could not be saved. No request was started.' } }; }
    broadcastState();

    const conversationId = state.id;
    state.sessions ||= {};
    const runOne = async id => {
      const agent = agents.find(item => item.id === id);
      if (controller.signal.aborted) { turn.replies[id] = { status: 'cancelled', text: '', activity: [] }; return; }
      Object.assign(turn.replies[id], { status: 'running' });
      broadcast({ type: 'reply', turnId: turn.id, agent: id, reply: turn.replies[id] });
      // One after another: later agents receive what earlier agents wrote in this same turn.
      const earlier = Object.fromEntries(targets.slice(0, targets.indexOf(id)).filter(other => turn.replies[other].status === 'complete').map(other => [other, turn.replies[other].text.slice(0, LIMITS.replyInHistory)]));
      const request = order === 'sequence' && Object.keys(earlier).length ? { ...requests[id], earlierInThisTurn: earlier, note: 'The agents listed in earlierInThisTurn already finished their part of this message. Do your part now, taking their work into account.' } : requests[id];
      const session = config.sessions === 'native' ? { id: state.sessions[id] || randomUUID(), resume: !!state.sessions[id] } : null;
      let last = 0;
      const result = await run(agent, promptFor(agent, request, before), {
        mode: config.mode, config, policy: policyFor(agent, agents, config.mode), cwd: workDir, signal: controller.signal, env, session,
        onUpdate: change => {
          Object.assign(turn.replies[id], { text: visibleText(change.text), model: change.model, activity: relative(change.activity) });
          if (now() - last >= 90) { last = now(); broadcast({ type: 'reply', turnId: turn.id, agent: id, reply: turn.replies[id] }); }
        },
      }).catch(error => ({ status: 'error', text: '', error: 'The agent process failed: ' + String(error.message).slice(0, 200), activity: [] }));

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
        if (result.status === 'complete') state.sessions[id] = agent.id === 'claude' ? session.id : result.sessionId || session.id;
        else if (result.status === 'error' && session.resume) { delete state.sessions[id]; result.error = (result.error || '') + ' (Its saved session was dropped; the next message starts a fresh one.)'; }
      }
      turn.replies[id] = { status: result.status, text: parsed.text, ...(result.error ? { error: result.error } : {}), model: result.model || null, activity: relative(result.activity), durationMs: result.durationMs || 0, boardAdded: added.length, ...(session ? { session: session.resume ? 'resumed' : 'new' } : {}) };
      if (result.status === 'error' && /sign|log ?in|auth/i.test(result.error || '')) statuses[id] = { ready: false, error: result.error };
      await persist().catch(() => broadcast({ type: 'notice', error: 'The latest answers could not be saved. Download a copy now.' }));
      broadcastState();
    };
    const work = order === 'sequence' ? (async () => { for (const id of targets) await runOne(id); })() : Promise.all(targets.map(runOne));
    void work.catch(() => {}).finally(async () => {
      active = null;
      await persist().catch(() => {});
      broadcastState();
    });
    return { status: 202, body: { turnId: turn.id, targets } };
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
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON is required.' });
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

      if (pathname === '/api/cancel') { active?.controller.abort(); return json(res, 202, { cancelRequested: !!active }); }

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
        if (!UUID.test(value.clientId || '') || message.length > LIMITS.messageCharacters || (kind === 'message' && !message)) return json(res, 400, { error: 'Write a message of at most ' + LIMITS.messageCharacters + ' characters.' });
        if (typeof value.brief === 'string' && value.brief.length <= LIMITS.briefCharacters) state.brief = value.brief;
        const result = await startTurn({ clientId: value.clientId, message, explicitTargets: value.targets, kind, from, order: value.order === 'sequence' ? 'sequence' : 'parallel' });
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
      active?.controller.abort();
      remote.tunnel?.stop();
      for (const res of clients.keys()) res.end();
      await writes.catch(() => {});
      const servers = [main, ...remote.lan.map(entry => entry.server), ...(remote.tunnelServer ? [remote.tunnelServer] : [])];
      await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })));
    },
  };
}
