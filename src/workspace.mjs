// Project workspace helpers: git changes, one worktree per agent, and the command panel.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const IDENTITY = ['-c', 'user.name=Shared Table', '-c', 'user.email=shared-table@localhost'];

/** Run git without a shell. Resolves with stdout; rejects with git's own message. */
export function git(cwd, args, { input, okCodes = [0], maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); }
    catch (error) { return reject(error); }
    let out = '', err = '', size = 0;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size <= maxBytes) out += chunk; });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); okCodes.includes(code) ? resolve(out) : reject(new Error(err.trim() || 'git ' + args[0] + ' failed')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

export const isRepo = dir => git(dir, ['rev-parse', '--is-inside-work-tree']).then(out => out.trim() === 'true', () => false);

const inside = (root, file) => { const full = path.resolve(root, file); if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside the folder.'); return full; };

/** Files that differ from the last commit: [{ path, status }] where status is M, A, D, R or ? (new, untracked). */
export async function changedFiles(dir) {
  const out = await git(dir, ['status', '--porcelain=v1', '-uall', '--no-renames']);
  return out.split('\n').filter(Boolean).slice(0, 400).map(line => {
    const code = line.slice(0, 2), file = line.slice(3).replace(/^"|"$/g, '');
    return { path: file, status: code === '??' ? '?' : code.includes('D') ? 'D' : code.includes('A') ? 'A' : 'M' };
  });
}

/** A unified diff for one file against the last commit. New files are shown as all-added. */
export async function fileDiff(dir, file) {
  const full = inside(dir, file);
  const tracked = await git(dir, ['cat-file', '-e', 'HEAD:' + file]).then(() => true, () => false);
  if (tracked) return (await git(dir, ['diff', 'HEAD', '--', file], { maxBytes: 400 * 1024 })).slice(0, 400 * 1024);
  const stat = await fs.stat(full);
  if (stat.size > 200 * 1024) return 'New file, ' + Math.round(stat.size / 1024) + ' KB (too large to show).';
  const text = (await fs.readFile(full)).toString('utf8');
  if (text.includes('\u0000')) return 'New binary file.';
  return '--- /dev/null\n+++ b/' + file + '\n' + text.split('\n').map(line => '+' + line).join('\n');
}

/** Put one file back to its last committed state. A new file is deleted. */
export async function revertFile(dir, file) {
  const full = inside(dir, file);
  const committed = await git(dir, ['cat-file', '-e', 'HEAD:' + file]).then(() => true, () => false);
  if (committed) return void await git(dir, ['checkout', 'HEAD', '--', file]);
  await git(dir, ['rm', '-q', '--cached', '--ignore-unmatch', '--', file]).catch(() => {});
  await fs.rm(full, { force: true });
}

/** Make sure an agent has its own worktree of the project, on its own branch, starting from the project's HEAD. */
export async function ensureWorktree(repo, dest, branch) {
  if (await fs.stat(path.join(dest, '.git')).then(() => true, () => false)) return dest;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(repo, ['worktree', 'prune']).catch(() => {});
  await git(repo, ['worktree', 'add', '--force', '-B', branch, dest, 'HEAD']);
  return dest;
}

/** Copy an agent's worktree changes into the project folder as uncommitted changes. Returns the number of files. */
export async function applyWorktree(repo, worktree) {
  await git(worktree, ['add', '-A']);
  const patch = await git(worktree, ['diff', '--cached', '--binary', 'HEAD'], { maxBytes: 32 * 1024 * 1024 });
  if (!patch.trim()) return 0;
  const count = (await git(worktree, ['diff', '--cached', '--name-only', 'HEAD'])).split('\n').filter(Boolean).length;
  await git(repo, ['apply', '--3way', '--whitespace=nowarn'], { input: patch });
  await git(worktree, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', 'Applied to the project by Shared Table']);
  return count;
}

export async function discardWorktree(worktree) {
  await git(worktree, ['reset', '-q', '--hard', 'HEAD']);
  await git(worktree, ['clean', '-fdq']);
}

export async function removeWorktrees(repo, folder) {
  await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  await git(repo, ['worktree', 'prune']).catch(() => {});
}

/**
 * The command panel: run one shell command in the project folder and stream its output.
 * This is a command runner, not an interactive terminal: commands get no keyboard input.
 */
export function runCommand(command, { cwd, onOutput, onExit, timeoutMs = 10 * 60000 }) {
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '1' } });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
  child.on('error', error => { clearTimeout(timer); onOutput('\n' + error.message + '\n'); onExit(127); });
  child.on('close', (code, signal) => { clearTimeout(timer); onExit(code ?? (signal ? 130 : 1)); });
  return () => { if (child.exitCode === null) { child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref(); } };
}
