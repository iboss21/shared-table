import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_BRIEF = 'Describe the project here in a few lines: what it is, who it is for, what matters, what is already decided. Both agents receive this brief with every message. Do not paste passwords, keys or private customer data.';

export const defaults = {
  name: '',
  brief: DEFAULT_BRIEF,
  projectDir: '',
  mode: 'advise', // 'advise' = no tools; 'read' = agents may read the project; 'build' = agents may edit it
  sessions: '', // 'native' (default) = each agent keeps its own CLI session per conversation, resumable in its own app; 'stateless' = fresh run every turn
  agents: '', // comma-separated ids; empty = claude, codex, plus gemini and custom agents when available
  port: 4783,
  dataDir: '',
  claudePath: '',
  codexPath: '',
  geminiPath: '',
  claudeModel: '',
  codexModel: '',
  geminiModel: '',
  timeoutSeconds: 0, // 0 = 180 in advise mode, 420 in read mode, 900 in build mode
  allowApiKeys: false, // false = use the CLIs' own sign-in, never API-key environment variables
  lan: false,
  tunnel: false,
  publicUrl: '',
  demo: false,
  open: false,
};

const ENV = {
  SHARED_TABLE_NAME: 'name', SHARED_TABLE_BRIEF: 'brief', SHARED_TABLE_PROJECT: 'projectDir', SHARED_TABLE_MODE: 'mode', SHARED_TABLE_SESSIONS: 'sessions', SHARED_TABLE_AGENTS: 'agents', SHARED_TABLE_GEMINI_PATH: 'geminiPath', SHARED_TABLE_GEMINI_MODEL: 'geminiModel',
  SHARED_TABLE_PORT: 'port', SHARED_TABLE_DATA_DIR: 'dataDir', SHARED_TABLE_CLAUDE_PATH: 'claudePath', SHARED_TABLE_CODEX_PATH: 'codexPath',
  SHARED_TABLE_CLAUDE_MODEL: 'claudeModel', SHARED_TABLE_CODEX_MODEL: 'codexModel', SHARED_TABLE_TIMEOUT: 'timeoutSeconds',
  SHARED_TABLE_ALLOW_API_KEYS: 'allowApiKeys', SHARED_TABLE_LAN: 'lan', SHARED_TABLE_TUNNEL: 'tunnel', SHARED_TABLE_PUBLIC_URL: 'publicUrl', SHARED_TABLE_DEMO: 'demo',
};

const FLAGS = {
  '--name': 'name', '--brief': 'brief', '--project': 'projectDir', '--mode': 'mode', '--sessions': 'sessions', '--agents': 'agents', '--gemini-path': 'geminiPath', '--gemini-model': 'geminiModel', '--port': 'port', '--data-dir': 'dataDir',
  '--claude-path': 'claudePath', '--codex-path': 'codexPath', '--claude-model': 'claudeModel', '--codex-model': 'codexModel',
  '--timeout': 'timeoutSeconds', '--public-url': 'publicUrl',
};
const SWITCHES = { '--lan': 'lan', '--tunnel': 'tunnel', '--demo': 'demo', '--open': 'open', '--allow-api-keys': 'allowApiKeys' };

const coerce = (key, value) => {
  if (typeof defaults[key] === 'boolean') return value === true || /^(1|true|yes|on)$/i.test(String(value));
  if (typeof defaults[key] === 'number') return Number(value);
  return String(value);
};

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--config') out.config = argv[++i];
    else if (SWITCHES[arg]) out[SWITCHES[arg]] = true;
    else if (FLAGS[arg]) out[FLAGS[arg]] = argv[++i];
    else if (arg.startsWith('--') && arg.includes('=') && FLAGS[arg.split('=')[0]]) out[FLAGS[arg.split('=')[0]]] = arg.slice(arg.indexOf('=') + 1);
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else out._.push(arg);
  }
  return out;
}

/** defaults < config file < environment < command-line flags */
export function loadConfig({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const config = { ...defaults };
  const projectHint = path.resolve(cwd, args.projectDir || args._[0] || env.SHARED_TABLE_PROJECT || '.');
  const file = args.config ? path.resolve(cwd, args.config) : path.join(projectHint, 'shared-table.config.json');
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(defaults)) if (value[key] !== undefined) config[key] = coerce(key, Array.isArray(value[key]) ? value[key].join(',') : value[key]);
    if (Array.isArray(value.customAgents)) config.customAgents = value.customAgents;
    config.configFile = file;
  } else if (args.config) throw new Error('Config file not found: ' + file);
  for (const [name, key] of Object.entries(ENV)) if (env[name] !== undefined && env[name] !== '') config[key] = coerce(key, env[name]);
  for (const key of Object.keys(defaults)) if (args[key] !== undefined) config[key] = coerce(key, args[key]);

  config.projectDir = path.resolve(cwd, args._[0] || config.projectDir || '.');
  if (!config.name) config.name = path.basename(config.projectDir) || 'Project';
  if (!['advise', 'read', 'build'].includes(config.mode)) throw new Error('mode must be "advise", "read" or "build".');
  config.customAgents ||= [];
  if (!config.sessions) config.sessions = 'native';
  if (!['native', 'stateless'].includes(config.sessions)) throw new Error('sessions must be "native" or "stateless".');
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (!config.timeoutSeconds) config.timeoutSeconds = config.mode === 'build' ? 900 : config.mode === 'read' ? 420 : 180;
  if (!config.dataDir) {
    const slug = config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    const hash = createHash('sha256').update(config.projectDir).digest('hex').slice(0, 8);
    config.dataDir = path.join(os.homedir(), '.shared-table', 'projects', slug + '-' + hash);
  } else config.dataDir = path.resolve(cwd, config.dataDir);
  config.help = !!args.help;
  config.version = !!args.version;
  return config;
}

export const HELP = `shared-table: one chat that runs Claude Code, Codex and other coding agents side by side, with a shared board.

Usage
  shared-table [project-folder] [options]

Options
  --mode <mode>          advise: agents answer without tools (default)
                         read:   agents may read files in the project folder
                         build:  agents may edit files and run commands in the project folder
  --sessions <kind>      native: each agent keeps its own CLI session per conversation, which you can
                                 also open in that agent's own app (default)
                         stateless: a fresh run every turn, nothing saved by the CLIs
  --agents <ids>         comma-separated agents to seat, for example claude,codex,gemini
  --name <text>          project name shown in the interface
  --brief <text>         starting brief sent to both agents
  --port <number>        local port (default 4783)
  --lan                  also listen on this computer's Wi-Fi/LAN address for paired phones
  --tunnel               open a public HTTPS tunnel for paired phones (cloudflared, or ssh to localhost.run)
  --public-url <url>     your own public address that forwards to the phone port (for example Tailscale Funnel)
  --claude-path <file>   path to the claude executable if it is not on PATH
  --codex-path <file>    path to the codex executable if it is not on PATH
  --claude-model <id>    model passed to Claude Code
  --codex-model <id>     model passed to Codex
  --timeout <seconds>    per-agent time limit
  --allow-api-keys       keep API-key environment variables instead of using the CLIs' own sign-in
  --data-dir <folder>    where conversations are saved (default ~/.shared-table/projects/<project>)
  --config <file>        JSON settings file (default <project>/shared-table.config.json)
  --demo                 scripted stand-in agents, no CLI or account needed
  --open                 open the browser after starting
  -h, --help / -v, --version
`;
