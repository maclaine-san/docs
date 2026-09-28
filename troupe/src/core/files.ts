// @file mentions: find files in a project's folders and inline their contents
// into the message that mentions them, so agents don't need file tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'target', 'Pods', 'DerivedData', '.DS_Store', 'coverage', '.turbo',
]);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;

/** Per-file and per-turn caps on inlined text, in characters (~4 chars per token). */
export const FILE_CHARS = 30_000;
export const TURN_FILE_CHARS = 60_000;

export interface FileHit {
  /** What the user sees, and what gets inserted after "@". */
  label: string;
  abs: string;
}

const cache = new Map<string, { at: number; files: string[] }>();

/** Relative paths of the files under `root` (cached briefly, since this runs per keystroke). */
function walk(root: string): string[] {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 10_000) return hit.files;
  const files: string[] = [];
  const queue: [string, number][] = [[root, 0]];
  while (queue.length && files.length < MAX_FILES) {
    const [dir, depth] = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) queue.push([abs, depth + 1]);
      } else if (e.isFile()) {
        files.push(path.relative(root, abs));
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  cache.set(root, { at: Date.now(), files });
  return files;
}

/** The label for a file in a project: relative to its folder, prefixed with the folder name for extra folders. */
function labelFor(folders: string[], i: number, rel: string): string {
  return i === 0 ? rel : `${path.basename(folders[i])}/${rel}`;
}

/** Best matches for `query` across the project's folders. */
export function searchFiles(folders: string[], query: string, limit = 8): FileHit[] {
  const q = query.toLowerCase();
  const scored: { hit: FileHit; score: number }[] = [];
  folders.forEach((root, i) => {
    for (const rel of walk(root)) {
      const label = labelFor(folders, i, rel);
      const l = label.toLowerCase();
      const base = path.basename(l);
      let score = -1;
      if (!q) score = 10 - Math.min(9, l.split('/').length);
      else if (base.startsWith(q)) score = 100 - base.length / 100;
      else if (base.includes(q)) score = 80;
      else if (l.includes(q)) score = 60;
      else if (isSubsequence(q, l)) score = 20;
      if (score >= 0) scored.push({ hit: { label, abs: path.join(root, rel) }, score: score - l.length / 1000 });
    }
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.hit);
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

/** Text to insert after "@" for a path (quoted if it contains spaces). */
export function mentionToken(label: string): string {
  return /\s/.test(label) ? `"${label}"` : label;
}

/**
 * File references in a message: `@"any path"`, or `@token` where the token
 * looks like a path (contains "/" or a file extension). Agent names never do.
 */
export function parseFileMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[\s(])@(?:"([^"\n]+)"|([\w~./-]+))/g)) {
    let tok = m[2] ?? m[3];
    if (!m[2]) {
      tok = tok.replace(/[.,;:!?)]+$/, '');
      if (!tok.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(tok)) continue;
    }
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a mention to an absolute path. Relative paths must stay inside the
 * project's folders; absolute paths are allowed because the user typed or dropped them.
 */
export function resolveMention(token: string, folders: string[]): string | null {
  if (token.startsWith('~/')) token = path.join(os.homedir(), token.slice(2));
  if (path.isAbsolute(token)) return isFile(token) ? path.normalize(token) : null;
  for (let i = 0; i < folders.length; i++) {
    const root = folders[i];
    const candidates = [path.resolve(root, token)];
    const prefix = path.basename(root) + '/';
    if (i > 0 && token.startsWith(prefix)) candidates.unshift(path.resolve(root, token.slice(prefix.length)));
    for (const c of candidates) if (inside(root, c) && isFile(c)) return c;
  }
  return null;
}

export interface FileContent {
  label: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  missing: boolean;
}

/** Read a file for the prompt, capped at `maxChars`. */
export function readForPrompt(abs: string, label: string, maxChars = FILE_CHARS): FileContent {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(maxChars * 2 + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, Math.min(n, 8000));
    if (head.includes(0)) return { label, text: '', truncated: false, binary: true, missing: false };
    let text = buf.subarray(0, n).toString('utf8');
    const truncated = text.length > maxChars || n === buf.length;
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { label, text, truncated, binary: false, missing: false };
  } catch {
    return { label, text: '', truncated: false, binary: false, missing: true };
  }
}

/** Label to show for an absolute path: relative to the project when inside it. */
export function displayLabel(abs: string, folders: string[]): string {
  for (let i = 0; i < folders.length; i++) if (inside(folders[i], abs)) return labelFor(folders, i, path.relative(folders[i], abs));
  return abs.startsWith(os.homedir() + path.sep) ? '~/' + path.relative(os.homedir(), abs) : abs;
}

export function formatFile(f: FileContent): string {
  if (f.missing) return `<file path="${f.label}" note="file no longer exists"/>`;
  if (f.binary) return `<file path="${f.label}" note="binary file, not included"/>`;
  return `<file path="${f.label}"${f.truncated ? ' note="truncated"' : ''}>\n${f.text}\n</file>`;
}
