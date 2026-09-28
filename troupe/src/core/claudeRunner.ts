import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Capability, UsageWindow } from '../shared/types';

export interface TurnRequest {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  /** Resume an existing session rather than creating it. */
  resume: boolean;
  systemPrompt: string;
  prompt: string;
  model: string;
  capability: Capability;
  /** Also give read-only file tools (project chats). Adds ~2.6k tokens per turn. */
  readFiles?: boolean;
  /** Extra folders the agent may access besides cwd. */
  addDirs?: string[];
  /** Replace Claude Code's default system prompt and skip skills, settings files and MCP servers. */
  lean: boolean;
}

export interface TurnEvent {
  kind: 'text' | 'tool' | 'tool_result' | 'stderr';
  text: string;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  costUsd: number;
  error?: string;
  /** The session could not be resumed (e.g. deleted); the caller should start a new one. */
  sessionMissing?: boolean;
}

export interface TurnHandle {
  done: Promise<TurnResult>;
  cancel(): void;
}

export interface TurnCallbacks {
  onEvent(e: TurnEvent): void;
  /** Subscription usage reported by Claude Code (rate_limit_event). */
  onUsage?(u: { fiveHour?: UsageWindow; sevenDay?: UsageWindow }): void;
}

/** Anything that can run one agent turn. The real one shells out to the claude CLI. */
export interface Runner {
  run(req: TurnRequest, cb: TurnCallbacks): TurnHandle;
}

const WEB = ['WebSearch', 'WebFetch'];
const READ = ['Read', 'Glob', 'Grep'];
const FILES = [...READ, 'Edit', 'Write'];

/**
 * Shell commands a "code" agent may run: tests, builds and read-only git.
 * Anything else (rm, mv, curl, redirects, chained commands…) is refused by
 * Claude Code, since nobody is there to approve it.
 */
export const CODE_COMMANDS = [
  'npm test', 'npm run', 'pnpm test', 'pnpm run', 'yarn test', 'yarn run', 'bun test', 'bun run',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'go test', 'go build', 'go vet', 'cargo test', 'cargo build', 'cargo check',
  'git status', 'git diff', 'git log', 'git show', 'ls',
];

/**
 * Built-in Claude Code tools and auto-approved tools for each capability.
 * Uses the default permission mode everywhere: "acceptEdits" would also
 * auto-approve shell commands like rm and mv.
 */
export function toolArgs(cap: Capability, readFiles = false): string[] {
  const allow = (tools: string[], extra: string[] = []) =>
    tools.length ? ['--tools', tools.join(','), '--allowedTools', [...tools, ...extra].join(',')] : ['--tools', ''];
  const read = readFiles ? READ : [];
  switch (cap) {
    case 'chat':
      return allow(read);
    case 'web':
      return allow([...WEB, ...read]);
    case 'files':
      return allow([...FILES, ...WEB]);
    case 'code':
      return [
        '--tools', [...FILES, ...WEB, 'Bash'].join(','),
        '--allowedTools', [...FILES, ...WEB, ...CODE_COMMANDS.map((c) => `Bash(${c}:*)`)].join(','),
      ];
    case 'full':
      return ['--dangerously-skip-permissions'];
  }
}

export function buildArgs(req: TurnRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push(...(req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId]));
  if (req.lean) {
    // ~900 input tokens per chat turn instead of ~4,000.
    args.push('--system-prompt', req.systemPrompt, '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '');
  } else {
    args.push('--append-system-prompt', req.systemPrompt);
  }
  if (req.model) args.push('--model', req.model);
  args.push(...toolArgs(req.capability, req.readFiles));
  if (req.addDirs?.length) args.push('--add-dir', ...req.addDirs);
  return args;
}

