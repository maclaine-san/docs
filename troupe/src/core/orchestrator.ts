import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Agent, AgentDraft, AppState, Chat, InboxItem, LiveStatus, Message, Project, Seat, Settings } from '../shared/types';
import path from 'node:path';
import { USER_ID, SYSTEM_ID } from '../shared/types';
import { today, type Store } from './store';
import type { Runner, TurnHandle } from './claudeRunner';
import { mentionedAgents, systemPrompt, turnPrompt, type ProjectContext } from './prompts';
import { displayLabel, FILE_CHARS, mentionToken, parseFileMentions, readForPrompt, resolveMention, searchFiles, TURN_FILE_CHARS, type FileContent } from './files';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const RESERVED = ['user', 'all', 'group', 'everyone', 'troupe', 'system', 'here'];
const USAGE_ERROR = /usage limit|rate limit|limit reached|too many requests|\b429\b|overloaded/i;

export interface OrchestratorEnv {
  /** Path to the claude CLI (resolved at startup, may be overridden by settings). */
  claudePath: string;
  /** Environment for claude child processes. */
  childEnv: () => NodeJS.ProcessEnv;
}

export class UserError extends Error {}

interface Running {
  handle: TurnHandle;
  chatId: string;
  agentId: string;
}

const seatKey = (chatId: string, agentId: string) => `${chatId}:${agentId}`;

export const STARTER_TEAM: AgentDraft[] = [
  {
    name: 'Nova',
    emoji: '✦',
    hue: 265,
    persona: 'The team lead: a sharp, friendly generalist who answers most things directly and pulls in a teammate only when they would clearly do it better.',
    model: 'sonnet',
    capability: 'chat',
    isLead: true,
  },
  {
    name: 'Scout',
    emoji: '🔎',
    hue: 150,
    persona: 'Researcher who searches the web and returns a short answer first, then key facts with sources.',
    model: 'haiku',
    capability: 'web',
    isLead: false,
  },
  {
    name: 'Quill',
    emoji: '✍️',
    hue: 20,
    persona: 'Writer who turns ideas into clear, punchy copy: one strong draft, never five weak ones.',
    model: 'haiku',
    capability: 'chat',
    isLead: false,
  },
];

export class Orchestrator extends EventEmitter {
  private running = new Map<string, Running>();
  private live = new Map<string, LiveStatus>();
  /** `${chatId}:${askerId}` -> agents the asker @mentioned and is still waiting on. */
  private pending = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;

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

  start(): void {
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
    this.schedule();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    for (const r of this.running.values()) r.handle.cancel();
    this.store.flush();
  }

  private changed(): void {
    this.store.save();
    this.emit('state', this.state);
  }

  private emitLive(): void {
    this.emit('live', this.getLive());
  }

  getLive(): LiveStatus[] {
    return [...this.live.values()];
  }

  isBusy(): boolean {
    return this.running.size > 0;
  }

  // ---------------------------------------------------------------- agents

  private agent(id: string): Agent {
    const a = this.state.agents.find((x) => x.id === id);
    if (!a) throw new UserError('That agent no longer exists.');
    return a;
  }

  private lead(): Agent | undefined {
    return this.state.agents.find((a) => a.isLead) ?? this.state.agents[0];
  }

  private validateName(name: string, selfId?: string): string {
    const n = name.trim().replace(/^@/, '');
    if (!NAME_RE.test(n)) throw new UserError('Use a one-word name: letters, digits, "-" or "_".');
    if (RESERVED.includes(n.toLowerCase())) throw new UserError(`"${n}" is reserved.`);
    const clash = this.state.agents.find((a) => a.name.toLowerCase() === n.toLowerCase());
    if (clash && clash.id !== selfId) throw new UserError(`You already have an agent called ${clash.name}.`);
    return n;
  }

