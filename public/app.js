'use strict';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const KIND_LABEL = { decision: 'Decisions', task: 'Tasks', risk: 'Risks', question: 'Questions', note: 'Notes' };
const KIND_MARK = { decision: 'D', task: '', risk: '!', question: '?', note: 'N' };
const STARTERS = [
  ['everyone', 'Review the plan in the brief. What is the weakest part, and what would you do first?'],
  ['@claude', '@claude propose the architecture. Keep it to one page.'],
  ['@codex', '@codex list the edge cases and failure modes we have not handled.'],
];

let order = 'parallel', pending = [];
let state = null, selected = new Set(), filter = 'all', pairVia = null, pairTimer = null, requestId = null, briefTimer = null, menuIndex = 0;

function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function post(path, value = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
const fail = error => { $('error').textContent = error?.message || String(error || ''); };
const SVG = 'http://www.w3.org/2000/svg';
function glyph(id, cls) { const svg = document.createElementNS(SVG, 'svg'), use = document.createElementNS(SVG, 'use'); svg.setAttribute('viewBox', id === 'st-logo' ? '0 0 64 64' : '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); if (cls) svg.setAttribute('class', cls); use.setAttribute('href', '#' + id); svg.append(use); return svg; }
function avatar(agent) { const badge = el('span', 'avatar'); badge.append(glyph('icon-' + (agent.icon || 'cli'))); return badge; }
const agentOf = id => state?.agents.find(agent => agent.id === id);
const tint = (node, id) => { const agent = agentOf(id); node.style.setProperty('--agent', agent ? agent.color : id === 'you' ? 'var(--ink)' : 'var(--muted)'); return node; };
const seconds = ms => (ms >= 60000 ? Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
const compact = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = iso => { const date = new Date(iso), today = new Date(); return date.toDateString() === today.toDateString() ? clock(iso) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); };

// ---------------------------------------------------------------- markdown (DOM only, no innerHTML)
function inline(parent, text) {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) parent.append(el('code', '', token.slice(1, -1)));
    else if (match[2]) { const strong = el('strong'); inline(strong, token.slice(2, -2)); parent.append(strong); }
    else if (match[3]) { const em = el('em'); inline(em, token.slice(1, -1)); parent.append(em); }
    else { const parts = /\[([^\]]+)\]\(([^)]+)\)/.exec(token), link = el('a', '', parts[1]); link.href = parts[2]; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link); }
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function markdown(source) {
  const root = el('div', 'md'), lines = String(source || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const pre = el('pre'); if (fence[1]) pre.dataset.lang = fence[1];
      pre.append(el('code', '', body.join('\n'))); root.append(pre); continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { const node = el(heading[1].length <= 2 ? 'h3' : 'h4'); inline(node, heading[2]); root.append(node); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quote = el('blockquote'), body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      inline(quote, body.join(' ')); root.append(quote); continue;
    }
    const bullet = /^\s*([-*]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const list = el(/^\s*\d/.test(line) ? 'ol' : 'ul');
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && list.lastChild))) {
        if (bullet.test(lines[i])) { const item = el('li'); inline(item, lines[i].replace(bullet, '')); list.append(item); }
        else { list.lastChild.append(' '); inline(list.lastChild, lines[i].trim()); }
        i++;
      }
      root.append(list); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !bullet.test(lines[i]) && !/^\s*>/.test(lines[i])) paragraph.push(lines[i++]);
    const node = el('p'); inline(node, paragraph.join('\n')); root.append(node);
  }
  return root;
}
function withMentions(parent, text) {
  const pattern = /(^|[\s(])@([a-z][a-z0-9_-]{1,23})\b/gi;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    const id = match[2].toLowerCase();
    if (!agentOf(id) && id !== 'all' && id !== 'everyone') continue;
    const start = match.index + match[1].length;
    parent.append(text.slice(last, start));
    parent.append(tint(el('span', 'mention', '@' + match[2]), id));
    last = start + match[2].length + 1;
  }
  parent.append(text.slice(last));
}

