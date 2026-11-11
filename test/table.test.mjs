import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTable } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { resolveAgents, agentEnv, policyFor } from '../src/agents.mjs';
import { parseBoard, visibleText } from '../src/board.mjs';
import { qrMatrix } from '../src/qr.mjs';
import { runAgent } from '../src/runner.mjs';
import http from 'node:http';

// No test makes a model request: agents are replaced by mock runners.
async function table(t, { runner, argv = [], tunnel } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-table-test-'));
  const config = loadConfig({ argv: ['--port', '0', '--data-dir', dataDir, '--agents', 'claude,codex', '--name', 'Test', ...argv], env: {}, cwd: dataDir });
  const calls = [];
  const instance = await createTable({
    config, tunnel, authenticate: async () => ({ ready: true, route: 'mock' }),
    runner: runner || (async (agent, prompt, options) => { calls.push({ agent: agent.id, prompt: JSON.parse(prompt), session: options.session }); return { status: 'complete', text: agent.label + ' says hi\n\n```board\ntask: from ' + agent.id + '\n```', durationMs: 5, activity: [] }; }),
  });
  await instance.ready;
  t.after(async () => { await instance.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const page = await fetch(instance.origin + '/');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const post = (route, body, { origin = instance.origin, headers = {} } = {}) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...headers }, body: JSON.stringify(body) });
  const state = async () => (await fetch(instance.origin + '/api/state', { headers: { Cookie: cookie } })).json();
  const settle = async () => { for (let i = 0; i < 200; i++) { const value = await state(); if (!value.active) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('turn did not finish'); };
  return { instance, cookie, post, state, settle, calls, config };
}
const id = () => crypto.randomUUID();

test('one message reaches every agent with the same brief, and their board entries land on the shared board', async t => {
  const { post, settle, calls } = await table(t);
  assert.equal((await post('/api/message', { clientId: id(), message: 'Plan the launch' })).status, 202);
  const state = await settle();
  assert.deepEqual(calls.map(call => call.agent).sort(), ['claude', 'codex']);
  assert.equal(calls[0].prompt.brief, calls[1].prompt.brief);
  assert.equal(calls[0].prompt.request.userMessage, 'Plan the launch');
  const turn = state.conversation.turns[0];
  assert.equal(turn.replies.claude.text, 'Claude says hi');
  assert.deepEqual(state.conversation.board.map(item => [item.author, item.kind, item.text]), [['claude', 'task', 'from claude'], ['codex', 'task', 'from codex']].sort((a, b) => state.conversation.board.findIndex(i => i.author === a[0]) - state.conversation.board.findIndex(i => i.author === b[0])));
});

test('@mentions address one agent; unknown mentions fall back to everyone', async t => {
  const { post, settle, calls } = await table(t);
  await post('/api/message', { clientId: id(), message: '@codex check the tests' }); await settle();
  assert.deepEqual(calls.map(call => call.agent), ['codex']);
  await post('/api/message', { clientId: id(), message: 'email @someone about it' }); await settle();
  assert.equal(calls.length, 3);
});

test('"in turn" runs agents in order and hands the earlier answer to the later agent', async t => {
  const { post, settle, calls } = await table(t);
  await post('/api/message', { clientId: id(), message: '@claude fix it. @codex check Claude\'s work.', order: 'sequence' });
  const state = await settle();
  assert.deepEqual(calls.map(call => call.agent), ['claude', 'codex']);
  assert.equal(calls[0].prompt.request.earlierInThisTurn, undefined);
  assert.equal(calls[1].prompt.request.earlierInThisTurn.claude, 'Claude says hi');
  assert.equal(state.conversation.turns[0].order, 'sequence');
});

test('native sessions: each agent starts its own session, then resumes it on the next turn', async t => {
  const { post, settle, calls } = await table(t, { argv: ['--mode', 'read'] });
  await post('/api/message', { clientId: id(), message: 'first' }); await settle();
  await post('/api/message', { clientId: id(), message: 'second' }); await settle();
  const claude = calls.filter(call => call.agent === 'claude');
  assert.equal(claude[0].session.resume, false);
  assert.equal(claude[1].session.resume, true);
  assert.equal(claude[0].session.id, claude[1].session.id);
  assert.notEqual(claude[0].session.id, calls.find(call => call.agent === 'codex').session.id);
});

