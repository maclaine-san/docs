import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type {
  ActivityEntry,
  Agent,
  AgentDraft,
  AppState,
  Channel,
  Message,
  Settings,
  Task,
  TaskStatus,
} from '../shared/types';
import { USER_ID, SYSTEM_ID } from '../shared/types';
import type { Store } from './store';
import type { Runner, TurnHandle } from './claudeRunner';
import { channelLabel, displayName, formatTaskLine, systemPrompt, turnPrompt, type WakeReason } from './prompts';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ACTIVITY_LIMIT = 400;
const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

export interface OrchestratorEnv {
  /** Path to the claude CLI (resolved at startup, may be overridden by settings). */
  claudePath: string;
  /** Environment for claude child processes. */
  childEnv: () => NodeJS.ProcessEnv;
  /** How claude should launch Troupe's MCP server. */
  mcpCommand: string;
  mcpArgs: string[];
  mcpEnv: Record<string, string>;
}

export class ToolError extends Error {}

interface RunningTurn {
  handle: TurnHandle;
  depth: number;
}

export class Orchestrator extends EventEmitter {
  private running = new Map<string, RunningTurn>();
  private activity = new Map<string, ActivityEntry[]>();
  /** Per-agent secrets for the MCP bridge: token -> agent id. */
  private tokens = new Map<string, string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  bridgeUrl = '';

  constructor(
    private store: Store,
    private runner: Runner,
    private env: OrchestratorEnv,
  ) {
    super();
  }

  get state(): AppState {
    return this.store.state;
  }

  start(bridgeUrl: string): void {
    this.bridgeUrl = bridgeUrl;
    this.heartbeatTimer = setInterval(() => this.heartbeats(), 30_000);
    this.heartbeatTimer.unref();
    this.schedule();
  }

