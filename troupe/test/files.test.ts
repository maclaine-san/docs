import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFileMentions, readForPrompt, resolveMention, searchFiles } from '../src/core/files';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-files-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Hello');
  fs.writeFileSync(path.join(root, 'docs/beta-feedback.md'), 'sync is slow');
  fs.writeFileSync(path.join(root, 'docs/my notes.txt'), 'spaces');
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'ignored');
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-extra-'));
  fs.writeFileSync(path.join(extra, 'design.md'), 'design doc');
  return { root, extra };
}

test('parses path-like @mentions and quoted paths, not agent names or emails', () => {
  assert.deepEqual(parseFileMentions('Hey @Nova, read @README.md and @docs/beta-feedback.md. Mail me at a@b.com'), ['README.md', 'docs/beta-feedback.md']);
  assert.deepEqual(parseFileMentions('see @"docs/my notes.txt" (and @src/)'), ['docs/my notes.txt', 'src/']);
  assert.deepEqual(parseFileMentions('@Scout @Quill'), []);
});

test('resolves inside project folders only, with folder-name prefixes for extra folders', () => {
  const { root, extra } = project();
  const folders = [root, extra];
  assert.equal(resolveMention('README.md', folders), path.join(root, 'README.md'));
  assert.equal(resolveMention('docs/my notes.txt', folders), path.join(root, 'docs/my notes.txt'));
  assert.equal(resolveMention(`${path.basename(extra)}/design.md`, folders), path.join(extra, 'design.md'));
  assert.equal(resolveMention('design.md', folders), path.join(extra, 'design.md'));
  assert.equal(resolveMention('../../etc/passwd', folders), null, 'no escaping the project');
  assert.equal(resolveMention('nope.md', folders), null);
  assert.equal(resolveMention(path.join(root, 'README.md'), []), path.join(root, 'README.md'), 'absolute paths from the user are allowed');
});

test('search ranks filename matches and skips ignored folders', () => {
  const { root, extra } = project();
  const hits = searchFiles([root, extra], 'beta');
  assert.equal(hits[0].label, 'docs/beta-feedback.md');
  assert.ok(!searchFiles([root], 'index').some((h) => h.label.includes('node_modules')));
  assert.ok(searchFiles([root, extra], 'design').some((h) => h.label === `${path.basename(extra)}/design.md`));
  assert.ok(searchFiles([root], '').length > 0, 'empty query lists files');
});

test('reads text with a cap and refuses binary files', () => {
  const { root } = project();
  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(5000));
  const r = readForPrompt(big, 'big.txt', 1000);
  assert.equal(r.text.length, 1000);
  assert.equal(r.truncated, true);
  const bin = path.join(root, 'img.bin');
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.equal(readForPrompt(bin, 'img.bin').binary, true);
  assert.equal(readForPrompt(path.join(root, 'gone.md'), 'gone.md').missing, true);
});
