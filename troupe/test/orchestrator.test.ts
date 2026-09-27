import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { Orchestrator } from '../src/core/orchestrator';
import { buildArgs, parseStreamLine, type Runner, type TurnCallbacks, type TurnRequest, type TurnResult } from '../src/core/claudeRunner';
import type { AgentDraft } from '../src/shared/types';
import { SYSTEM_ID, USER_ID } from '../src/shared/types';

type Script = (req: TurnRequest, agentName: string, cb: TurnCallbacks) => Promise<TurnResult> | TurnResult;

/** A runner that doesn't call Claude: each turn's reply comes from `script`. */
class FakeRunner implements Runner {
  calls: { req: TurnRequest; agent: string }[] = [];
  active = 0;
  maxActive = 0;
  orch!: Orchestrator;
  constructor(public script: Script) {}
  run(req: TurnRequest, cb: TurnCallbacks) {
    const agent = this.orch.state.agents.find((a) => req.systemPrompt.startsWith(`You are ${a.name}.`))!;
    this.calls.push({ req, agent: agent.name });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const done = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await this.script(req, agent.name, cb);
      } finally {
        this.active--;
      }
    })();
    return { done, cancel() {} };
  }
}

function setup(script: Script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-test-'));
  const runner = new FakeRunner(script);
  const orch = new Orchestrator(new Store(dir), runner, { claudePath: '/bin/false', childEnv: () => ({}) });
  runner.orch = orch;
  orch.start();
  return { orch, runner };
}

const draft = (name: string, extra: Partial<AgentDraft> = {}): AgentDraft => ({
  name,
  emoji: '●',
  hue: 0,
  persona: `${name} persona`,
  model: 'haiku',
  capability: 'chat',
  isLead: false,
  ...extra,
});

async function idle(orch: Orchestrator) {
  for (let i = 0; i < 400; i++) {
    if (!orch.isBusy() && (!orch.state.inbox.length || orch.state.settings.paused)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('never went idle');
}

const ok = (text: string): TurnResult => ({ ok: true, text, costUsd: 0.001 });
const texts = (orch: Orchestrator, chatId: string) =>
  orch.state.messages.filter((m) => m.chatId === chatId).map((m) => `${orch.state.agents.find((a) => a.id === m.from)?.name ?? m.from}: ${m.text}`);

test('group messages go to the lead only, and the reply is posted in the chat', async () => {
  const { orch, runner } = setup(() => ok('hi there'));
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Scout'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'hello');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Nova']);
  assert.deepEqual(texts(orch, chat.id), ['user: hello', 'Nova: hi there']);
  assert.equal(chat.title, 'hello');
});

test('picking an agent tab talks to that agent directly', async () => {
  const { orch, runner } = setup(() => ok('scout here'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const scout = orch.addAgent(draft('Scout'));
  const chat = orch.newChat(scout.id);
  orch.userMessage(chat.id, 'find stuff');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Scout']);
});

test('@mentions in your message wake exactly those agents', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Scout'));
  orch.addAgent(draft('Quill'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, '@scout and @Quill, thoughts?');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent).sort(), ['Quill', 'Scout']);
});