function short(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** A human-readable one-liner for a tool call, e.g. "Searching the web: note apps". */
export function describeTool(name: string, input: any): string {
  const arg = (k: string) => (typeof input?.[k] === 'string' ? short(input[k], 80) : '');
  switch (name) {
    case 'WebSearch': return `Searching the web: ${arg('query')}`;
    case 'WebFetch': return `Reading ${arg('url')}`;
    case 'Read': return `Reading ${arg('file_path')}`;
    case 'Write': return `Writing ${arg('file_path')}`;
    case 'Edit': return `Editing ${arg('file_path')}`;
    case 'Glob': case 'Grep': return `Searching files: ${arg('pattern')}`;
    case 'Bash': return `Running ${arg('command')}`;
    default: return `Using ${name}`;
  }
}

/** Turn one stream-json line from the CLI into UI events, and pick out the final result. */
export function parseStreamLine(
  line: string,
  onEvent: (e: TurnEvent) => void,
  onUsage?: TurnCallbacks['onUsage'],
): { result?: { text: string; isError: boolean; costUsd: number } } {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return {};
  }
  if (msg.type === 'rate_limit_event') {
    const w = msg.rate_limit_info?.unifiedWindows ?? {};
    const win = (x: any): UsageWindow | undefined =>
      x && typeof x.utilization === 'number' ? { utilization: x.utilization > 1 ? x.utilization / 100 : x.utilization, resetsAt: Number(x.resetsAt) || 0 } : undefined;
    onUsage?.({ fiveHour: win(w.five_hour), sevenDay: win(w.seven_day) });
  } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) onEvent({ kind: 'text', text: block.text });
      if (block.type === 'tool_use') {
        onEvent({ kind: 'tool', text: describeTool(String(block.name ?? ''), block.input ?? {}) });
      }
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type !== 'tool_result') continue;
      const c = block.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? '').join('\n') : '';
      onEvent({ kind: 'tool_result', text: short(text, 300) });
    }
  } else if (msg.type === 'result') {
    return {
      result: {
        text: typeof msg.result === 'string' ? msg.result : '',
        isError: Boolean(msg.is_error) || (msg.subtype && msg.subtype !== 'success'),
        costUsd: Number(msg.total_cost_usd) || 0,
      },
    };
  }
  return {};
}

export class ClaudeCliRunner implements Runner {
  run(req: TurnRequest, cb: TurnCallbacks): TurnHandle {
    const { onEvent, onUsage } = cb;
    const child = spawn(req.claudePath, buildArgs(req), {
      cwd: req.cwd,
      env: req.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let cancelled = false;
    const done = new Promise<TurnResult>((resolve) => {
      let buf = '';
      let stderr = '';
      let result: { text: string; isError: boolean; costUsd: number } | undefined;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) result = parseStreamLine(line, onEvent, onUsage).result ?? result;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
      });
      child.on('error', (err) => resolve({ ok: false, text: '', costUsd: 0, error: `Could not start claude: ${err.message}` }));
      child.on('close', (code) => {
        if (buf.trim()) result = parseStreamLine(buf.trim(), onEvent, onUsage).result ?? result;
        if (cancelled) return resolve({ ok: false, text: '', costUsd: result?.costUsd ?? 0, error: 'Stopped' });
        if (result && !result.isError) return resolve({ ok: true, text: result.text, costUsd: result.costUsd });
        const detail = (result?.text || stderr.trim() || `claude exited with code ${code}`).slice(-2000);
        const sessionMissing = /no conversation found|session.*not found/i.test(detail);
        if (stderr.trim()) onEvent({ kind: 'stderr', text: short(stderr.trim(), 1000) });
        resolve({ ok: false, text: '', costUsd: result?.costUsd ?? 0, error: detail, sessionMissing });
      });
    });
    child.stdin.end(req.prompt);
    return {
      done,
      cancel() {
        cancelled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
      },
    };
  }
}

/**
 * Apps launched from Finder don't get your shell's PATH, so ask a login shell
 * for it. Returns the PATH to use for child processes.
 */
export async function loginShellPath(): Promise<string> {
  const current = process.env.PATH ?? '';
  if (process.platform === 'win32') return current;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const fromShell = await new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', 'printf "__TROUPE__%s__TROUPE__" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const m = /__TROUPE__(.*)__TROUPE__/.exec(stdout ?? '');
      resolve(err || !m ? '' : m[1]);
    });
  });
  const extra = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const parts = [...fromShell.split(':'), ...current.split(':'), ...extra].filter(Boolean);
  return [...new Set(parts)].join(':');
}

/** Find the claude CLI on the given PATH. */
export function findClaude(pathVar: string): string {
  for (const dir of pathVar.split(':')) {
    const p = path.join(dir, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

export function claudeVersion(claudePath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(claudePath, ['--version'], { env, timeout: 15000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
}

/** Environment for the CLI. With forceSubscription, API-key auth is removed so your Claude login is used. */
export function childEnv(pathVar: string, forceSubscription: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathVar };
  delete env.ELECTRON_RUN_AS_NODE;
  if (forceSubscription) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}