test('cross-review gives each agent the other answer', async t => {
  const { post, settle, calls } = await table(t);
  await post('/api/message', { clientId: id(), message: 'Pick a database' }); await settle();
  assert.equal((await post('/api/message', { clientId: id(), message: '', kind: 'review' })).status, 202); await settle();
  const review = calls.slice(2).find(call => call.agent === 'claude').prompt.request;
  assert.equal(review.kind, 'review');
  assert.equal(review.otherAnswers.codex, 'Codex says hi');
});

test('one failing agent does not hide the other answer; duplicates are not re-run; a second turn cannot start while one is active', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { post, settle } = await table(t, { runner: async agent => { await gate; return agent.id === 'codex' ? { status: 'error', text: '', error: 'Usage limit reached' } : { status: 'complete', text: 'fine' }; } });
  const clientId = id();
  assert.equal((await post('/api/message', { clientId, message: 'go' })).status, 202);
  assert.equal((await post('/api/message', { clientId: id(), message: 'again' })).status, 409);
  release();
  const turn = (await settle()).conversation.turns[0];
  assert.equal((await (await post('/api/message', { clientId, message: 'go' })).json()).duplicate, true);
  assert.equal(turn.replies.claude.status, 'complete');
  assert.equal(turn.replies.codex.error, 'Usage limit reached');
});

