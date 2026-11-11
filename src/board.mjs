// The shared board: decisions, tasks, risks and open questions that the user and both agents can add to.
// Agents add entries by ending a reply with a fenced block:
//
//   ```board
//   decision: Ship the read-only mode first
//   task: Write the migration script
//   ```

export const KINDS = ['decision', 'task', 'risk', 'question', 'note'];
export const MAX_ENTRY = 400;
export const MAX_PER_REPLY = 6;

const START = /(^|\n)[ \t]*```+[ \t]*board[ \t]*(\n|$)/i;

/** Text shown in the chat: everything before the board block (also hides a block that is still streaming). */
export function visibleText(text) {
  const match = START.exec(text || '');
  return (match ? text.slice(0, match.index) : text || '').trimEnd();
}

/** Extract board entries from a finished reply. */
export function parseBoard(text) {
  const match = START.exec(text || '');
  if (!match) return { text: (text || '').trim(), entries: [] };
  const rest = text.slice(match.index + match[0].length);
  const end = rest.search(/(^|\n)[ \t]*```/);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const after = end >= 0 ? rest.slice(end).replace(/^\s*```+[ \t]*/, '') : '';
  const entries = [];
  for (const raw of block.split('\n')) {
    const line = /^\s*(?:[-*]\s*)?(decision|task|risk|question|note)s?\s*[:\-]\s*(.+?)\s*$/i.exec(raw);
    if (!line || entries.length >= MAX_PER_REPLY) continue;
    entries.push({ kind: line[1].toLowerCase(), text: line[2].slice(0, MAX_ENTRY) });
  }
  return { text: (text.slice(0, match.index) + (after.trim() ? '\n\n' + after.trim() : '')).trim(), entries };
}

export const boardInstructions = 'You share a board with the user and the other agent. To add to it, end your reply with a fenced block that starts with ```board and contains one entry per line in the form "decision: ...", "task: ...", "risk: ...", "question: ..." or "note: ...". Add at most ' + MAX_PER_REPLY + ' short entries, only for things worth keeping, and never repeat an entry that is already on the board.';
