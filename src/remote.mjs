// Phone access: LAN addresses and optional public tunnels.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { findExecutable } from './agents.mjs';

/** IPv4 addresses of this computer on local networks. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) {
    if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) out.push(item.address);
  }
  return [...new Set(out)];
}

export function tunnelProvider(env = process.env) {
  const cloudflared = findExecutable('cloudflared', { env, extra: ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'] });
  if (cloudflared) return { id: 'cloudflared', label: 'Cloudflare quick tunnel', command: cloudflared };
  const ssh = findExecutable('ssh', { env, extra: ['/usr/bin/ssh'] });
  if (ssh) return { id: 'localhost.run', label: 'localhost.run (ssh)', command: ssh };
  return null;
}

/**
 * Start a public HTTPS tunnel to http://127.0.0.1:<port>. Resolves with { url, provider, stop }.
 * Uses cloudflared when installed, otherwise an ssh reverse tunnel through localhost.run. Both are free and need no account.
 */
export function startTunnel(port, { env = process.env, spawnImpl = spawn, timeoutMs = 30000, onExit = () => {} } = {}) {
  const provider = tunnelProvider(env);
  if (!provider) return Promise.reject(new Error('No tunnel tool found. Install cloudflared, or use --public-url with your own address.'));
  const args = provider.id === 'cloudflared'
    ? ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port]
    : ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', '80:127.0.0.1:' + port, 'nokey@localhost.run'];
  const pattern = provider.id === 'cloudflared' ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i : /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(provider.command, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
    const timer = setTimeout(() => { if (!settled) { settled = true; stop(); reject(new Error('The tunnel did not report an address within ' + timeoutMs / 1000 + ' seconds.')); } }, timeoutMs);
    const read = chunk => {
      output = (output + chunk).slice(-8000);
      const match = pattern.exec(output);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve({ url: match[0], provider: provider.label, stop }); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('The tunnel closed before reporting an address.')); } else onExit(); });
  });
}