test('the host page is loopback only: wrong Host, missing cookie and foreign Origin are refused', async t => {
  const { instance, cookie, post } = await table(t);
  assert.equal((await fetch(instance.origin + '/api/state')).status, 401);
  assert.equal((await post('/api/new', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const port = new URL(instance.origin).port;
  const rebound = await new Promise((resolve, reject) => import('node:http').then(({ default: http }) => http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example', Cookie: cookie } }, res => resolve(res.statusCode)).on('error', reject)));
  assert.equal(rebound, 403);
  assert.equal((await fetch(instance.origin + '/package.json', { headers: { Cookie: cookie } })).status, 404);
});

test('a phone must pair with a one-time code; a paired phone can chat but cannot manage phone access', async t => {
  const { instance, post, settle } = await table(t, { tunnel: async () => ({ url: 'https://example.invalid', provider: 'mock', stop() {} }) });
  assert.equal((await post('/api/remote', { tunnel: true })).status, 200);
  const phone = 'http://127.0.0.1:' + instance.phonePort();
  assert.equal((await fetch(phone + '/api/state')).status, 401);
  // The owner cookie is worthless on the phone listener.
  assert.equal((await fetch(phone + '/api/state', { headers: { Cookie: (await fetch(instance.origin + '/')).headers.get('set-cookie').split(';')[0] } })).status, 401);
  const pair = await (await post('/api/pair/start', { via: 'tunnel' })).json();
  assert.match(pair.url, /^https:\/\/example\.invalid\/#pair=[\w-]{20,}$/);
  const token = pair.url.split('pair=')[1];
  const claim = body => fetch(phone + '/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: phone }, body: JSON.stringify(body) });
  assert.equal((await claim({ token: 'wrong' })).status, 403);
  const paired = await claim({ token, name: 'Test phone' });
  assert.equal(paired.status, 200);
  assert.match(paired.headers.get('set-cookie'), /HttpOnly; SameSite=Strict.*Secure/);
  assert.equal((await claim({ token })).status, 403, 'a code works once');
  const device = paired.headers.get('set-cookie').split(';')[0];
  const phonePost = (route, body) => fetch(phone + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: phone, Cookie: device }, body: JSON.stringify(body) });
  const view = await (await fetch(phone + '/api/state', { headers: { Cookie: device } })).json();
  assert.equal(view.role, 'device');
  assert.equal(view.remote, undefined);
  assert.equal((await phonePost('/api/message', { clientId: id(), message: 'from the phone' })).status, 202);
  assert.equal((await settle()).conversation.turns[0].from, 'Test phone');
  assert.equal((await phonePost('/api/remote', { tunnel: false })).status, 403);
  assert.equal((await phonePost('/api/pair/start', { via: 'tunnel' })).status, 403);
  const deviceId = (await (await fetch(instance.origin + '/api/state', { headers: { Cookie: (await fetch(instance.origin + '/')).headers.get('set-cookie').split(';')[0] } })).json()).remote.devices[0].id;
  await post('/api/pair/revoke', { id: deviceId });
  assert.equal((await fetch(phone + '/api/state', { headers: { Cookie: device } })).status, 401);
});

test('board: the user can add, tick and remove entries; agent blocks are parsed and hidden from the chat text', async t => {
  const { post, state } = await table(t);
  await post('/api/board', { op: 'add', kind: 'task', text: 'Write docs' });
  let board = (await state()).conversation.board;
  assert.equal(board[0].author, 'you');
  await post('/api/board', { op: 'toggle', id: board[0].id });
  assert.equal((await state()).conversation.board[0].done, true);
  await post('/api/board', { op: 'remove', id: board[0].id });
  assert.equal((await state()).conversation.board.length, 0);
  assert.deepEqual(parseBoard('Answer.\n\n```board\ndecision: Use Postgres\n- risk: Lock contention\nnonsense line\n```'), { text: 'Answer.', entries: [{ kind: 'decision', text: 'Use Postgres' }, { kind: 'risk', text: 'Lock contention' }] });
  assert.equal(visibleText('Streaming answer\n```board\ndeci'), 'Streaming answer');
  assert.equal(parseBoard('```js\nconst a = 1;\n```').entries.length, 0);
});

test('agent commands: no shell, sealed in advise mode, own session and full harness in build mode, API keys stripped', () => {
  const config = loadConfig({ argv: ['--agents', 'claude,codex,gemini'], env: {}, cwd: os.tmpdir() });
  const agents = resolveAgents(config, { PATH: '' });
  const [claude, codex] = agents;
  const policy = policyFor(claude, agents, 'advise');
  assert.match(policy, /supervisor/);
  const advise = claude.args({ mode: 'advise', config, policy }).args;
  assert.equal(advise[advise.indexOf('--tools') + 1], '');
  assert.ok(advise.includes('--no-session-persistence') && advise.includes('--strict-mcp-config') && advise.at(-1) === '-p');
  const build = claude.args({ mode: 'build', config, policy, session: { id: 'abc', resume: true } }).args;
  assert.deepEqual(build.slice(build.indexOf('--resume'), build.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.ok(!build.includes('--safe-mode') && !build.includes('--strict-mcp-config') && !build.includes('--no-session-persistence'));
  const codexAdvise = codex.args({ mode: 'advise', config, policy }).args;
  assert.ok(codexAdvise.includes('sandbox_mode="read-only"') && codexAdvise.includes('--ephemeral') && codexAdvise.includes('shell_tool'));
  const codexBuild = codex.args({ mode: 'build', config, policy, session: { id: 'thread-1', resume: true } }).args;
  assert.deepEqual(codexBuild.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(codexBuild.includes('sandbox_mode="workspace-write"') && !codexBuild.includes('--ephemeral'));
  const env = agentEnv({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', PATH: '/bin' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'NO_COLOR', 'PATH']);
  assert.equal(agentEnv({ OPENAI_API_KEY: 'x' }, { allowApiKeys: true }).OPENAI_API_KEY, 'x');
  assert.throws(() => resolveAgents({ ...config, agents: 'nope' }, { PATH: '' }), /Unknown agent/);
  const custom = resolveAgents({ ...config, agents: 'local', customAgents: [{ id: 'local', label: 'Local', command: 'ollama', args: ['run', 'llama3', '{prompt}'] }] }, { PATH: '' })[0];
  const made = custom.args({ policy: 'P', prompt: '{}' });
  assert.equal(made.stdin, false);
  assert.equal(made.args[2], 'P\n\nINPUT (JSON):\n{}');
});

test('QR codes have the right geometry for short and long pairing links', () => {
  for (const [text, size] of [['http://192.168.1.20:4783/#pair=abcdefghijklmnopqrstuvwx', 33], ['https://some-long-random-words-here.trycloudflare.com/#pair=abcdefghijklmnopqrstuvwx', 37]]) {
    const matrix = qrMatrix(text);
    assert.equal(matrix.length, size);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) { assert.equal(matrix[y][x], true); assert.equal(matrix[y + 1][x + 1], false); assert.equal(matrix[y + 3][x + 3], true); }
    assert.equal(matrix[size - 8][8], true, 'dark module');
  }
  assert.throws(() => qrMatrix('x'.repeat(400)), /too long/);
});

test('HTTP agents: an OpenAI-compatible server streams an answer, gets the key from the named environment variable, and reports when it is down', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local-model' }] })); }
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['Hello ', 'from ', 'a local model']) res.write('data: ' + JSON.stringify({ model: 'local-model', choices: [{ delta: { content: piece } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  process.env.ST_TEST_KEY = 'test-value';
  const config = { ...loadConfig({ argv: [], env: {}, cwd: os.tmpdir() }), agents: 'reges', customAgents: [{ id: 'reges', label: 'Reges', baseUrl, apiKeyEnv: 'ST_TEST_KEY' }] };
  const [agent] = resolveAgents(config, { PATH: '' });
  assert.deepEqual(await agent.auth(), { ready: true, route: 'local-model' });
  const updates = [];
  const result = await runAgent(agent, '{"request":{}}', { mode: 'build', config, policy: 'POLICY', onUpdate: change => updates.push(change.text) });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'Hello from a local model');
  assert.equal(updates.length, 3);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer test-value');
  assert.deepEqual(seen[0].body.messages.map(message => message.role), ['system', 'user']);
  assert.equal(seen[0].body.model, 'local-model');
  const [down] = resolveAgents({ ...config, customAgents: [{ id: 'reges', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }] }, { PATH: '' });
  assert.equal((await down.auth()).ready, false);
  assert.equal((await runAgent(down, '{}', { mode: 'advise', config, policy: 'P' })).status, 'error');
  assert.equal(resolveAgents({ ...config, agents: 'lmstudio,ollama', customAgents: [] }, { PATH: '' }).map(a => a.baseUrl).join(' '), 'http://127.0.0.1:1234/v1 http://127.0.0.1:11434/v1');
});

test('conversations can be renamed, pinned and grouped; a renamed conversation keeps its name after the first message', async t => {
  const { post, state, settle } = await table(t);
  const first = (await state()).conversation.id;
  assert.equal((await post('/api/conversation', { id: first, title: '  Billing   exports ', pinned: true, group: 'Acme' })).status, 200);
  await post('/api/message', { clientId: id(), message: 'hello there' }); await settle();
  let row = (await state()).conversations[0];
  assert.deepEqual([row.title, row.pinned, row.group], ['Billing exports', true, 'Acme']);
  await post('/api/conversation', { id: first, pinned: false, group: '' });
  row = (await state()).conversations[0];
  assert.deepEqual([row.pinned, row.group], [false, undefined]);
  assert.equal((await post('/api/conversation', { id: first, title: '   ' })).status, 400);
  assert.equal((await post('/api/conversation', { id: crypto.randomUUID(), title: 'x' })).status, 400);
});

test('attachments: text files are inlined for every agent, images are handed over by path, and files are served back only to a signed-in session', async t => {
  const { instance, cookie, post, settle, calls } = await table(t);
  const upload = (name, type, body) => fetch(instance.origin + '/api/upload', { method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name), Origin: instance.origin, Cookie: cookie }, body });
  const note = await (await upload('../notes.md', 'text/markdown', '# Plan\nShip it.')).json();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const image = await (await upload('shot.png', 'image/png', png)).json();
  assert.equal(note.name, 'notes.md');
  assert.equal(image.image, true);
  assert.equal((await post('/api/message', { clientId: id(), message: '', attachments: [note.id, image.id] })).status, 202);
  const turn = (await settle()).conversation.turns[0];
  assert.deepEqual(turn.attachments.map(item => item.name), ['notes.md', 'shot.png']);
  assert.equal(turn.attachments[0].path, undefined, 'disk paths are not sent to the browser');
  const request = calls[0].prompt.request;
  assert.equal(request.attachments[0].text, '# Plan\nShip it.');
  assert.equal(request.attachments[1].text, undefined);
  assert.match(request.attachments[1].path, /shot\.png$/);
  assert.equal((await fetch(instance.origin + '/api/file/' + image.id)).status, 401);
  const served = await fetch(instance.origin + '/api/file/' + image.id, { headers: { Cookie: cookie } });
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(instance.origin + '/api/file/' + note.id, { headers: { Cookie: cookie } })).headers.get('content-disposition'), 'attachment; filename="notes.md"');
  const config = loadConfig({ argv: [], env: {}, cwd: os.tmpdir() });
  const [claude, codex] = resolveAgents({ ...config, agents: 'claude,codex' }, { PATH: '' });
  const files = [{ name: 'shot.png', image: true, path: '/tmp/a/shot.png' }];
  const claudeArgs = claude.args({ mode: 'advise', config, policy: 'P', attachments: files, attachmentDir: '/tmp/a' }).args;
  assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'Read');
  assert.equal(claudeArgs[claudeArgs.indexOf('--add-dir') + 1], '/tmp/a');
  const codexArgs = codex.args({ mode: 'advise', config, policy: 'P', attachments: files }).args;
  assert.deepEqual(codexArgs.slice(0, 4), ['exec', '--image', '/tmp/a/shot.png', '--skip-git-repo-check']);
});