// ---------------------------------------------------------------- chat
function replyCard(turn, id) {
  const reply = turn.replies[id], agent = agentOf(id) || { label: id, vendor: '' };
  const card = tint(el('section', 'reply'), id); card.id = 'reply-' + turn.id + '-' + id;
  const head = el('div', 'reply-head');
  const names = el('div'); names.append(el('b', '', agent.label));
  head.append(avatar(agent), names, el('small', '', reply.model && reply.model !== 'demo' ? reply.model : agent.vendor));
  const status = el('span', 'status is-' + reply.status);
  if (reply.status === 'running' || reply.status === 'queued') status.append(el('span', 'pulse'), reply.activity?.length && !reply.text ? 'working' : reply.text ? 'writing' : 'thinking');
  else status.textContent = reply.status === 'complete' ? seconds(reply.durationMs || 0) : reply.status === 'cancelled' ? 'stopped' : 'failed';
  head.append(status);
  const live = reply.status === 'running' || reply.status === 'queued', lastTurn = state.conversation.turns.at(-1) === turn;
  if (live && turn.targets.length > 1) { const tools = el('span', 'reply-tools'), stop = el('button', '', 'Stop'); stop.type = 'button'; stop.title = 'Stop only ' + agent.label; stop.addEventListener('click', () => post('/api/cancel', { agent: id }).catch(fail)); tools.append(stop); head.append(tools); }
  if (!live && lastTurn && !state.active) { const tools = el('span', 'reply-tools'), again = el('button', '', reply.status === 'complete' ? 'Ask again' : 'Retry'); again.type = 'button'; again.title = 'Ask ' + agent.label + ' this again'; again.addEventListener('click', () => post('/api/retry', { agent: id }).catch(fail)); tools.append(again); head.append(tools); }
  card.append(head);
  for (const request of (state.approvals || []).filter(item => item.turnId === turn.id && item.agent === id)) {
    const box = el('div', 'approval'), line = el('p'), buttons = el('div');
    line.append(el('b', '', agent.label + ' asks permission'), ' to use ' + request.tool + ':');
    box.append(line, el('code', '', request.detail));
    if (state.canApprove) for (const [decision, label, cls] of [['allow', 'Allow', 'primary'], ['allow_turn', 'Allow all this turn', ''], ['deny', 'Deny', 'danger']]) { const button = el('button', 'button ' + cls, label); button.type = 'button'; button.addEventListener('click', () => post('/api/approve', { id: request.id, decision }).catch(fail)); buttons.append(button); }
    else buttons.append(el('small', '', 'Waiting for an answer on the host computer.'));
    box.append(buttons); card.append(box);
  }
  if (reply.activity?.length) {
    const box = el('div', 'activity');
    for (const step of reply.activity.slice(-4)) { const row = el('div'); row.append(el('i', '', step.tool), step.detail || ''); box.append(row); }
    card.append(box);
  }
  if (reply.text) { const body = el('div', 'reply-body'); body.append(markdown(reply.text)); card.append(body); }
  else if (reply.status === 'running' || reply.status === 'queued') card.append(el('div', 'reply-body waiting', reply.status === 'queued' && turn.order === 'sequence' ? agent.label + ' goes next, after the agent before it finishes.' : agent.label + ' is working in its own session…'));
  if (reply.error) card.append(el('p', 'reply-error', reply.error));
  if (reply.boardAdded || reply.session || reply.usage) {
    const foot = el('div', 'reply-foot'), parts = [];
    if (reply.boardAdded) foot.append(el('b', '', '+' + reply.boardAdded), 'added to the table');
    if (reply.session) parts.push(reply.session === 'resumed' ? 'continued its own session' : 'started its own session');
    if (reply.usage) parts.push(compact(reply.usage.input + reply.usage.output) + ' tokens' + (reply.usage.costUsd ? ' · $' + reply.usage.costUsd.toFixed(2) : ''));
    if (parts.length) foot.append(el('span', 'session', (reply.boardAdded ? '· ' : '') + parts.join(' · ')));
    card.append(foot);
  }
  return card;
}
function turnCard(turn) {
  const article = el('article', 'turn' + (turn.kind === 'review' ? ' review' : '')); article.id = 'turn-' + turn.id;
  const you = el('div', 'you'), meta = el('div', 'you-meta');
  const everyone = turn.targets.length === state.agents.length;
  meta.append((turn.from && turn.from !== 'you' ? turn.from : 'You') + ' · ' + clock(turn.createdAt) + ' · to ' + (everyone ? 'everyone' : turn.targets.map(id => agentOf(id)?.label || id).join(', ')) + (turn.order === 'sequence' ? ' · in turn' : ''));
  const text = el('div', 'you-text'); withMentions(text, turn.kind === 'review' ? 'Cross-review: ' + turn.message : turn.message);
  you.append(meta, text);
  if (turn.attachments?.length) {
    const files = el('div', 'you-files');
    for (const item of turn.attachments) {
      if (item.image) { const link = el('a', 'shot'); link.href = '/api/file/' + item.id; link.target = '_blank'; link.rel = 'noopener'; const image = el('img'); image.src = link.href; image.alt = item.name; image.loading = 'lazy'; link.append(image); files.append(link); }
      else files.append(fileChip(item));
    }
    you.append(files);
  }
  const replies = el('div', 'replies'); replies.style.setProperty('--columns', String(Math.min(turn.targets.length, 3)));
  for (const id of turn.targets) replies.append(replyCard(turn, id));
  article.append(you, replies);
  return article;
}
function emptyState() {
  const box = el('div', 'empty');
  box.append(el('h2', '', 'One message. Every agent at the table.'));
  box.append(el('p', '', 'Write once. ' + state.agents.map(agent => agent.label).join(' and ') + ' answer side by side, each in its own session, and keep decisions on the shared table.'));
  const list = el('div', 'starters');
  for (const [tag, text] of STARTERS) {
    if (tag !== 'everyone' && !agentOf(tag.slice(1))) continue;
    const button = el('button', 'starter'); button.type = 'button'; button.append(el('b', '', tag), el('span', '', text.replace(/^@\w+\s/, '')));
    button.addEventListener('click', () => { $('message').value = text; $('message').focus(); resize(); });
    list.append(button);
  }
  box.append(list);
  return box;
}
function renderTranscript() {
  const box = $('transcript'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.replaceChildren(...(state.conversation.turns.length ? state.conversation.turns.map(turnCard) : [emptyState()]));
  if (stick) box.scrollTop = box.scrollHeight;
}
function patchReply(event) {
  const turn = state.conversation.turns.find(item => item.id === event.turnId);
  if (!turn) return;
  turn.replies[event.agent] = event.reply;
  const old = $('reply-' + event.turnId + '-' + event.agent), box = $('transcript');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (old) old.replaceWith(replyCard(turn, event.agent));
  if (event.reply.status !== 'running' || !event.reply.text) renderRail();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- rail
function renderRail() {
  $('project-name').textContent = state.project.name;
  const rows = [...state.conversations].reverse();
  const sections = [];
  const pinned = rows.filter(item => item.pinned);
  if (pinned.length) sections.push(['Pinned', pinned]);
  for (const group of [...new Set(rows.filter(item => !item.pinned && item.group).map(item => item.group))].sort((x, y) => x.localeCompare(y))) sections.push([group, rows.filter(item => !item.pinned && item.group === group)]);
  const rest = rows.filter(item => !item.pinned && !item.group);
  if (rest.length) sections.push(['Conversations', rest]);
  const nodes = [];
  for (const [label, items] of sections) {
    nodes.push(el('p', 'rail-label', label));
    for (const item of items) {
      const row = el('div', 'conversation' + (item.id === state.conversation.id ? ' on' : '')); row.setAttribute('role', 'button'); row.tabIndex = 0; row.dataset.id = item.id;
      if (item.pinned) row.append(el('span', 'pin', '●'));
      row.append(el('span', '', item.title), el('time', '', day(item.createdAt)));
      const more = el('button', 'more', '···'); more.type = 'button'; more.title = 'Rename, pin, group'; more.setAttribute('aria-label', 'Manage conversation');
      more.addEventListener('click', event => { event.stopPropagation(); openMenu(item, row, more); });
      row.append(more);
      const open = () => { if (item.id !== state.conversation.id) post('/api/switch', { id: item.id }).then(() => setView('chat')).catch(fail); else setView('chat'); };
      row.addEventListener('click', event => { if (event.target.tagName !== 'INPUT') open(); });
      row.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === row) open(); });
      nodes.push(row);
    }
  }
  $('conversations').replaceChildren(...nodes);
  $('seats').replaceChildren(...state.agents.map(agent => {
    const row = tint(el('div', 'seat' + (agent.ready ? '' : ' off')), agent.id), text = el('div');
    const live = state.active ? state.conversation.turns.find(turn => turn.id === state.active)?.replies[agent.id]?.status : null;
    const working = live === 'running' || live === 'queued';
    text.append(el('b', '', agent.label + (agent.experimental ? ' (experimental)' : '')), el('small', '', working ? (live === 'queued' ? 'Waiting for its turn' : 'Working now…') : agent.ready ? agent.vendor + ' · ' + agent.route : agent.error));
    row.append(avatar(agent), text, el('span', working ? 'pulse' : 'dot ' + (agent.checking ? '' : agent.ready ? 'ready' : 'off')));
    if (agent.session) { const open = el('button', 'session-copy', 'session ' + agent.session.slice(0, 8) + ' · copy resume command'); open.type = 'button'; open.title = agent.resume; open.addEventListener('click', event => { event.stopPropagation(); (navigator.clipboard?.writeText(agent.resume) || Promise.reject()).then(() => { open.textContent = 'copied: paste in a terminal'; }, () => { prompt('Run this in a terminal to open the same session:', agent.resume); }); }); text.append(open); }
    const spent = state.conversation.turns.reduce((sum, turn) => sum + ((turn.replies[agent.id]?.usage?.input || 0) + (turn.replies[agent.id]?.usage?.output || 0)), 0);
    if (agent.limit?.status === 'reached') { text.append(el('small', '', 'Usage limit reached')); const bar = el('div', 'meter full'); bar.append(el('i')); bar.firstChild.style.width = '100%'; text.append(bar); row.classList.add('off'); }
    else if (typeof agent.limit?.used === 'number') { const used = Math.round(agent.limit.used * 100); text.append(el('small', '', used + '% of ' + (agent.limit.window || 'usage') + ' limit' + (spent ? ' · ' + compact(spent) + ' tokens here' : ''))); const bar = el('div', 'meter' + (used >= 90 ? ' full' : used >= 70 ? ' warn' : '')); bar.append(el('i')); bar.firstChild.style.width = Math.min(100, used) + '%'; text.append(bar); }
    else if (spent) text.append(el('small', '', compact(spent) + ' tokens in this conversation'));
    row.title = 'Click to address ' + agent.label; row.addEventListener('click', () => { const box = $('message'); if (!new RegExp('@' + agent.id + '\\b', 'i').test(box.value)) box.value = '@' + agent.id + ' ' + box.value; setView('chat'); box.focus(); });
    return row;
  }));
  $('phone-open').hidden = state.role !== 'owner';
}

function closeMenu() { $('conversation-menu').hidden = true; document.querySelector('.conversation.menu-open')?.classList.remove('menu-open'); }
function renameInline(item) {
  const row = document.querySelector('.conversation[data-id="' + item.id + '"]'); if (!row) return;
  const input = el('input'); input.value = item.title; input.maxLength = 80; input.setAttribute('aria-label', 'Conversation name');
  row.querySelector('span:not(.pin)').replaceWith(input); input.focus(); input.select();
  let finished = false;
  const finish = save => { if (finished) return; finished = true; const title = input.value.trim(); if (save && title && title !== item.title) post('/api/conversation', { id: item.id, title }).catch(fail); else renderRail(); };
  input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}
