import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { Orchestrator } from '../src/core/orchestrator';
import { buildArgs, parseStreamLine, type Runner, type TurnRequest, type TurnResult } from '../src/core/claudeRunner';
import type { AgentDraft } from '../src/shared/types';
import { USER_ID, SYSTEM_ID } from '../src/shared/types';

type Script = (req: TurnRequest, agentName: string) => Promise<TurnResult> | TurnResult;

/** A runner that doesn't call Claude: each turn runs `script`, which can call tools. */
class FakeRunner implements Runner {
  calls: { req: TurnRequest; agent: string }[] = [];
  active = 0;
  maxActive = 0;
  orch!: Orchestrator;
  constructor(public script: Script) {}
  run(req: TurnRequest) {
    const agent = this.orch.state.agents.find((a) => a.sessionId === req.sessionId)!;
    this.calls.push({ req, agent: agent.name });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const done = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await this.script(req, agent.name);
      } finally {
        this.active--;
      }
    })();
    return { done, cancel() {} };
  }
}

function setup(script: Script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-test-'));
  const store = new Store(dir);
  const runner = new FakeRunner(script);
  const orch = new Orchestrator(store, runner, {
    claudePath: '/bin/false',
    childEnv: () => ({}),
    mcpCommand: 'node',
    mcpArgs: ['mcp.js'],
    mcpEnv: {},
  });
  runner.orch = orch;
  orch.start('http://127.0.0.1:0');
  return { orch, runner };
}

const draft = (name: string, extra: Partial<AgentDraft> = {}): AgentDraft => ({
  name,
  role: `${name} role`,
  responsibilities: '',
  instructions: '',
  model: 'haiku',
  reportsTo: '',
  tools: 'chat',
  useMyMcpServers: false,
  cwd: '',
  heartbeatMinutes: 0,
  ...extra,
});

async function idle(orch: Orchestrator) {
  for (let i = 0; i < 400; i++) {
    const busy = orch.state.agents.some((a) => orch.isRunning(a.id)) || orch.state.inbox.some((x) => orch.state.agents.find((a) => a.id === x.agentId)?.status !== 'error');
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('orchestrator never went idle');
}

const ok = (text: string): TurnResult => ({ ok: true, text, costUsd: 0.01 });

test('a DM from the user wakes the agent and the reply is posted back', async () => {
  const { orch, runner } = setup(() => ok('hello boss'));
  const a = orch.hireAgent(draft('Maya'));
  const dm = orch.dm(USER_ID, a.id);
  orch.userMessage(dm.id, 'hi');
  await idle(orch);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].req.resume, false);
  assert.match(runner.calls[0].req.prompt, /hi/);
  const msgs = orch.state.messages.filter((m) => m.channelId === dm.id);
  assert.deepEqual(msgs.map((m) => [m.from, m.text]), [[USER_ID, 'hi'], [a.id, 'hello boss']]);

  orch.userMessage(dm.id, 'again');
  await idle(orch);
  assert.equal(runner.calls[1].req.resume, true, 'second turn resumes the same session');
  assert.equal(runner.calls[1].req.sessionId, runner.calls[0].req.sessionId);
});

test('channel routing: humans wake everyone, agents only wake who they @mention', async () => {
  const { orch, runner } = setup(async (req, name) => {
    if (name === 'Maya' && /kickoff/.test(req.prompt)) {
      const maya = orch.state.agents.find((a) => a.name === 'Maya')!;
      await orch.handleTool(maya.id, 'send_message', { to: '#general', text: 'thinking out loud' });
      await orch.handleTool(maya.id, 'send_message', { to: '#general', text: '@Leo please draft it' });
    }
    return ok('');
  });
  orch.hireAgent(draft('Maya'));
  orch.hireAgent(draft('Leo'));
  orch.hireAgent(draft('Ana'));
  const general = orch.state.channels.find((c) => c.name === 'general')!;
  orch.userMessage(general.id, 'kickoff');
  await idle(orch);
  const woke = runner.calls.map((c) => c.agent);
  assert.deepEqual(woke.slice(0, 3).sort(), ['Ana', 'Leo', 'Maya']);
  // Only Leo is woken by Maya's @mention; "thinking out loud" wakes nobody.
  assert.deepEqual(woke.slice(3), ['Leo']);
});

