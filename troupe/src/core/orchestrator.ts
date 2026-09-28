import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { ActivityRow, ActivityView, Agent, AgentDraft, AppState, Chat, InboxItem, LiveStatus, Message, Project, ProjectPatch, Seat, Settings } from '../shared/types';
import path from 'node:path';
import { USER_ID, SYSTEM_ID, canEditFiles } from '../shared/types';
import { today, type Store } from './store';
import type { Runner, TurnHandle } from './claudeRunner';
import { handOffs, mentionedAgents, systemPrompt, turnPrompt, type ProjectContext } from './prompts';
import { changesSince, createCheckpoint, restoreCheckpoint } from './checkpoint';
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
  /** Folders this turn may edit. Only one editing turn per folder runs at a time. */
  editFolders: string[];
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

  updateProject(id: string, patch: ProjectPatch): void {
    const p = this.project(id);
    if (patch.paused !== undefined) {
      p.paused = patch.paused;
      p.pauseReason = patch.paused ? 'user' : '';
    }
    if (patch.dailyTurnCap !== undefined) {
      p.dailyTurnCap = Math.max(0, Math.floor(Number(patch.dailyTurnCap) || 0));
      // Raising the limit past today's usage lifts a cap pause.
      if (p.pauseReason === 'daily_cap' && (!p.dailyTurnCap || this.projectTurns(p.id) < p.dailyTurnCap)) {
        p.paused = false;
        p.pauseReason = '';
      }
    }
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.folders !== undefined) p.folders = this.checkFolders(patch.folders);
    if (patch.instructions !== undefined) p.instructions = patch.instructions;
    if (patch.readAccess !== undefined) p.readAccess = patch.readAccess;
    if (patch.folders !== undefined || patch.instructions !== undefined || patch.readAccess !== undefined) p.version++;
    p.updatedAt = Date.now();
    this.changed();
    this.schedule();
  }

  private projectTurns(projectId: string): number {
    return this.state.usage.projectTurns?.[projectId] ?? 0;
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
      u.projectTurns = {};
      u.projectCost = {};
      for (const p of this.state.projects) {
        if (p.paused && p.pauseReason === 'daily_cap') {
          p.paused = false;
          p.pauseReason = '';
        }
      }
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

  /** Folders an agent's turn in this chat may edit (empty if it can't edit files). */
  private editFoldersFor(chat: Chat, agent: Agent): string[] {
    if (!canEditFiles(agent.capability)) return [];
    const project = this.state.projects.find((p) => p.id === chat.projectId);
    return project?.folders.length ? project.folders : [this.state.settings.workspaceDir];
  }

  /** Why a queued agent can't start yet, or "" if it can (apart from free slots and caps). */
  private whyWaiting(chatId: string, agentId: string): string {
    const chat = this.state.chats.find((c) => c.id === chatId);
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!chat || !agent) return 'Gone';
    if (this.running.has(seatKey(chatId, agentId))) return 'Finishing its current turn in this chat';
    const project = this.state.projects.find((p) => p.id === chat.projectId);
    if (project?.paused) return project.pauseReason === 'daily_cap' ? `Project paused: daily limit of ${project.dailyTurnCap} turns used` : 'Project paused';
    const waitingOn = [...(this.pending.get(seatKey(chatId, agentId)) ?? [])];
    if (waitingOn.length) {
      return `Waiting for ${waitingOn.map((id) => this.state.agents.find((a) => a.id === id)?.name ?? 'a teammate').join(' and ')} to answer`;
    }
    const folders = this.editFoldersFor(chat, agent);
    if (folders.length) {
      for (const r of this.running.values()) {
        if (!r.editFolders.some((f) => folders.includes(f))) continue;
        const who = this.state.agents.find((a) => a.id === r.agentId)?.name ?? 'Another agent';
        const where = this.state.chats.find((c) => c.id === r.chatId)?.title ?? 'another chat';
        return `Waiting: ${who} is editing the same folder (in "${where}")`;
      }
    }
    return '';
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
      if (this.whyWaiting(item.chatId, item.agentId)) continue;
      const chat = this.state.chats.find((c) => c.id === item.chatId)!;
      const project = this.state.projects.find((p) => p.id === chat.projectId);
      if (project?.dailyTurnCap && this.projectTurns(project.id) >= project.dailyTurnCap) {
        project.paused = true;
        project.pauseReason = 'daily_cap';
        this.note(item.chatId, `Paused **${project.name}**: it has used its daily limit of ${project.dailyTurnCap} turns. Other projects keep going. Raise the limit or resume it on the project page.`);
        this.changed();
        continue;
      }
      if (s.dailyTurnCap && this.state.usage.turnsToday >= s.dailyTurnCap) {
        this.pause('daily_cap');
        this.note(item.chatId, `Paused: the team has used today's limit of ${s.dailyTurnCap} turns. It resumes tomorrow, or you can raise the limit in Settings and press Resume.`);
        this.changed();
        return;
      }
      this.startTurn(item.chatId, item.agentId);
    }
  }

  /** What's running and waiting across all chats, and today's usage per project. */
  activityView(): ActivityView {
    const running: ActivityRow[] = [...this.running.entries()].map(([k, r]) => ({
      chatId: r.chatId,
      agentId: r.agentId,
      projectId: this.state.chats.find((c) => c.id === r.chatId)?.projectId ?? '',
      detail: this.live.get(k)?.step || 'Thinking',
      since: this.live.get(k)?.since ?? Date.now(),
    }));
    const queued: ActivityRow[] = [];
    const seen = new Set<string>();
    for (const i of this.state.inbox) {
      const k = seatKey(i.chatId, i.agentId);
      if (seen.has(k)) continue;
      seen.add(k);
      const msg = this.state.messages.find((m) => m.id === i.messageId);
      const s = this.state.settings;
      const detail =
        (s.paused ? 'Team paused' : '') ||
        this.whyWaiting(i.chatId, i.agentId) ||
        (this.running.size >= s.maxConcurrent ? `Waiting for a free slot (${s.maxConcurrent} agents at once)` : 'Starting…');
      queued.push({ chatId: i.chatId, agentId: i.agentId, projectId: this.state.chats.find((c) => c.id === i.chatId)?.projectId ?? '', detail, since: msg?.ts ?? Date.now() });
    }
    const u = this.state.usage;
    const projects = [
      ...this.state.projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        turnsToday: u.projectTurns?.[p.id] ?? 0,
        costToday: u.projectCost?.[p.id] ?? 0,
        cap: p.dailyTurnCap ?? 0,
        paused: Boolean(p.paused),
        pauseReason: p.pauseReason ?? '',
      })),
      { projectId: '', name: 'Other chats', turnsToday: u.projectTurns?.[''] ?? 0, costToday: u.projectCost?.[''] ?? 0, cap: 0, paused: false, pauseReason: '' },
    ];
    return { running, queued, projects };
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
    this.checkpointBeforeEdits(chat, agent);
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
      const canEdit = canEditFiles(agent.capability);
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
    if (!retried) {
      this.state.usage.turnsToday++;
      const pt = (this.state.usage.projectTurns ??= {});
      pt[chat.projectId] = (pt[chat.projectId] ?? 0) + 1;
    }
    const editFolders = this.editFoldersFor(chat, agent);

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
    this.running.set(k, { handle, chatId, agentId, editFolders });
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
      const pc = (this.state.usage.projectCost ??= {});
      pc[c.projectId] = (pc[c.projectId] ?? 0) + res.costUsd;
      if (editFolders.length) {
        c.editedFolders ??= {};
        for (const f of editFolders) c.editedFolders[f] = Date.now();
        this.refreshAllCheckpointNotes(editFolders);
      }

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

  // ---------------------------------------------------------------- checkpoints

  /** Before an agent that can edit files first works in a project chat, snapshot each git folder. */
  private checkpointBeforeEdits(chat: Chat, agent: Agent): void {
    const project = this.state.projects.find((p) => p.id === chat.projectId);
    if (!project || !this.state.settings.checkpoints || !canEditFiles(agent.capability)) return;
    const done = (chat.checkpointed ??= []);
    for (const folder of project.folders) {
      if (done.includes(folder)) continue;
      done.push(folder);
      let sha: string | null = null;
      try {
        sha = createCheckpoint(folder, chat.title);
      } catch (e) {
        this.note(chat.id, `Couldn't save a checkpoint of \`${path.basename(folder)}\`: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      if (!sha) {
        this.note(chat.id, `\`${path.basename(folder)}\` isn't the root of a git repository, so there's no checkpoint to undo ${agent.name}'s edits. Run \`git init\` there to enable it.`);
        continue;
      }
      const msg = this.post(chat.id, SYSTEM_ID, this.checkpointText(folder, 0, 0, 0), 0);
      msg.checkpoint = { folder, sha, files: 0 };
    }
  }

  private checkpointText(folder: string, files: number, plus: number, minus: number): string {
    const name = `\`${path.basename(folder)}\``;
    return files
      ? `📌 Checkpoint of ${name} saved before agents edited it. Since then: **${files} file${files === 1 ? '' : 's'} changed** (+${plus} −${minus}).`
      : `📌 Checkpoint of ${name} saved before agents edit it. You can undo their changes from here.`;
  }

  /** Update checkpoint notes (in every chat) for these folders with what has changed since. */
  private refreshAllCheckpointNotes(folders: string[]): void {
    for (const m of this.state.messages) {
      if (!m.checkpoint || !folders.includes(m.checkpoint.folder)) continue;
      try {
        const st = changesSince(m.checkpoint.folder, m.checkpoint.sha);
        m.checkpoint.files = st.files;
        m.text = this.checkpointText(m.checkpoint.folder, st.files, st.insertions, st.deletions);
      } catch {
        /* folder moved or not a repo any more */
      }
    }
  }

  /** Other chats whose editing agents worked on this checkpoint's folder after it was saved. */
  checkpointConflicts(messageId: string): string[] {
    const m = this.state.messages.find((x) => x.id === messageId);
    if (!m?.checkpoint) return [];
    const folder = m.checkpoint.folder;
    return this.state.chats
      .filter((c) => c.id !== m.chatId && (c.editedFolders?.[folder] ?? 0) > m.ts)
      .map((c) => c.title);
  }

  /** Undo: put the folder back to the checkpoint. Stops this chat, and anyone editing the folder, first. */
  restoreCheckpoint(messageId: string): void {
    const m = this.state.messages.find((x) => x.id === messageId);
    if (!m?.checkpoint) throw new UserError('That checkpoint no longer exists.');
    this.stopChat(m.chatId);
    for (const [k, r] of [...this.running]) {
      if (!r.editFolders.includes(m.checkpoint.folder)) continue;
      r.handle.cancel();
      this.running.delete(k);
      this.live.delete(k);
      this.note(r.chatId, `Stopped ${this.state.agents.find((a) => a.id === r.agentId)?.name ?? 'an agent'}: \`${path.basename(m.checkpoint.folder)}\` was rolled back from another chat.`);
    }
    this.emitLive();
    const st = restoreCheckpoint(m.checkpoint.folder, m.checkpoint.sha);
    this.refreshAllCheckpointNotes([m.checkpoint.folder]);
    // Visible to agents, so they know their earlier edits are gone.
    this.note(m.chatId, `↩︎ Undid all changes to \`${path.basename(m.checkpoint.folder)}\` since the checkpoint (${st.files} file${st.files === 1 ? '' : 's'}). Earlier edits in this chat no longer exist.`);
    this.changed();
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
    // "@Chief Done: …" to whoever asked is an answer, not a new request: deliver it, don't wait for a reply.
    const requests = handOffs(this.state, reply.text, agent.id).filter((id) => !askers.includes(id));
    if (requests.length) {
      if (reply.depth > this.state.settings.maxDepth) {
        this.note(chat.id, `Loop limit reached (${this.state.settings.maxDepth} hops between agents), so the team is waiting for you.`);
      } else {
        const k = seatKey(chat.id, agent.id);
        const set = this.pending.get(k) ?? new Set<string>();
        for (const m of requests) {
          set.add(m);
          this.state.inbox.push({ chatId: chat.id, agentId: m, messageId: reply.id, askedBy: agent.id });
        }
        this.pending.set(k, set);
      }
    }
    this.release(chat.id, agent.id, askers, reply);
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
