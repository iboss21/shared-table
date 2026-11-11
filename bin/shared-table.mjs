#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig, HELP } from '../src/config.mjs';

let config;
try { config = loadConfig({ argv: process.argv.slice(2) }); }
catch (error) { console.error('shared-table: ' + error.message + '\nRun "shared-table --help" for options.'); process.exit(2); }

if (config.help) { console.log(HELP); process.exit(0); }
const { createTable, VERSION } = await import('../src/server.mjs');
if (config.version) { console.log(VERSION); process.exit(0); }

let table;
try { table = await createTable({ config }); }
catch (error) {
  console.error('shared-table: ' + (error.code === 'EADDRINUSE' ? 'port ' + config.port + ' is already in use. Try --port ' + (config.port + 1) + '.' : error.message));
  process.exit(1);
}
await table.ready;

const line = (label, value) => console.log('  ' + label.padEnd(12) + value);
console.log('\n  Shared Table ' + VERSION + (config.demo ? '  (demo mode: scripted replies)' : '') + '\n');
line('Open', table.origin);
line('Project', config.name + '  (' + config.projectDir + ')');
line('Mode', config.mode + (config.mode === 'build' ? '  (agents can edit files and run commands in the project folder)' : ''));
for (const agent of table.state().agents) line(agent.label, agent.ready ? 'ready, ' + agent.route : 'not ready: ' + agent.error);
for (const url of table.lanUrls()) line('Wi-Fi', url + '  (pair a phone from the Phone button)');
if (table.tunnelUrl()) line('Anywhere', table.tunnelUrl());
if (config.publicUrl) line('Phone port', 'forward ' + config.publicUrl + ' to http://127.0.0.1:' + table.phonePort());
for (const warning of table.warnings) line('Warning', warning);
line('Saved in', table.runtime);
console.log('\n  Press Ctrl+C to stop.\n');

if (config.open) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', table.origin] : [table.origin];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void table.close().finally(() => process.exit(0));
});
