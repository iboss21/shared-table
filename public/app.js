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
const initials = label => label.slice(0, 2);
const agentOf = id => state?.agents.find(agent => agent.id === id);
const tint = (node, id) => { const agent = agentOf(id); node.style.setProperty('--agent', agent ? agent.color : id === 'you' ? 'var(--ink)' : 'var(--muted)'); return node; };
const seconds = ms => (ms >= 60000 ? Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's');
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
  head.append(el('span', 'avatar', initials(agent.label)), names, el('small', '', reply.model && reply.model !== 'demo' ? reply.model : agent.vendor));
  const status = el('span', 'status is-' + reply.status);
  if (reply.status === 'running' || reply.status === 'queued') status.append(el('span', 'pulse'), reply.activity?.length && !reply.text ? 'working' : reply.text ? 'writing' : 'thinking');
  else status.textContent = reply.status === 'complete' ? seconds(reply.durationMs || 0) : reply.status === 'cancelled' ? 'stopped' : 'failed';
  head.append(status); card.append(head);
  if (reply.activity?.length) {
    const box = el('div', 'activity');
    for (const step of reply.activity.slice(-4)) { const row = el('div'); row.append(el('i', '', step.tool), step.detail || ''); box.append(row); }
    card.append(box);
  }
  if (reply.text) { const body = el('div', 'reply-body'); body.append(markdown(reply.text)); card.append(body); }
  else if (reply.status === 'running' || reply.status === 'queued') card.append(el('div', 'reply-body waiting', reply.status === 'queued' && turn.order === 'sequence' ? agent.label + ' goes next, after the agent before it finishes.' : agent.label + ' is working in its own session…'));
  if (reply.error) card.append(el('p', 'reply-error', reply.error));
  if (reply.boardAdded || reply.session) { const foot = el('div', 'reply-foot'); if (reply.boardAdded) foot.append(el('b', '', '+' + reply.boardAdded), 'added to the table'); if (reply.session) foot.append(el('span', 'session', (reply.boardAdded ? '· ' : '') + (reply.session === 'resumed' ? 'continued its own session' : 'started its own session'))); card.append(foot); }
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
    row.append(el('span', 'avatar', initials(agent.label)), text, el('span', working ? 'pulse' : 'dot ' + (agent.checking ? '' : agent.ready ? 'ready' : 'off')));
    if (agent.session) { const open = el('button', 'session-copy', 'session ' + agent.session.slice(0, 8) + ' · copy resume command'); open.type = 'button'; open.title = agent.resume; open.addEventListener('click', event => { event.stopPropagation(); (navigator.clipboard?.writeText(agent.resume) || Promise.reject()).then(() => { open.textContent = 'copied: paste in a terminal'; }, () => { prompt('Run this in a terminal to open the same session:', agent.resume); }); }); text.append(open); }
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
  $('board-count').textContent = String(board.length);
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
    const avatar = el('span', 'avatar', initials(agent.label)); avatar.style.setProperty('--agent', agent.color);
    button.append(avatar, el('b', '', '@' + agent.id), el('small', '', agent.vendor));
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
  renderRail(); renderTranscript(); renderBoard(); renderComposer(); renderPhone();
  if (previous?.remote && JSON.stringify([previous.remote.lan, previous.remote.tunnel]) !== JSON.stringify([state.remote?.lan, state.remote?.tunnel])) refreshQR();
}

// ---------------------------------------------------------------- start
function connect() {
  const events = new EventSource('/api/events');
  events.onmessage = message => {
    const event = JSON.parse(message.data);
    if (event.type === 'state') render(event);
    else if (event.type === 'reply' && state) patchReply(event);
    else if (event.type === 'notice') fail(event);
  };
  events.onerror = () => { if (state) $('hint').textContent = 'Connection lost. Reconnecting…'; };
}
function showPairing(text, steps) { $('app').hidden = true; $('tabs').hidden = true; $('pairing').hidden = false; $('pairing-text').textContent = text; $('pairing-steps').hidden = !steps; }
async function start() {
  let theme = null, accent = '';
  try { theme = localStorage.getItem('st-theme'); accent = localStorage.getItem('st-accent') || ''; } catch { /* private mode */ }
  applyLook(THEMES.some(item => item[0] === theme) ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', accent);
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
function openAppearance() {
  const menu = $('appearance-menu'), root = document.documentElement;
  if (!menu.hidden) { menu.hidden = true; return; }
  const draw = () => {
    menu.replaceChildren(el('p', '', 'Theme'));
    for (const [id, label, a, b] of THEMES) {
      const button = el('button', root.dataset.theme === id ? 'on' : ''); button.type = 'button';
      const preview = el('span', 'preview'); preview.style.setProperty('--a', a); preview.style.setProperty('--b', b);
      button.append(preview, label); button.addEventListener('click', () => { applyLook(id, ''); draw(); }); menu.append(button);
    }
    menu.append(el('hr'), el('p', '', 'Accent colour'));
    const row = el('div', 'swatches');
    for (const [id, label, color] of ACCENTS) { const dot = el('button', (root.dataset.accent || '') === id ? 'on' : ''); dot.type = 'button'; dot.title = label; dot.setAttribute('aria-label', label); dot.style.setProperty('--swatch', color); dot.addEventListener('click', () => { applyLook(root.dataset.theme, id); draw(); }); row.append(dot); }
    menu.append(row);
  };
  draw(); menu.hidden = false;
  const box = $('theme').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, box.top - menu.offsetHeight - 6) + 'px';
}
$('theme').addEventListener('click', event => { event.stopPropagation(); openAppearance(); });
$('order').addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; order = button.dataset.order; for (const item of $('order').children) item.classList.toggle('on', item === button); });
$('tabs').addEventListener('click', event => { const button = event.target.closest('button'); if (button) setView(button.dataset.view); });
$('phone-open').addEventListener('click', () => { $('phone').showModal(); renderPhone(); refreshQR(); });
$('phone').addEventListener('close', () => clearTimeout(pairTimer));
$('lan-toggle').addEventListener('change', event => setRemote({ lan: event.target.checked }, $('lan-option')));
$('tunnel-toggle').addEventListener('change', event => setRemote({ tunnel: event.target.checked }, $('tunnel-option')));
$('qr-switch').addEventListener('click', event => { const button = event.target.closest('button'); if (button) { pairVia = button.dataset.via; refreshQR(); } });
document.addEventListener('click', event => { if (!event.target.closest('#conversation-menu')) closeMenu(); if (!event.target.closest('#appearance-menu')) $('appearance-menu').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); $('appearance-menu').hidden = true; } });
start().catch(error => showPairing('Could not reach Shared Table: ' + error.message));
