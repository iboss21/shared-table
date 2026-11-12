// Renders public/icon.svg to the PNG app icons with headless Chrome. Run: node scripts/make-icons.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CHROME = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const port = 9400 + Math.floor(Math.random() * 400), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-table-icons-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let version; for (let i = 0; i < 80 && !version; i++) { await sleep(250); version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).catch(() => null); }
const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => { socket.onopen = resolve; });
let next = 0; const waiting = new Map();
socket.onmessage = message => { const data = JSON.parse(message.data); if (waiting.has(data.id)) { waiting.get(data.id)(data.result); waiting.delete(data.id); } };
const send = (method, params = {}) => new Promise(resolve => { const id = ++next; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
const svg = await fs.readFile(path.join(pub, 'icon.svg'), 'utf8');
for (const size of [192, 512]) {
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent('<body style="margin:0">' + svg.replace('<svg ', '<svg style="display:block;width:100vw;height:100vh" ')) });
  await sleep(500);
  await fs.writeFile(path.join(pub, 'icon-' + size + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
chrome.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
console.log('icons written');
process.exit(0);
