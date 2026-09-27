# Troupe: plan

A **simple, chat-first** macOS app, in the spirit of Grok or a Muse-style companion app rather than an "AI company" dashboard. You chat with a small team of agents. Each has a name, emoji and personality. They answer in one thread and help each other when useful. It runs on a **Claude Pro/Max subscription**, not an API key, and is designed to use as few tokens as possible.

## Principles

1. **It's a chat.** No org charts, task boards or permission grids on screen. There's a chat list, agent tabs, a message box, and one settings sheet.
2. **One voice by default.** Messages to the group go to the lead, who answers directly and only pulls others in when that clearly helps.
3. **Cheap by default.** Every design choice is checked against "how many tokens does this add per turn?"

## Using the subscription

Each agent in each chat is a Claude Code session driven through the `claude` CLI you've already logged into:

```
claude -p --output-format stream-json --verbose
       --session-id <uuid> | --resume <uuid>
       --system-prompt "<short persona prompt>"      # lean mode
       --disable-slash-commands --strict-mcp-config --setting-sources ""
       --tools "" | "WebSearch,WebFetch" | …        # by capability
       --model haiku|sonnet|opus
```

`ANTHROPIC_API_KEY` is removed from the child environment so an API key is never billed. Claude Code's `rate_limit_event` stream reports the 5-hour and weekly utilization, which drives the usage meter and the auto-pause.

## UX

```
┌────────────┬─────────────────────────────────────────┐
│ ◆ Troupe   │ [👥 Group] [✦ Nova] [🔎 Scout] [✍ Quill] [+] │
│ ✎ New chat │─────────────────────────────────────────│
│            │                 you: plan my newsletter │
│ Today      │ ✦ Nova: names: … @Scout who reads plant │
│ • Newsl…   │         content?                        │
│ • Kyoto…   │ 🔎 Scout: 68% are millennials …          │
│            │ ✦ Nova: here's the full package: …       │
│ 5h ▓▓░ 23% │ ┌─────────────────────────────────────┐ │
│ ⚙ Settings │ │ Message the group or @mention…    ↑ │ │
└────────────┴─┴─────────────────────────────────────┴─┘
```

- Tabs choose who gets your message: the Group (the lead) or one agent. `@mentions` override the tab.
- Live "thinking" rows show what each agent is doing, e.g. "Searching the web: …".
- Sidebar: chat history (Today, Yesterday…), usage meter, settings.
- Agent sheet: emoji and colour, name, "who are they?", model, what they can use, and a lead toggle.

## How agents collaborate

- An agent's reply is posted to the chat. If it `@mentions` teammates, each of them is woken with the request.
- The asker **waits for all of them** and is then woken **once** with every answer. For example, three agents asked means one follow-up turn, not three.
- A teammate that fails still releases the asker, so nobody waits forever.
- Hop limit: every message carries its distance from your last message. Past the limit (default 6), mentions are not delivered.

## Token budget per turn (lean mode)

| Part | Size |
|---|---|
| Claude Code base (with `--system-prompt`, no tools) | ~800 tokens |
| Persona + roster + rules | ~150–300 tokens |
| New messages since the agent's last turn | ≤12 messages × ≤1,500 chars |
| Tool definitions | 0 for chat-only agents; ~1.6k for web search; ~2.6k for read-only file access (projects) |

Measured: a chat-only turn is about 900 input tokens in lean mode, against about 4,050 with Claude Code's default prompt.

## Milestones

**v0.2 (this PR)**
- [x] Chat-first UI: chat history, agent tabs, @mention autocomplete, live thinking rows, stop, agent editor, settings sheet
- [x] Orchestrator: per-chat sessions, @mention routing, wait-for-all answers, hop limit, concurrency limit
- [x] Lean mode, daily turn cap, auto-pause on 5-hour usage (auto-resume at reset), usage meter
- [x] Unit tests (fake runner), real CLI end-to-end, UI driven in Electron

**v0.3: Projects**
- [x] Projects with attached folders (first = working directory, the rest via `--add-dir`), shared instructions and per-project file access (lead / everyone / nobody)
- [x] Project page: start a chat, manage folders (add, drop, show in Finder, detach), instructions, chat list; projects and their chats in the sidebar
- [x] Move chats between projects; agents are re-briefed once when folders or instructions change; missing folders are reported instead of run

**Next**
- Menu-bar quick chat with a global hotkey
- Notifications when a long answer finishes
- Attach files and images to a message
- Voice input
- "Remember this" memory notes per agent that carry across chats (small, capped)
- Signed, notarized `.dmg`
