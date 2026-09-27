import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolPreset } from '../shared/types';

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
  tools: ToolPreset;
  useMyMcpServers: boolean;
  mcpConfig: object;
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

/** Anything that can run one agent turn. The real one shells out to the claude CLI. */
export interface Runner {
  run(req: TurnRequest, onEvent: (e: TurnEvent) => void): TurnHandle;
}

const TROUPE_TOOLS = 'mcp__troupe';

/** Built-in Claude Code tools and auto-approved tools for each preset. */
export function toolArgs(preset: ToolPreset): string[] {
  switch (preset) {
    case 'chat':
      return ['--tools', '', '--allowedTools', TROUPE_TOOLS];
    case 'research':
      return [
        '--tools', 'WebSearch,WebFetch,Read,Glob,Grep',
        '--allowedTools', `${TROUPE_TOOLS},WebSearch,WebFetch,Read,Glob,Grep`,
      ];
    case 'builder':
      return [
        '--permission-mode', 'acceptEdits',
        '--allowedTools',
        [
          TROUPE_TOOLS, 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'TodoWrite',
          'Bash(ls:*)', 'Bash(cat:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
          'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)', 'Bash(python3:*)', 'Bash(mkdir:*)',
        ].join(','),
      ];
    case 'autonomous':
      return ['--dangerously-skip-permissions'];
  }
}

export function buildArgs(req: TurnRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push(...(req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId]));
  args.push('--append-system-prompt', req.systemPrompt);
  if (req.model) args.push('--model', req.model);
  args.push('--mcp-config', JSON.stringify(req.mcpConfig));
  if (!req.useMyMcpServers) args.push('--strict-mcp-config');
  args.push(...toolArgs(req.tools));
  return args;
}

function short(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Turn one stream-json line from the CLI into UI events, and pick out the final result. */
export function parseStreamLine(
  line: string,
  onEvent: (e: TurnEvent) => void,
): { result?: { text: string; isError: boolean; costUsd: number } } {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return {};
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) onEvent({ kind: 'text', text: block.text });
      if (block.type === 'tool_use') {
        const name = String(block.name ?? '').replace(/^mcp__troupe__/, '');
        onEvent({ kind: 'tool', text: `${name} ${short(JSON.stringify(block.input ?? {}), 300)}` });
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
  run(req: TurnRequest, onEvent: (e: TurnEvent) => void): TurnHandle {
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
          if (line) result = parseStreamLine(line, onEvent).result ?? result;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
      });
      child.on('error', (err) => resolve({ ok: false, text: '', costUsd: 0, error: `Could not start claude: ${err.message}` }));
      child.on('close', (code) => {
        if (buf.trim()) result = parseStreamLine(buf.trim(), onEvent).result ?? result;
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
