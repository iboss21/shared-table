// Regenerates the README screenshots and the demo video by driving a real Chrome through the DevTools protocol.
// No dependencies: needs Node 22+ (built-in WebSocket) and Google Chrome.
//
//   node scripts/capture.mjs            screenshots + video, demo mode (scripted replies)
//   node scripts/capture.mjs --shots    screenshots only
//
// Output: docs/assets/*.png and docs/assets/shared-table-demo.(mp4|webm)

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTable } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'docs', 'assets');
const CHROME = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const shotsOnly = process.argv.includes('--shots');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-table-capture-'));
const frameDir = path.join(work, 'frames');
await fs.mkdir(frameDir, { recursive: true });
await fs.mkdir(assets, { recursive: true });

// ---------------------------------------------------------------- app under capture
const config = loadConfig({ argv: [root, '--demo', '--mode', 'read', '--name', 'Acme Billing', '--port', '0', '--data-dir', path.join(work, 'data'), '--brief', 'Acme Billing: invoicing service for small agencies. Node + Postgres, one deployable. Goal this week: stop export timeouts under load without a rewrite.'], env: {} });
const table = await createTable({ config, tunnel: async () => ({ url: 'https://shared-table-demo.example', provider: 'demo', stop() {} }) });
await table.ready;

// ---------------------------------------------------------------- Chrome
const debugPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(work, 'chrome'), '--hide-scrollbars', '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 80 && !version; i++) { await sleep(250); version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json()).catch(() => null); }
if (!version) throw new Error('Chrome did not start. Set CHROME_PATH.');

