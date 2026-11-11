# Shared Table: product plan

## What it is

One place to run, watch and direct every coding agent you use. You are the supervisor; the agents are the team; the chat is the bridge between sessions that otherwise cannot see each other.

## Who it is for

1. **Solo builders who direct agents instead of typing code.** They already pay for two or more agents and lose time carrying context between them.
2. **Small teams and agencies** running agents across several client projects, who need one view of what each agent is doing and what was decided.
3. **Local-model users** who want a hosted agent and a local model answering the same question side by side.

## The problem, in order of pain

1. Switching between apps and sessions to give the same instruction twice.
2. No shared memory: one agent does not know what the other decided.
3. No supervision: you cannot see all agents working at once, or stop one without finding its window.
4. Agents stall on a permission question in a terminal you are not looking at.
5. Away from the desk, everything stops.

Release 0.1 addresses 1, 2, 3 and 5. Number 4 is the top item below.

## Shipped in 0.1

One chat with `@mentions`; at-once, in-turn and cross-review turns; native per-agent CLI sessions; shared board; advise / read / build modes; Claude Code, Codex, Gemini CLI, API servers (LM Studio, Ollama, any OpenAI-compatible endpoint) and custom CLIs; file and image attachments; conversation rename, pin and groups; themes; phone access by QR over Wi-Fi or tunnel; demo mode.

## Next: 0.2 "Supervise"

The release that makes it possible to stay in Shared Table for a whole working session.

| Feature | Why | Notes |
|---|---|---|
| **Approvals in the chat** | Today an agent that needs permission is denied automatically. The supervisor should see "Claude wants to run `npm install`" and answer Allow / Deny / Always, from desktop or phone. | Needs the CLIs' interactive permission channel instead of one-shot runs. Largest item. |
| **Per-agent stop and retry** | Stop one agent without stopping the turn; re-ask one agent. | Small. |
| **Changes panel** | After a build turn, show the git diff per agent, with revert. | Makes build mode safe to use daily. |
| **One worktree per agent** | Each agent edits its own git worktree; you merge the winner. Removes the "two agents, one folder" risk. | Optional per conversation. |
| **Terminal panel** | Run a command and see output without leaving the page; paste output to the agents in one click. | Command runner first; a full interactive terminal later. |
| **Projects switcher** | Several project folders in one window, each with its own conversations and agents. | Today: one server per project. |

## 0.3 "Team"

| Feature | Why |
|---|---|
| **Roles and playbooks** | Save "Claude builds, Codex reviews, local model summarises" as a one-click routine. |
| **Board to tasks** | Assign a board task to an agent and track it to done; export to GitHub Issues. |
| **Cost and usage meter** | Tokens, time and limit warnings per agent, per conversation. |
| **Notifications** | Phone push or desktop alert when a long run finishes or needs approval. |
| **Search and export** | Search across conversations; export a conversation as Markdown. |
| **MCP server** | Expose the board and transcript as tools, so an agent in any other app can read and write the same table. |

## Later

- Desktop app wrapper (menu-bar icon, auto-start) and one-line installer.
- Team mode: several people at one table, with named seats and an audit log.
- Voice input on the phone.
- Hosted relay as an optional paid service for people who do not want to run a tunnel. The open-source core stays complete without it.

## What we will not do

- Drive other vendors' desktop apps by automating their windows. It breaks on every update.
- Store or proxy anyone's model credentials. Each agent uses its own sign-in.
- Hide untested paths. The README states what has and has not been run.

## How we will know it works

- Time from clone to first two-agent answer: under 3 minutes.
- A full build-review-fix cycle completed without leaving the page (needs 0.2).
- Stars, forks and issues from people who are not us; the first outside pull request that adds an agent adapter.