test('the lead waits for everyone it @mentioned, then gets all answers in one turn', async () => {
  const { orch, runner } = setup(async (req, name) => {
    if (name === 'Nova' && /write me a launch post/.test(req.prompt)) return ok('@Scout find 3 facts. @Quill draft a headline.');
    if (name === 'Scout') {
      await new Promise((r) => setTimeout(r, 30)); // slower than Quill
      return ok('fact1 fact2 fact3');
    }
    if (name === 'Quill') return ok('Big Headline');
    return ok('Final: Big Headline + facts');
  });
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Scout'));
  orch.addAgent(draft('Quill'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'write me a launch post');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Nova', 'Scout', 'Quill', 'Nova']);
  const final = runner.calls[3].req.prompt;
  assert.match(final, /Scout: fact1/);
  assert.match(final, /Quill: Big Headline/);
  assert.match(final, /Scout and Quill are waiting|Quill and Scout are waiting/);
  assert.equal(texts(orch, chat.id).at(-1), 'Nova: Final: Big Headline + facts');
});

test('each turn only sends messages the agent has not seen yet', async () => {
  const { orch, runner } = setup(() => ok('noted'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'first message');
  await idle(orch);
  orch.userMessage(chat.id, 'second message');
  await idle(orch);
  assert.equal(runner.calls[1].req.resume, true);
  assert.equal(runner.calls[1].req.sessionId, runner.calls[0].req.sessionId);
  assert.match(runner.calls[1].req.prompt, /second message/);
  assert.doesNotMatch(runner.calls[1].req.prompt, /first message/);
});

test('a new chat starts a fresh session for the same agent', async () => {
  const { orch, runner } = setup(() => ok('hi'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const a = orch.newChat('group');
  orch.userMessage(a.id, 'one');
  await idle(orch);
  const b = orch.newChat('group');
  assert.notEqual(a.id, b.id);
  orch.userMessage(b.id, 'two');
  await idle(orch);
  assert.notEqual(runner.calls[0].req.sessionId, runner.calls[1].req.sessionId);
  assert.equal(runner.calls[1].req.resume, false);
});

test('agent ping-pong stops at the hop limit', async () => {
  const { orch, runner } = setup((_req, name) => ok(name === 'A' ? '@B your turn' : '@A your turn'));
  orch.updateSettings({ maxDepth: 4 });
  orch.addAgent(draft('A', { isLead: true }));
  orch.addAgent(draft('B'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'go');
  await idle(orch);
  // Your message wakes A (turn 1), then 4 agent-to-agent hops are allowed.
  assert.equal(runner.calls.length, 5);
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /Loop limit/.test(m.text)));
});

test('concurrency limit is respected', async () => {
  const { orch, runner } = setup(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return ok('');
  });
  orch.updateSettings({ maxConcurrent: 2 });
  for (const n of ['A', 'B', 'C', 'D']) orch.addAgent(draft(n));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, '@A @B @C @D go');
  await idle(orch);
  assert.equal(runner.calls.length, 4);
  assert.equal(runner.maxActive, 2);
});

test('daily turn cap pauses the team and keeps the queue', async () => {
  const { orch, runner } = setup(() => ok('done'));
  orch.updateSettings({ dailyTurnCap: 1 });
  orch.addAgent(draft('A', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'one');
  await idle(orch);
  orch.userMessage(chat.id, 'two');
  await idle(orch);
  assert.equal(runner.calls.length, 1);
  assert.equal(orch.state.settings.paused, true);
  assert.equal(orch.state.settings.pauseReason, 'daily_cap');
  assert.equal(orch.state.inbox.length, 1);
  orch.updateSettings({ dailyTurnCap: 0, paused: false });
  await idle(orch);
  assert.equal(runner.calls.length, 2);
});

test('high 5-hour usage pauses the team', async () => {
  const { orch } = setup((_r, _n, cb) => {
    cb.onUsage?.({ fiveHour: { utilization: 0.85, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    return ok('ok');
  });
  orch.addAgent(draft('A', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'hi');
  await idle(orch);
  assert.equal(orch.state.settings.paused, true);
  assert.equal(orch.state.settings.pauseReason, 'usage_limit');
});

test('a usage-limit error keeps the message and pauses; other errors post a note', async () => {
  let err = 'Claude usage limit reached';
  const { orch, runner } = setup(() => (err ? { ok: false, text: '', costUsd: 0, error: err } : ok('back')));
  orch.addAgent(draft('A', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'hi');
  await idle(orch);
  assert.equal(orch.state.settings.pauseReason, 'usage_limit');
  assert.equal(orch.state.inbox.length, 1);
  err = '';
  orch.updateSettings({ paused: false });
  await idle(orch);
  assert.equal(texts(orch, chat.id).at(-1), 'A: back');

  err = 'bad model name';
  orch.userMessage(chat.id, 'again');
  await idle(orch);
  assert.match(texts(orch, chat.id).at(-1)!, /A hit an error/);
  assert.equal(orch.state.inbox.length, 0);
  assert.equal(runner.calls.length, 3);
});

test('a failing helper does not leave the lead waiting forever', async () => {
  const { orch, runner } = setup((req, name) => {
    if (name === 'Scout') return { ok: false, text: '', costUsd: 0, error: 'boom' };
    return ok(/waiting/.test(req.prompt) && runner.calls.length > 1 ? 'Scout failed, here is my best guess' : '@Scout look this up');
  });
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Scout'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'question');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Nova', 'Scout', 'Nova']);
});

test('stopping a chat clears its queue and waits', async () => {
  const { orch } = setup(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return ok('late');
  });
  orch.addAgent(draft('A', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'hi');
  await new Promise((r) => setTimeout(r, 10));
  orch.stopChat(chat.id);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(texts(orch, chat.id), ['user: hi']);
  assert.equal(orch.isBusy(), false);
});

test('team changes are mentioned once in existing chats', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('A', { isLead: true }));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'one');
  await idle(orch);
  orch.addAgent(draft('B'));
  orch.userMessage(chat.id, 'two');
  await idle(orch);
  orch.userMessage(chat.id, 'three');
  await idle(orch);
  assert.match(runner.calls[1].req.prompt, /Team update[\s\S]*@B/);
  assert.doesNotMatch(runner.calls[2].req.prompt, /Team update/);
});

test('names are validated, removing the lead promotes someone else', () => {
  const { orch } = setup(() => ok(''));
  const a = orch.addAgent(draft('Nova'));
  assert.equal(a.isLead, true, 'first agent becomes lead');
  orch.addAgent(draft('Scout'));
  assert.throws(() => orch.addAgent(draft('nova')), /already/);
  assert.throws(() => orch.addAgent(draft('Two Words')), /one-word/);
  assert.throws(() => orch.addAgent(draft('group')), /reserved/);
  orch.removeAgent(a.id);
  assert.equal(orch.state.agents[0].isLead, true);
});

test('lean mode replaces the system prompt and trims what Claude Code loads', () => {
  const base: TurnRequest = {
    claudePath: 'claude', cwd: '/tmp', env: {}, sessionId: 'sid', resume: false, systemPrompt: 'sys', prompt: 'p',
    model: 'haiku', capability: 'chat', lean: true,
  };
  const lean = buildArgs(base);
  assert.equal(lean[lean.indexOf('--system-prompt') + 1], 'sys');
  for (const f of ['--disable-slash-commands', '--strict-mcp-config', '--setting-sources']) assert.ok(lean.includes(f), f);
  assert.equal(lean[lean.indexOf('--tools') + 1], '');
  const full = buildArgs({ ...base, lean: false, resume: true, capability: 'web' });
  assert.ok(full.includes('--append-system-prompt') && !full.includes('--system-prompt') && full.includes('--resume'));
  assert.equal(full[full.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.ok(buildArgs({ ...base, capability: 'full' }).includes('--dangerously-skip-permissions'));
});

test('stream-json parsing: text, tools, usage and result', () => {
  const events: string[] = [];
  let usage: any;
  const line = (o: object) => parseStreamLine(JSON.stringify(o), (e) => events.push(`${e.kind}:${e.text}`), (u) => (usage = u));
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'WebSearch', input: { query: 'note apps' } }] } });
  assert.deepEqual(events, ['text:hi', 'tool:Searching the web: note apps']);
  line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 100 }, seven_day: { utilization: 8, resetsAt: 200 } } } });
  assert.deepEqual(usage, { fiveHour: { utilization: 0.42, resetsAt: 100 }, sevenDay: { utilization: 0.08, resetsAt: 200 } });
  assert.deepEqual(line({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.5 }).result, { text: 'done', isError: false, costUsd: 0.5 });
});