  addAgent(d: AgentDraft): Agent {
    const agent: Agent = {
      id: randomUUID(),
      name: this.validateName(d.name),
      emoji: d.emoji || '●',
      hue: Number.isFinite(d.hue) ? d.hue : Math.floor(Math.random() * 360),
      persona: d.persona?.trim() ?? '',
      model: d.model ?? 'haiku',
      capability: d.capability ?? 'chat',
      isLead: Boolean(d.isLead) || !this.state.agents.length,
      createdAt: Date.now(),
      turns: 0,
      costUsd: 0,
    };
    if (agent.isLead) for (const a of this.state.agents) a.isLead = false;
    this.state.agents.push(agent);
    this.state.teamVersion++;
    this.changed();
    return agent;
  }

  seedStarterTeam(): void {
    if (this.state.agents.length || this.state.chats.length) return;
    for (const d of STARTER_TEAM) this.addAgent(d);
  }

  updateAgent(id: string, patch: Partial<AgentDraft>): void {
    const a = this.agent(id);
    if (patch.name !== undefined && patch.name !== a.name) a.name = this.validateName(patch.name, a.id);
    if (patch.persona !== undefined) a.persona = patch.persona.trim();
    for (const k of ['emoji', 'hue', 'model', 'capability'] as const) if (patch[k] !== undefined) (a as any)[k] = patch[k];
    if (patch.isLead) for (const x of this.state.agents) x.isLead = x.id === a.id;
    if (patch.isLead === false && a.isLead) {
      a.isLead = false;
      const other = this.state.agents.find((x) => x.id !== a.id);
      (other ?? a).isLead = true;
    }
    // Name/persona/lead changes are shown to existing chats at the start of the next turn.
    this.state.teamVersion++;
    this.changed();
  }

  removeAgent(id: string): void {
    const a = this.agent(id);
    for (const [k, r] of this.running) if (r.agentId === id) r.handle.cancel(), this.running.delete(k), this.live.delete(k);
    this.state.agents = this.state.agents.filter((x) => x.id !== id);
    this.state.inbox = this.state.inbox.filter((i) => i.agentId !== id);
    for (const c of this.state.chats) {
      delete c.seats[id];
      if (c.target === id) c.target = 'group';
    }
    for (const [k, set] of this.pending) {
      set.delete(id);
      if (k.endsWith(`:${id}`) || !set.size) this.pending.delete(k);
    }
    if (a.isLead && this.state.agents.length) this.state.agents[0].isLead = true;
    this.state.teamVersion++;
    this.emitLive();
    this.changed();
    this.schedule();
  }

  // ---------------------------------------------------------------- chats

  private chat(id: string): Chat {
    const c = this.state.chats.find((x) => x.id === id);
    if (!c) throw new UserError('That chat no longer exists.');
    return c;
  }

  newChat(target = 'group', projectId = '', quick = false): Chat {
    if (projectId) this.project(projectId);
    // Reuse an untouched chat rather than piling up empty ones.
    const empty = this.state.chats.find(
      (c) => c.projectId === projectId && Boolean(c.quick) === quick && !this.state.messages.some((m) => m.chatId === c.id),
    );
    if (empty) {
      empty.target = target;
      empty.updatedAt = Date.now();
      this.changed();
      return empty;
    }
    const c: Chat = { id: randomUUID(), title: 'New chat', target, projectId, seats: {}, createdAt: Date.now(), updatedAt: Date.now() };
    if (quick) c.quick = true;
    this.state.chats.push(c);
    this.changed();
    return c;
  }

  /** Move a chat into a project (or out, with ""). Agents are briefed on the change next turn. */
  moveChat(chatId: string, projectId: string): void {
    if (projectId) this.project(projectId);
    const c = this.chat(chatId);
    if (c.projectId === projectId) return;
    c.projectId = projectId;
    for (const seat of Object.values(c.seats)) seat.projectVersion = -1;
    this.changed();
  }

  // ---------------------------------------------------------------- projects

  private project(id: string): Project {
    const p = this.state.projects.find((x) => x.id === id);
    if (!p) throw new UserError('That project no longer exists.');
    return p;
  }

  private checkFolders(folders: string[]): string[] {
    const out: string[] = [];
    for (const f of folders) {
      const abs = path.resolve(f);
      let ok = false;
      try {
        ok = fs.statSync(abs).isDirectory();
      } catch {
        /* reported below */
      }
      if (!ok) throw new UserError(`${abs} is not a folder.`);
      if (!out.includes(abs)) out.push(abs);
    }
    return out;
  }

