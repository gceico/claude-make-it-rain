'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { costForEntry } from './pricing';
import { parseUsageEntry } from './entry-parser';
import { tailFile } from './tail-reader';
import {
  allProjectsDirs,
  defaultProjectsDir,
  resolveCoworkSessionsDir,
} from './projects-dirs';

/** Per-model running totals within a Snapshot. */
export interface ModelBucket {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
}

/** Cache token totals within a Snapshot (read vs creation). */
export interface CacheTotals {
  readTokens: number;
  creationTokens: number;
}

/** One user turn's content shape (text LENGTH only — never the text).
 *  Shape matches habits.ts's UserTurnEvent so it feeds detectors directly. */
export interface UserTurn {
  sessionId: string | null;
  userTextLength: number;
  timestampMs: number;
}

/** An idle gap within one session followed by a cache-creation entry.
 *  Shape matches habits.ts's SessionGapEvent. */
export interface SessionGap {
  sessionId: string;
  gapMs: number;
  cacheCreationTokensAfterGap: number;
}

// Only record gaps at least this long; the authoritative stale-cache-idle
// threshold (gap AND cache-spike size) lives in habits.ts — this is just a
// recording bound so the array stays small.
const GAP_RECORD_MS = 5 * 60 * 1000;

/** Today's running spend + token totals. */
export interface Snapshot {
  totalCostUSD: number;
  inputTokens: number;
  outputTokens: number;
  entryCount: number;
  /** Per-model cost/token split, keyed by the raw model id (or 'unknown'). */
  perModel: Record<string, ModelBucket>;
  cache: CacheTotals;
  /** Distinct-session count + peak context size, for the long-sessions habit. */
  sessions: { count: number; maxContextTokens: number };
  /** Today's user turns (length only) — giant-paste / rage-retry habits. */
  userTurns: UserTurn[];
  /** Today's >5min-then-cache-rebuild gaps — stale-cache-idle habit. */
  sessionGaps: SessionGap[];
}

export interface UsageMonitorOptions {
  projectsDir?: string;
  /** Cowork sessions root; `null` skips Cowork. Defaults to the real one only
   *  when `projectsDir` is left at its default (see resolveCoworkSessionsDir). */
  coworkSessionsDir?: string | null;
  pollMs?: number;
}

/**
 * Monitors the *.jsonl session logs under ~/.claude/projects for assistant usage entries,
 * accumulating today's estimated spend. Port of UsageMonitor.swift.
 *
 * Files are read incrementally (only newly appended bytes), entries are
 * deduplicated by requestId:messageId, and all state resets at local midnight.
 */
export class UsageMonitor {
  projectsDir: string;
  coworkSessionsDir: string | null;
  pollMs: number;

  /** Called whenever the running total changes: (previousTotal, snapshot). */
  onUpdate: ((previousTotal: number, snapshot: Snapshot) => void) | null;
  /** Called once after the very first scan completes: (snapshot). */
  onInitialScanComplete: ((snapshot: Snapshot) => void) | null;

  timer: NodeJS.Timeout | null;
  fileOffsets!: Map<string, number>;
  partialLines!: Map<string, Buffer>;
  seenKeys!: Set<string>;
  snapshot!: Snapshot;
  currentDayStart!: Date;
  // sessionId -> last assistant timestamp seen today (for gap detection).
  sessionLastTs!: Map<string, number>;

  constructor({
    projectsDir,
    coworkSessionsDir,
    pollMs = 3000,
  }: UsageMonitorOptions = {}) {
    this.projectsDir = projectsDir || defaultProjectsDir();
    this.coworkSessionsDir = resolveCoworkSessionsDir(
      projectsDir,
      coworkSessionsDir
    );
    this.pollMs = pollMs;

    this.onUpdate = null;
    this.onInitialScanComplete = null;

    this.timer = null;
    this._resetState();
  }

  _resetState(): void {
    this.fileOffsets = new Map(); // path -> byte offset consumed
    this.partialLines = new Map(); // path -> Buffer of trailing partial line
    this.seenKeys = new Set(); // requestId:messageId dedup
    this.snapshot = {
      totalCostUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      entryCount: 0,
      perModel: {},
      cache: { readTokens: 0, creationTokens: 0 },
      sessions: { count: 0, maxContextTokens: 0 },
      userTurns: [],
      sessionGaps: [],
    };
    this.sessionLastTs = new Map();
    this.currentDayStart = UsageMonitor.startOfToday();
  }

