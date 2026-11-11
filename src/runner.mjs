import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { agentEnv, safeError } from './agents.mjs';

const MAX_REPLY = 48000;
const MAX_OUTPUT = 8 * 1024 * 1024;

/** Only ever stops a process that this module started itself. */
export function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 4000).unref();
  }
}

/** Run an HTTP agent: one streamed POST to an OpenAI-compatible /chat/completions endpoint. */
async function runHttp(agent, prompt, { config, policy, signal, onUpdate, attachments = [] }) {
  const start = Date.now(), timeoutMs = (config.timeoutSeconds || 180) * 1000;
  const timeout = AbortSignal.timeout(timeoutMs);
  let text = '', model = null;
  const done = (status, error) => ({ status, text: text.trim(), ...(error ? { error } : {}), model, activity: [], durationMs: Date.now() - start });
  try {
    model = await agent.model();
    // Images are sent in the OpenAI vision format; the model behind the server must support images.
    const images = [];
    for (const item of attachments.filter(entry => entry.image)) images.push({ type: 'image_url', image_url: { url: 'data:' + item.type + ';base64,' + (await readFile(item.path)).toString('base64') } });
    const response = await fetch(agent.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...agent.headers() }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: policy }, { role: 'user', content: images.length ? [{ type: 'text', text: 'INPUT (JSON):\n' + prompt }, ...images] : 'INPUT (JSON):\n' + prompt }] }),
    });
    if (!response.ok) return done('error', safeError('HTTP ' + response.status + ' from ' + agent.baseUrl + ': ' + (await response.text()).slice(0, 300)));
    const take = value => { const piece = value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.message?.content; if (value.model) model = value.model; if (piece) { text += piece; onUpdate({ text, model, activity: [] }); } };
    if (!(response.headers.get('content-type') || '').includes('event-stream')) take(await response.json());
    else {
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let position;
        while ((position = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, position).trim(); buffer = buffer.slice(position + 1);
          if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
          try { take(JSON.parse(line.slice(5))); } catch { /* keep-alive or partial line */ }
        }
        if (text.length > MAX_REPLY) return done('error', 'The reply exceeded the ' + MAX_REPLY + '-character limit.');
      }
    }
    return text.trim() ? done('complete') : done('error', 'The server returned an empty answer.');
  } catch (error) {
    if (signal?.aborted) return done('cancelled');
    if (timeout.aborted) return done('error', 'The agent reached the ' + Math.round(timeoutMs / 1000) + '-second limit.');
    return done('error', safeError('Could not reach ' + agent.baseUrl + ': ' + (error.cause?.code || error.message)));
  }
}

/**
 * Run one agent once. Resolves with { status: 'complete' | 'error' | 'cancelled', text, error?, model, activity, durationMs }.
 * No shell is involved: the prompt travels on stdin or as a single argument.
 */
export async function runAgent(agent, prompt, { mode, config, policy, cwd, signal, session = null, attachments = [], attachmentDir = null, onUpdate = () => {}, spawnImpl = spawn, env = agentEnv(process.env, config) } = {}) {
  if (agent.kind === 'http') return runHttp(agent, prompt, { config, policy, signal, onUpdate, attachments });
  if (!agent.path) return { status: 'error', text: '', error: agent.install, activity: [] };
  if (signal?.aborted) return { status: 'cancelled', text: '', activity: [] };
  const timeoutMs = (config.timeoutSeconds || 180) * 1000;
  const { args, stdin, stdinText } = agent.args({ mode, config, policy, prompt, session, attachments, attachmentDir });

  return await new Promise(resolve => {
    const state = { text: '', sessionId: null, model: null, changed: false, activity: [], error: null, allowRead: attachments.some(item => !item.inline) };
    const start = Date.now();
    let line = '', stderr = '', bytes = 0, settled = false, aborted = false, timedOut = false;
    let child;
    try { child = spawnImpl(agent.path, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ status: 'error', text: '', error: safeError(error.message), activity: [] }); }

    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const text = state.text.trim();
      const status = aborted ? 'cancelled' : timedOut ? 'error' : code === 0 && !state.error && text ? 'complete' : 'error';
      const result = { status, text, sessionId: state.sessionId, model: state.model, activity: state.activity.slice(-40), durationMs: Date.now() - start };
      if (status === 'error') result.error = timedOut ? 'The agent reached the ' + Math.round(timeoutMs / 1000) + '-second limit.' : state.error || safeError(stderr) || 'The agent exited without an answer.';
      resolve(result);
    };
    const abort = () => { aborted = true; stopOwned(child); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stopOwned(child); }, timeoutMs);
    const push = () => { if (state.changed) { state.changed = false; onUpdate({ text: state.text, model: state.model, activity: state.activity.slice(-40) }); } };
    const guard = () => { if (state.text.length > MAX_REPLY) { state.error = 'The reply exceeded the ' + MAX_REPLY + '-character limit.'; stopOwned(child); } };
    const handleLine = raw => {
      if (!raw.trim()) return;
      try { agent.parse(JSON.parse(raw), state, mode); guard(); push(); }
      catch (error) { if (error instanceof SyntaxError) return; state.error = safeError(error.message); stopOwned(child); }
    };

    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) { state.error = 'The agent produced too much output.'; stopOwned(child); return; }
      if (agent.format === 'text') { state.text += chunk; state.changed = true; guard(); push(); return; }
      line += chunk;
      let position;
      while ((position = line.indexOf('\n')) >= 0) { handleLine(line.slice(0, position)); line = line.slice(position + 1); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', error => { state.error = safeError(error.code === 'ENOENT' ? agent.install : error.message); finish(1); });
    child.on('close', code => { if (line && agent.format !== 'text') handleLine(line); finish(code); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ? (stdinText ?? prompt) : '');
  });
}
