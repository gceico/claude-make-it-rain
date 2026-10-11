'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import { claudeMdContextFor, clearClaudeMdCache } from '../src/lib/claude-md';

function fakeFs(files: Record<string, string>) {
  const readFile = (absPath: string): string | null =>
    Object.prototype.hasOwnProperty.call(files, absPath)
      ? files[absPath]!
      : null;
  const statMtimeMs = (absPath: string): number | null =>
    Object.prototype.hasOwnProperty.call(files, absPath) ? 1 : null;
  return { readFile, statMtimeMs };
}

test('missing global CLAUDE.md and missing project CLAUDE.md contribute 0, never throw', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({});
  const ctx = claudeMdContextFor('/proj/missing-1', {
    homeDir: '/home/missing-1',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 0);
  assert.strictEqual(ctx.fileCount, 0);
});

test('resolves the global CLAUDE.md plus a project CLAUDE.md, summing lines', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/home/u2/.claude/CLAUDE.md': 'a\nb\nc\n', // 3 lines
    '/proj/missing-2/CLAUDE.md': '1\n2\n', // 2 lines
  });
  const ctx = claudeMdContextFor('/proj/missing-2', {
    homeDir: '/home/u2',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 5);
  assert.strictEqual(ctx.fileCount, 2);
});

test('walks from cwd up to the filesystem root, checking CLAUDE.md and .claude/CLAUDE.md', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/proj3/sub/dir/CLAUDE.md': 'x\n', // 1 line, at cwd
    '/proj3/.claude/CLAUDE.md': 'y\ny\n', // 2 lines, up a couple levels
  });
  const ctx = claudeMdContextFor('/proj3/sub/dir', {
    homeDir: '/home/nowhere3',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 3);
  assert.strictEqual(ctx.fileCount, 2);
});

test('resolves @relative/path imports recursively', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/home/u4/.claude/CLAUDE.md': 'root\n@RTK.md\n', // 2 lines + import
    '/home/u4/.claude/RTK.md': 'one\ntwo\nthree\n', // 3 lines
  });
  const ctx = claudeMdContextFor('/proj/missing-4', {
    homeDir: '/home/u4',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 5, '2 root + 3 imported');
  assert.strictEqual(ctx.fileCount, 2);
});

test('resolves home-relative @~/ imports against homeDir, not a literal ~ dir', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/proj4b/CLAUDE.md': 'local\n@~/.claude/shared.md\n', // 2 lines + import
    '/home/u4b/.claude/shared.md': 'a\nb\nc\nd\n', // 4 lines
  });
  const ctx = claudeMdContextFor('/proj4b', {
    homeDir: '/home/u4b',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 6, '2 local + 4 from the ~/ import');
  assert.strictEqual(ctx.fileCount, 2);
});

test('an import cycle terminates instead of infinite-looping', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/home/u5/.claude/CLAUDE.md': 'a\n@b.md\n',
    '/home/u5/.claude/b.md': 'b\n@CLAUDE.md\n', // cycles back to the root file
  });
  const ctx = claudeMdContextFor('/proj/missing-5', {
    homeDir: '/home/u5',
    readFile,
    statMtimeMs,
  });
  // Each file visited exactly once despite the cycle.
  assert.strictEqual(ctx.fileCount, 2);
  assert.strictEqual(ctx.totalLines, 4);
});

test('a deep import chain past the depth guard stops contributing further', () => {
  clearClaudeMdCache();
  const files: Record<string, string> = {
    '/home/u6/.claude/CLAUDE.md': 'root\n@l1.md\n',
  };
  // Chain of 10 imports, each 1 line + an import to the next.
  for (let i = 1; i <= 10; i++) {
    files[`/home/u6/.claude/l${i}.md`] =
      i < 10 ? `line${i}\n@l${i + 1}.md\n` : `line${i}\n`;
  }
  const { readFile, statMtimeMs } = fakeFs(files);
  const ctx = claudeMdContextFor('/proj/missing-6', {
    homeDir: '/home/u6',
    readFile,
    statMtimeMs,
  });
  // Depth-limited: not all 11 files get resolved.
  assert.ok(
    ctx.fileCount < 11,
    `expected depth guard to cap fileCount, got ${ctx.fileCount}`
  );
  assert.ok(ctx.fileCount >= 1);
});

test('memoizes per cwd until a resolved file mtime changes', () => {
  clearClaudeMdCache();
  let mtime = 1;
  const content = { current: 'a\nb\n' };
  const readFile = (absPath: string): string | null =>
    absPath === '/home/u7/.claude/CLAUDE.md' ? content.current : null;
  const statMtimeMs = (absPath: string): number | null =>
    absPath === '/home/u7/.claude/CLAUDE.md' ? mtime : null;

  const first = claudeMdContextFor('/proj/missing-7', {
    homeDir: '/home/u7',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(first.totalLines, 2);

  // Change the content WITHOUT bumping mtime: cached result should be reused.
  content.current = 'a\nb\nc\nd\n';
  const cached = claudeMdContextFor('/proj/missing-7', {
    homeDir: '/home/u7',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(
    cached.totalLines,
    2,
    'stale cache reused (mtime unchanged)'
  );

  // Now bump mtime: the change should be picked up.
  mtime = 2;
  const fresh = claudeMdContextFor('/proj/missing-7', {
    homeDir: '/home/u7',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(fresh.totalLines, 4, 'recomputed after mtime change');
});

test('with no project CLAUDE.md, AGENTS.md is read instead (global still counts)', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/home/u9/.claude/CLAUDE.md': 'g\n', // 1 line, doesn't block AGENTS.md
    '/repo9/AGENTS.md': 'a\nb\nc\n', // 3 lines
    '/repo9/.claude/AGENTS.md': 'x\n', // 1 line
  });
  const ctx = claudeMdContextFor('/repo9/src', {
    homeDir: '/home/u9',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 5);
  assert.strictEqual(ctx.fileCount, 3);
});

test('a project CLAUDE.md or CLAUDE.local.md anywhere up the tree wins over AGENTS.md', () => {
  clearClaudeMdCache();
  const { readFile, statMtimeMs } = fakeFs({
    '/repo10/AGENTS.md': 'a\nb\nc\nd\n',
    '/repo10/CLAUDE.md': '1\n', // 1 line
    '/repo10/sub/CLAUDE.local.md': '2\n3\n', // 2 lines, counted too
  });
  const ctx = claudeMdContextFor('/repo10/sub', {
    homeDir: '/home/u10',
    readFile,
    statMtimeMs,
  });
  assert.strictEqual(ctx.totalLines, 3);
  assert.strictEqual(ctx.fileCount, 2);
});
