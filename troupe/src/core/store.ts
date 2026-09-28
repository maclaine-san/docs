import fs from 'node:fs';
import path from 'node:path';
import type { AppState, Settings } from '../shared/types';

/** Messages kept per chat on disk. Older ones are dropped. */
const MAX_MESSAGES_PER_CHAT = 1000;

export function defaultSettings(dataDir: string): Settings {
  return {
    claudePath: '',
    workspaceDir: path.join(dataDir, 'workspace'),
    maxConcurrent: 2,
    maxDepth: 6,
    forceSubscription: true,
    leanMode: true,
    dailyTurnCap: 150,
    usagePauseAt: 0.8,
    paused: false,
    pauseReason: '',
    quickShortcut: 'Alt+Space',
    notifications: true,
    checkpoints: true,
    theme: 'system',
  };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyState(dataDir: string): AppState {
  return {
    version: 2,
    settings: defaultSettings(dataDir),
    agents: [],
    projects: [],
    chats: [],
    messages: [],
    inbox: [],
    usage: { day: today(), turnsToday: 0, updatedAt: 0 },
    teamVersion: 1,
  };
}

/** A JSON-file store with debounced, atomic writes. */
export class Store {
  state: AppState;
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.load();
  }

  private load(): AppState {
    const fresh = emptyState(this.dataDir);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.version !== 2) return fresh; // pre-release format: start over
      for (const c of raw.chats ?? []) c.projectId ??= '';
      return { ...fresh, ...raw, settings: { ...fresh.settings, ...raw.settings }, usage: { ...fresh.usage, ...raw.usage } };
    } catch {
      return fresh;
    }
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.trim();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  private trim(): void {
    const counts = new Map<string, number>();
    const keep: typeof this.state.messages = [];
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const m = this.state.messages[i];
      const n = (counts.get(m.chatId) ?? 0) + 1;
      counts.set(m.chatId, n);
      if (n <= MAX_MESSAGES_PER_CHAT) keep.push(m);
    }
    if (keep.length !== this.state.messages.length) this.state.messages = keep.reverse();
  }
}
