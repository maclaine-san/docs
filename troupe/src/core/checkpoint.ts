// Git checkpoints: snapshot a project folder before agents edit it, so the
// user can undo everything they changed. Snapshots are commits stored under
// refs/troupe/ and built with a throwaway index, so the user's branch,
// staging area and working tree are never touched when saving.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Troupe',
  GIT_AUTHOR_EMAIL: 'troupe@localhost',
  GIT_COMMITTER_NAME: 'Troupe',
  GIT_COMMITTER_EMAIL: 'troupe@localhost',
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...IDENTITY, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function isGitRepo(folder: string): boolean {
  try {
    return git(folder, ['rev-parse', '--show-toplevel']) === fs.realpathSync(folder);
  } catch {
    return false;
  }
}

/** Tree of the working directory as it is now (tracked + untracked, minus ignored files). */
function snapshotTree(folder: string): string {
  const index = path.join(os.tmpdir(), `troupe-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    // Start from a copy of the real index so only changed files are re-hashed.
    try {
      fs.copyFileSync(path.resolve(folder, git(folder, ['rev-parse', '--git-path', 'index'])), index);
    } catch {
      /* no index yet */
    }
    const env = { GIT_INDEX_FILE: index };
    git(folder, ['add', '-A', '.'], env);
    return git(folder, ['write-tree'], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Save the folder's current state. Returns the checkpoint commit, or null if the folder isn't a git repo root. */
export function createCheckpoint(folder: string, label: string): string | null {
  if (!isGitRepo(folder)) return null;
  const tree = snapshotTree(folder);
  let head = '';
  try {
    head = git(folder, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    /* no commits yet */
  }
  const sha = git(folder, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `Troupe checkpoint: ${label}`]);
  // Keep it reachable so git gc doesn't collect it.
  git(folder, ['update-ref', `refs/troupe/checkpoints/${sha}`, sha]);
  return sha;
}

export interface ChangeStat {
  files: number;
  insertions: number;
  deletions: number;
  names: string[];
}

/** What changed in the folder since the checkpoint. */
export function changesSince(folder: string, sha: string): ChangeStat {
  const now = snapshotTree(folder);
  const names = git(folder, ['diff', '--name-only', sha, now]).split('\n').filter(Boolean);
  const short = git(folder, ['diff', '--shortstat', sha, now]);
  const num = (re: RegExp) => Number(re.exec(short)?.[1] ?? 0);
  return { files: names.length, insertions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/), names };
}

/**
 * Put the folder back exactly as it was at the checkpoint: restore changed and
 * deleted files, remove files created since. Ignored files are left alone, and
 * so are your branch and staging area.
 */
export function restoreCheckpoint(folder: string, sha: string): ChangeStat {
  const changed = changesSince(folder, sha);
  const before = new Set(git(folder, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean));
  const index = path.join(os.tmpdir(), `troupe-restore-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(folder, ['read-tree', sha], env);
    git(folder, ['checkout-index', '-a', '-f'], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
  for (const name of changed.names) {
    if (before.has(name)) continue;
    fs.rmSync(path.join(folder, name), { force: true });
  }
  return changed;
}
