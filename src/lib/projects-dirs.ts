'use strict';

/**
 * Where Claude Code transcripts live on disk.
 *
 * Two producers write the same JSONL format to two different roots:
 *
 *  - The `claude` CLI — and Claude Desktop's built-in Code, which drives the
 *    very same binary and records a `cliSessionId` pointing back at it —
 *    write to `~/.claude/projects`.
 *  - Cowork ("local agent mode") gives every session its own sandboxed HOME,
 *    so those transcripts land in `<session>/.claude/projects` instead.
 *
 * Desktop Chat is deliberately absent: it keeps no local usage log (only
 * `plan-usage-history.json`, which is percent-of-plan, not tokens), so there
 * is nothing to price.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function defaultCoworkSessionsDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions'
  );
}

/**
 * The `.claude/projects` root of every Cowork session under `sessionsDir`,
 * which is laid out `<account>/<org>/<session>/.claude/projects`. The descent
 * is fixed at three levels on purpose: a Cowork session's HOME also holds
 * whatever files the agent checked out, and a recursive walk would descend
 * into all of them on every poll.
 *
 * `null` disables Cowork discovery entirely (isolated runs and tests).
 */
export function coworkProjectsDirs(sessionsDir: string | null): string[] {
  if (!sessionsDir) return [];
  let dirs = [sessionsDir];
  // Three fixed levels down: account, org, session.
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const dir of dirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.'))
          next.push(path.join(dir, e.name));
      }
    }
    dirs = next;
  }
  return dirs
    .map((dir) => path.join(dir, '.claude', 'projects'))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Resolves the cowork root to use given an (optional) explicit projects dir:
 * pointing the app at a specific projectsDir means "scan exactly this", so it
 * opts out of the real Cowork tree unless a cowork root is named too.
 */
export function resolveCoworkSessionsDir(
  projectsDir: string | undefined,
  coworkSessionsDir: string | null | undefined
): string | null {
  if (coworkSessionsDir !== undefined) return coworkSessionsDir;
  return projectsDir ? null : defaultCoworkSessionsDir();
}

/** Every projects root to scan: the primary one plus each Cowork session's. */
export function allProjectsDirs(
  projectsDir: string,
  coworkSessionsDir: string | null
): string[] {
  return [projectsDir, ...coworkProjectsDirs(coworkSessionsDir)];
}