function openMenu(item, row, anchor) {
  closeMenu();
  const menu = $('conversation-menu'), add = (label, action, cls) => { const button = el('button', cls || '', label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.addEventListener('click', () => { closeMenu(); action(); }); menu.append(button); return button; };
  const change = value => post('/api/conversation', { id: item.id, ...value }).catch(fail);
  menu.replaceChildren();
  add('Rename', () => renameInline(item));
  add(item.pinned ? 'Unpin' : 'Pin to top', () => change({ pinned: !item.pinned }));
  menu.append(el('hr'), el('p', '', 'Group'));
  for (const group of [...new Set(state.conversations.map(entry => entry.group).filter(Boolean))].sort()) add(group, () => change({ group }), item.group === group ? 'on' : '');
  add('New group…', () => { const name = prompt('Name of the new group'); if (name && name.trim()) change({ group: name }); });
  if (item.group) add('Remove from group', () => change({ group: '' }));
  if (state.role === 'owner') { menu.append(el('hr')); add('Delete', () => { if (confirm('Delete "' + item.title + '"? This cannot be undone.')) post('/api/delete', { id: item.id }).catch(fail); }, 'danger'); }
  menu.hidden = false; row.classList.add('menu-open');
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.min(box.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  menu.querySelector('button').focus();
}

// ---------------------------------------------------------------- board
function renderBoard() {
  const board = state.conversation.board || [];
  $('board-count').textContent = board.length ? String(board.length) : '';
  $('tab-count').textContent = board.length ? String(board.length) : '';
  const kinds = ['all', ...Object.keys(KIND_LABEL).filter(kind => board.some(item => item.kind === kind))];
  if (!kinds.includes(filter)) filter = 'all';
  $('filters').replaceChildren(...kinds.map(kind => {
    const button = el('button', 'filter' + (kind === filter ? ' on' : ''), kind === 'all' ? 'All' : KIND_LABEL[kind]); button.type = 'button';
    button.append(el('span', '', String(kind === 'all' ? board.length : board.filter(item => item.kind === kind).length)));
    button.addEventListener('click', () => { filter = kind; renderBoard(); });
    return button;
  }));
  const rows = board.filter(item => filter === 'all' || item.kind === filter).reverse();
  if (!rows.length) { const empty = el('li', 'entries-empty', 'Nothing on the table yet. Agents add decisions, tasks, risks and open questions here as they work, and so can you.'); $('entries').replaceChildren(empty); return; }
  $('entries').replaceChildren(...rows.map(item => {
    const row = el('li', 'entry' + (item.done ? ' done' : ''));
    let mark;
    if (item.kind === 'task') {
      mark = el('button', 'kind task', item.done ? '✓' : ''); mark.type = 'button'; mark.title = item.done ? 'Mark as open' : 'Mark as done';
      mark.addEventListener('click', () => post('/api/board', { op: 'toggle', id: item.id }).catch(fail));
    } else { mark = el('span', 'kind ' + item.kind, KIND_MARK[item.kind]); mark.title = item.kind; }
    const body = el('div'), meta = tint(el('div', 'entry-meta'), item.author);
    meta.append(el('i'), (agentOf(item.author)?.label || 'You') + ' · ' + item.kind + ' · ' + day(item.createdAt));
    body.append(el('div', 'entry-text', item.text), meta);
    const remove = el('button', 'remove', '×'); remove.type = 'button'; remove.title = 'Remove';
    remove.addEventListener('click', () => post('/api/board', { op: 'remove', id: item.id }).catch(fail));
    row.append(mark, body, remove);
    return row;
  }));
}

// ---------------------------------------------------------------- attachments
const sizeOf = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');
function fileChip(item, onRemove) {
  const chip = el(onRemove ? 'div' : 'a', 'file' + (item.busy ? ' busy' : ''));
  if (!onRemove) { chip.href = '/api/file/' + item.id; chip.target = '_blank'; chip.rel = 'noopener'; }
  if (item.image && item.id) { const image = el('img'); image.src = '/api/file/' + item.id; image.alt = ''; chip.append(image); }
  else chip.append(el('i', 'ext', (item.name.split('.').pop() || 'file').slice(0, 4)));
  chip.append(el('span', '', item.name), el('small', '', item.busy ? 'uploading' : sizeOf(item.size)));
  if (onRemove) { const remove = el('button', '', '×'); remove.type = 'button'; remove.title = 'Remove'; remove.addEventListener('click', onRemove); chip.append(remove); }
  return chip;
}
function renderPending() {
  $('pending').hidden = !pending.length;
  $('pending').replaceChildren(...pending.map(item => fileChip(item, () => { pending = pending.filter(other => other !== item); renderPending(); })));
}
async function addFiles(files) {
  fail('');
  for (const file of [...files].slice(0, Math.max(0, 10 - pending.length))) {
    if (file.size > 15 * 1048576) { fail('"' + file.name + '" is larger than 15 MB.'); continue; }
    const item = { name: file.name || 'pasted-image.png', size: file.size, busy: true };
    pending.push(item); renderPending();
    try {
      const response = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(item.name) }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Upload failed.');
      Object.assign(item, result, { busy: false });
    } catch (error) { pending = pending.filter(other => other !== item); fail(error); }
    renderPending();
  }
}

// ---------------------------------------------------------------- composer
function renderComposer() {
  const busy = !!state.active;
  const everyone = el('button', 'target all' + (selected.size ? '' : ' on'), 'Everyone'); everyone.type = 'button';
  everyone.addEventListener('click', () => { selected.clear(); renderComposer(); });
  $('targets').replaceChildren(everyone, ...state.agents.map(agent => {
    const button = tint(el('button', 'target' + (selected.has(agent.id) ? ' on' : ''), agent.label), agent.id); button.type = 'button';
    button.title = agent.ready ? 'Send only to ' + agent.label : agent.error;
    button.addEventListener('click', () => { if (selected.has(agent.id)) selected.delete(agent.id); else selected.add(agent.id); if (selected.size === state.agents.length) selected.clear(); renderComposer(); });
    return button;
  }));
  const last = state.conversation.turns.at(-1);
  const canReview = !busy && last && Object.values(last.replies).filter(reply => reply.status === 'complete').length >= 2;
  $('order').hidden = state.agents.length < 2;
  $('review').hidden = state.agents.length < 2; $('review').disabled = !canReview;
  $('send').hidden = busy; $('cancel').hidden = !busy;
  $('new').disabled = busy;
  $('hint').textContent = busy ? 'Agents are working. You can stop them.' : state.demo ? 'Demo mode: replies are scripted, no model is called.' : 'Type @ to address one agent. Paste or drop files and images.';
  $('message').placeholder = selected.size ? 'Message ' + [...selected].map(id => agentOf(id).label).join(' and ') + '…' : 'Message everyone, or @mention one agent…';
}
function resize() { const box = $('message'); box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 220) + 'px'; }
function mentionQuery() {
  const box = $('message'), before = box.value.slice(0, box.selectionStart), match = /(^|[\s(])@([a-z0-9_-]*)$/i.exec(before);
  return match ? { text: match[2].toLowerCase(), start: before.length - match[2].length - 1 } : null;
}
function renderMenu() {
  const query = mentionQuery(), menu = $('mention-menu');
  const options = query ? [...state.agents, { id: 'all', label: 'Everyone', vendor: 'all agents', color: 'var(--ink)' }].filter(agent => agent.id.startsWith(query.text)) : [];
  if (!options.length) { menu.hidden = true; return []; }
  menuIndex = Math.min(menuIndex, options.length - 1);
  menu.replaceChildren(...options.map((agent, i) => {
    const button = el('button', i === menuIndex ? 'on' : ''); button.type = 'button';
    const badge = agent.id === 'all' ? el('span', 'avatar you') : avatar(agent); if (agent.id === 'all') badge.append(glyph('st-logo')); badge.style.setProperty('--agent', agent.color);
    button.append(badge, el('b', '', '@' + agent.id), el('small', '', agent.vendor));
    button.addEventListener('mousedown', event => { event.preventDefault(); pickMention(agent.id); });
    return button;
  }));
  menu.hidden = false;
  return options;
}
function pickMention(id) {
  const box = $('message'), query = mentionQuery(); if (!query) return;
  const after = box.value.slice(box.selectionStart);
  box.value = box.value.slice(0, query.start) + '@' + id + ' ' + after.replace(/^\s/, '');
  const caret = query.start + id.length + 2; box.setSelectionRange(caret, caret);
  $('mention-menu').hidden = true; box.focus();
}
async function sendMessage(kind = 'message') {
  const box = $('message'), message = box.value.trim();
  if (kind === 'message' && /^\/gamarjoba$/i.test(message)) { box.value = ''; resize(); return hello(); }
  if (state.active || pending.some(item => item.busy) || (kind === 'message' && !message && !pending.length)) return;
  fail(''); requestId ??= uuid();
  try {
    await post('/api/message', { clientId: requestId, message: kind === 'review' ? '' : message, kind, targets: kind === 'review' ? [] : [...selected], order, attachments: kind === 'review' ? [] : pending.map(item => item.id), brief: $('brief').value });
    if (kind === 'message') { box.value = ''; resize(); pending = []; renderPending(); }
    requestId = null; setView('chat');
    const transcript = $('transcript'); transcript.scrollTop = transcript.scrollHeight;
  } catch (error) { fail(error); }
}

// ---------------------------------------------------------------- phone access
function drawQR(rows) {
  const canvas = $('qr'), context = canvas.getContext('2d'), quiet = 3, count = rows.length + quiet * 2;
  const scale = Math.floor(792 / count); canvas.width = canvas.height = scale * count;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#111';
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); });
}
async function refreshQR() {
  clearTimeout(pairTimer);
  const remote = state.remote; if (!remote || !$('phone').open) return;
  const ways = [...(remote.lan.length ? ['lan'] : []), ...(remote.tunnelStatus === 'on' ? ['tunnel'] : [])];
  $('qr-switch').hidden = ways.length < 2;
  if (!ways.includes(pairVia)) pairVia = ways.at(-1) || null;
  for (const button of $('qr-switch').children) button.classList.toggle('on', button.dataset.via === pairVia);
  $('qr').classList.toggle('off', !pairVia); $('qr-empty').hidden = !!pairVia;
  if (!pairVia) { $('qr-url').textContent = ''; const c = $('qr'); c.getContext('2d').clearRect(0, 0, c.width, c.height); return; }
  try {
    const pair = await post('/api/pair/start', { via: pairVia });
    drawQR(pair.qr);
    $('qr-url').textContent = 'Scan with the phone camera. ' + new URL(pair.url).origin;
    pairTimer = setTimeout(refreshQR, (pair.expiresInSeconds - 30) * 1000);
  } catch (error) { $('qr-url').textContent = error.message; }
}
function renderPhone() {
  const remote = state.remote; if (!remote) return;
  $('lan-toggle').checked = remote.lan.length > 0; $('lan-toggle').disabled = !remote.lanAvailable;
  $('lan-text').textContent = remote.lan.length ? remote.lan.join('  ') : remote.lanAvailable ? 'Phones on this network can connect after scanning.' : 'This computer is not on a network.';
  $('tunnel-toggle').checked = remote.tunnelStatus !== 'off'; $('tunnel-toggle').disabled = !remote.tunnelProvider;
  $('tunnel-option').classList.toggle('busy', remote.tunnelStatus === 'starting');
  $('tunnel-text').textContent = remote.tunnelStatus === 'starting' ? 'Opening tunnel…' : remote.tunnel ? remote.tunnel + '  ·  ' + remote.tunnelProvider : remote.tunnelError ? remote.tunnelError : remote.tunnelProvider ? 'Opens a private HTTPS tunnel (' + remote.tunnelProvider + ') so the phone works on mobile data.' : 'Needs cloudflared or ssh on this computer.';
  $('devices').replaceChildren(...(remote.devices.length ? remote.devices.map(device => {
    const row = el('li'), text = el('span'); text.append(device.name, el('small', '', 'Paired ' + day(device.createdAt) + ' · last seen ' + day(device.lastSeen)));
    const remove = el('button', 'button ghost', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', () => post('/api/pair/revoke', { id: device.id }).catch(fail));
    row.append(text, remove); return row;
  }) : [el('li', 'none', 'No phone paired yet.')]));
}
async function setRemote(change, option) {
  option.classList.add('busy');
  try { await post('/api/remote', change); } catch (error) { $('qr-url').textContent = error.message; }
  option.classList.remove('busy');
}

// ---------------------------------------------------------------- render
function setView(view) {
  document.body.dataset.view = view;
  for (const button of $('tabs').children) button.classList.toggle('on', button.dataset.view === view);
}
function render(next) {
  const previous = state; state = next;
  for (const id of [...selected]) if (!agentOf(id)) selected.delete(id);
  $('pairing').hidden = true; $('app').hidden = false; $('tabs').hidden = false;
  const current = state.conversations.find(item => item.id === state.conversation.id);
  $('title').textContent = current?.title || 'New conversation';
  document.title = (current?.title && current.title !== 'New conversation' ? current.title + ' · ' : '') + 'Shared Table';
  $('subtitle').textContent = state.project.name + ' · ' + state.agents.length + ' agents · ' + state.conversation.turns.length + (state.conversation.turns.length === 1 ? ' turn' : ' turns');
  const mode = el('span', 'chip ' + state.project.mode, { advise: 'Advise · no tools', read: 'Read · project files', build: 'Build · agents can edit' }[state.project.mode]);
  $('chips').replaceChildren(...(state.demo ? [el('span', 'chip demo', 'Demo')] : []), mode);
  if (document.activeElement !== $('brief') || previous?.conversation.id !== state.conversation.id) $('brief').value = state.conversation.brief;
  $('folder').textContent = state.project.folder;
  renderRail(); renderTranscript(); renderBoard(); renderComposer(); renderPhone(); renderCommands(); if ($('settings').open) renderSettings();
  $('commands-tab').hidden = !state.terminal; if (!state.terminal && sidePane === 'commands') showPane('table');
  if (previous && previous.project.folder !== state.project.folder) { changes = null; if (sidePane === 'changes') loadChanges(); }
  const waiting = (state.approvals || []).length;
  if (waiting > (previous?.approvals || []).length) { const request = state.approvals.at(-1); notify('Permission needed', request.detail.slice(0, 120)); window.SharedTablePet?.say((agentOf(request.agent)?.label || 'An agent') + ' needs your OK to use ' + request.tool + '.', 9000); }
  window.SharedTablePet?.signal(state.active ? 'working' : 'idle');
  if (previous?.remote && JSON.stringify([previous.remote.lan, previous.remote.tunnel]) !== JSON.stringify([state.remote?.lan, state.remote?.tunnel])) refreshQR();
}

// ---------------------------------------------------------------- start
function handleEvent(event) {
  if (event.type === 'state') render(event);
  else if (event.type === 'reply' && state) patchReply(event);
  else if (event.type === 'notice') fail(event);
  else if (event.type === 'terminal' && state?.terminal) { const at = state.terminal.findIndex(entry => entry.id === event.entry.id); if (at >= 0) state.terminal[at] = event.entry; else state.terminal.push(event.entry); renderCommands(); }
  else if (event.type === 'done') { const turn = state?.conversation.turns.find(item => item.id === event.turnId), failed = turn ? Object.entries(turn.replies).filter(([, reply]) => reply.status === 'error').map(([id]) => agentOf(id)?.label || id) : []; window.SharedTablePet?.signal('finished'); window.SharedTablePet?.say(failed.length ? failed.join(' and ') + ' could not finish. The rest is ready.' : 'Finished. Have a look.', 6000); notify('Agents finished', $('title').textContent); loadChanges(true); }
}
// Live updates arrive as a server-sent event stream. Some tunnels (Cloudflare quick tunnels) do not carry such
// streams, so if nothing arrives the page falls back to asking for the state every second and a half.
let polling = 0;
function startPolling() {
  if (polling) return;
  let wasActive = null;
  polling = setInterval(async () => {
    try {
      const response = await fetch('/api/state'); if (!response.ok) return;
      const next = await response.json();
      if (wasActive && !next.active) handleEvent({ type: 'done', turnId: wasActive });
      wasActive = next.active; render(next);
    } catch { /* offline for a moment */ }
  }, 1500);
}
function connect() {
  const events = new EventSource('/api/events');
  let received = false, failures = 0;
  const watchdog = setTimeout(() => { if (!received) { events.close(); startPolling(); } }, 7000);
  events.onmessage = message => { received = true; failures = 0; clearTimeout(watchdog); handleEvent(JSON.parse(message.data)); };
  events.onerror = () => { if (state) $('hint').textContent = 'Connection lost. Reconnecting…'; if (++failures >= 3 && !received) { events.close(); clearTimeout(watchdog); startPolling(); } };
}
function showPairing(text, steps) { $('app').hidden = true; $('tabs').hidden = true; $('pairing').hidden = false; $('pairing-text').textContent = text; $('pairing-steps').hidden = !steps; }
async function start() {
  let theme = null, accent = '';
  try { theme = localStorage.getItem('st-theme'); accent = localStorage.getItem('st-accent') || ''; } catch { /* private mode */ }
  applyLook(THEMES.some(item => item[0] === theme) ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', accent);
  if (window.SharedTablePet) {
    window.SharedTablePet.mount($('pet'), $('pet-bubble'), {
      // The pet walks along the top edge of the message box.
      bounds: () => { const box = $('compose').getBoundingClientRect(); return box.width ? { left: box.left, right: box.right, y: box.top + 14 } : { left: 0, right: innerWidth, y: innerHeight - 70 }; },
      onMenu: openPetMenu, onPet: petStatus,
    });
    window.SharedTablePet.choose(prefs.get('pet'));
  }
  if (prefs.get('order') === 'sequence') setOrder('sequence');
  const token = /[#&]pair=([\w-]+)/.exec(location.hash)?.[1];
  if (token) {
    history.replaceState(null, '', location.pathname);
    showPairing('Pairing this device…');
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser';
    try { await post('/api/pair/claim', { token, name }); } catch (error) { return showPairing(error.message, true); }
  }
  const response = await fetch('/api/state');
  if (response.status === 401) return showPairing('This device is not paired yet.', true);
  render(await response.json());
  connect();
}

$('compose').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
$('message').addEventListener('input', () => { requestId = null; resize(); menuIndex = 0; renderMenu(); });
$('message').addEventListener('blur', () => { $('mention-menu').hidden = true; });
$('message').addEventListener('keydown', event => {
  const options = $('mention-menu').hidden ? [] : renderMenu();
  if (options.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Escape') $('mention-menu').hidden = true;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length; renderMenu(); }
    else pickMention(options[menuIndex].id);
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(max-width: 980px)').matches) { event.preventDefault(); sendMessage(); }
});
$('attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
$('message').addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
let dragDepth = 0;
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
$('chat').addEventListener('dragenter', event => { if (hasFiles(event)) { event.preventDefault(); dragDepth++; $('drop-hint').hidden = false; } });
$('chat').addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
$('chat').addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-hint').hidden = true; });
$('chat').addEventListener('drop', event => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth = 0; $('drop-hint').hidden = true; addFiles(event.dataTransfer.files); });
$('review').addEventListener('click', () => sendMessage('review'));
$('cancel').addEventListener('click', () => post('/api/cancel').catch(fail));
$('new').addEventListener('click', () => post('/api/new').then(() => { setView('chat'); $('message').focus(); }).catch(fail));
$('brief').addEventListener('input', () => { clearTimeout(briefTimer); $('brief-state').textContent = 'saving…'; briefTimer = setTimeout(() => post('/api/brief', { brief: $('brief').value }).then(() => { $('brief-state').textContent = 'saved'; }).catch(fail), 600); });
$('add-entry').addEventListener('submit', event => { event.preventDefault(); const text = $('entry-text').value.trim(); if (!text) return; post('/api/board', { op: 'add', kind: $('entry-kind').value, text }).then(() => { $('entry-text').value = ''; }).catch(fail); });
const THEMES = [['light', 'Day', '#f4f1ea', '#1b1a17'], ['dark', 'Night', '#0f100e', '#f2efe7'], ['crimson', 'Crimson', '#0f0b07', '#d31414'], ['parchment', 'Parchment', '#f4e8d0', '#8b2a2a'], ['midnight', 'Midnight', '#0b1020', '#7c9cff']];
const ACCENTS = [['', 'Theme default', 'var(--ink)'], ['crimson', 'Crimson', '#d31414'], ['gold', 'Gold', '#c9a84c'], ['blue', 'Blue', '#4f6bed'], ['green', 'Green', '#1f9d74'], ['violet', 'Violet', '#7a5af5']];
function applyLook(theme, accent) {
  const root = document.documentElement;
  root.dataset.theme = theme; if (accent) root.dataset.accent = accent; else delete root.dataset.accent;
  try { localStorage.setItem('st-theme', theme); localStorage.setItem('st-accent', accent || ''); } catch { /* private mode */ }
  document.querySelector('meta[name=theme-color]').content = THEMES.find(item => item[0] === theme)?.[2] || '#0f100e';
}
const prefs = { get: (key, fallback = '') => { try { return localStorage.getItem('st-' + key) ?? fallback; } catch { return fallback; } }, set: (key, value) => { try { localStorage.setItem('st-' + key, value); } catch { /* private mode */ } } };
function notify(title, body) {
  if (prefs.get('notify') !== '1' || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('Shared Table: ' + title, { body, icon: '/icon-192.png', tag: 'shared-table' }); } catch { /* not allowed here */ }
}

// ---------------------------------------------------------------- side panes: table, changes, commands
let sidePane = 'table', changes = null, openDiff = null;
function showPane(name) {
  sidePane = name;
  for (const button of $('side-tabs').children) button.classList.toggle('on', button.dataset.pane === name);
  for (const pane of ['table', 'changes', 'commands', 'preview']) $('pane-' + pane).hidden = pane !== name;
  $('app').classList.toggle('wide-side', name === 'preview');
  if (name === 'preview' && !$('preview-frame').src && prefs.get('preview')) loadPreview(prefs.get('preview'));
  if (name === 'changes') loadChanges();
}
async function loadChanges(quiet) {
  if (quiet && sidePane !== 'changes' && !state?.project.repo) return;
  try { changes = await post('/api/changes'); } catch (error) { changes = { repo: false, targets: [], error: error.message }; }
  renderChanges();
}
function renderChanges() {
  if (!changes) return;
  const total = changes.targets.reduce((sum, place) => sum + place.files.length, 0);
  $('changes-count').textContent = total ? String(total) : '';
  $('changes-sub').textContent = changes.isolated ? 'Each agent works in its own copy; apply what you want to keep' : 'What differs from the last commit';
  if (!changes.repo) return $('changes').replaceChildren(el('div', 'entries-empty', 'This project folder is not a git repository, so changes cannot be tracked. Run "git init" in it to see what agents change and to revert it.'));
  $('changes').replaceChildren(...changes.targets.map(place => {
    const box = tint(el('div', 'place'), place.id), head = el('div', 'place-head');
    head.append(el('i'), el('span', '', place.label), el('small', '', place.files.length ? place.files.length + (place.files.length === 1 ? ' file' : ' files') : 'no changes'));
    box.append(head);
    if (!place.files.length) box.append(el('div', 'place-empty', place.id === 'project' ? 'Nothing has changed since the last commit.' : 'Nothing waiting in this agent’s copy.'));
    for (const file of place.files) {
      const row = el('button', 'file-row' + (openDiff?.target === place.id && openDiff.file === file.path ? ' on' : '')); row.type = 'button';
      row.append(el('b', 's-' + file.status, file.status === '?' ? '+' : file.status), el('span', '', file.path));
      row.addEventListener('click', () => showDiff(place.id, file.path));
      box.append(row);
    }
    if (place.id !== 'project' && place.files.length && state.role === 'owner') {
      const actions = el('div', 'place-actions'), apply = el('button', 'button primary', 'Apply to project'), discard = el('button', 'button danger', 'Discard');
      apply.type = discard.type = 'button';
      apply.addEventListener('click', () => post('/api/worktree', { target: place.id, op: 'apply' }).then(() => loadChanges(), fail));
      discard.addEventListener('click', () => { if (confirm('Throw away everything ' + place.label + ' changed in its copy?')) post('/api/worktree', { target: place.id, op: 'discard' }).then(() => { closeDiff(); loadChanges(); }, fail); });
      actions.append(apply, discard); box.append(actions);
    }
    return box;
  }));
}
async function showDiff(target, file) {
  openDiff = { target, file }; renderChanges();
  $('diff').hidden = false; $('diff-name').textContent = file; $('diff-revert').hidden = state.role !== 'owner'; $('diff-text').textContent = 'Loading…';
  try {
    const { text } = await post('/api/diff', { target, file });
    $('diff-text').replaceChildren(...(text || 'No differences.').split('\n').map(line => el('div', line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '', line || ' ')));
  } catch (error) { $('diff-text').textContent = error.message; }
}
function closeDiff() { openDiff = null; $('diff').hidden = true; if (changes) renderChanges(); }
function loadPreview(address) {
  let url = String(address || '').trim(); if (!url) return;
  if (/^\d+$/.test(url)) url = 'http://localhost:' + url; else if (!/^https?:\/\//i.test(url)) url = (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) ? 'http://' : 'https://') + url;
  try { url = new URL(url).href; } catch { return fail('That is not a web address.'); }
  $('preview-url').value = url; prefs.set('preview', url);
  $('preview-empty').hidden = true; $('preview-frame').hidden = false; $('preview-frame').src = url;
}
function renderCommands() {
  if (!state?.terminal) return;
  const box = $('commands'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!state.terminal.length) return box.replaceChildren(el('div', 'entries-empty', 'Run a command in the project folder without leaving the page: tests, a build, git status. Send the output to the agents with one click. Commands cannot ask for keyboard input.'));
  box.replaceChildren(...state.terminal.map(entry => {
    const card = el('div', 'command'), head = el('div', 'command-head'), actions = el('div', 'command-actions');
    head.append(el('code', '', entry.command), el('small', entry.running ? '' : entry.exitCode === 0 ? 'good' : 'bad', entry.running ? 'running…' : entry.exitCode === 0 ? 'done' : 'exit ' + entry.exitCode));
    const out = el('pre', '', entry.output || (entry.running ? '' : '(no output)')); card.append(head, out);
    if (entry.running) { const stop = el('button', 'button danger', 'Stop'); stop.type = 'button'; stop.addEventListener('click', () => post('/api/terminal/stop', { id: entry.id }).catch(fail)); actions.append(stop); }
    else {
      const share = el('button', 'button ghost', 'Send output to chat'); share.type = 'button';
      share.addEventListener('click', () => { addFiles([new File(['$ ' + entry.command + '\n' + entry.output + '\n(exit ' + entry.exitCode + ')\n'], 'command-output.txt', { type: 'text/plain' })]); setView('chat'); $('message').focus(); });
      const again = el('button', 'button ghost', 'Run again'); again.type = 'button'; again.addEventListener('click', () => post('/api/terminal/run', { command: entry.command }).catch(fail));
      actions.append(share, again);
    }
    card.append(actions); queueMicrotask(() => { out.scrollTop = out.scrollHeight; });
    return card;
  }));
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- projects
function openProjects() {
  const menu = $('project-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  if (state.role !== 'owner') return;
  menu.replaceChildren(el('p', '', 'Projects'));
  for (const item of state.projects || []) {
    const button = el('button', item.folder === state.project.folder ? 'on' : ''); button.type = 'button'; button.title = item.folder; button.append(item.name);
    button.addEventListener('click', () => { menu.hidden = true; if (item.folder !== state.project.folder) post('/api/project', { folder: item.folder }).catch(fail); });
    menu.append(button);
  }
  menu.append(el('hr'));
  const open = el('button', '', 'Open another folder…'); open.type = 'button';
  open.addEventListener('click', () => { menu.hidden = true; const folder = prompt('Full path of the project folder', state.project.folder); if (folder && folder.trim()) post('/api/project', { folder: folder.trim() }).catch(fail); });
  menu.append(open);
  menu.hidden = false;
  const box = $('project-open').getBoundingClientRect();
  menu.style.left = box.left + 'px'; menu.style.top = box.bottom + 4 + 'px';
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const body = $('settings-body'), root = document.documentElement, owner = state.role === 'owner', busy = !!state.active, scroll = body.scrollTop;
  const section = title => el('h3', '', title);
  const row = (title, help, control, off) => { const line = el('div', 'setting' + (off ? ' off' : '')), text = el('div'); text.append(el('b', '', title), el('small', '', help)); line.append(text, control); return line; };
  const toggle = (checked, onChange) => { const wrap = el('label', 'toggle'), input = el('input'); input.type = 'checkbox'; input.checked = checked; input.addEventListener('change', () => onChange(input.checked)); wrap.append(input, el('span', 'switch')); return wrap; };
  const choice = (value, options, onChange) => { const select = el('select'); for (const [id, label] of options) { const option = el('option', '', label); option.value = id; option.selected = id === value; select.append(option); } select.addEventListener('change', () => onChange(select.value)); return select; };
  const save = change => post('/api/settings', change).catch(error => { fail(error); renderSettings(); });
  const nodes = [section('Theme')];

  const themes = el('div', 'theme-grid');
  for (const [id, label, a, b] of THEMES) { const card = el('button', 'theme-card' + (root.dataset.theme === id ? ' on' : '')); card.type = 'button'; const swatch = el('i'); swatch.style.setProperty('--a', a); swatch.style.setProperty('--b', b); card.append(swatch, el('span', '', label)); card.addEventListener('click', () => { applyLook(id, ''); renderSettings(); }); themes.append(card); }
  const accents = el('div', 'swatches');
  for (const [id, label, color] of ACCENTS) { const dot = el('button', (root.dataset.accent || '') === id ? 'on' : ''); dot.type = 'button'; dot.title = label; dot.setAttribute('aria-label', label); dot.style.setProperty('--swatch', color); dot.addEventListener('click', () => { applyLook(root.dataset.theme, id); renderSettings(); }); accents.append(dot); }
  nodes.push(themes, row('Accent colour', 'Buttons, your messages and highlights.', accents));

  nodes.push(section('Companion'));
  const pets = el('div', 'pet-grid'), current = prefs.get('pet');
  for (const [id, label, image] of [['', 'None', null], ['flick', 'Flick the fox', '/pets/flick-sit.webp'], ['perle', 'Perle the kitten', 'sprite']]) {
    const card = el('button', 'pet-card' + (current === id ? ' on' : '')); card.type = 'button';
    if (image === 'sprite') card.append(el('span', 'perle-face'));
    else if (image) { const picture = el('img'); picture.src = image; picture.alt = ''; card.append(picture); } else card.append(el('span', 'none', '—'));
    card.append(label); card.addEventListener('click', () => { prefs.set('pet', id); window.SharedTablePet?.choose(id); renderSettings(); }); pets.append(card);
  }
  nodes.push(pets);

  nodes.push(section('On this device'));
  nodes.push(row('Notifications', 'Tell me when agents finish or need permission while this tab is in the background.', toggle(prefs.get('notify') === '1' && 'Notification' in window && Notification.permission === 'granted', async on => { if (on && 'Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission(); prefs.set('notify', on && 'Notification' in window && Notification.permission === 'granted' ? '1' : '0'); renderSettings(); }), !('Notification' in window)));
  nodes.push(row('Send in turn by default', 'Agents go one after another instead of all at once.', toggle(prefs.get('order') === 'sequence', on => { prefs.set('order', on ? 'sequence' : 'parallel'); setOrder(on ? 'sequence' : 'parallel'); })));

  if (owner) {
    const settings = state.settings;
    nodes.push(section('What agents may do' + (busy ? ' (locked while agents are working)' : '')));
    nodes.push(row('Mode', 'Advise: answer only. Read: may read the project. Build: may edit files and run commands.', choice(settings.mode, [['advise', 'Advise'], ['read', 'Read'], ['build', 'Build']], mode => save({ mode })), busy));
    nodes.push(row('Ask me before commands', 'In build mode, Claude Code asks in the chat before running a command or anything beyond a file edit. Off: such actions are refused. Codex has no such channel; its sandbox decides.', toggle(settings.approvals === 'ask', on => save({ approvals: on ? 'ask' : 'deny' })), busy));
    nodes.push(row('Phones may answer permission requests', 'Paired phones can allow or deny what agents ask for.', toggle(settings.phoneApprovals, on => save({ phoneApprovals: on })), busy));
    nodes.push(row('One copy of the project per agent', 'Build mode: each agent edits its own git worktree, and you apply the result from the Changes tab. Needs a git repository' + (state.project.repo ? '.' : ' (this folder is not one).'), toggle(settings.isolation === 'worktree', on => save({ isolation: on ? 'worktree' : 'shared' })), busy || !state.project.repo));
    nodes.push(row('Keep each agent’s own session', 'Agents remember their own work between messages and can be resumed in their own app.', toggle(settings.sessions === 'native', on => save({ sessions: on ? 'native' : 'stateless' })), busy));
    nodes.push(row('Full Claude Code harness', 'Build mode: also load your personal MCP servers, plugins and slash commands. Uses much more of your Claude allowance per message.', toggle(settings.fullHarness, on => save({ fullHarness: on })), busy));
    nodes.push(row('Commands tab', 'Run shell commands in the project folder from this page. Host computer only.', toggle(settings.terminal, on => save({ terminal: on })), busy));
  }
  if (owner && state.gateway) {
    nodes.push(section('Model gateway'));
    nodes.push(el('p', 'fineprint', 'Seat any model at the table through its API: Claude, OpenAI, Gemini, OpenRouter, Groq, xAI, Mistral, DeepSeek, or a model running on this computer. These agents answer from the brief, the board, the chat and your attachments; they cannot read or change files.'));
    for (const item of state.gateway.agents) {
      const provider = state.gateway.providers.find(entry => entry.id === item.provider), remove = el('button', 'button ghost danger-text', 'Remove'); remove.type = 'button';
      remove.addEventListener('click', () => post('/api/gateway/agent', { op: 'remove', id: item.id }).catch(fail));
      nodes.push(row('@' + item.id + ' · ' + item.label, (provider?.label || item.provider) + ' · ' + item.model, remove, busy));
    }
    const form = el('form', 'gateway-form'), provider = el('select'), address = el('input'), key = el('input'), model = el('input'), options = el('datalist'), load = el('button', 'button', 'Load models'), add = el('button', 'button primary', 'Add to the table'), note = el('small');
    form.autocomplete = 'off'; options.id = 'gateway-models'; model.setAttribute('list', options.id);
    for (const item of state.gateway.providers) { const option = el('option', '', item.label); option.value = item.id; option.selected = item.id === gatewayDraft.provider; provider.append(option); }
    address.placeholder = 'http://127.0.0.1:8080/v1'; address.value = gatewayDraft.baseUrl; address.spellcheck = false; address.setAttribute('aria-label', 'Server address');
    key.type = 'password'; key.autocomplete = 'new-password'; key.spellcheck = false; key.setAttribute('aria-label', 'API key');
    model.placeholder = 'Model'; model.value = gatewayDraft.model; model.spellcheck = false; model.setAttribute('aria-label', 'Model');
    load.type = 'button'; add.type = 'submit';
    const current = () => state.gateway.providers.find(item => item.id === provider.value);
    const sync = () => {
      const item = current(); gatewayDraft.provider = item.id;
      address.hidden = !(item.custom || item.local); if (!address.value && item.local) address.placeholder = item.baseUrl;
      key.hidden = item.local; key.placeholder = item.hasKey ? 'Key ' + (item.keySource === 'saved' ? 'saved' : 'found in ' + item.keyEnv) + '. Paste to replace.' : 'Paste your ' + item.label + ' key' + (item.keyEnv ? ' (or set ' + item.keyEnv + ')' : '');
      if (!model.value && item.suggest) model.placeholder = item.suggest; else model.placeholder = 'Model';
      note.textContent = item.local ? 'Start the server first, then load its models.' : 'The key is saved only on this computer, in a file only you can read. It is never shown again or sent anywhere except to ' + item.label + '.';
    };
    const saveKey = async () => { if (!key.hidden && key.value.trim()) { await post('/api/gateway/key', { provider: provider.value, key: key.value.trim() }); key.value = ''; } };
    provider.addEventListener('change', () => { model.value = ''; gatewayDraft.model = ''; options.replaceChildren(); sync(); });
    address.addEventListener('input', () => { gatewayDraft.baseUrl = address.value; }); model.addEventListener('input', () => { gatewayDraft.model = model.value; });
    load.addEventListener('click', async () => {
      note.textContent = 'Loading…';
      try { await saveKey(); const { models } = await post('/api/gateway/models', { provider: provider.value, baseUrl: address.hidden ? '' : address.value }); gatewayModels = models; note.textContent = models.length + ' models. Pick one or type its name.'; options.replaceChildren(...models.slice(0, 400).map(id => { const option = el('option'); option.value = id; return option; })); model.focus(); }
      catch (error) { note.textContent = error.message; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); const item = current();
      try { await saveKey(); await post('/api/gateway/agent', { op: 'add', provider: provider.value, model: model.value.trim() || item.suggest, baseUrl: address.hidden ? '' : address.value }); gatewayDraft.model = ''; }
      catch (error) { note.textContent = error.message; }
    });
    options.replaceChildren(...gatewayModels.slice(0, 400).map(id => { const option = el('option'); option.value = id; return option; }));
    const line = el('div', 'gateway-line'); line.append(provider, address, key); const line2 = el('div', 'gateway-line'); line2.append(model, options, load, add);
    form.append(line, line2, note); sync();
    if (busy) form.classList.add('off');
    nodes.push(form);
  }
  nodes.push(section('About'));
  nodes.push(el('p', 'fineprint', 'Shared Table ' + state.version + ' · open source · part of RegesCore by LIKE A KING INC. · project folder: ' + state.project.folder));
  body.replaceChildren(...nodes); body.scrollTop = scroll;
}
// ---------------------------------------------------------------- the pet as a small helper
function petStatus() {
  if (!state) return;
  const pending = (state.approvals || []).length, tasks = (state.conversation.board || []).filter(item => item.kind === 'task' && !item.done).length;
  const limited = state.agents.filter(agent => agent.limit?.status === 'reached').map(agent => agent.label), down = state.agents.filter(agent => !agent.ready && !agent.checking).map(agent => agent.label);
  window.SharedTablePet.say(pending ? pending + (pending === 1 ? ' request is' : ' requests are') + ' waiting for your OK.' : state.active ? 'The agents are working. I will tell you when they finish.' : limited.length ? limited.join(' and ') + (limited.length === 1 ? ' has' : ' have') + ' hit the usage limit.' : down.length ? down.join(' and ') + (down.length === 1 ? ' is' : ' are') + ' not ready. Check the sidebar.' : tasks ? tasks + (tasks === 1 ? ' open task' : ' open tasks') + ' on the table. Right-click me for shortcuts.' : 'All quiet. Right-click me for search and shortcuts.');
}
function openPetMenu(px, py) {
  const menu = $('pet-menu'), pet = window.SharedTablePet;
  const close = () => { menu.hidden = true; };
  const add = (label, action, cls) => { const button = el('button', cls || '', label); button.type = 'button'; button.addEventListener('click', () => { close(); action(); }); menu.append(button); return button; };
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search conversations and the table…'; search.setAttribute('aria-label', 'Search');
  const results = el('div'), actions = el('div');
  const find = () => {
    const query = search.value.trim().toLowerCase(); results.replaceChildren(); actions.hidden = !!query;
    if (!query) return;
    const hits = [];
    for (const item of state.conversations) if (item.title.toLowerCase().includes(query)) hits.push([item.title, 'conversation', () => post('/api/switch', { id: item.id }).then(() => setView('chat')).catch(fail)]);
    for (const item of state.conversation.board || []) if (item.text.toLowerCase().includes(query)) hits.push([item.text, item.kind, () => { showPane('table'); setView('board'); }]);
    state.conversation.turns.forEach(turn => { if (turn.message.toLowerCase().includes(query)) hits.push([turn.message, 'message', () => { setView('chat'); document.getElementById('turn-' + turn.id)?.scrollIntoView({ block: 'start' }); }]); });
    if (!hits.length) return results.append(el('p', '', 'Nothing found'));
    for (const [text, kind, go] of hits.slice(0, 7)) { const button = el('button', 'hit'); button.type = 'button'; button.append(el('span', '', text), el('small', '', kind)); button.addEventListener('click', () => { close(); go(); }); results.append(button); }
  };
  search.addEventListener('input', find);
  search.addEventListener('keydown', event => { if (event.key === 'Enter') results.querySelector('button')?.click(); if (event.key === 'Escape') close(); });
  menu.replaceChildren(search, results, actions);
  const into = (label, action, cls) => { const button = add(label, action, cls); actions.append(button); return button; };
  const pending = (state.approvals || []).length;
  if (pending) into('Show ' + pending + (pending === 1 ? ' permission request' : ' permission requests'), () => { setView('chat'); document.querySelector('.approval')?.scrollIntoView({ block: 'center' }); });
  if (state.active) into('Stop all agents', () => post('/api/cancel').catch(fail), 'danger');
  into('New conversation', () => $('new').click());
  for (const agent of state.agents) into('Ask ' + agent.label + '…', () => { const box = $('message'); if (!new RegExp('@' + agent.id + '\\b', 'i').test(box.value)) box.value = '@' + agent.id + ' ' + box.value; setView('chat'); box.focus(); });
  if (!$('review').disabled && !$('review').hidden) into('Cross-review the last answers', () => sendMessage('review'));
  into('What changed in the project?', () => { showPane('changes'); setView('board'); });
  actions.append(el('hr'));
  actions.append(el('p', '', pet.current()));
  const poses = el('div', 'poses'); for (const pose of pet.poses()) { const button = el('button', '', pose[0].toUpperCase() + pose.slice(1)); button.type = 'button'; button.addEventListener('click', () => { close(); pet.act(pose); }); poses.append(button); }
  actions.append(poses);
  into(pet.perched() ? 'Wander again' : 'Stay where I put you (drag me)', () => { if (pet.perched()) pet.wander(); else pet.say('Drag me anywhere and I will stay there.'); });
  into('Settings', () => $('settings-open').click());
  into('Let ' + pet.current().split(' ')[0] + ' rest', () => { prefs.set('pet', ''); pet.choose(''); });
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(px, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(py - menu.offsetHeight - 6, innerHeight - menu.offsetHeight - 8)) + 'px';
  if (!matchMedia('(max-width: 980px)').matches) search.focus();
}
function hello() {
  const box = $('hello'), logo = glyph('st-logo', 'logo');
  const links = el('div', 'links');
  for (const [label, host] of [['Developer', 'davidio.dev'], ['Company', 'likeakinginc.com'], ['Reges', 'regescore.pro'], ['Reges Code', 'regescode.com'], ['RegesARC', 'regesarc.com']]) { const link = el('a'); link.href = 'https://' + host; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.append(el('b', '', label), el('span', '', host)); links.append(link); }
  const close = el('button', 'button primary', 'Madloba'); close.type = 'button'; close.addEventListener('click', () => box.close());
  box.replaceChildren(logo, el('h2', '', 'Gamarjoba'), el('div', 'who', 'David · Davidio / Dev'), el('p', '', 'Founder of LIKE A KING INC. · creator of RegesCore'), el('p', '', 'Shared Table ' + (state?.version || '') + ' was designed and built under his direction.'), links, close);
  box.showModal(); window.SharedTablePet?.signal('finished');
}
let partnerList = null;
async function openPartners() {
  $('partners').showModal();
  const body = $('partners-body');
  if (!partnerList) { body.replaceChildren(el('p', 'fineprint', 'Loading…')); try { partnerList = await fetch('/partners.json').then(response => response.json()); } catch { return body.replaceChildren(el('p', 'fineprint', 'Could not load the list.')); } }
  const nodes = [];
  for (const group of [...new Set(partnerList.map(item => item.group))]) {
    const grid = el('div', 'partner-grid');
    for (const item of partnerList.filter(entry => entry.group === group)) {
      const host = new URL(item.url).hostname.replace(/^www\./, ''), card = el('a', 'partner'), shot = el('div', 'shot'), text = el('div', 'body'), title = el('b', '', item.name);
      card.href = item.url; card.target = '_blank'; card.rel = 'noopener noreferrer';
      if (item.live) shot.style.backgroundImage = 'url(/partners/' + host.replace(/\./g, '-') + '.jpg)'; else shot.textContent = 'Coming soon';
      title.append(el('i', item.live ? 'live' : 'soon', item.live ? 'Live' : 'Soon'));
      text.append(title, el('p', '', item.text), el('small', '', host + (item.live ? '  ↗' : '')));
      card.append(shot, text); grid.append(card);
    }
    nodes.push(el('h3', '', group), grid);
  }
  body.replaceChildren(...nodes);
}
$('partners-open').addEventListener('click', openPartners);
const gatewayDraft = { provider: 'anthropic', baseUrl: '', model: '' };
let gatewayModels = [];
function setOrder(value) { order = value; for (const item of $('order').children) item.classList.toggle('on', item.dataset.order === value); }
$('settings-open').addEventListener('click', () => { $('settings').showModal(); renderSettings(); });
$('project-open').addEventListener('click', event => { event.stopPropagation(); openProjects(); });
$('side-tabs').addEventListener('click', event => { const button = event.target.closest('button'); if (button) showPane(button.dataset.pane); });
$('changes-refresh').addEventListener('click', () => loadChanges());
$('preview-form').addEventListener('submit', event => { event.preventDefault(); loadPreview($('preview-url').value); });
$('preview-reload').addEventListener('click', () => { const frame = $('preview-frame'); if (frame.src) { const url = frame.src; frame.src = 'about:blank'; setTimeout(() => { frame.src = url; }, 30); } });
$('preview-external').addEventListener('click', () => { if ($('preview-frame').src) open($('preview-frame').src, '_blank', 'noopener'); });
$('diff-close').addEventListener('click', closeDiff);
$('diff-revert').addEventListener('click', () => { if (openDiff && confirm('Put "' + openDiff.file + '" back to the last committed version? This cannot be undone.')) post('/api/revert', openDiff).then(() => { closeDiff(); loadChanges(); }, fail); });
$('commands-clear').addEventListener('click', () => post('/api/terminal/clear').catch(fail));
$('command-form').addEventListener('submit', event => { event.preventDefault(); const command = $('command-text').value.trim(); if (command) post('/api/terminal/run', { command }).then(() => { $('command-text').value = ''; }, fail); });
$('order').addEventListener('click', event => { const button = event.target.closest('button'); if (button) setOrder(button.dataset.order); });
$('tabs').addEventListener('click', event => { const button = event.target.closest('button'); if (button) setView(button.dataset.view); });
$('phone-open').addEventListener('click', () => { $('phone').showModal(); renderPhone(); refreshQR(); });
$('phone').addEventListener('close', () => clearTimeout(pairTimer));
$('lan-toggle').addEventListener('change', event => setRemote({ lan: event.target.checked }, $('lan-option')));
$('tunnel-toggle').addEventListener('change', event => setRemote({ tunnel: event.target.checked }, $('tunnel-option')));
$('qr-switch').addEventListener('click', event => { const button = event.target.closest('button'); if (button) { pairVia = button.dataset.via; refreshQR(); } });
document.addEventListener('click', event => { if (!event.target.closest('#conversation-menu')) closeMenu(); if (!event.target.closest('#project-menu')) $('project-menu').hidden = true; if (!event.target.closest('#pet-menu')) $('pet-menu').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); $('project-menu').hidden = true; } });
document.addEventListener('pointerdown', () => window.SharedTablePet?.signal('wake'));
start().catch(error => showPairing('Could not reach Shared Table: ' + error.message));