  shutdown(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const r of this.running.values()) r.handle.cancel();
    this.store.flush();
  }

  private changed(): void {
    this.store.save();
    this.emit('state', this.state);
  }

  // ---------------------------------------------------------------- lookups

  agent(id: string): Agent {
    const a = this.state.agents.find((x) => x.id === id);
    if (!a) throw new ToolError(`No agent with id ${id}`);
    return a;
  }

  private agentByName(name: string): Agent | undefined {
    const n = name.trim().replace(/^@/, '').toLowerCase();
    return this.state.agents.find((a) => a.name.toLowerCase() === n);
  }

  private channelByName(name: string): Channel | undefined {
    const n = name.trim().replace(/^#/, '').toLowerCase();
    return this.state.channels.find((c) => c.kind === 'channel' && c.name.toLowerCase() === n);
  }

  agentForToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  getActivity(agentId: string): ActivityEntry[] {
    return this.activity.get(agentId) ?? [];
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  // ---------------------------------------------------------------- agents

  private validateName(name: string, selfId?: string): string {
    const n = name.trim();
    if (!NAME_RE.test(n)) throw new ToolError('Names must start with a letter and use only letters, digits, "-" or "_" (max 32).');
    if (['user', 'all', 'here', 'channel', 'troupe', 'system'].includes(n.toLowerCase())) throw new ToolError(`"${n}" is reserved.`);
    const clash = this.agentByName(n);
    if (clash && clash.id !== selfId) throw new ToolError(`There is already a teammate called ${clash.name}.`);
    return n;
  }

  hireAgent(draft: AgentDraft): Agent {
    const agent: Agent = {
      id: randomUUID(),
      name: this.validateName(draft.name),
      role: draft.role.trim() || 'Generalist',
      responsibilities: draft.responsibilities ?? '',
      instructions: draft.instructions ?? '',
      model: draft.model ?? '',
      reportsTo: draft.reportsTo ?? '',
      tools: draft.tools ?? 'chat',
      useMyMcpServers: Boolean(draft.useMyMcpServers),
      cwd: draft.cwd ?? '',
      heartbeatMinutes: Math.max(0, Number(draft.heartbeatMinutes) || 0),
      sessionId: randomUUID(),
      sessionStarted: false,
      profileVersion: 1,
      briefedProfileVersion: 1,
      status: 'idle',
      lastError: '',
      lastHeartbeatAt: Date.now(),
      paused: false,
      createdAt: Date.now(),
      turns: 0,
      costUsd: 0,
    };
    this.state.agents.push(agent);
    // Everyone joins #general, created on first hire.
    let general = this.channelByName('general');
    if (!general) general = this.createChannel('general', [USER_ID], 'Team-wide announcements and discussion');
    general.members.push(agent.id);
    this.postMessage(general.id, SYSTEM_ID, `${agent.name} joined the team as ${agent.role}.`, 0, undefined, false);
    this.changed();
    return agent;
  }

  updateAgent(id: string, patch: Partial<AgentDraft> & { paused?: boolean }): void {
    const a = this.agent(id);
    if (patch.name !== undefined && patch.name !== a.name) a.name = this.validateName(patch.name, a.id);
    const profileFields = ['role', 'responsibilities', 'instructions'] as const;
    let profileChanged = false;
    for (const f of profileFields) {
      if (patch[f] !== undefined && patch[f] !== a[f]) {
        a[f] = patch[f]!;
        profileChanged = true;
      }
    }
    if (profileChanged) a.profileVersion++;
    if (patch.reportsTo !== undefined) {
      if (patch.reportsTo === a.id) throw new ToolError('An agent cannot report to itself.');
      a.reportsTo = patch.reportsTo;
    }
    if (patch.model !== undefined) a.model = patch.model;
    if (patch.tools !== undefined) a.tools = patch.tools;
    if (patch.useMyMcpServers !== undefined) a.useMyMcpServers = patch.useMyMcpServers;
    if (patch.cwd !== undefined) a.cwd = patch.cwd;
    if (patch.heartbeatMinutes !== undefined) a.heartbeatMinutes = Math.max(0, Number(patch.heartbeatMinutes) || 0);
    if (patch.paused !== undefined) {
      a.paused = patch.paused;
      if (!a.paused && a.status === 'error') a.status = this.hasInbox(a.id) ? 'queued' : 'idle';
    }
    this.changed();
    this.schedule();
  }

  fireAgent(id: string): void {
    const a = this.agent(id);
    this.stopAgent(id);
    this.state.agents = this.state.agents.filter((x) => x.id !== id);
    this.state.inbox = this.state.inbox.filter((i) => i.agentId !== id);
    for (const other of this.state.agents) if (other.reportsTo === id) other.reportsTo = a.reportsTo;
    for (const c of this.state.channels) c.members = c.members.filter((m) => m !== id);
    this.state.channels = this.state.channels.filter((c) => c.kind === 'channel' || c.members.length === 2);
    for (const t of this.state.tasks) if (t.assigneeId === id && t.status !== 'done') t.assigneeId = '';
    const general = this.channelByName('general');
    if (general) this.postMessage(general.id, SYSTEM_ID, `${a.name} (${a.role}) left the team.`, 0, undefined, false);
    this.activity.delete(id);
    this.changed();
  }

  resetAgentMemory(id: string): void {
    const a = this.agent(id);
    this.stopAgent(id);
    a.sessionId = randomUUID();
    a.sessionStarted = false;
    a.briefedProfileVersion = a.profileVersion;
    this.log(id, 'turn_end', 'Memory reset: the next turn starts a fresh Claude session.');
    this.changed();
  }

  stopAgent(id: string): void {
    this.running.get(id)?.handle.cancel();
  }

  // ---------------------------------------------------------------- channels

  createChannel(name: string, members: string[], topic = ''): Channel {
    const n = name.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(n)) throw new ToolError('Channel names use lowercase letters, digits, "-" or "_".');
    if (this.channelByName(n)) throw new ToolError(`#${n} already exists.`);
    const c: Channel = {
      id: randomUUID(),
      name: n,
      kind: 'channel',
      members: [...new Set([USER_ID, ...members])],
      topic,
      createdAt: Date.now(),
    };
    this.state.channels.push(c);
    this.changed();
    return c;
  }

  updateChannel(id: string, patch: Partial<Pick<Channel, 'name' | 'members' | 'topic'>>): void {
    const c = this.state.channels.find((x) => x.id === id);
    if (!c || c.kind !== 'channel') throw new ToolError('No such channel');
    if (patch.name !== undefined) {
      const n = patch.name.trim().replace(/^#/, '').toLowerCase();
      const clash = this.channelByName(n);
      if (clash && clash.id !== id) throw new ToolError(`#${n} already exists.`);
      c.name = n;
    }
    if (patch.topic !== undefined) c.topic = patch.topic;
    if (patch.members !== undefined) c.members = [...new Set([USER_ID, ...patch.members])];
    this.changed();
  }

  deleteChannel(id: string): void {
    this.state.channels = this.state.channels.filter((c) => c.id !== id);
    const gone = new Set(this.state.messages.filter((m) => m.channelId === id).map((m) => m.id));
    this.state.messages = this.state.messages.filter((m) => m.channelId !== id);
    this.state.inbox = this.state.inbox.filter((i) => !gone.has(i.messageId));
    this.changed();
  }

  clearMessages(channelId: string): void {
    const gone = new Set(this.state.messages.filter((m) => m.channelId === channelId).map((m) => m.id));
    this.state.messages = this.state.messages.filter((m) => m.channelId !== channelId);
    this.state.inbox = this.state.inbox.filter((i) => !gone.has(i.messageId));
    this.changed();
  }

  /** The direct-message channel between two participants, created on demand. */
  dm(a: string, b: string): Channel {
    const pair = [a, b].sort();
    let c = this.state.channels.find((x) => x.kind === 'dm' && x.members.length === 2 && [...x.members].sort().join() === pair.join());
    if (!c) {
      c = { id: randomUUID(), name: '', kind: 'dm', members: pair, topic: '', createdAt: Date.now() };
      this.state.channels.push(c);
      this.changed();
    }
    return c;
  }

  // ---------------------------------------------------------------- messages

  /** Which agents a new message should wake up. */
  private recipients(channel: Channel, from: string, text: string): string[] {
    const agentMembers = channel.members.filter((m) => m !== USER_ID && m !== from);
    if (channel.kind === 'dm') return agentMembers;
    const mentions = [...text.matchAll(/@([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1].toLowerCase());
    if (mentions.some((m) => m === 'all' || m === 'here' || m === 'channel')) return agentMembers;
    if (mentions.length) {
      const ids = mentions.map((m) => this.agentByName(m)?.id).filter((x): x is string => Boolean(x) && x !== from);
      return [...new Set(ids)];
    }
    // Un-addressed human messages go to the whole channel; un-addressed agent chatter wakes nobody.
    return from === USER_ID ? agentMembers : [];
  }

  postMessage(channelId: string, from: string, text: string, depth: number, taskId?: string, deliver = true): Message {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) throw new ToolError('No such channel');
    const msg: Message = { id: randomUUID(), channelId, from, text, ts: Date.now(), depth, taskId };
    this.state.messages.push(msg);
    if (deliver && from !== SYSTEM_ID) {
      const to = this.recipients(channel, from, text);
      if (to.length && depth > this.state.settings.maxDepth) {
        this.state.messages.push({
          id: randomUUID(),
          channelId,
          from: SYSTEM_ID,
          text: `Loop limit reached (${this.state.settings.maxDepth} agent-to-agent hops since the last human message), so this message was not delivered. Send a message yourself to let the team continue.`,
          ts: Date.now(),
          depth,
        });
      } else {
        for (const agentId of to) this.state.inbox.push({ messageId: msg.id, agentId });
      }
    }
    this.changed();
    this.schedule();
    return msg;
  }

  /** A message from you, typed in the app. */
  userMessage(channelId: string, text: string): void {
    if (!text.trim()) return;
    this.postMessage(channelId, USER_ID, text.trim(), 0);
  }

  // ---------------------------------------------------------------- tasks

  createTask(by: string, t: { title: string; description: string; assigneeId: string }, depth: number): Task {
    const task: Task = {
      id: `T-${this.state.nextTaskNumber++}`,
      title: t.title.trim() || 'Untitled',
      description: t.description ?? '',
      assigneeId: t.assigneeId,
      createdBy: by,
      status: 'todo',
      result: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.tasks.push(task);
    if (task.assigneeId && task.assigneeId !== by) {
      const c = this.dm(by, task.assigneeId);
      this.postMessage(c.id, by, `New task ${task.id}: **${task.title}**\n\n${task.description}`, depth, task.id);
    }
    this.changed();
    return task;
  }

  updateTask(by: string, id: string, patch: Partial<Pick<Task, 'status' | 'title' | 'description' | 'assigneeId' | 'result'>>, depth: number): Task {
    const t = this.state.tasks.find((x) => x.id.toLowerCase() === id.trim().toLowerCase());
    if (!t) throw new ToolError(`No task ${id}`);
    if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new ToolError(`Status must be one of ${TASK_STATUSES.join(', ')}`);
    const wasDone = t.status === 'done';
    const oldAssignee = t.assigneeId;
    Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    t.updatedAt = Date.now();
    // Tell the creator when their task is finished or blocked.
    if (t.createdBy !== by && (patch.status === 'done' || patch.status === 'blocked') && !(wasDone && patch.status === 'done')) {
      const c = this.dm(by, t.createdBy);
      const verb = patch.status === 'done' ? 'is done' : 'is blocked';
      this.postMessage(c.id, by, `Task ${t.id} "${t.title}" ${verb}.${t.result ? `\n\n${t.result}` : ''}`, depth, t.id);
    }
    // Tell the new assignee when a task is handed over.
    if (patch.assigneeId && patch.assigneeId !== oldAssignee && patch.assigneeId !== by) {
      const c = this.dm(by, patch.assigneeId);
      this.postMessage(c.id, by, `Task ${t.id} is now yours: **${t.title}**\n\n${t.description}`, depth, t.id);
    }
    this.changed();
    return t;
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.state.settings, patch);
    this.state.settings.maxConcurrent = Math.max(1, Math.min(10, Number(this.state.settings.maxConcurrent) || 1));
    this.state.settings.maxDepth = Math.max(1, Math.min(50, Number(this.state.settings.maxDepth) || 8));
    this.changed();
    this.schedule();
  }

  // ---------------------------------------------------------------- agent tools (MCP)

  async handleTool(agentId: string, name: string, args: Record<string, any>): Promise<string> {
    const me = this.agent(agentId);
    const depth = (this.running.get(agentId)?.depth ?? 0) + 1;
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    switch (name) {
      case 'send_message': {
        const to = str('to').trim();
        const text = str('text').trim();
        if (!to || !text) throw new ToolError('"to" and "text" are required.');
        let channel: Channel;
        if (to.toLowerCase() === 'user' || to.toLowerCase() === '@user') channel = this.dm(me.id, USER_ID);
        else if (to.startsWith('#')) {
          const c = this.channelByName(to);
          if (!c) throw new ToolError(`No channel ${to}. Channels: ${this.state.channels.filter((x) => x.kind === 'channel').map((x) => '#' + x.name).join(', ')}`);
          if (!c.members.includes(me.id)) throw new ToolError(`You are not a member of ${to}.`);
          channel = c;
        } else {
          const other = this.agentByName(to);
          if (!other) throw new ToolError(`No teammate called "${to}". Team: ${this.state.agents.map((a) => a.name).join(', ')}`);
          if (other.id === me.id) throw new ToolError('You cannot message yourself.');
          channel = this.dm(me.id, other.id);
        }
        const msg = this.postMessage(channel.id, me.id, text, depth, str('task_id') || undefined);
        const delivered = this.state.inbox.some((i) => i.messageId === msg.id);
        return `Sent to ${channelLabel(this.state, channel.id, me.id)}.${
          channel.kind === 'channel' && !delivered ? ' Nobody was @mentioned, so nobody was woken up.' : ''
        }${depth > this.state.settings.maxDepth ? ' Loop limit reached: not delivered.' : ''}`;
      }
      case 'create_task': {
        const assignee = str('assignee') ? this.agentByName(str('assignee')) : me;
        if (!assignee) throw new ToolError(`No teammate called "${str('assignee')}".`);
        const t = this.createTask(me.id, { title: str('title'), description: str('description'), assigneeId: assignee.id }, depth);
        return `Created ${t.id} for ${assignee.name}.`;
      }
      case 'update_task': {
        const patch: Partial<Task> = {};
        if (str('status')) patch.status = str('status') as TaskStatus;
        if (str('result')) patch.result = str('result');
        const t = this.updateTask(me.id, str('task_id'), patch, depth);
        return `Updated: ${formatTaskLine(this.state, t)}`;
      }
      case 'list_tasks': {
        const scope = str('scope') || 'mine';
        const tasks = this.state.tasks.filter(
          (t) =>
            (args.include_done || t.status !== 'done') &&
            (scope === 'all' || (scope === 'mine' ? t.assigneeId === me.id : t.createdBy === me.id)),
        );
        if (!tasks.length) return 'No matching tasks.';
        return tasks
          .map((t) => `${formatTaskLine(this.state, t)}\n  ${t.description.slice(0, 300)}${t.result ? `\n  Result: ${t.result.slice(0, 500)}` : ''}`)
          .join('\n');
      }
      case 'list_team': {
        return this.state.agents
          .map((a) => {
            const mgr = a.reportsTo ? this.state.agents.find((m) => m.id === a.reportsTo)?.name ?? 'user' : 'user';
            const busy = this.running.has(a.id) ? 'working' : a.paused ? 'paused' : 'available';
            return `## ${a.name}${a.id === me.id ? ' (you)' : ''}\nRole: ${a.role}\nReports to: ${mgr}\nStatus: ${busy}\nResponsibilities: ${a.responsibilities || '-'}`;
          })
          .join('\n\n');
      }
      case 'read_channel': {
        const ref = str('channel').trim();
        let channel: Channel | undefined;
        if (ref.startsWith('#')) channel = this.channelByName(ref);
        else if (ref.toLowerCase() === 'user') channel = this.dm(me.id, USER_ID);
        else {
          const other = this.agentByName(ref);
          if (other) channel = this.dm(me.id, other.id);
        }
        if (!channel) throw new ToolError(`Unknown channel "${ref}".`);
        if (!channel.members.includes(me.id)) throw new ToolError(`You are not a member of ${ref}.`);
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        const msgs = this.state.messages.filter((m) => m.channelId === channel!.id).slice(-limit);
        if (!msgs.length) return 'No messages yet.';
        return msgs.map((m) => `${displayName(this.state, m.from)}: ${m.text}`).join('\n\n');
      }
      default:
        throw new ToolError(`Unknown tool ${name}`);
    }
  }

  // ---------------------------------------------------------------- scheduling

  private hasInbox(agentId: string): boolean {
    return this.state.inbox.some((i) => i.agentId === agentId);
  }

  private heartbeatDue = new Set<string>();

  private heartbeats(): void {
    const now = Date.now();
    for (const a of this.state.agents) {
      if (a.heartbeatMinutes > 0 && !a.paused && now - a.lastHeartbeatAt >= a.heartbeatMinutes * 60_000) {
        a.lastHeartbeatAt = now;
        this.heartbeatDue.add(a.id);
      }
    }
    this.schedule();
  }

  /** Start turns for agents with pending work, up to the concurrency limit. */
  schedule(): void {
    const s = this.state.settings;
    for (const a of this.state.agents) {
      const pending = this.hasInbox(a.id) || this.heartbeatDue.has(a.id);
      if (!this.running.has(a.id) && a.status !== 'error') {
        const next = pending && !a.paused ? 'queued' : 'idle';
        if (a.status !== next) {
          a.status = next;
          this.emit('state', this.state);
        }
      }
    }
    if (s.paused) return;
    for (const a of this.state.agents) {
      if (this.running.size >= s.maxConcurrent) break;
      if (a.paused || a.status === 'error' || this.running.has(a.id)) continue;
      if (this.hasInbox(a.id)) this.startTurn(a, 'messages');
      else if (this.heartbeatDue.has(a.id)) this.startTurn(a, 'heartbeat');
    }
  }

  private log(agentId: string, kind: ActivityEntry['kind'], text: string): void {
    const e: ActivityEntry = { id: randomUUID(), agentId, ts: Date.now(), kind, text };
    const list = this.activity.get(agentId) ?? [];
    list.push(e);
    if (list.length > ACTIVITY_LIMIT) list.splice(0, list.length - ACTIVITY_LIMIT);
    this.activity.set(agentId, list);
    this.emit('activity', e);
  }

  private mcpConfig(agentId: string): object {
    let token = [...this.tokens.entries()].find(([, id]) => id === agentId)?.[0];
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.tokens.set(token, agentId);
    }
    return {
      mcpServers: {
        troupe: {
          type: 'stdio',
          command: this.env.mcpCommand,
          args: this.env.mcpArgs,
          env: { ...this.env.mcpEnv, TROUPE_URL: this.bridgeUrl, TROUPE_TOKEN: token },
        },
      },
    };
  }

  private startTurn(agent: Agent, reason: WakeReason, retried = false): void {
    this.heartbeatDue.delete(agent.id);
    const items = this.state.inbox.filter((i) => i.agentId === agent.id);
    this.state.inbox = this.state.inbox.filter((i) => i.agentId !== agent.id);
    const messages = items
      .map((i) => this.state.messages.find((m) => m.id === i.messageId))
      .filter((m): m is Message => Boolean(m));
    if (reason === 'messages' && !messages.length) return this.changed();

    const depth = messages.reduce((d, m) => Math.max(d, m.depth), 0);
    const lastUserMsg = [...messages].reverse().find((m) => m.from === USER_ID);
    const settings = this.state.settings;
    const cwd = agent.cwd || settings.workspaceDir;
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
      /* reported by the CLI if it matters */
    }

    const prompt = turnPrompt(this.state, agent, messages, reason);
    agent.status = 'working';
    agent.lastError = '';
    this.log(agent.id, 'turn_start', reason === 'heartbeat' ? 'Heartbeat' : `Woke up for ${messages.length} message(s)`);

    const handle = this.runner.run(
      {
        claudePath: settings.claudePath || this.env.claudePath,
        cwd,
        env: this.env.childEnv(),
        sessionId: agent.sessionId,
        resume: agent.sessionStarted,
        systemPrompt: systemPrompt(agent, cwd),
        prompt,
        model: agent.model || settings.defaultModel,
        tools: agent.tools,
        useMyMcpServers: agent.useMyMcpServers,
        mcpConfig: this.mcpConfig(agent.id),
      },
      (e) => this.log(agent.id, e.kind, e.text),
    );
    this.running.set(agent.id, { handle, depth });
    this.changed();

    handle.done.then((res) => {
      this.running.delete(agent.id);
      // The agent may have been fired mid-turn.
      const a = this.state.agents.find((x) => x.id === agent.id);
      if (!a) return this.schedule();
      a.turns++;
      a.costUsd += res.costUsd;
      if (res.ok) {
        a.sessionStarted = true;
        a.briefedProfileVersion = a.profileVersion;
        a.status = 'idle';
        this.log(a.id, 'turn_end', `Turn finished${res.costUsd ? ` (≈$${res.costUsd.toFixed(3)})` : ''}`);
        if (lastUserMsg && res.text.trim()) this.postMessage(lastUserMsg.channelId, a.id, res.text.trim(), depth + 1);
      } else if (res.sessionMissing && a.sessionStarted && !retried) {
        // Claude Code lost the session (e.g. history was cleared): start a fresh one and retry once.
        a.sessionId = randomUUID();
        a.sessionStarted = false;
        this.requeue(a.id, items);
        this.log(a.id, 'error', 'Session not found; starting a new one.');
        return this.startTurn(a, reason, true);
      } else if (res.error === 'Stopped') {
        a.status = 'idle';
        this.log(a.id, 'turn_end', 'Stopped by you.');
      } else {
        // Keep the messages and pause the agent, so a rate limit or bad setting doesn't loop.
        a.status = 'error';
        a.lastError = res.error ?? 'Unknown error';
        this.requeue(a.id, items);
        this.log(a.id, 'error', a.lastError);
        if (lastUserMsg) {
          this.postMessage(lastUserMsg.channelId, SYSTEM_ID, `${a.name} hit an error and is on hold until you resume them:\n\n${a.lastError.slice(0, 600)}`, 0, undefined, false);
        }
      }
      this.changed();
      this.schedule();
    });
  }

  private requeue(agentId: string, items: { messageId: string }[]): void {
    this.state.inbox.unshift(...items.map((i) => ({ messageId: i.messageId, agentId })));
  }
}
