import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    // Idle = nothing running and nothing that could start (paused work stays queued on purpose).
    if (!orch.isBusy() && (orch.state.settings.paused || orch.activityView().queued.every((q) => /paused/i.test(q.detail)))) return;
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
    if (name === 'Nova' && /write me a launch post/.test(req.prompt)) return ok('@Scout find 3 facts.\n@Quill draft a headline.');
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

test('@file mentions inline the file for the agents that read the message, once', async () => {
  const { orch, runner } = setup((_req, name) => ok(name === 'Nova' ? '@Quill tighten this' : 'done'));
  orch.addAgent(draft('Nova', { isLead: true }));
  orch.addAgent(draft('Quill'));
  const dir = tmpDir('mention');
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Launch is on October 3.');
  const p = orch.createProject('P', [dir]);
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'Summarise @brief.md please, and @missing.md too');
  await idle(orch);
  const [nova, quill, nova2] = runner.calls.map((c) => c.req);
  assert.match(nova.prompt, /<file path="brief.md">\nLaunch is on October 3.\n<\/file>/);
  assert.equal(nova.readFiles, true, 'unchanged: the lead may still read');
  assert.match(quill.prompt, /Launch is on October 3/, 'Quill sees the file with the user message');
  assert.doesNotMatch(nova2.prompt, /Launch is on October 3/, 'not resent to Nova on her next turn');
  assert.deepEqual(orch.state.messages.find((m) => m.from === USER_ID)!.files, [path.join(dir, 'brief.md')]);
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /missing\.md/.test(m.text)));
  assert.deepEqual(orch.searchFiles(chat.id, 'bri').map((f) => f.label), ['brief.md']);
});

// ------------------------------------------------------------------ code agents, hand-offs, checkpoints

test('only @Name at the start of a line hands off work', async () => {
  const replies: Record<string, string> = {
    Chief: "I'll check with the team. As @CTO's notes say, and per @Researcher, we're close.\n\n@CTO please fix the titles.\n- @Researcher find 3 sources",
  };
  const { orch, runner } = setup((_r, name) => ok(replies[name] ?? 'done'));
  orch.addAgent(draft('Chief', { isLead: true }));
  orch.addAgent(draft('CTO'));
  orch.addAgent(draft('Researcher'));
  orch.addAgent(draft('Quill'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'go');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent).slice(1, 3).sort(), ['CTO', 'Researcher']);
  assert.equal(runner.calls.filter((c) => c.agent === 'Quill').length, 0);

  // A reply that only mentions someone mid-sentence wakes nobody.
  replies.Chief = 'Done. Thanks to @CTO and @Researcher for the help.';
  const n = runner.calls.length;
  orch.userMessage(chat.id, 'thanks');
  await idle(orch);
  assert.equal(runner.calls.length, n + 1);
});

test('code capability: file tools plus an allowlist of test/build commands, no auto-approved edits mode', () => {
  const base: TurnRequest = {
    claudePath: 'claude', cwd: '/a', env: {}, sessionId: 'sid', resume: false, systemPrompt: 'sys', prompt: 'p',
    model: 'sonnet', capability: 'code', lean: true,
  };
  const args = buildArgs(base);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,Bash');
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('Bash(npm test:*)') && allowed.includes('Bash(git diff:*)') && allowed.includes('Edit'));
  assert.ok(!allowed.includes('Bash') && !allowed.some((a) => /rm|curl|Bash\(\*/.test(a)));
  assert.ok(!args.includes('--permission-mode'), 'acceptEdits would also auto-approve rm/mv');
  assert.ok(!buildArgs({ ...base, capability: 'files' }).includes('--permission-mode'));
});

