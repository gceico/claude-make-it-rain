'use strict';

/**
 * Where OpenAI's Codex agent (the `codex` CLI and the Codex IDE extension)
 * writes its session transcripts on disk.
 *
 * Codex records one "rollout" JSONL file per session under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<session-id>.jsonl` (CODEX_HOME
 * defaults to `~/.codex`). Unlike Claude Code's flat one-level-per-project
 * layout, Codex nests by calendar date, so discovery recurses YYYY/MM/DD.
 *
 * `archived_sessions/` (a sibling of `sessions/`) holds finished sessions the
 * user archived; live tracking ignores it — an archived session's spend was
 * already counted while it was active, and its file mtime is frozen.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `$CODEX_HOME`, or `~/.codex` when unset/empty. */
export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env;
  return path.join(os.homedir(), '.codex');
}

export function defaultCodexSessionsDir(): string {
  return path.join(codexHome(), 'sessions');
}

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

/** Numeric-only dir names (the YYYY/MM/DD segments); everything else skipped. */
function numericDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name);
}

/**
 * The local calendar day (midnight) `n` days before `dayStartMs`. Used as a
 * lenient lower bound for the YYYY/MM/DD path prefilter: the per-file mtime
 * check is the real correctness gate, so a day of slack absorbs any timezone
 * skew between the (possibly UTC) directory date and the local mtime window.
 */
function startOfDayMinus(dayStartMs: number, n: number): number {
  const d = new Date(dayStartMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

/**
 * Every `rollout-*.jsonl` under `sessionsRoot` touched at/after `sinceMs`.
 *
 * The YYYY/MM/DD path is used as a cheap prefilter to skip clearly-old day
 * directories (with one day of slack, see startOfDayMinus), then each surviving
 * file is stat-filtered on mtime. A session started yesterday but appended to
 * today has `mtime >= sinceMs` and is kept even though its directory date is
 * yesterday. Per-event timestamps still gate results downstream, so the mtime
 * filter is only an optimization.
 */
export function discoverCodexFiles(
  sessionsRoot: string,
  sinceMs: number
): string[] {
  const cutoffDayMs = startOfDayMinus(sinceMs, 1);
  const result: string[] = [];

  for (const yyyy of numericDirs(sessionsRoot)) {
    const yearDir = path.join(sessionsRoot, yyyy);
    for (const mm of numericDirs(yearDir)) {
      const monthDir = path.join(yearDir, mm);
      for (const dd of numericDirs(monthDir)) {
        // Prefilter: skip day-dirs whose calendar day precedes the cutoff.
        const y = Number(yyyy);
        const m = Number(mm);
        const d = Number(dd);
        const dayMs = new Date(y, m - 1, d).getTime();
        if (dayMs < cutoffDayMs) continue;

        const dayDir = path.join(monthDir, dd);
        let files: string[];
        try {
          files = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!ROLLOUT_RE.test(name)) continue;
          const filePath = path.join(dayDir, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (stat.mtimeMs >= sinceMs) result.push(filePath);
        }
      }
    }
  }
  return result;
}

/** Async variant for the retroactive history scanner (never blocks the tray). */
export async function discoverCodexFilesAsync(
  sessionsRoot: string,
  sinceMs: number
): Promise<string[]> {
  const cutoffDayMs = startOfDayMinus(sinceMs, 1);
  const result: string[] = [];

  const numericDirsAsync = async (dir: string): Promise<string[]> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name);
  };

  for (const yyyy of await numericDirsAsync(sessionsRoot)) {
    const yearDir = path.join(sessionsRoot, yyyy);
    for (const mm of await numericDirsAsync(yearDir)) {
      const monthDir = path.join(yearDir, mm);
      for (const dd of await numericDirsAsync(monthDir)) {
        const dayMs = new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd)
        ).getTime();
        if (dayMs < cutoffDayMs) continue;

        const dayDir = path.join(monthDir, dd);
        let files: string[];
        try {
          files = await fs.promises.readdir(dayDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!ROLLOUT_RE.test(name)) continue;
          const filePath = path.join(dayDir, name);
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(filePath);
          } catch {
            continue;
          }
          if (stat.mtimeMs >= sinceMs) result.push(filePath);
        }
      }
    }
  }
  return result;
}

/**
 * Resolves the Codex sessions root to use given an (optional) explicit dir,
 * mirroring resolveCoworkSessionsDir: passing an explicit `sessionsDir` (e.g.
 * a test fixture) opts out of the real `~/.codex` tree; `null` disables Codex
 * discovery entirely.
 */
export function resolveCodexSessionsDir(
  sessionsDir: string | null | undefined
): string | null {
  if (sessionsDir === null) return null;
  if (sessionsDir !== undefined) return sessionsDir;
  return defaultCodexSessionsDir();
}
