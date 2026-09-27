// Shared data model for the orchestrator, the Electron main process and the UI.

export const USER_ID = 'user';
export const SYSTEM_ID = 'system';

/** How much an agent is allowed to do on your machine. */
export type ToolPreset = 'chat' | 'research' | 'builder' | 'autonomous';

export type AgentStatus = 'idle' | 'queued' | 'working' | 'error';

export interface Agent {
  id: string;
  name: string;
  /** Short job title, e.g. "Engineering Lead". */
  role: string;
  /** What this agent owns and is accountable for. Free text. */
  responsibilities: string;
  /** Extra instructions appended to the agent's system prompt. */
  instructions: string;
  /** Claude model alias ("opus", "sonnet", "haiku", ...) or "" for the CLI default. */
  model: string;
  /** Agent id of this agent's manager, or "" if it reports to you. */
  reportsTo: string;
  tools: ToolPreset;
  /** Load the MCP servers from your own Claude Code config as well as Troupe's. */
  useMyMcpServers: boolean;
  /** Working directory override. Empty = the workspace directory. */
  cwd: string;
  /** Wake the agent every N minutes to check its tasks. 0 = off. */
  heartbeatMinutes: number;
  /** Claude Code session id backing this agent's memory. */
  sessionId: string;
  /** True once the session has had its first turn (so we resume instead of create). */
  sessionStarted: boolean;
  /** Bumped when role/responsibilities change so the next turn re-briefs the agent. */
  profileVersion: number;
  briefedProfileVersion: number;
  status: AgentStatus;
  lastError: string;
  lastHeartbeatAt: number;
  paused: boolean;
  createdAt: number;
  turns: number;
  costUsd: number;
}

export type ChannelKind = 'channel' | 'dm';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Participant ids: agent ids and/or USER_ID. */
  members: string[];
  topic: string;
  createdAt: number;
}

export interface Message {
  id: string;
  channelId: string;
  /** Agent id, USER_ID or SYSTEM_ID. */
  from: string;
  text: string;
  ts: number;
  /** Hops away from a human message. Used to stop runaway agent loops. */
  depth: number;
  taskId?: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string;
  createdBy: string;
  status: TaskStatus;
  result: string;
  createdAt: number;
  updatedAt: number;
}

/** A pending message waiting to be delivered to an agent on its next turn. */
export interface InboxItem {
  messageId: string;
  agentId: string;
}

export interface Settings {
  /** Absolute path to the claude CLI. Empty = auto-detect. */
  claudePath: string;
  /** Shared folder the team works in. */
  workspaceDir: string;
  /** How many agents may run at the same time. Keep low on a subscription. */
  maxConcurrent: number;
  /** Max hops of agent-to-agent messages after a human message. */
  maxDepth: number;
  /** Strip ANTHROPIC_API_KEY etc. so the CLI uses your subscription login. */
  forceSubscription: boolean;
  /** Global pause: nothing new starts while true. */
  paused: boolean;
  defaultModel: string;
}

export interface ActivityEntry {
  id: string;
  agentId: string;
  ts: number;
  kind: 'turn_start' | 'text' | 'tool' | 'tool_result' | 'turn_end' | 'error' | 'stderr';
  text: string;
}

export interface AppState {
  version: 1;
  settings: Settings;
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  tasks: Task[];
  inbox: InboxItem[];
  nextTaskNumber: number;
}

export type AgentDraft = Pick<
  Agent,
  | 'name'
  | 'role'
  | 'responsibilities'
  | 'instructions'
  | 'model'
  | 'reportsTo'
  | 'tools'
  | 'useMyMcpServers'
  | 'cwd'
  | 'heartbeatMinutes'
>;

/** The API the preload script exposes to the renderer as window.troupe. */
export interface TroupeApi {
  getState(): Promise<AppState>;
  getActivity(agentId: string): Promise<ActivityEntry[]>;
  onState(cb: (s: AppState) => void): () => void;
  onActivity(cb: (e: ActivityEntry) => void): () => void;
  hireAgent(draft: AgentDraft): Promise<Agent>;
  updateAgent(id: string, patch: Partial<AgentDraft> & { paused?: boolean }): Promise<void>;
  fireAgent(id: string): Promise<void>;
  resetAgentMemory(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  createChannel(name: string, memberIds: string[], topic: string): Promise<Channel>;
  updateChannel(id: string, patch: Partial<Pick<Channel, 'name' | 'members' | 'topic'>>): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  openDm(agentId: string): Promise<Channel>;
  sendMessage(channelId: string, text: string): Promise<void>;
  createTask(t: { title: string; description: string; assigneeId: string }): Promise<Task>;
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'title' | 'description' | 'assigneeId' | 'result'>>): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  checkClaude(): Promise<{ ok: boolean; path: string; version: string; error?: string }>;
  chooseDirectory(): Promise<string | null>;
  clearMessages(channelId: string): Promise<void>;
}
