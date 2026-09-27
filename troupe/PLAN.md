# Troupe: plan

A macOS app where you **hire AI agents, give them roles and responsibilities, and let them talk to and work with each other**, in the same spirit as Paperclip, Hermes and Grok-style agent bots. It runs on your **Claude subscription (Pro/Max)**, not an API key.

## 1. Key decision: how to use a subscription instead of the API

The Anthropic API (and the Agent SDK's default auth) bills per token against an API key. A Pro/Max subscription is only usable through Anthropic's own clients, one of which is **Claude Code**. Claude Code has a documented headless mode:

```
claude -p --output-format stream-json --verbose \
       --session-id <uuid> | --resume <uuid> \
       --append-system-prompt "<role>" --model sonnet \
       --mcp-config '<json>' --allowedTools mcp__troupe
```

So **each agent is a persistent Claude Code session** that Troupe drives with the `claude` CLI you've already logged into. Consequences:

| | |
|---|---|
| ✅ Uses your subscription | The CLI uses whatever account `claude /login` is signed into. Troupe strips `ANTHROPIC_API_KEY` from the child environment by default so an API key is never billed by accident. |
| ✅ Real memory per agent | `--session-id` on the first turn, `--resume` after that. Every agent keeps its own conversation history, and Claude Code's auto-compaction handles long histories. |
| ✅ Real tools | Agents can get file editing, shell, web search and your own MCP servers, depending on the permission preset. |
| ⚠️ Shared usage limits | All agents draw from the same 5-hour/weekly subscription limits. Troupe defaults to **2 agents at once**, a **loop limit**, and puts an agent **on hold** (keeping its messages) when a turn fails, e.g. on a usage limit. |
| ⚠️ Terms | This is personal automation of the official CLI on your own machine. Don't turn it into a hosted service that other people use with your login. Check Anthropic's current terms before distributing it. |

## 2. Architecture

```
┌──────────────────────── Troupe.app (Electron) ─────────────────────────┐
│  Renderer (React)             Main process (Node)                       │
│  ─────────────────            ───────────────────────────────────────── │
│  Team / org chart   ◀─IPC─▶  Orchestrator                               │
│  Channels & DMs                 • store (state.json)                    │
│  Agent: chat,                   • router: who does a message wake?      │
│    live activity, profile       • scheduler: inbox → turns, concurrency │
│  Task board                     • loop guard, heartbeats, error hold    │
│  Hire / settings                ClaudeCliRunner ── spawns ──┐           │
│                                 Bridge (127.0.0.1, per-agent token) ◀┐  │
└─────────────────────────────────────────────────────────────┼──────┼──┘
                                                              ▼      │
                                  claude -p (one per agent turn)     │
                                     └── MCP stdio: troupe server ───┘
                                         send_message, create_task,
                                         update_task, list_tasks,
                                         list_team, read_channel
```

* **Agents talk to each other through tools, not free text.** Each `claude` process launches Troupe's small MCP server (`dist/mcp.js`, run with Electron's own Node), which forwards tool calls to the app over a localhost bridge. Every agent gets its own bearer token, so it can only act as itself.
* **Push model.** When a message or task reaches an agent it goes into that agent's inbox. The scheduler starts a turn when the agent is free and a concurrency slot is open. The turn prompt contains the new messages, the current roster and the agent's open tasks.
* **Final replies.** If you messaged the agent, its final text is posted back to you. Otherwise the final text stays in its private work log. This keeps agents from auto-replying to each other forever.

### Routing rules

| Message | Who wakes up |
|---|---|
| DM | the other participant |
| Channel message from you | every agent in the channel, or only the ones you @mention |
| Channel message from an agent | only @mentioned agents (`@all` for everyone) |
| `create_task` | the assignee (via a DM from the creator) |
| `update_task` → done/blocked | the task's creator |

**Loop guard:** every message has a *depth*, the number of agent hops since a human message. Past the limit (default 8), messages are posted but not delivered, and the team waits for you.

## 3. Data model

`Agent` (name, role, responsibilities, instructions, model, reportsTo, tool preset, cwd, heartbeat, sessionId, status) · `Channel` (channel or DM, members) · `Message` (from, text, depth, taskId) · `Task` (T-n, assignee, creator, status, result) · `Inbox` (pending deliveries) · `Settings`. All of it lives in `~/Library/Application Support/Troupe/state.json`.

## 4. Permission presets

| Preset | Claude Code flags |
|---|---|
| Chat only | `--tools ""` (no built-ins), Troupe tools only |
| Research | WebSearch, WebFetch, Read, Glob, Grep |
| Builder | `--permission-mode acceptEdits` plus file tools and a short allowlist of safe shell commands |
| Full autonomy | `--dangerously-skip-permissions` (with a warning in the UI) |

Anything outside the preset is denied automatically, because nobody is there to answer a permission prompt in `-p` mode.

## 5. Milestones

**v0.1 (this PR)**
- [x] Orchestrator: routing, inbox, scheduler, concurrency limit, loop guard, heartbeats, pause/resume, error hold and retry, lost-session recovery
- [x] Claude CLI runner: stream-json parsing, cancellation, login-shell PATH discovery (Finder-launched apps don't get your PATH)
- [x] MCP server and authenticated localhost bridge
- [x] UI: org chart, channels, DMs, a read-only backchannel of agent↔agent DMs, per-agent live activity, profile editing (re-briefed on the next turn), hire templates, task board, settings
- [x] Unit tests with a fake runner; headless end-to-end test against the real CLI

**v0.2**
- Approvals inbox: agents ask before spending, hiring or running risky commands (`--permission-prompt-tool` routed to the UI)
- `request_hire` tool so a lead agent can propose new teammates for you to approve
- Usage meter from the CLI's `rate_limit_event` stream, with auto-pause near the limit and auto-resume after the reset
- Menu-bar extra, notifications when an agent messages you, global hotkey

**v0.3**
- Goals/projects above tasks (Paperclip-style), budgets per agent, scheduled routines
- Git worktree per builder agent to avoid edit conflicts
- Export/import team templates ("companies")
- Native SwiftUI shell reusing the same engine as a local helper, if the Electron footprint matters