test('tasks notify the assignee, and completion notifies the creator', async () => {
  const { orch, runner } = setup(async (req, name) => {
    const me = orch.state.agents.find((a) => a.name === name)!;
    if (name === 'Maya' && /ship it/.test(req.prompt)) {
      await orch.handleTool(me.id, 'create_task', { title: 'Write copy', description: 'hero text', assignee: 'Leo' });
    }
    if (name === 'Leo' && /New task T-1/.test(req.prompt)) {
      await orch.handleTool(me.id, 'update_task', { task_id: 'T-1', status: 'done', result: 'Buy now' });
    }
    return ok('');
  });
  const maya = orch.hireAgent(draft('Maya'));
  orch.hireAgent(draft('Leo', { reportsTo: maya.id }));
  orch.userMessage(orch.dm(USER_ID, maya.id).id, 'ship it');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Maya', 'Leo', 'Maya']);
  assert.match(runner.calls[2].req.prompt, /T-1 "Write copy" is done/);
  assert.equal(orch.state.tasks[0].status, 'done');
  assert.equal(orch.state.tasks[0].result, 'Buy now');
});

test('agent ping-pong stops at the loop limit', async () => {
  const { orch, runner } = setup(async (_req, name) => {
    const me = orch.state.agents.find((a) => a.name === name)!;
    await orch.handleTool(me.id, 'send_message', { to: name === 'A' ? 'B' : 'A', text: 'your turn' });
    return ok('');
  });
  orch.updateSettings({ maxDepth: 4 });
  const a = orch.hireAgent(draft('A'));
  orch.hireAgent(draft('B'));
  orch.userMessage(orch.dm(USER_ID, a.id).id, 'start');
  await idle(orch);
  // The user's message wakes A (turn 1), then 4 agent-to-agent hops are allowed.
  assert.equal(runner.calls.length, 5);
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /Loop limit/.test(m.text)));
});

test('concurrency limit is respected', async () => {
  const { orch, runner } = setup(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return ok('');
  });
  orch.updateSettings({ maxConcurrent: 2 });
  for (const n of ['A', 'B', 'C', 'D', 'E']) orch.hireAgent(draft(n));
  orch.userMessage(orch.state.channels.find((c) => c.name === 'general')!.id, 'everyone go');
  await idle(orch);
  assert.equal(runner.calls.length, 5);
  assert.equal(runner.maxActive, 2);
});

test('pausing the team holds work until resumed', async () => {
  const { orch, runner } = setup(() => ok('done'));
  const a = orch.hireAgent(draft('A'));
  orch.updateSettings({ paused: true });
  orch.userMessage(orch.dm(USER_ID, a.id).id, 'go');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runner.calls.length, 0);
  assert.equal(orch.state.agents[0].status, 'queued');
  orch.updateSettings({ paused: false });
  await idle(orch);
  assert.equal(runner.calls.length, 1);
});

test('errors put the agent on hold without losing messages', async () => {
  let fail = true;
  const { orch, runner } = setup(() => (fail ? { ok: false, text: '', costUsd: 0, error: 'usage limit reached' } : ok('recovered')));
  const a = orch.hireAgent(draft('A'));
  const dm = orch.dm(USER_ID, a.id);
  orch.userMessage(dm.id, 'hello');
  await idle(orch);
  assert.equal(orch.state.agents[0].status, 'error');
  assert.equal(orch.state.inbox.length, 1, 'message kept for retry');
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /usage limit/.test(m.text)));
  fail = false;
  orch.updateAgent(a.id, { paused: false });
  await idle(orch);
  assert.equal(runner.calls.length, 2);
  assert.equal(orch.state.messages.at(-1)!.text, 'recovered');
});

