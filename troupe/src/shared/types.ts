// Shared data model for the orchestrator, the Electron main process and the UI.

export const USER_ID = 'user';
export const SYSTEM_ID = 'system';

/**
 * What an agent may do beyond talking:
 * chat: nothing · web: search/fetch · files: read/edit files + web ·
 * code: files + web + a fixed list of test/build/git-read commands · full: anything, no checks.
 */
export type Capability = 'chat' | 'web' | 'files' | 'code' | 'full';

/** Capabilities that can change files. */
export function canEditFiles(c: Capability): boolean {
  return c === 'files' || c === 'code' || c === 'full';
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  /** Hue (0-360) for the agent's avatar and name colour. */
  hue: number;
  /** Who they are: role, personality, what they're good at. */
  persona: string;
  /** Claude model alias ("opus", "sonnet", "haiku", ...). */
  model: string;
  capability: Capability;
  /** The lead answers messages sent to the whole group and brings others in. */
  isLead: boolean;
  createdAt: number;
  turns: number;
  costUsd: number;
}

/** Who may read a project's folders. Agents with the "files" or "full" capability always can. */
export type ProjectReadAccess = 'lead' | 'all' | 'none';

export type ProjectPatch = Partial<Pick<Project, 'name' | 'folders' | 'instructions' | 'readAccess' | 'paused' | 'dailyTurnCap'>>;

/** A group of chats that share attached folders and instructions. */
export interface Project {
  id: string;
  name: string;
  /** Absolute paths. The first is the working directory; the rest are added with --add-dir. */
  folders: string[];
  /** Shared context every agent gets in this project's chats. */
  instructions: string;
  readAccess: ProjectReadAccess;
  /** Bumped when folders or instructions change, so open chats are re-briefed. */
  version: number;
  /** Nothing new starts in this project's chats while paused. */
  paused?: boolean;
  pauseReason?: '' | 'user' | 'daily_cap';
  /** Max agent turns per day in this project. 0 = no limit (the global cap still applies). */
  dailyTurnCap?: number;
  createdAt: number;
  updatedAt: number;
}

/** One agent's Claude Code session inside one chat. New chat = fresh, small context. */
export interface Seat {
  sessionId: string;
  started: boolean;
  /** Timestamp of the last chat message this agent has seen. */
  seenUntil: number;
  /** Team roster version the agent was last told about. */
  teamVersion: number;
  /** Project version the agent was last told about. */
  projectVersion?: number;
}

export interface Chat {
  id: string;
  title: string;
  /** Who your messages go to by default: "group" (the lead) or an agent id. */
  target: string;
  /** Project this chat belongs to, or "". */
  projectId: string;
  seats: Record<string, Seat>;
  /** Started from the menu-bar quick chat. */
  quick?: boolean;
  /** Folders already checkpointed (or found not to be git repos) in this chat. */
  checkpointed?: string[];
  /** Folder -> when an agent that can edit files last worked on it in this chat. */
  editedFolders?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  chatId: string;
  /** Agent id, USER_ID or SYSTEM_ID. */
  from: string;
  text: string;
  ts: number;
  /** Hops away from a human message. Used to stop runaway agent loops. */
  depth: number;
  /** Files @mentioned in the message (absolute paths). Their contents are inlined for agents. */
  files?: string[];
  /** A checkpoint note: the folder snapshot you can roll back to. Not shown to agents. */
  checkpoint?: { folder: string; sha: string; files: number };
}

/** A pending delivery: `agentId` should read `messageId` in `chatId` on its next turn. */
export interface InboxItem {
  chatId: string;
  agentId: string;
  messageId: string;
  /** Agent that @mentioned this agent and is waiting for the answer. */
  askedBy?: string;
}

export type PauseReason = '' | 'user' | 'daily_cap' | 'usage_limit';

export interface Settings {
  /** Absolute path to the claude CLI. Empty = auto-detect. */
  claudePath: string;
  /** Folder agents with file access work in. */
  workspaceDir: string;
  /** How many agents may run at the same time. */
  maxConcurrent: number;
  /** Max agent-to-agent hops after one message from you. */
  maxDepth: number;
  /** Strip ANTHROPIC_API_KEY etc. so the CLI uses your subscription login. */
  forceSubscription: boolean;
  /** Replace Claude Code's large default system prompt and skip skills, settings and MCP servers. */
  leanMode: boolean;
  /** Stop after this many agent turns per day. 0 = no cap. */
  dailyTurnCap: number;
  /** Pause when the 5-hour usage window reaches this fraction (0-1). 0 = never. */
  usagePauseAt: number;
  paused: boolean;
  pauseReason: PauseReason;
  /** Global shortcut for the menu-bar quick chat (Electron accelerator), "" = off. */
  quickShortcut: string;
  /** Notify when an agent replies while Troupe isn't in front. */
  notifications: boolean;
  /** Snapshot a project's git folder before agents first edit it in a chat, for one-click undo. */
  checkpoints: boolean;
}

