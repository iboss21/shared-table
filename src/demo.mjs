// Demo mode: scripted stand-in agents so the interface can be tried, tested and recorded
// without any CLI, account or model request. Replies are canned and clearly labelled in the UI.

const SCRIPTS = {
  claude: [
    `**Short answer: keep one process, add a queue.**

I would not split this into services yet. The work is I/O-bound and one team owns it, so a second deployable buys you coordination cost and nothing else.

1. Put slow jobs behind an in-process queue with a persisted table, so a restart cannot lose work.
2. Keep the HTTP handlers thin: validate, enqueue, return a job id.
3. Add one worker loop with a concurrency cap of 4 and exponential backoff.

\`\`\`js
await queue.add('export', { reportId }, { attempts: 5, backoff: 'exponential' });
\`\`\`

Where I expect Codex to disagree: it will probably want a real broker. That is right the day you need a second consumer, not before.

\`\`\`board
decision: Stay on one deployable; move slow work to a persisted in-process queue
task: Add jobs table and worker loop with a concurrency cap of 4
risk: A single process means a bad deploy stops both web and workers
\`\`\``,
    `I read Codex's answer. We agree on the important part: the handlers must stop doing slow work inline.

**Where we differ** is the broker. Codex's point about visibility is fair, so I would take its dashboard requirement and meet it with the jobs table: one page listing queued, running and failed jobs is an afternoon of work.

**Converged plan**
- Persisted queue in the existing database now.
- Job status page from the same table.
- Revisit a broker when a second service needs to consume jobs.

\`\`\`board
decision: Converged: database-backed queue now, broker only when a second consumer appears
task: Build the job status page from the jobs table
\`\`\``,
  ],
  codex: [
    `**Recommendation: introduce a job queue, and make failures visible from day one.**

The current design blocks request threads on exports. Under load that is where your p95 goes.

- Move exports and email to background jobs.
- Use a broker if you already run one; otherwise a database table with \`SELECT ... FOR UPDATE SKIP LOCKED\` is enough.
- Whatever you pick, ship a failed-jobs view at the same time. Silent retries are how queues rot.

\`\`\`sql
SELECT id FROM jobs
WHERE status = 'queued'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 4;
\`\`\`

Assumption I am making: you are on Postgres. If not, say so and I will adjust the locking.

\`\`\`board
task: Move exports and email sending to background jobs
question: Is the database Postgres? The locking query depends on it
risk: Retries without a failed-jobs view will hide broken exports
\`\`\``,
    `Reviewed Claude's answer.

**Agree:** one deployable is the right call at this size, and the thin-handler rule is correct.

**Disagree, mildly:** a concurrency cap of 4 is a guess. Measure export duration first, then set the cap from the database connection pool, not from a round number.

**Next step I would take:** write the worker with the cap as configuration and add a metric for queue depth, so the number can be tuned with evidence.

\`\`\`board
task: Make worker concurrency configurable and record queue depth
decision: Converged: database-backed queue now, broker only when a second consumer appears
\`\`\``,
  ],
};

const GENERIC = label => `**${label} (demo reply).** This is a scripted answer: demo mode makes no model request.

In a real session this agent would answer your message here, in its own process, at the same time as the others.

\`\`\`board
note: Demo mode is on: replies are scripted
\`\`\``;

const wait = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Drop-in replacement for runAgent. */
export function createDemoRunner({ speed = 1 } = {}) {
  return async function runDemoAgent(agent, prompt, { signal, onUpdate = () => {}, mode } = {}) {
    const start = Date.now();
    const script = SCRIPTS[agent.id];
    let request = {};
    try { request = JSON.parse(prompt).request || {}; } catch { /* ignore */ }
    const index = request.kind === 'review' || request.earlierInThisTurn ? 1 : 0;
    const full = script ? script[Math.min(index, script.length - 1)] : GENERIC(agent.label);
    const activity = [];
    await wait((agent.id === 'claude' ? 500 : 900) / speed, signal);
    if (mode !== 'advise' && script) {
      for (const step of agent.id === 'claude' ? [['Read', 'src/server/exports.js'], ['Grep', 'sendEmail(']] : [['Shell', 'rg "export" --files-with-matches'], ['Shell', 'sed -n 1,80p src/worker.js']]) {
        if (signal?.aborted) break;
        activity.push({ tool: step[0], detail: step[1] }); onUpdate({ text: '', model: 'demo', activity: [...activity] });
        await wait(600 / speed, signal);
      }
    }
    const words = full.split(/(?<=\s)/);
    let text = '';
    const chunk = agent.id === 'claude' ? 4 : 6;
    for (let i = 0; i < words.length; i += chunk) {
      if (signal?.aborted) return { status: 'cancelled', text, activity, model: 'demo', durationMs: Date.now() - start };
      text += words.slice(i, i + chunk).join('');
      onUpdate({ text, model: 'demo', activity: [...activity] });
      await wait((agent.id === 'claude' ? 45 : 60) / speed, signal);
    }
    return { status: 'complete', text: full, model: 'demo', activity, durationMs: Date.now() - start };
  };
}
