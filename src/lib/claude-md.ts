'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Resolves the effective CLAUDE.md "chain" a project's system prompt actually
 * carries. Every line in it is re-injected into EVERY request of a session,
 * so its size is a direct, repeated cost driver — the signal the
 * `bloated-claude-md` habit (habits.ts) is built on.
 *
 * Mirrors the resolution order Claude Code itself uses:
 *   1. `~/.claude/CLAUDE.md` (the global memory file)
 *   2. walking from `cwd` up to the filesystem root, checking `CLAUDE.md` and
 *      `.claude/CLAUDE.md` at each level
 *   3. `@relative/path` imports referenced inside any of the above, resolved
 *      recursively (depth-limited, cycle-guarded)
 *
 * This is a best-effort local heuristic, not a guarantee of what any given
 * session actually loaded (Claude Code's own resolution has edge cases this
 * doesn't attempt to replicate). `homeDir`/`readFile`/`statMtimeMs` are
 * injectable so tests never touch the real $HOME or filesystem.
 */

export interface ClaudeMdContext {
  totalLines: number;
  fileCount: number;
}

export interface ClaudeMdContextOptions {
  homeDir?: string;
  readFile?: (absPath: string) => string | null;
  statMtimeMs?: (absPath: string) => number | null;
}

const MAX_IMPORT_DEPTH = 5;
// Matches `@relative/path` import references (stops at whitespace/closing paren).
const IMPORT_RE = /@([^\s)]+)/g;

function defaultReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function defaultStatMtimeMs(absPath: string): number | null {
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

function countLines(content: string): number {
  if (content === '') return 0;
  // A trailing newline shouldn't count as an extra empty line.
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/** Resolves an import reference to an absolute path. Claude Code supports
 *  home-relative imports (`@~/.claude/shared.md`), which `path.resolve` would
 *  otherwise turn into a literal `~` directory that never exists — silently
 *  dropping that file's lines from the count. */
function resolveImport(
  importPath: string,
  dir: string,
  homeDir: string
): string {
  if (importPath === '~') return homeDir;
  if (importPath.startsWith('~/')) {
    return path.join(homeDir, importPath.slice(2));
  }
  return path.resolve(dir, importPath);
}

/** Resolves one file + its @imports, recursively, folding lines into `acc`. */
function resolveFile(
  absPath: string,
  depth: number,
  visited: Set<string>,
  readFile: (absPath: string) => string | null,
  acc: ClaudeMdContext,
  homeDir: string
): void {
  const resolved = path.resolve(absPath);
  if (visited.has(resolved) || depth > MAX_IMPORT_DEPTH) return;
  visited.add(resolved); // marks the path as handled even if missing/unreadable

  const content = readFile(resolved);
  if (content === null) return;

  acc.totalLines += countLines(content);
  acc.fileCount += 1;

  const dir = path.dirname(resolved);
  for (const m of content.matchAll(IMPORT_RE)) {
    const importPath = m[1];
    if (!importPath) continue;
    resolveFile(
      resolveImport(importPath, dir, homeDir),
      depth + 1,
      visited,
      readFile,
      acc,
      homeDir
    );
  }
}

function statAll(
  files: string[],
  statMtimeMs: (absPath: string) => number | null
): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of files) {
    const mt = statMtimeMs(f);
    if (mt !== null) m.set(f, mt);
  }
  return m;
}

function mtimesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

interface CacheEntry {
  files: string[];
  mtimes: Map<string, number>;
  result: ClaudeMdContext;
}

// Memoized per cwd, invalidated by comparing the resolved files' mtimes — the
// monitor polls every ~3s, so re-reading + re-parsing an unchanged chain on
// every tick would be wasted work.
const cache = new Map<string, CacheEntry>();

/** Drops all memoized results (tests only — production never needs this). */
export function clearClaudeMdCache(): void {
  cache.clear();
}

/** Effective CLAUDE.md line count reachable from a project directory. */
export function claudeMdContextFor(
  cwd: string,
  {
    homeDir = os.homedir(),
    readFile = defaultReadFile,
    statMtimeMs = defaultStatMtimeMs,
  }: ClaudeMdContextOptions = {}
): ClaudeMdContext {
  const cacheKey = path.resolve(cwd);
  const cached = cache.get(cacheKey);
  if (
    cached &&
    mtimesEqual(statAll(cached.files, statMtimeMs), cached.mtimes)
  ) {
    return cached.result;
  }

  const acc: ClaudeMdContext = { totalLines: 0, fileCount: 0 };
  const visited = new Set<string>();

  // 1. Global memory file.
  resolveFile(
    path.join(homeDir, '.claude', 'CLAUDE.md'),
    0,
    visited,
    readFile,
    acc,
    homeDir
  );

  // 2. Walk cwd -> filesystem root, checking both conventional locations.
  let dir = path.resolve(cwd);
  for (;;) {
    resolveFile(
      path.join(dir, 'CLAUDE.md'),
      0,
      visited,
      readFile,
      acc,
      homeDir
    );
    resolveFile(
      path.join(dir, '.claude', 'CLAUDE.md'),
      0,
      visited,
      readFile,
      acc,
      homeDir
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const files = [...visited];
  cache.set(cacheKey, {
    files,
    mtimes: statAll(files, statMtimeMs),
    result: acc,
  });
  return acc;
}