test('user messages in an empty team get a hint', () => {
  const { orch } = setup(() => ok(''));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'hello?');
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /Add an agent/.test(m.text)));
  assert.equal(orch.state.messages[0].from, USER_ID);
});

// ------------------------------------------------------------------ projects

function tmpDir(name: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `troupe-${name}-`));
  return d;
}

test('project chats run in the project folder and brief agents on it', async () => {
  const { orch, runner } = setup((_req, name) => ok(name === 'Nova' ? '@Scout check the numbers' : '42'));
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Scout', { capability: 'web' }));
  const main = tmpDir('main');
  const extra = tmpDir('extra');
  const p = orch.createProject('', [main, extra]);
  assert.equal(p.name, path.basename(main));
  orch.updateProject(p.id, { instructions: 'We are building Inkwell.' });
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'what is the answer?');
  await idle(orch);
  const [lead, helper] = runner.calls.map((c) => c.req);
  assert.equal(lead.cwd, main);
  assert.deepEqual(lead.addDirs, [extra]);
  assert.equal(lead.readFiles, true, 'the lead can read by default');
  assert.equal(helper.readFiles, false, 'helpers cannot by default');
  assert.match(lead.systemPrompt, /Project: .*\n[\s\S]*You can read files there[\s\S]*We are building Inkwell/);
  assert.match(helper.systemPrompt, /You cannot open these files/);
});