test('a lost session is replaced and the turn retried', async () => {
  let n = 0;
  const { orch, runner } = setup(() => (n++ === 1 ? { ok: false, text: '', costUsd: 0, error: 'No conversation found with session ID x', sessionMissing: true } : ok('fine')));
  const a = orch.hireAgent(draft('A'));
  const dm = orch.dm(USER_ID, a.id);
  orch.userMessage(dm.id, 'one');
  await idle(orch);
  orch.userMessage(dm.id, 'two');
  await idle(orch);
  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2].req.resume, false);
  assert.notEqual(runner.calls[2].req.sessionId, runner.calls[0].req.sessionId);
  assert.equal(orch.state.agents[0].status, 'idle');
});

test('profile changes are briefed on the next turn', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  const a = orch.hireAgent(draft('A'));
  const dm = orch.dm(USER_ID, a.id);
  orch.userMessage(dm.id, 'one');
  await idle(orch);
  orch.updateAgent(a.id, { role: 'Chief Poet' });
  orch.userMessage(dm.id, 'two');
  await idle(orch);
  assert.match(runner.calls[1].req.prompt, /profile was updated[\s\S]*Chief Poet/);
  orch.userMessage(dm.id, 'three');
  await idle(orch);
  assert.doesNotMatch(runner.calls[2].req.prompt, /profile was updated/);
});

test('names are validated and unique', () => {
  const { orch } = setup(() => ok(''));
  orch.hireAgent(draft('Maya'));
  assert.throws(() => orch.hireAgent(draft('maya')), /already/);
  assert.throws(() => orch.hireAgent(draft('Two Words')), /letters/);
  assert.throws(() => orch.hireAgent(draft('all')), /reserved/);
});

test('firing an agent cleans up', async () => {
  const { orch } = setup(() => ok(''));
  const boss = orch.hireAgent(draft('Boss'));
  const a = orch.hireAgent(draft('A', { reportsTo: boss.id }));
  orch.createTask(USER_ID, { title: 't', description: '', assigneeId: a.id }, 0);
  orch.fireAgent(boss.id);
  assert.equal(orch.state.agents.find((x) => x.id === a.id)!.reportsTo, '');
  orch.fireAgent(a.id);
  assert.equal(orch.state.tasks[0].assigneeId, '');
  assert.equal(orch.state.inbox.length, 0);
});

test('CLI arguments for each permission preset', () => {
  const base: TurnRequest = {
    claudePath: 'claude', cwd: '/tmp', env: {}, sessionId: 'sid', resume: false, systemPrompt: 'sys', prompt: 'p',
    model: 'sonnet', tools: 'chat', useMyMcpServers: false, mcpConfig: { mcpServers: {} },
  };
  const chat = buildArgs(base);
  assert.deepEqual(chat.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'sid']);
  assert.ok(chat.includes('--strict-mcp-config'));
  assert.equal(chat[chat.indexOf('--tools') + 1], '');
  assert.equal(chat[chat.indexOf('--allowedTools') + 1], 'mcp__troupe');
  const resumed = buildArgs({ ...base, resume: true, useMyMcpServers: true });
  assert.ok(resumed.includes('--resume') && !resumed.includes('--strict-mcp-config'));
  assert.ok(buildArgs({ ...base, tools: 'builder' }).includes('acceptEdits'));
  assert.ok(buildArgs({ ...base, tools: 'autonomous' }).includes('--dangerously-skip-permissions'));
});

test('stream-json parsing', () => {
  const events: string[] = [];
  parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'mcp__troupe__send_message', input: { to: 'Leo' } }] } }), (e) => events.push(`${e.kind}:${e.text}`));
  assert.deepEqual(events, ['text:hi', 'tool:send_message {"to":"Leo"}']);
  const r = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.5 }), () => {});
  assert.deepEqual(r.result, { text: 'done', isError: false, costUsd: 0.5 });
  const bad = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }), () => {});
  assert.equal(bad.result!.isError, true);
});