test('a checkpoint is saved once per chat before the first editing turn, and hidden from agents', async () => {
  const { orch, runner } = setup((req, name) => {
    if (name === 'CTO') fs.writeFileSync(path.join(req.cwd, 'index.html'), '<h1>changed</h1>');
    return ok(name === 'Chief' ? '@CTO fix it' : 'fixed');
  });
  orch.addAgent(draft('Chief', { isLead: true }));
  orch.addAgent(draft('CTO', { capability: 'code' }));
  const dir = tmpDir('cp');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>orig</h1>');
  const p = orch.createProject('Site', [dir]);
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'improve it');
  await idle(orch);
  orch.userMessage(chat.id, '@CTO once more');
  await idle(orch);
  const notes = orch.state.messages.filter((m) => m.checkpoint);
  assert.equal(notes.length, 1, 'one checkpoint per folder per chat');
  assert.equal(notes[0].checkpoint!.files, 1);
  assert.match(notes[0].text, /1 file changed/);
  for (const c of runner.calls) assert.doesNotMatch(c.req.prompt, /Checkpoint/);

  orch.restoreCheckpoint(notes[0].id);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>orig</h1>');
  assert.ok(orch.state.messages.some((m) => m.from === SYSTEM_ID && /Undid all changes/.test(m.text)));
});