test('project read access: everyone, nobody; file agents can always edit', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Byte', { capability: 'files' }));
  orch.addAgent(draft('Quill'));
  const p = orch.createProject('Site', [tmpDir('site')]);
  const chat = orch.newChat('group', p.id);
  orch.updateProject(p.id, { readAccess: 'all' });
  orch.userMessage(chat.id, '@Quill hi');
  await idle(orch);
  orch.updateProject(p.id, { readAccess: 'none' });
  orch.userMessage(chat.id, '@Nova @Byte hi');
  await idle(orch);
  const by = (n: string, i = 0) => runner.calls.filter((c) => c.agent === n)[i].req;
  assert.equal(by('Quill').readFiles, true);
  assert.equal(by('Nova').readFiles, false);
  assert.equal(by('Byte').readFiles, false, 'files agents already have file tools');
  assert.match(by('Byte').systemPrompt, /read and edit files there/);
});

test('changing project instructions re-briefs open chats once', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const p = orch.createProject('X', []);
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'one');
  await idle(orch);
  orch.updateProject(p.id, { instructions: 'Use British spelling.' });
  orch.userMessage(chat.id, 'two');
  await idle(orch);
  orch.userMessage(chat.id, 'three');
  await idle(orch);
  assert.match(runner.calls[1].req.prompt, /Project update[\s\S]*British spelling/);
  assert.doesNotMatch(runner.calls[2].req.prompt, /Project update/);
});

test('moving a chat into a project briefs agents and switches folders', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const dir = tmpDir('mv');
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'one');
  await idle(orch);
  const p = orch.createProject('Moved', [dir]);
  orch.moveChat(chat.id, p.id);
  orch.userMessage(chat.id, 'two');
  await idle(orch);
  assert.equal(runner.calls[1].req.cwd, dir);
  assert.match(runner.calls[1].req.prompt, /Project update[\s\S]*Project: Moved/);
});

test('a missing project folder is reported instead of running', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Nova', { isLead: true }));
  const dir = tmpDir('gone');
  const p = orch.createProject('Gone', [dir]);
  fs.rmSync(dir, { recursive: true });
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'hi');
  await idle(orch);
  assert.equal(runner.calls.length, 0);
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /Can't find/.test(m.text)));
});

test('projects validate folders and deleting one removes its chats only', () => {
  const { orch } = setup(() => ok(''));
  assert.throws(() => orch.createProject('bad', ['/definitely/not/here']), /not a folder/);
  const p = orch.createProject('P', [tmpDir('p')]);
  const inP = orch.newChat('group', p.id);
  orch.userMessage(inP.id, 'x');
  const outside = orch.newChat('group');
  orch.userMessage(outside.id, 'y');
  orch.deleteProject(p.id);
  assert.deepEqual(orch.state.chats.map((c) => c.id), [outside.id]);
  assert.equal(orch.state.projects.length, 0);
});

test('read-only file tools and extra folders reach the CLI', () => {
  const base: TurnRequest = {
    claudePath: 'claude', cwd: '/a', env: {}, sessionId: 'sid', resume: false, systemPrompt: 'sys', prompt: 'p',
    model: 'haiku', capability: 'chat', lean: true, readFiles: true, addDirs: ['/b', '/c'],
  };
  const args = buildArgs(base);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep');
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 3), ['--add-dir', '/b', '/c']);
  const web = buildArgs({ ...base, capability: 'web', addDirs: [] });
  assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  assert.ok(!web.includes('--add-dir'));
});