  static startOfToday(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  start(): void {
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(isInitial: boolean): void {
    // Detect local-midnight rollover.
    const todayStart = UsageMonitor.startOfToday();
    const rolled = todayStart.getTime() !== this.currentDayStart.getTime();
    if (rolled) {
      this._resetState();
    }

    const previousTotal = this.snapshot.totalCostUSD;
    for (const file of this.discoverCandidateFiles()) {
      this.processFile(file);
    }

    const snap: Snapshot = { ...this.snapshot };
    if (isInitial && this.onInitialScanComplete)
      this.onInitialScanComplete(snap);
    // Emit on rollover even when the total is unchanged (e.g. no new spend yet
    // after midnight): consumers must be told the daily total reset to $0 so
    // they stop displaying / reporting yesterday's figure.
    if (
      (snap.totalCostUSD !== previousTotal || isInitial || rolled) &&
      this.onUpdate
    ) {
      this.onUpdate(previousTotal, snap);
    }
  }

  /** All *.jsonl under every projects root (CLI + Cowork sessions), modified
   *  since local day start. */
  discoverCandidateFiles(): string[] {
    const result: string[] = [];
    for (const root of allProjectsDirs(
      this.projectsDir,
      this.coworkSessionsDir
    )) {
      let projectDirs: fs.Dirent[];
      try {
        projectDirs = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const dirent of projectDirs) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
        const projectDir = path.join(root, dirent.name);
        let files: string[];
        try {
          files = fs.readdirSync(projectDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.endsWith('.jsonl')) continue;
          const filePath = path.join(projectDir, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (stat.mtimeMs >= this.currentDayStart.getTime()) {
            result.push(filePath);
          }
        }
      }
    }
    return result;
  }

  /** Incrementally reads newly appended bytes and processes complete lines.
   *  No `onTruncate` handler: dedup by requestId:messageId (seenKeys) makes a
   *  full re-read after truncation safe on its own. */
  processFile(filePath: string): void {
    tailFile(
      filePath,
      { offsets: this.fileOffsets, partials: this.partialLines },
      (line) => this.processLine(line)
    );
  }

  processLine(lineBuffer: Buffer): void {
    const parsed = parseUsageEntry(lineBuffer);
    if (!parsed) return;

    // Local-day filter (shared by assistant + user entries).
    const timestamp = parsed.timestamp;
    const now = new Date();
    if (
      timestamp.getFullYear() !== now.getFullYear() ||
      timestamp.getMonth() !== now.getMonth() ||
      timestamp.getDate() !== now.getDate()
    )
      return;
    // Also make sure it's within the tracked "today" window (handles the
    // rare race right at midnight rollover).
    if (timestamp.getTime() < this.currentDayStart.getTime()) return;

    // User turns: record text LENGTH + session + time only (giant-paste /
    // rage-retry). ponytail: no dedup key on user lines, so a truncation/
    // re-read can double-count a turn — rare, and both detectors are
    // conservative; daily reset bounds the array. Add a uuid dedup if it ever
    // matters.
    if (parsed.kind === 'user') {
      this.snapshot.userTurns.push({
        sessionId: parsed.sessionId,
        userTextLength: parsed.userTextLength,
        timestampMs: timestamp.getTime(),
      });
      return;
    }

    // Dedup key — computed by the shared parser (lib/entry-parser.ts), whose
    // deterministic message.id → uuid → randomUUID fallback keeps id-less
    // entries from double-counting when a truncated/rotated file is re-read.
    if (this.seenKeys.has(parsed.key)) return;
    this.seenKeys.add(parsed.key);

    const cost = costForEntry(parsed.usage, parsed.model);
    this.snapshot.totalCostUSD += cost;
    this.snapshot.inputTokens += parsed.inputTokens;
    this.snapshot.outputTokens += parsed.outputTokens;
    this.snapshot.entryCount += 1;

    const modelKey = parsed.model || 'unknown';
    const bucket = this.snapshot.perModel[modelKey] || {
      costUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    bucket.costUSD += cost;
    bucket.inputTokens += parsed.inputTokens;
    bucket.outputTokens += parsed.outputTokens;
    this.snapshot.perModel[modelKey] = bucket;

    this.snapshot.cache.readTokens += parsed.usage.cacheReadInputTokens;
    this.snapshot.cache.creationTokens += parsed.usage.cacheCreationInputTokens;

    // Session tracking: peak context (input + cache-read is the context the
    // model actually saw) and a distinct-session count for long-sessions, plus
    // a >5min idle gap followed by a cache-creation entry for stale-cache-idle.
    if (parsed.sessionId) {
      const contextTokens =
        parsed.inputTokens + parsed.usage.cacheReadInputTokens;
      if (contextTokens > this.snapshot.sessions.maxContextTokens) {
        this.snapshot.sessions.maxContextTokens = contextTokens;
      }
      const ts = timestamp.getTime();
      const lastTs = this.sessionLastTs.get(parsed.sessionId);
      if (lastTs === undefined) {
        this.snapshot.sessions.count += 1;
      } else if (
        ts - lastTs >= GAP_RECORD_MS &&
        parsed.usage.cacheCreationInputTokens > 0
      ) {
        this.snapshot.sessionGaps.push({
          sessionId: parsed.sessionId,
          gapMs: ts - lastTs,
          cacheCreationTokensAfterGap: parsed.usage.cacheCreationInputTokens,
        });
      }
      this.sessionLastTs.set(parsed.sessionId, ts);
    }
  }
}
