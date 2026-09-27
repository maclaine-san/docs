import fs from 'node:fs';
import path from 'node:path';
import type { AppState, Settings } from '../shared/types';

/** Messages kept per channel on disk. Older ones are dropped. */
const MAX_MESSAGES_PER_CHANNEL = 2000;

export function defaultSettings(dataDir: string): Settings {
  return {
    claudePath: '',
    workspaceDir: path.join(dataDir, 'workspace'),
    maxConcurrent: 2,
    maxDepth: 8,
    forceSubscription: true,
    paused: false,
    defaultModel: 'sonnet',
  };
}

export function emptyState(dataDir: string): AppState {
  return {
    version: 1,
    settings: defaultSettings(dataDir),
    agents: [],
    channels: [],
    messages: [],
    tasks: [],
    inbox: [],
    nextTaskNumber: 1,
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
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AppState;
      const state: AppState = { ...fresh, ...raw, settings: { ...fresh.settings, ...raw.settings } };
      // Nothing is running after a restart.
      for (const a of state.agents) if (a.status === 'working' || a.status === 'queued') a.status = 'idle';
      return state;
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
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  private trim(): void {
    const counts = new Map<string, number>();
    const keep: typeof this.state.messages = [];
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const m = this.state.messages[i];
      const n = (counts.get(m.channelId) ?? 0) + 1;
      counts.set(m.channelId, n);
      if (n <= MAX_MESSAGES_PER_CHANNEL) keep.push(m);
    }
    if (keep.length !== this.state.messages.length) this.state.messages = keep.reverse();
  }
}
