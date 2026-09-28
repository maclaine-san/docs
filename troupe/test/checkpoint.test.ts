import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changesSince, createCheckpoint, isGitRepo, restoreCheckpoint } from '../src/core/checkpoint';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-cp-'));
  git(d, 'init', '-q');
  fs.writeFileSync(path.join(d, '.gitignore'), 'secret.env\n');
  fs.writeFileSync(path.join(d, 'a.txt'), 'A1\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'B1\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  // Uncommitted work of the user's: an edit, a staged file and an untracked file.
  fs.writeFileSync(path.join(d, 'a.txt'), 'A2 (user edit)\n');
  fs.writeFileSync(path.join(d, 'staged.txt'), 'S\n');
  git(d, 'add', 'staged.txt');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'user notes\n');
  fs.writeFileSync(path.join(d, 'secret.env'), 'KEY=1\n');
  return d;
}

test('checkpoint, measure and undo agent edits without touching branch or staging', () => {
  const d = repo();
  const head = git(d, 'rev-parse', 'HEAD');
  const staged = git(d, 'diff', '--cached', '--name-only');
  const sha = createCheckpoint(d, 'test')!;
  assert.ok(sha);
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
  assert.equal(git(d, 'diff', '--cached', '--name-only'), staged, 'staging unchanged');
  assert.equal(git(d, 'status', '--porcelain').includes('troupe'), false);

  // The "agent" edits, deletes and creates files.
  fs.writeFileSync(path.join(d, 'a.txt'), 'A3 (agent)\n');
  fs.rmSync(path.join(d, 'b.txt'));
  fs.writeFileSync(path.join(d, 'new.txt'), 'agent file\n');
  fs.writeFileSync(path.join(d, 'secret.env'), 'KEY=2\n');
  const st = changesSince(d, sha);
  assert.deepEqual(st.names.sort(), ['a.txt', 'b.txt', 'new.txt']);
  assert.equal(st.files, 3);

  restoreCheckpoint(d, sha);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'A2 (user edit)\n', "user's uncommitted edit is back");
  assert.equal(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'B1\n', 'deleted file restored');
  assert.equal(fs.existsSync(path.join(d, 'new.txt')), false, 'agent-created file removed');
  assert.equal(fs.readFileSync(path.join(d, 'notes.txt'), 'utf8'), 'user notes\n', 'untracked user file kept');
  assert.equal(fs.readFileSync(path.join(d, 'secret.env'), 'utf8'), 'KEY=2\n', 'ignored files are never touched');
  assert.equal(git(d, 'rev-parse', 'HEAD'), head);
  assert.equal(git(d, 'diff', '--cached', '--name-only'), staged);
  assert.equal(changesSince(d, sha).files, 0);
});

test('works in a repo with no commits, and skips non-repos and subfolders', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-cp0-'));
  git(d, 'init', '-q');
  fs.writeFileSync(path.join(d, 'x.txt'), 'x');
  const sha = createCheckpoint(d, 'empty')!;
  fs.writeFileSync(path.join(d, 'x.txt'), 'changed');
  restoreCheckpoint(d, sha);
  assert.equal(fs.readFileSync(path.join(d, 'x.txt'), 'utf8'), 'x');

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-plain-'));
  assert.equal(createCheckpoint(plain, 'x'), null);
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal(isGitRepo(path.join(d, 'sub')), false);
});