export interface UsageWindow {
  /** 0-1 fraction of the window used, as reported by Claude Code. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
}

export interface Usage {
  day: string;
  turnsToday: number;
  /** Today's turns and API-equivalent cost per project id ("" = chats outside projects). */
  projectTurns?: Record<string, number>;
  projectCost?: Record<string, number>;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  updatedAt: number;
}

export interface AppState {
  version: 2;
  settings: Settings;
  agents: Agent[];
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  inbox: InboxItem[];
  usage: Usage;
  /** Bumped whenever agents are added, removed or renamed. */
  teamVersion: number;
}

/** What an agent is doing right now, for the "thinking…" line in a chat. */
export interface LiveStatus {
  chatId: string;
  agentId: string;
  /** Latest step, e.g. "Searching the web: note app users". Empty while thinking. */
  step: string;
  since: number;
}

/** One row of the Activity view: an agent working, or waiting, in a chat. */
export interface ActivityRow {
  chatId: string;
  agentId: string;
  projectId: string;
  /** Latest step while running; why it's waiting while queued. */
  detail: string;
  since: number;
}

export interface ProjectUsageRow {
  projectId: string;
  name: string;
  turnsToday: number;
  costToday: number;
  cap: number;
  paused: boolean;
  pauseReason: string;
}

export interface ActivityView {
  running: ActivityRow[];
  queued: ActivityRow[];
  projects: ProjectUsageRow[];
}

export type AgentDraft = Pick<Agent, 'name' | 'emoji' | 'hue' | 'persona' | 'model' | 'capability' | 'isLead'>;

/** The API the preload script exposes to the renderer as window.troupe. */
export interface TroupeApi {
  getState(): Promise<AppState>;
  getLive(): Promise<LiveStatus[]>;
  onState(cb: (s: AppState) => void): () => void;
  onLive(cb: (l: LiveStatus[]) => void): () => void;
  addAgent(draft: AgentDraft): Promise<Agent>;
  updateAgent(id: string, patch: Partial<AgentDraft>): Promise<void>;
  removeAgent(id: string): Promise<void>;
  newChat(target: string, projectId?: string, quick?: boolean): Promise<Chat>;
  /** Files matching `query` in the chat's project, for @mention autocomplete. */
  searchFiles(chatId: string, query: string): Promise<{ label: string; insert: string }[]>;
  moveChat(chatId: string, projectId: string): Promise<void>;
  createProject(name: string, folders: string[]): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch): Promise<void>;
  /** What's running and queued across all projects, and today's usage per project. */
  getActivityView(): Promise<ActivityView>;
  /** Titles of other chats whose agents may have edited this checkpoint's folder since it was saved. */
  checkpointConflicts(messageId: string): Promise<string[]>;
  deleteProject(id: string): Promise<void>;
  /** Pick folders with the system dialog. */
  chooseDirectories(): Promise<string[]>;
  /** Absolute path of a dropped file or folder. */
  pathForFile(file: File): string;
  showInFinder(path: string): Promise<void>;
  /** Show the main window on a chat (from the quick window or a notification). */
  openInMain(chatId: string): Promise<void>;
  hideQuick(): Promise<void>;
  /** Roll a folder back to the checkpoint in this note message. */
  restoreCheckpoint(messageId: string): Promise<void>;
  /** Whether the quick-chat shortcut is registered. */
  shortcutStatus(): Promise<{ accelerator: string; ok: boolean }>;
  /** Main window: open this chat. */
  onOpenChat(cb: (chatId: string) => void): () => void;
  /** Quick window: it was just shown, optionally for a specific chat. */
  onQuickShown(cb: (chatId: string) => void): () => void;
  setChatTarget(chatId: string, target: string): Promise<void>;
  renameChat(chatId: string, title: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  stopChat(chatId: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  checkClaude(): Promise<{ ok: boolean; path: string; version: string; error?: string }>;
  chooseDirectory(): Promise<string | null>;
}