  createProject(name: string, folders: string[] = []): Project {
    const dirs = this.checkFolders(folders);
    const p: Project = {
      id: randomUUID(),
      name: name.trim() || (dirs[0] ? path.basename(dirs[0]) : 'New project'),
      folders: dirs,
      instructions: '',
      readAccess: 'lead',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.projects.push(p);
    this.changed();
    return p;
  }

  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'folders' | 'instructions' | 'readAccess'>>): void {
    const p = this.project(id);
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.folders !== undefined) p.folders = this.checkFolders(patch.folders);
    if (patch.instructions !== undefined) p.instructions = patch.instructions;
    if (patch.readAccess !== undefined) p.readAccess = patch.readAccess;
    if (patch.folders !== undefined || patch.instructions !== undefined || patch.readAccess !== undefined) p.version++;
    p.updatedAt = Date.now();
    this.changed();
  }

  /** Deletes the project and its chats. Never touches the folders on disk. */
  deleteProject(id: string): void {
    this.project(id);
    for (const c of this.state.chats.filter((x) => x.projectId === id)) this.deleteChat(c.id);
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.changed();
  }

  setChatTarget(chatId: string, target: string): void {
    if (target !== 'group') this.agent(target);
    this.chat(chatId).target = target;
    this.changed();
  }

  renameChat(chatId: string, title: string): void {
    this.chat(chatId).title = title.trim() || 'Untitled';
    this.changed();
  }

  deleteChat(chatId: string): void {
    this.stopChat(chatId);
    this.state.chats = this.state.chats.filter((c) => c.id !== chatId);
    this.state.messages = this.state.messages.filter((m) => m.chatId !== chatId);
    this.changed();
  }

  /** Stop everything in a chat: running turns, queued messages and pending asks. */
  stopChat(chatId: string): void {
    for (const [k, r] of this.running) {
      if (r.chatId !== chatId) continue;
      r.handle.cancel();
      this.running.delete(k);
      this.live.delete(k);
    }
    this.state.inbox = this.state.inbox.filter((i) => i.chatId !== chatId);
    for (const k of this.pending.keys()) if (k.startsWith(chatId + ':')) this.pending.delete(k);
    this.emitLive();
    this.changed();
    this.schedule();
  }

  private post(chatId: string, from: string, text: string, depth: number): Message {
    const chat = this.chat(chatId);
    // Keep timestamps strictly increasing within a chat so "seen until" works.
    const last = this.state.messages.findLast((m) => m.chatId === chatId);
    const ts = Math.max(Date.now(), (last?.ts ?? 0) + 1);
    const msg: Message = { id: randomUUID(), chatId, from, text, ts, depth };
    this.state.messages.push(msg);
    chat.updatedAt = ts;
    if (from !== USER_ID && from !== SYSTEM_ID) this.emit('message', msg);
    return msg;
  }

  private note(chatId: string, text: string): void {
    this.post(chatId, SYSTEM_ID, text, 0);
  }

  private folders(chat: Chat): string[] {
    return this.state.projects.find((p) => p.id === chat.projectId)?.folders ?? [];
  }

  /** @mention autocomplete: files in the chat's project. */
  searchFiles(chatId: string, query: string): { label: string; insert: string }[] {
    const folders = this.folders(this.chat(chatId));
    if (!folders.length) return [];
    return searchFiles(folders, query).map((h) => ({ label: h.label, insert: mentionToken(h.label) }));
  }

  userMessage(chatId: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const chat = this.chat(chatId);
    const folders = this.folders(chat);
    const files: string[] = [];
    const unknown: string[] = [];
    for (const tok of parseFileMentions(t)) {
      const abs = resolveMention(tok, folders);
      if (abs) files.push(abs);
      else unknown.push(tok);
    }
    const msg = this.post(chatId, USER_ID, t, 0);
    if (files.length) msg.files = [...new Set(files)];
    if (unknown.length) {
      this.note(chatId, `Couldn't find ${unknown.map((u) => `\`${u}\``).join(', ')}${folders.length ? ' in this project' : ''}, so ${unknown.length > 1 ? "they weren't" : "it wasn't"} attached.`);
    }
    if (chat.title === 'New chat') chat.title = t.replace(/\s+/g, ' ').slice(0, 48) + (t.length > 48 ? '…' : '');

    let to = mentionedAgents(this.state, t);
    if (!to.length) {
      const target = chat.target !== 'group' && this.state.agents.some((a) => a.id === chat.target) ? chat.target : this.lead()?.id;
      if (target) to = [target];
    }
    if (!to.length) this.note(chatId, 'Add an agent first: press **+** next to the agent tabs.');
    for (const agentId of to) this.state.inbox.push({ chatId, agentId, messageId: msg.id });
    this.changed();
    this.schedule();
  }

  updateSettings(patch: Partial<Settings>): void {
    const s = this.state.settings;
    Object.assign(s, patch);
    if (patch.paused === false) s.pauseReason = '';
    if (patch.paused === true && !patch.pauseReason) s.pauseReason = 'user';
    s.maxConcurrent = Math.max(1, Math.min(6, Number(s.maxConcurrent) || 1));
    s.maxDepth = Math.max(1, Math.min(30, Number(s.maxDepth) || 6));
    s.dailyTurnCap = Math.max(0, Number(s.dailyTurnCap) || 0);
    s.usagePauseAt = Math.max(0, Math.min(1, Number(s.usagePauseAt) || 0));
    this.changed();
    this.schedule();
  }

  // ---------------------------------------------------------------- scheduling

  private pause(reason: Settings['pauseReason']): void {
    this.state.settings.paused = true;
    this.state.settings.pauseReason = reason;
  }

  /** Lift automatic pauses whose cause has passed: a new day, or a reset usage window. */
  private autoResume(): void {
    const s = this.state.settings;
    const u = this.state.usage;
    if (u.day !== today()) {
      u.day = today();
      u.turnsToday = 0;
      if (s.paused && s.pauseReason === 'daily_cap') s.paused = false;
    }
    if (s.paused && s.pauseReason === 'usage_limit') {
      const resetsAt = (u.fiveHour?.resetsAt ?? 0) * 1000;
      if (resetsAt && Date.now() > resetsAt) {
        s.paused = false;
        u.fiveHour = { utilization: 0, resetsAt: 0 };
      }
    }
    if (!s.paused) s.pauseReason = '';
  }

  private blocked(chatId: string, agentId: string): boolean {
    return (this.pending.get(seatKey(chatId, agentId))?.size ?? 0) > 0;
  }

  schedule(): void {
    this.autoResume();
    const s = this.state.settings;
    if (s.paused) return void this.emit('state', this.state);
    const seen = new Set<string>();
    for (const item of [...this.state.inbox]) {
      if (this.running.size >= s.maxConcurrent) break;
      const k = seatKey(item.chatId, item.agentId);
      if (seen.has(k)) continue;
      seen.add(k);
      if (this.running.has(k) || this.blocked(item.chatId, item.agentId)) continue;
      if (s.dailyTurnCap && this.state.usage.turnsToday >= s.dailyTurnCap) {
        this.pause('daily_cap');
        this.note(item.chatId, `Paused: the team has used today's limit of ${s.dailyTurnCap} turns. It resumes tomorrow, or you can raise the limit in Settings and press Resume.`);
        this.changed();
        return;
      }
      this.startTurn(item.chatId, item.agentId);
    }
  }

  private seat(chat: Chat, agentId: string): Seat {
    return (chat.seats[agentId] ??= { sessionId: randomUUID(), started: false, seenUntil: 0, teamVersion: this.state.teamVersion });
  }

  private startTurn(chatId: string, agentId: string, retried = false): void {
    const chat = this.chat(chatId);
    const agent = this.agent(agentId);
    const k = seatKey(chatId, agentId);
    const items = this.state.inbox.filter((i) => i.chatId === chatId && i.agentId === agentId);
    this.state.inbox = this.state.inbox.filter((i) => !(i.chatId === chatId && i.agentId === agentId));
    const triggers = items
      .map((i) => this.state.messages.find((m) => m.id === i.messageId))
      .filter((m): m is Message => Boolean(m));
    if (!triggers.length) return this.changed();

    const seat = this.seat(chat, agentId);
    const chatMsgs = this.state.messages.filter((m) => m.chatId === chatId);
    const unseen = chatMsgs.filter((m) => m.ts > seat.seenUntil);
    const teamChanged = seat.started && seat.teamVersion !== this.state.teamVersion;
    seat.seenUntil = chatMsgs.at(-1)?.ts ?? seat.seenUntil;
    seat.teamVersion = this.state.teamVersion;

    const depth = triggers.reduce((d, m) => Math.max(d, m.depth), 0);
    const askers = [...new Set(items.map((i) => i.askedBy).filter((x): x is string => Boolean(x)))];
    const settings = this.state.settings;

    const project = this.state.projects.find((p) => p.id === chat.projectId);
    let ctx: ProjectContext | undefined;
    let cwd = settings.workspaceDir;
    if (project) {
      const missing = project.folders.filter((f) => !fs.existsSync(f));
      if (missing.length) {
        this.note(chatId, `Can't find ${missing.join(', ')}. Re-attach the folder in the project settings, then send your message again.`);
        this.release(chatId, agentId, askers, null);
        this.changed();
        return;
      }
      const canEdit = agent.capability === 'files' || agent.capability === 'full';
      const canRead = canEdit || project.readAccess === 'all' || (project.readAccess === 'lead' && agent.isLead);
      ctx = { project, canRead, canEdit };
      if (project.folders[0]) cwd = project.folders[0];
    }
    const projectChanged = Boolean(ctx) && seat.started && seat.projectVersion !== project!.version;
    if (project) seat.projectVersion = project.version;
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
      /* the CLI reports it if it matters */
    }
    if (!retried) this.state.usage.turnsToday++;

    this.live.set(k, { chatId, agentId, step: '', since: Date.now() });
    this.emitLive();
    const handle = this.runner.run(
      {
        claudePath: settings.claudePath || this.env.claudePath,
        cwd,
        env: this.env.childEnv(),
        sessionId: seat.sessionId,
        resume: seat.started,
        systemPrompt: systemPrompt(this.state, agent, cwd, ctx),
        prompt: turnPrompt(this.state, agent, unseen, triggers.map((m) => m.from), teamChanged, projectChanged ? ctx : undefined, this.attachments(unseen, agent.id, project?.folders ?? [])),
        model: agent.model,
        capability: agent.capability,
        readFiles: Boolean(ctx?.canRead && !ctx.canEdit),
        addDirs: project?.folders.slice(1),
        lean: settings.leanMode,
      },
      {
        onEvent: (e) => {
          const l = this.live.get(k);
          if (l && e.kind === 'tool') {
            l.step = e.text;
            this.emitLive();
          }
        },
        onUsage: (u) => this.recordUsage(u),
      },
    );
    this.running.set(k, { handle, chatId, agentId });
    this.changed();

    handle.done.then((res) => {
      // Stopped, deleted or removed while running: nothing more to do.
      if (this.running.get(k)?.handle !== handle) return;
      this.running.delete(k);
      this.live.delete(k);
      this.emitLive();
      const a = this.state.agents.find((x) => x.id === agentId);
      const c = this.state.chats.find((x) => x.id === chatId);
      if (!a || !c) return this.schedule();
      a.turns++;
      a.costUsd += res.costUsd;

      if (res.ok) {
        seat.started = true;
        const text = res.text.trim() || (askers.length ? '_(no answer)_' : '');
        if (text) this.afterReply(c, a, this.post(chatId, a.id, text, depth + 1), askers);
      } else if (res.sessionMissing && seat.started && !retried) {
        seat.sessionId = randomUUID();
        seat.started = false;
        seat.seenUntil = 0;
        this.state.inbox.unshift(...items);
        return this.startTurn(chatId, agentId, true);
      } else if (USAGE_ERROR.test(res.error ?? '')) {
        // Keep the messages and wait for the usage window to reset.
        this.state.inbox.unshift(...items);
        this.pause('usage_limit');
        this.note(chatId, `Paused: Claude reported a usage limit. The team picks up where it left off when you press Resume.\n\n> ${(res.error ?? '').slice(0, 300)}`);
      } else {
        this.note(chatId, `${a.name} hit an error:\n\n\`\`\`\n${(res.error ?? 'Unknown error').slice(0, 800)}\n\`\`\``);
        this.release(chatId, a.id, askers, null);
      }
      this.changed();
      this.schedule();
    });
  }

  /** Read @mentioned files for the messages this agent is about to see, within the per-turn budget. */
  private attachments(unseen: Message[], agentId: string, folders: string[]): Map<string, FileContent[]> {
    const out = new Map<string, FileContent[]>();
    let budget = TURN_FILE_CHARS;
    // Newest first, so the message that woke the agent gets its files even if the budget runs out.
    for (const m of [...unseen].reverse()) {
      if (!m.files?.length || m.from === agentId) continue;
      const list: FileContent[] = [];
      for (const abs of m.files) {
        const label = displayLabel(abs, folders);
        if (budget <= 0) {
          list.push({ label, text: '', truncated: true, binary: false, missing: false });
          continue;
        }
        const f = readForPrompt(abs, label, Math.min(FILE_CHARS, budget));
        budget -= f.text.length;
        list.push(f);
      }
      out.set(m.id, list);
    }
    return out;
  }

  /** Route an agent's reply: wake anyone it @mentioned, and hand the answer back to whoever asked. */
  private afterReply(chat: Chat, agent: Agent, reply: Message, askers: string[]): void {
    const mentions = mentionedAgents(this.state, reply.text, agent.id);
    if (mentions.length) {
      if (reply.depth > this.state.settings.maxDepth) {
        this.note(chat.id, `Loop limit reached (${this.state.settings.maxDepth} hops between agents), so the team is waiting for you.`);
      } else {
        const k = seatKey(chat.id, agent.id);
        const set = this.pending.get(k) ?? new Set<string>();
        for (const m of mentions) {
          set.add(m);
          this.state.inbox.push({ chatId: chat.id, agentId: m, messageId: reply.id, askedBy: agent.id });
        }
        this.pending.set(k, set);
      }
    }
    this.release(chat.id, agent.id, askers.filter((x) => !mentions.includes(x)), reply);
    // Askers that were @mentioned back already have the reply queued; just clear the wait.
    for (const asker of askers.filter((x) => mentions.includes(x))) this.pending.get(seatKey(chat.id, asker))?.delete(agent.id);
  }

  /** `agentId` has answered (or failed) for each asker: stop waiting and deliver the answer. */
  private release(chatId: string, agentId: string, askers: string[], answer: Message | null): void {
    for (const asker of askers) {
      if (!this.state.agents.some((a) => a.id === asker)) continue;
      this.pending.get(seatKey(chatId, asker))?.delete(agentId);
      const messageId = answer?.id ?? this.state.messages.findLast((m) => m.chatId === chatId)?.id;
      if (messageId) this.state.inbox.push({ chatId, agentId: asker, messageId });
    }
  }

  private recordUsage(u: { fiveHour?: AppState['usage']['fiveHour']; sevenDay?: AppState['usage']['sevenDay'] }): void {
    const usage = this.state.usage;
    if (u.fiveHour) usage.fiveHour = u.fiveHour;
    if (u.sevenDay) usage.sevenDay = u.sevenDay;
    usage.updatedAt = Date.now();
    const s = this.state.settings;
    if (s.usagePauseAt && !s.paused && (usage.fiveHour?.utilization ?? 0) >= s.usagePauseAt) {
      this.pause('usage_limit');
    }
    this.changed();
  }

  /** For tests. */
  pendingFor(chatId: string, agentId: string): string[] {
    return [...(this.pending.get(seatKey(chatId, agentId)) ?? [])];
  }

  inboxFor(chatId: string): InboxItem[] {
    return this.state.inbox.filter((i) => i.chatId === chatId);
  }
}