async function openPage(url, { width, height, scale = 2, mobile = false, dark = true }) {
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0; const waiting = new Map();
  socket.onmessage = message => { const data = JSON.parse(message.data); if (data.id && waiting.has(data.id)) { const { resolve, reject } = waiting.get(data.id); waiting.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await send('Page.navigate', { url });
  await sleep(900);
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed'); return result.result.value; };
  const png = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  return { send, evaluate, png, shot: async name => { await fs.writeFile(path.join(assets, name), await png()); console.log('  wrote docs/assets/' + name); }, close: () => socket.close() };
}

// ---------------------------------------------------------------- video frames
const frames = [];
let caption = '', clock = 0;
async function frame(page, hold = 0) {
  const started = Date.now();
  const name = String(frames.length).padStart(4, '0') + '.png';
  await fs.writeFile(path.join(frameDir, name), await page.png());
  const took = Date.now() - started;
  frames.push({ name, at: clock, caption });
  clock += Math.max(took, 120) + hold;
}
async function watch(page, ms) { const end = Date.now() + ms; while (Date.now() < end) await frame(page); }
async function type(page, text, record) {
  for (let i = 0; i <= text.length; i += 3) {
    await page.evaluate(`const box = document.getElementById('message'); box.value = ${JSON.stringify(text)}.slice(0, ${i + 3}); box.dispatchEvent(new Event('input'));`);
    if (record) await frame(page);
  }
  await page.evaluate(`document.getElementById('mention-menu').hidden = true;`);
}
const submit = page => page.evaluate(`document.getElementById('compose').requestSubmit();`);
const idle = async page => { for (let i = 0; i < 300; i++) { if (!(await page.evaluate(`return (await fetch('/api/state').then(r => r.json())).active;`))) return; await sleep(200); } };
const bottom = page => page.evaluate(`const t = document.getElementById('transcript'); t.scrollTop = t.scrollHeight;`);

// ---------------------------------------------------------------- run
const record = !shotsOnly;
const desk = await openPage(table.origin, { width: 1440, height: 900, scale: record ? 4 / 3 : 2 });
console.log('Capturing…');

await desk.evaluate(`localStorage.setItem('st-pet', 'flick'); window.SharedTablePet.choose('flick');`);
caption = 'One chat. Every coding agent you use, side by side.';
if (record) await frame(desk, 1600);
caption = 'Write once. Claude Code and Codex both start, each in its own session.';
await type(desk, 'Exports are timing out under load. Should we split the service or add a queue?', record);
await submit(desk);
if (record) await watch(desk, 2600);
await sleep(record ? 0 : 2600);
await desk.shot('screenshot-live.png');
if (record) { caption = 'Watch both work at the same time. Decisions, tasks and risks land on the shared table.'; while (await desk.evaluate(`return (await fetch('/api/state').then(r => r.json())).active;`)) await frame(desk); await frame(desk, 1800); } else await idle(desk);
await desk.evaluate(`document.getElementById('transcript').scrollTop = 0;`);
await sleep(300);
await desk.shot('screenshot-desktop.png');

caption = 'Give each agent its own job in one message: Claude fixes, then Codex checks Claude\'s work.';
await desk.evaluate(`document.querySelector('#order [data-order=sequence]').click();`);
await type(desk, "@claude propose the fix for the export timeouts. @codex check Claude's work.", record);
if (record) await frame(desk, 900);
await submit(desk);
await sleep(400); await bottom(desk);
if (record) { while (await desk.evaluate(`return (await fetch('/api/state').then(r => r.json())).active;`)) { await bottom(desk); await frame(desk); } await frame(desk, 1800); } else await idle(desk);
await bottom(desk); await sleep(300);
await desk.shot('screenshot-in-turn.png');

caption = 'Continue on your phone: scan a QR code, on the same Wi-Fi or from anywhere.';
await desk.evaluate(`await fetch('/api/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnel: true }) }); document.getElementById('phone-open').click();`);
await sleep(1200);
await desk.shot('screenshot-phone-pairing.png');
if (record) await frame(desk, 3200);

// Phone: pair through the phone listener exactly as a scanned code would.
const pairUrl = await desk.evaluate(`return (await fetch('/api/pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via: 'tunnel' }) }).then(r => r.json())).url;`);
const phone = await openPage('http://127.0.0.1:' + table.phonePort() + '/' + pairUrl.slice(pairUrl.indexOf('#')), { width: 390, height: 844, scale: 3, mobile: true });
await sleep(1200);
await bottom(phone); await sleep(300);
await phone.shot('screenshot-mobile-chat.png');
await phone.evaluate(`document.querySelector('#tabs [data-view=board]').click();`);
await sleep(400);
await phone.shot('screenshot-mobile-table.png');

await desk.evaluate(`document.getElementById('phone').close(); document.getElementById('settings-open').click();`);
await sleep(600);
await desk.shot('screenshot-settings.png');
await desk.evaluate(`document.getElementById('settings').close();`);

// Light theme, for the README.
// Headless Chrome does not advance CSS transitions between screenshots, so switch them off before changing theme.
await desk.evaluate(`document.querySelectorAll('.button, .switch').forEach(node => { node.style.transition = 'none'; });`);
await desk.evaluate(`document.getElementById('phone').close(); applyLook('light', ''); document.getElementById('transcript').scrollTop = 0;`); await sleep(1000);
await sleep(500);
await desk.shot('screenshot-light.png');
await desk.evaluate(`applyLook('crimson', '');`); await sleep(1500);
await desk.shot('screenshot-crimson.png');
await desk.evaluate(`applyLook('dark', '');`);

// ---------------------------------------------------------------- video
if (record) {
  console.log('Encoding video from ' + frames.length + ' frames…');
  const phoneFrames = { chat: 'screenshot-mobile-chat.png', table: 'screenshot-mobile-table.png' };
  const total = clock;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0f100e"><canvas id="c" width="1920" height="1080"></canvas>'); }
      const file = req.url.startsWith('/asset/') ? path.join(assets, path.basename(req.url)) : path.join(frameDir, path.basename(req.url));
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const studio = await openPage('http://127.0.0.1:' + server.address().port + '/', { width: 1920, height: 1080, scale: 1 });
  const result = await studio.evaluate(`
    const frames = ${JSON.stringify(frames)}, total = ${total}, phone = ${JSON.stringify(phoneFrames)};
    const canvas = document.getElementById('c'), g = canvas.getContext('2d');
    const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const images = await Promise.all(frames.map(f => load('/' + f.name)));
    const phoneChat = await load('/asset/' + phone.chat), phoneTable = await load('/asset/' + phone.table);
    const SERIF = '"Iowan Old Style", Palatino, Georgia, serif', SANS = '-apple-system, "Helvetica Neue", Arial, sans-serif';
    const INTRO = 2600, PHONE = 4200, OUTRO = 4600, length = INTRO + total + PHONE + OUTRO;
    const bg = () => { g.fillStyle = '#0f100e'; g.fillRect(0, 0, 1920, 1080); };
    const center = (text, y, font, color) => { g.font = font; g.fillStyle = color; g.textAlign = 'center'; g.fillText(text, 960, y); };
    const logo = (x, y, s) => { g.fillStyle = '#f2efe7'; g.beginPath(); g.roundRect(x, y, s, s, s * .28); g.fill(); g.strokeStyle = '#0f100e'; g.lineWidth = s * .06; g.beginPath(); g.roundRect(x + s * .28, y + s * .28, s * .44, s * .44, s * .12); g.stroke(); for (const [cx, color] of [[.2, '#e0633d'], [.8, '#4f6bed']]) { g.fillStyle = '#f2efe7'; g.beginPath(); g.arc(x + s * cx, y + s * .5, s * .15, 0, 7); g.fill(); g.fillStyle = color; g.beginPath(); g.arc(x + s * cx, y + s * .5, s * .1, 0, 7); g.fill(); } };
    const shot = (image, x, y, w, h, r) => { g.save(); g.beginPath(); g.roundRect(x, y, w, h, r); g.clip(); g.drawImage(image, x, y, w, h); g.restore(); g.strokeStyle = '#3a3b34'; g.lineWidth = 2; g.beginPath(); g.roundRect(x, y, w, h, r); g.stroke(); };
    const captionBar = text => { g.font = '500 34px ' + SANS; g.fillStyle = '#f2efe7'; g.textAlign = 'center'; g.fillText(text, 960, 1022); };
    function draw(t) {
      bg();
      if (t < INTRO) { logo(888, 330, 144); center('Shared Table', 600, '600 104px ' + SERIF, '#f2efe7'); center('One chat that runs Claude Code, Codex and your other coding agents together.', 680, '400 38px ' + SANS, '#9a968b'); return; }
      t -= INTRO;
      if (t < total) { let i = 0; while (i + 1 < frames.length && frames[i + 1].at <= t) i++; shot(images[i], 208, 34, 1504, 940, 18); captionBar(frames[i].caption); return; }
      t -= total;
      if (t < PHONE) { shot(phoneChat, 560, 60, 370, 801, 34); shot(phoneTable, 990, 60, 370, 801, 34); center('Same conversation, same agents, live on your phone.', 960, '500 40px ' + SANS, '#f2efe7'); center('The shared table travels with you.', 1016, '400 30px ' + SANS, '#9a968b'); return; }
      logo(900, 250, 120); center('Shared Table', 480, '600 88px ' + SERIF, '#f2efe7'); center('Open source, MIT. Runs on your machine with your own Claude and Codex sign-ins.', 560, '400 36px ' + SANS, '#9a968b');
      center('github.com/iboss21/shared-table', 680, '600 46px ' + SANS, '#f2efe7'); center('by LIKE A KING INC.  ·  part of RegesCore', 760, '400 30px ' + SANS, '#9a968b'); center('Recorded in demo mode: agent replies in this video are scripted.', 1000, '400 24px ' + SANS, '#6f6b62');
    }
    const type = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(kind => MediaRecorder.isTypeSupported(kind));
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 6000000 });
    const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    draw(0); recorder.start(500);
    const start = performance.now();
    await new Promise(resolve => { const tick = () => { const t = performance.now() - start; draw(Math.min(t, length - 1)); if (t < length) setTimeout(tick, 33); else resolve(); }; tick(); });
    recorder.stop(); await done;
    const blob = new Blob(chunks, { type });
    const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
    draw(INTRO + total * 0.42);
    return { type, data, seconds: Math.round(length / 1000) };
  `);
  const file = 'shared-table-demo.' + (result.type.startsWith('video/mp4') ? 'mp4' : 'webm');
  await fs.writeFile(path.join(assets, file), Buffer.from(result.data, 'base64'));
  await studio.shot('video-poster.png');
  console.log('  wrote docs/assets/' + file + ' (' + result.seconds + ' s, ' + result.type + ')');
  server.close();
}

chrome.kill();
await table.close();
await fs.rm(work, { recursive: true, force: true }).catch(() => {});
console.log('Done.');
process.exit(0);