test('non-git project folders get a one-time explanation instead of a checkpoint', async () => {
  const { orch } = setup(() => ok('ok'));
  orch.addAgent(draft('CTO', { isLead: true, capability: 'files' }));
  const p = orch.createProject('Plain', [tmpDir('plain')]);
  const chat = orch.newChat('group', p.id);
  orch.userMessage(chat.id, 'one');
  await idle(orch);
  orch.userMessage(chat.id, 'two');
  await idle(orch);
  assert.equal(orch.state.messages.filter((m) => /isn't the root of a git repository/.test(m.text)).length, 1);
});

test('answering the asker with "@Asker done" does not wake the answerer again', async () => {
  const { orch, runner } = setup((_r, name) => ok(name === 'Chief' ? (runner.calls.length === 1 ? '@CTO fix it' : 'All done. Thanks CTO.') : '@Chief Done, tests pass.'));
  orch.addAgent(draft('Chief', { isLead: true }));
  orch.addAgent(draft('CTO'));
  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'go');
  await idle(orch);
  assert.deepEqual(runner.calls.map((c) => c.agent), ['Chief', 'CTO', 'Chief']);
});

// ------------------------------------------------------------------ multiple projects

test('only one editing agent per folder at a time; other projects and chat-only agents run in parallel', async () => {
  const active = new Map<string, number>();
  let maxSameFolder = 0;
  let maxTotal = 0;
  let total = 0;
  const { orch, runner } = setup(async (req, name) => {
    const editing = name.startsWith('Dev');
    total++;
    maxTotal = Math.max(maxTotal, total);
    if (editing) {
      active.set(req.cwd, (active.get(req.cwd) ?? 0) + 1);
      maxSameFolder = Math.max(maxSameFolder, active.get(req.cwd)!);
    }
    await new Promise((r) => setTimeout(r, 40));
    if (editing) active.set(req.cwd, active.get(req.cwd)! - 1);
    total--;
    return ok('done');
  });
  orch.updateSettings({ maxConcurrent: 4 });
  orch.addAgent(draft('Lead', { isLead: true }));
  orch.addAgent(draft('Dev1', { capability: 'code' }));
  orch.addAgent(draft('Dev2', { capability: 'files' }));
  const a = orch.createProject('A', [tmpDir('a')]);
  const b = orch.createProject('B', [tmpDir('b')]);
  const a1 = orch.newChat('group', a.id);
  orch.userMessage(a1.id, 'x');
  const a2 = orch.newChat('group', a.id);
  const b1 = orch.newChat('group', b.id);
  orch.userMessage(a1.id, '@Dev1 edit');
  orch.userMessage(a2.id, '@Dev2 edit');
  orch.userMessage(b1.id, '@Dev1 edit');
  await new Promise((r) => setTimeout(r, 15));
  const waiting = orch.activityView().queued.find((q) => q.chatId === a2.id);
  assert.match(waiting?.detail ?? '', /editing the same folder/);
  await idle(orch);
  assert.equal(maxSameFolder, 1, 'never two editors in one folder');
  assert.ok(maxTotal >= 2, 'project B and the chat-only lead ran in parallel');
  assert.equal(runner.calls.filter((c) => c.agent.startsWith('Dev')).length, 3);
});

test('pausing one project holds its chats while other projects keep going', async () => {
  const { orch, runner } = setup(() => ok('ok'));
  orch.addAgent(draft('Lead', { isLead: true }));
  const a = orch.createProject('A', []);
  const b = orch.createProject('B', []);
  const ca = orch.newChat('group', a.id);
  const cb = orch.newChat('group', b.id);
  orch.updateProject(a.id, { paused: true });
  orch.userMessage(ca.id, 'in A');
  orch.userMessage(cb.id, 'in B');
  await idle(orch);
  assert.equal(runner.calls.length, 1);
  assert.match(runner.calls[0].req.prompt, /in B/);
  assert.equal(orch.activityView().queued[0].detail, 'Project paused');
  orch.updateProject(a.id, { paused: false });
  await idle(orch);
  assert.equal(runner.calls.length, 2);
});

test('a per-project daily limit pauses only that project, with per-project usage tracked', async () => {
  const { orch, runner } = setup(() => ({ ok: true, text: 'ok', costUsd: 0.05 }));
  orch.addAgent(draft('Lead', { isLead: true }));
  const a = orch.createProject('A', []);
  const b = orch.createProject('B', []);
  orch.updateProject(a.id, { dailyTurnCap: 1 });
  const ca = orch.newChat('group', a.id);
  const cb = orch.newChat('group', b.id);
  orch.userMessage(ca.id, 'one');
  await idle(orch);
  orch.userMessage(ca.id, 'two');
  orch.userMessage(cb.id, 'b one');
  orch.userMessage(cb.id, 'b two');
  await idle(orch);
  const pa = orch.state.projects.find((p) => p.id === a.id)!;
  assert.equal(pa.paused, true);
  assert.equal(pa.pauseReason, 'daily_cap');
  assert.ok(orch.state.messages.some((m) => m.chatId === ca.id && /daily limit of 1 turns/.test(m.text)));
  assert.equal(orch.state.settings.paused, false, 'the rest of the team keeps going');
  const view = orch.activityView();
  const row = (id: string) => view.projects.find((p) => p.projectId === id)!;
  assert.equal(row(a.id).turnsToday, 1);
  assert.equal(row(b.id).turnsToday, 2, 'B is unaffected by A\'s limit');
  assert.ok(Math.abs(row(a.id).costToday - 0.05) < 1e-9);
  // Raising the limit resumes it.
  orch.updateProject(a.id, { dailyTurnCap: 5 });
  await idle(orch);
  assert.equal(pa.paused, false);
  assert.equal(runner.calls.length, 4, "A's held message runs once the limit is raised");
});

test('undo warns about other chats that edited the same folder, and stops them', async () => {
  let slow = false;
  const { orch } = setup(async (req, name) => {
    if (name === 'Dev') fs.appendFileSync(path.join(req.cwd, 'f.txt'), `${name}\n`);
    if (slow) await new Promise((r) => setTimeout(r, 200));
    return ok('done');
  });
  orch.addAgent(draft('Dev', { isLead: true, capability: 'code' }));
  const dir = tmpDir('undo');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const p = orch.createProject('P', [dir]);
  const c1 = orch.newChat('group', p.id);
  orch.userMessage(c1.id, 'first');
  await idle(orch);
  const c2 = orch.newChat('group', p.id);
  orch.userMessage(c2.id, 'second');
  await idle(orch);
  const cp1 = orch.state.messages.find((m) => m.chatId === c1.id && m.checkpoint)!;
  assert.deepEqual(orch.checkpointConflicts(cp1.id), ['second']);
  assert.equal(cp1.checkpoint!.files, 1);

  slow = true;
  orch.userMessage(c2.id, 'third');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(orch.isBusy(), true);
  orch.restoreCheckpoint(cp1.id);
  assert.equal(orch.isBusy(), false, "the other chat's editor was stopped");
  assert.ok(orch.state.messages.some((m) => m.chatId === c2.id && /rolled back from another chat/.test(m.text)));
});
