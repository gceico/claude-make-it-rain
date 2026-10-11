'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { costForEntry, pricingForCodexModel } from './pricing';
import { parseUsageEntry } from './entry-parser';
import { parseCodexLine } from './codex-entry-parser';
import {
  mapCodexUsage,
  zeroTotals,
  delta as codexDelta,
} from './codex-monitor';
import { discoverCodexFilesAsync, resolveCodexSessionsDir } from './codex-dirs';
import { AnalyticsStore, emptyDailySnapshot } from './analytics-store';
import type { DailySnapshot, ToolingState } from './analytics-store';
import { runHabitDetectors } from './habits';
import {
  allProjectsDirs,
  defaultProjectsDir,
  resolveCoworkSessionsDir,
} from './projects-dirs';

/**
 * Retroactive spend history built directly from the ~/.claude/projects/**\/*.jsonl
 * session logs — no local database. Because the logs already exist, users see
 * spend from before they installed the app.
 *
 * Scans are lazy and async so they never block the tray. Scanning a month of
 * logs is not cheap, so the History class pays that price at most once per
 * local day: completed days are immutable and get cached in a "ledger", and
 * refreshes only re-read files touched today.
 */

/** A selectable time range in the "Past spending" submenu. */
export interface Range {
  id: string;
  label: string;
}

/** Per-model cost/token accumulation within a DayBucket. */
export interface DayBucketModel {
  costUSD: number;
  inTok: number;
  outTok: number;
}

/** Accumulated cost for one local calendar day. */
export interface DayBucket {
  costUSD: number;
  entryCount: number;
  perModel: Record<string, DayBucketModel>;
  cacheReadTok: number;
  cacheCreationTok: number;
  /** sessionId -> max input+cache tokens seen in one assistant entry of that
   *  session, on this day — a proxy for that session's peak context size. */
  sessionMaxContext: Map<string, number>;
}

/** A per-day entry in an assembled range result. */
export interface DayEntry {
  date: string;
  costUSD: number;
  entryCount: number;
}

/** The result of scanning one range. */
export interface RangeResult {
  rangeId: string;
  start: Date;
  end: Date;
  totalCostUSD: number;
  entryCount: number;
  days: DayEntry[];
}

/** The raw result of one window scan. */
export interface ScanResult {
  days: Map<string, DayBucket>;
  seenKeys: Set<string>;
  totalCostUSD: number;
  entryCount: number;
}

/** The selectable ranges, in menu order. */
export const RANGES: Range[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7days', label: 'Last 7 days' },
  { id: 'last30days', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
];

export function startOfDay(d: Date | number): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date | number, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local `YYYY-MM-DD` calendar-day key for grouping. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Half-open [start, end) window for a range id, computed against local time.
 * `end` is exclusive; ranges that include today end at the start of tomorrow.
 */
export function rangeFor(
  id: string,
  now: Date = new Date()
): { start: Date; end: Date } {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  switch (id) {
    case 'today':
      return { start: today, end: tomorrow };
    case 'yesterday':
      return { start: addDays(today, -1), end: today };
    case 'last7days':
      return { start: addDays(today, -6), end: tomorrow };
    case 'last30days':
      return { start: addDays(today, -29), end: tomorrow };
    case 'thisMonth': {
      const s = new Date(today);
      s.setDate(1);
      return { start: s, end: tomorrow };
    }
    default:
      throw new Error('unknown range: ' + id);
  }
}

/** Number of $100 "rain bills" a dollar amount represents. */
export function billCount(costUSD: number): number {
  return Math.max(0, Math.floor(costUSD / 100));
}

/** A single 💰 with a count prefix per $100 (e.g. `10×💰`) instead of a long
 *  unreadable trail of pouches. Empty string below $100. */
export function billStacksLabel(costUSD: number): string {
  const n = billCount(costUSD);
  if (n <= 0) return '';
  return `${n}×💰`;
}

/** All *.jsonl under <root>/<project>/ last modified at/after `since`, across
 * every projects root (CLI + Cowork sessions).
 * A file whose mtime predates the window cannot contain in-window entries, so
 * skipping it is a safe optimization; per-entry timestamps still gate results. */
async function discoverFiles(roots: string[], since: Date): Promise<string[]> {
  const sinceMs = since.getTime();
  const result: string[] = [];
  for (const root of roots) {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const projectDir = path.join(root, dirent.name);
      let files: string[];
      try {
        files = await fs.promises.readdir(projectDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, name);
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
  return result;
}

function emptyBucket(): DayBucket {
  return {
    costUSD: 0,
    entryCount: 0,
    perModel: {},
    cacheReadTok: 0,
    cacheCreationTok: 0,
    sessionMaxContext: new Map(),
  };
}

/** Adds every field of `src` into `dst` (same-day merge of two DayBuckets). */
function mergeDayBucket(dst: DayBucket, src: DayBucket): void {
  dst.costUSD += src.costUSD;
  dst.entryCount += src.entryCount;
  for (const [model, m] of Object.entries(src.perModel)) {
    const b = dst.perModel[model] || { costUSD: 0, inTok: 0, outTok: 0 };
    b.costUSD += m.costUSD;
    b.inTok += m.inTok;
    b.outTok += m.outTok;
    dst.perModel[model] = b;
  }
  dst.cacheReadTok += src.cacheReadTok;
  dst.cacheCreationTok += src.cacheCreationTok;
  for (const [sid, ctx] of src.sessionMaxContext) {
    const prev = dst.sessionMaxContext.get(sid) || 0;
    if (ctx > prev) dst.sessionMaxContext.set(sid, ctx);
  }
}

/** Folds a Codex day map into a Claude day map (mutating `into`). */
function mergeDayMaps(
  into: Map<string, DayBucket>,
  from: Map<string, DayBucket>
): void {
  for (const [day, bucket] of from) {
    const dst = into.get(day) || emptyBucket();
    mergeDayBucket(dst, bucket);
    into.set(day, dst);
  }
}

/**
 * Retroactive Codex spend for [startMs, endMs), grouped by local calendar day.
 *
 * Codex writes one rollout file per session with *cumulative* token counts, so
 * each file is read in full while tracking the active model (from turn_context)
 * and the previous cumulative reading. Each token_count's per-component delta is
 * attributed to the day of its own timestamp, but ONLY when that timestamp falls
 * in the window — while `lastTotal` is still advanced for out-of-window events,
 * so the window's first in-range delta measures real growth (this makes a
 * session that spans a window/day boundary correct, and needs no cross-file
 * dedup since one session lives in exactly one file).
 */
async function scanCodexWindow(
  sessionsDir: string | null,
  startMs: number,
  endMs: number
): Promise<{
  days: Map<string, DayBucket>;
  totalCostUSD: number;
  entryCount: number;
}> {
  const days = new Map<string, DayBucket>();
  let totalCostUSD = 0;
  let entryCount = 0;
  if (!sessionsDir) return { days, totalCostUSD, entryCount };

  const files = await discoverCodexFilesAsync(sessionsDir, startMs);
  for (const file of files) {
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let model: string | null = null;
    let sessionId: string | null = file; // fall back to path if no session_meta
    let lastTotal = zeroTotals();

    for (const line of content.split('\n')) {
      if (!line) continue;
      const rec = parseCodexLine(line);
      if (!rec) continue;

      if (rec.kind === 'session_meta') {
        if (rec.sessionId) sessionId = rec.sessionId;
        continue;
      }
      if (rec.kind === 'turn_context') {
        model = rec.model;
        continue;
      }
      if (rec.kind !== 'token_count') continue;

      const total = rec.total;
      const delta = codexDelta(total, lastTotal);
      lastTotal = total;

      const t = rec.timestamp.getTime();
      if (t < startMs || t >= endMs) continue;

      const usage = mapCodexUsage(delta, rec.contextTokens);
      const cost = costForEntry(usage, model, pricingForCodexModel);
      const key = dayKey(rec.timestamp);
      const bucket = days.get(key) || emptyBucket();
      bucket.costUSD += cost;
      bucket.entryCount += 1;

      const modelKey = model || 'unknown';
      const mb = bucket.perModel[modelKey] || {
        costUSD: 0,
        inTok: 0,
        outTok: 0,
      };
      mb.costUSD += cost;
      mb.inTok += usage.inputTokens;
      mb.outTok += usage.outputTokens;
      bucket.perModel[modelKey] = mb;

      bucket.cacheReadTok += delta.cachedInputTokens;

      // Context is the last request's prompt size, NOT the session's cumulative
      // totals (which grow without bound); see codex-entry-parser.contextTokens.
      const context = rec.contextTokens;
      const prevMax = bucket.sessionMaxContext.get(sessionId) || 0;
      if (context > prevMax) bucket.sessionMaxContext.set(sessionId, context);

      days.set(key, bucket);
      totalCostUSD += cost;
      entryCount += 1;
    }
  }
  return { days, totalCostUSD, entryCount };
}

interface ScanWindowArgs {
  projectsDir: string;
  coworkSessionsDir?: string | null;
  codexSessionsDir?: string | null;
  startMs: number;
  endMs: number;
  baseSeen?: Set<string> | null;
}

/**
 * Core scan: read every candidate file (mtime >= startMs) fully, keep entries
 * whose own timestamp falls in the half-open [startMs, endMs) window, dedup by
 * requestId:messageId across ALL files (a session that spans several files
 * must not double-count), and group cost by local calendar day.
 *
 * `baseSeen` is an optional read-only set of dedup keys already counted by a
 * previous scan; entries with those keys are skipped (used so the incremental
 * "today" scan never recounts entries that a resumed session rewrote into a
 * freshly-touched file).
 */
async function scanWindow({
  projectsDir,
  coworkSessionsDir = null,
  codexSessionsDir = null,
  startMs,
  endMs,
  baseSeen = null,
}: ScanWindowArgs): Promise<ScanResult> {
  // Kick off the Codex scan concurrently — it walks a disjoint directory tree
  // and only needs joining in at the end (mergeDayMaps below).
  const codexPromise = scanCodexWindow(codexSessionsDir, startMs, endMs);

  const files = await discoverFiles(
    allProjectsDirs(projectsDir, coworkSessionsDir),
    new Date(startMs)
  );
  const seen = new Set<string>();
  const days = new Map<string, DayBucket>(); // dayKey -> DayBucket
  let totalCostUSD = 0;
  let entryCount = 0;

  for (const file of files) {
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      const parsed = parseUsageEntry(line);
      if (!parsed || parsed.kind !== 'assistant') continue;

      const t = parsed.timestamp.getTime();
      if (t < startMs || t >= endMs) continue;

      if (baseSeen && baseSeen.has(parsed.key)) continue;
      if (seen.has(parsed.key)) continue;
      seen.add(parsed.key);

      const cost = costForEntry(parsed.usage, parsed.model);
      const key = dayKey(parsed.timestamp);
      const bucket = days.get(key) || emptyBucket();
      bucket.costUSD += cost;
      bucket.entryCount += 1;

      const modelKey = parsed.model || 'unknown';
      const modelBucket = bucket.perModel[modelKey] || {
        costUSD: 0,
        inTok: 0,
        outTok: 0,
      };
      modelBucket.costUSD += cost;
      modelBucket.inTok += parsed.inputTokens;
      modelBucket.outTok += parsed.outputTokens;
      bucket.perModel[modelKey] = modelBucket;

      bucket.cacheReadTok += parsed.usage.cacheReadInputTokens;
      bucket.cacheCreationTok += parsed.usage.cacheCreationInputTokens;

      if (parsed.sessionId) {
        const contextTokens =
          parsed.inputTokens + parsed.usage.cacheReadInputTokens;
        const prevMax = bucket.sessionMaxContext.get(parsed.sessionId) || 0;
        if (contextTokens > prevMax) {
          bucket.sessionMaxContext.set(parsed.sessionId, contextTokens);
        }
      }

      days.set(key, bucket);

      totalCostUSD += cost;
      entryCount += 1;
    }
  }

  // Fold in retroactive Codex spend for the same window. Codex sessions are
  // self-contained per file (no cross-file dedup), and its gpt-* model keys
  // never collide with Claude's, so both tools coexist in each DayBucket.
  const codex = await codexPromise;
  mergeDayMaps(days, codex.days);
  totalCostUSD += codex.totalCostUSD;
  entryCount += codex.entryCount;

  return { days, seenKeys: seen, totalCostUSD, entryCount };
}

/** Formats a dayKey->bucket map as a result's sorted `days` array. */
function daysArray(dayMap: Map<string, DayBucket>): DayEntry[] {
  return [...dayMap.entries()]
    .map(([date, v]) => ({
      date,
      costUSD: v.costUSD,
      entryCount: v.entryCount,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// All-installed tooling for the historical habit pass: tool-missing is a
// current fact, not a per-day-historical one, so it must not inflate stored
// habitCounts (today's live pass reports real tool state).
const ALL_TOOLS_INSTALLED: ToolingState = {
  rtk: { installed: true, version: null, detectedAtMs: 0 },
  caveman: { installed: true, version: null, detectedAtMs: 0 },
  ponytail: { installed: true, version: null, detectedAtMs: 0 },
};

/** Converts one scan's DayBucket into the analytics-store's persisted
 *  DailySnapshot shape, including per-day habitCounts derived from that day's
 *  token/model/cache/session data (content-shape habits like giant-paste need
 *  user-turn data the history scan doesn't retain, so they stay 0 in history
 *  and are only counted live). */
function dailySnapshotFromBucket(bucket: DayBucket): DailySnapshot {
  const snap = emptyDailySnapshot();
  snap.costUSD = bucket.costUSD;
  for (const [model, m] of Object.entries(bucket.perModel)) {
    snap.perModel[model] = {
      costUSD: m.costUSD,
      inTok: m.inTok,
      outTok: m.outTok,
    };
  }
  const totalCacheTok = bucket.cacheReadTok + bucket.cacheCreationTok;
  snap.cache = {
    readTok: bucket.cacheReadTok,
    creationTok: bucket.cacheCreationTok,
    hitRatio: totalCacheTok > 0 ? bucket.cacheReadTok / totalCacheTok : 0,
  };
  let maxContext = 0;
  for (const v of bucket.sessionMaxContext.values()) {
    if (v > maxContext) maxContext = v;
  }
  snap.sessions = {
    count: bucket.sessionMaxContext.size,
    maxContextTokens: maxContext,
  };
  for (const r of runHabitDetectors({
    snapshot: snap,
    toolingState: ALL_TOOLS_INSTALLED,
    userTurns: [],
    sessionGaps: [],
  })) {
    if (r.count > 0) snap.habitCounts[r.id] = r.count;
  }
  return snap;
}

interface ScanRangeArgs {
  projectsDir: string;
  coworkSessionsDir?: string | null;
  codexSessionsDir?: string | null;
  rangeId: string;
  now?: Date;
}

/**
 * One-shot full scan of a range (no caching). Kept as the plain reference
 * implementation; the History class below produces the same result shape but
 * reuses an immutable past-days ledger so repeat calls only re-read today's
 * files. `days` is sorted ascending by date.
 */
export async function scanRange({
  projectsDir,
  coworkSessionsDir = null,
  codexSessionsDir = null,
  rangeId,
  now = new Date(),
}: ScanRangeArgs): Promise<RangeResult> {
  const range = rangeFor(rangeId, now);
  const { days, totalCostUSD, entryCount } = await scanWindow({
    projectsDir,
    coworkSessionsDir,
    codexSessionsDir,
    startMs: range.start.getTime(),
    endMs: range.end.getTime(),
  });
  return {
    rangeId,
    start: range.start,
    end: range.end,
    totalCostUSD,
    entryCount,
    days: daysArray(days),
  };
}

interface CacheEntry {
  at: number;
  dayStartMs: number;
  promise: Promise<RangeResult>;
}

interface LedgerEntry {
  promise: Promise<ScanResult>;
  dayStartMs: number;
  startMs: number;
}

interface TodayEntry {
  at: number;
  dayStartMs: number;
  settled: boolean;
  promise: Promise<ScanResult>;
}

export interface HistoryOptions {
  projectsDir?: string;
  /** Cowork sessions root; `null` skips Cowork. See resolveCoworkSessionsDir. */
  coworkSessionsDir?: string | null;
  /** Codex sessions root; `null` skips Codex. See resolveCodexSessionsDir. */
  codexSessionsDir?: string | null;
  cacheTtlMs?: number;
  /** Optional analytics store to persist finished (immutable) ledger days
   *  into, so daily snapshots survive relaunch and past months even if
   *  Claude prunes the underlying logs. Writing happens once per ledger
   *  build (see _getLedger), the cheap correct path since the ledger is
   *  itself only rebuilt once per local day. */
  analyticsStore?: AnalyticsStore | null;
}

/**
 * Range results with near-zero steady-state cost.
 *
 * Days before today are immutable — the logs only ever gain entries with new
 * timestamps, so a past calendar day's total never changes once that day is
 * over. History exploits that with a two-tier scan:
 *
 *  - A "ledger" covering [earliest range start, start of today) is built once
 *    and reused until local midnight rolls the day over. This is the only
 *    expensive scan.
 *  - Only "today" is rescanned on refresh (files with mtime >= start of
 *    today), deduped against the ledger's seen keys so entries a resumed
 *    session rewrote into a freshly-touched file are not double-counted, and
 *    cached for `cacheTtlMs`. `force` bypasses the today cache but never
 *    rebuilds the ledger.
 *
 * Assembled per-range results are additionally cached for `cacheTtlMs` so
 * concurrent menu rebuilds share one in-flight promise.
 */
export class History {
  projectsDir: string;
  coworkSessionsDir: string | null;
  codexSessionsDir: string | null;
  cacheTtlMs: number;
  _cache: Map<string, CacheEntry>;
  _ledger: LedgerEntry | null;
  _today: TodayEntry | null;
  _analyticsStore: AnalyticsStore | null;

  constructor({
    projectsDir,
    coworkSessionsDir,
    codexSessionsDir,
    cacheTtlMs = 60_000,
    analyticsStore = null,
  }: HistoryOptions = {}) {
    this.projectsDir = projectsDir || defaultProjectsDir();
    this.coworkSessionsDir = resolveCoworkSessionsDir(
      projectsDir,
      coworkSessionsDir
    );
    this.codexSessionsDir = resolveCodexSessionsDir(codexSessionsDir);
    this.cacheTtlMs = cacheTtlMs;
    this._cache = new Map(); // rangeId -> { at, dayStartMs, promise }
    this._ledger = null; // { promise, dayStartMs, startMs }
    this._today = null; // { promise, at, dayStartMs }
    this._analyticsStore = analyticsStore;
  }

  /** Earliest window start any selectable range can ask for. */
  _earliestStartMs(now: Date): number {
    let min = Infinity;
    for (const r of RANGES) {
      min = Math.min(min, rangeFor(r.id, now).start.getTime());
    }
    return min;
  }

  /** Immutable past-days scan: [earliest range start, start of today). */
  _getLedger(now: Date): Promise<ScanResult> {
    const dayStartMs = startOfDay(now).getTime();
    const startMs = this._earliestStartMs(now);
    const l = this._ledger;
    if (l && l.dayStartMs === dayStartMs && l.startMs <= startMs)
      return l.promise;

    const promise = scanWindow({
      projectsDir: this.projectsDir,
      coworkSessionsDir: this.coworkSessionsDir,
      codexSessionsDir: this.codexSessionsDir,
      startMs,
      endMs: dayStartMs,
    })
      .then((result) => {
        // Cheap, correct write path: every finished (immutable) day the ledger
        // just scanned gets persisted into analytics-store, so daily snapshots
        // survive relaunch and outlive any log pruning. Best-effort — a store
        // write failure must never break the (already-completed) history scan.
        if (this._analyticsStore) {
          try {
            this._analyticsStore.setDays(
              [...result.days].map(
                ([day, bucket]) =>
                  [day, dailySnapshotFromBucket(bucket)] as [
                    string,
                    DailySnapshot,
                  ]
              )
            );
          } catch {
            /* best-effort persistence */
          }
        }
        return result;
      })
      .catch((err) => {
        // Don't cache failures.
        if (this._ledger && this._ledger.promise === promise)
          this._ledger = null;
        throw err;
      });
    this._ledger = { promise, dayStartMs, startMs };
    return promise;
  }

  /** Today-only scan (cheap): files touched today, deduped against the ledger.
   *  A still-running scan is reused even under `force` — it is as fresh as one
   *  started now, and this keeps a forced refresh of all five ranges (or rapid
   *  menu clicks) down to a single scan. */
  _getToday(now: Date, force: boolean): Promise<ScanResult> {
    const dayStartMs = startOfDay(now).getTime();
    const t = this._today;
    if (t && t.dayStartMs === dayStartMs) {
      const fresh = Date.now() - t.at < this.cacheTtlMs;
      if (!t.settled || (!force && fresh)) return t.promise;
    }

    const entry = { at: Date.now(), dayStartMs, settled: false } as TodayEntry;
    entry.promise = this._getLedger(now)
      .then((ledger) =>
        scanWindow({
          projectsDir: this.projectsDir,
          coworkSessionsDir: this.coworkSessionsDir,
          codexSessionsDir: this.codexSessionsDir,
          startMs: dayStartMs,
          endMs: addDays(new Date(dayStartMs), 1).getTime(),
          baseSeen: ledger.seenKeys,
        })
      )
      .catch((err) => {
        // Don't cache failures.
        if (this._today === entry) this._today = null;
        throw err;
      });
    entry.promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      }
    );
    this._today = entry;
    return entry.promise;
  }

  /** Ledger days ∩ range window, merged with a fresh today scan. */
  async _assemble(
    rangeId: string,
    now: Date,
    force: boolean
  ): Promise<RangeResult> {
    const range = rangeFor(rangeId, now);
    const dayStartMs = startOfDay(now).getTime();
    const dayMap = new Map<string, DayBucket>();
    let totalCostUSD = 0;
    let entryCount = 0;

    if (range.start.getTime() < dayStartMs) {
      const ledger = await this._getLedger(now);
      const startKey = dayKey(range.start);
      for (const [key, bucket] of ledger.days) {
        if (key < startKey) continue; // the ledger only holds days before today
        dayMap.set(key, { ...bucket });
        totalCostUSD += bucket.costUSD;
        entryCount += bucket.entryCount;
      }
    }

    if (range.end.getTime() > dayStartMs) {
      const today = await this._getToday(now, force);
      for (const [key, bucket] of today.days) {
        dayMap.set(key, { ...bucket });
        totalCostUSD += bucket.costUSD;
        entryCount += bucket.entryCount;
      }
    }

    return {
      rangeId,
      start: range.start,
      end: range.end,
      totalCostUSD,
      entryCount,
      days: daysArray(dayMap),
    };
  }

  /** Returns a Promise for the range result, using a fresh cache entry if any.
   *  Pass `force` to rescan today's files; past days stay cached (they are
   *  immutable), so even a forced refresh is cheap. */
  get(
    rangeId: string,
    { force = false, now = new Date() }: { force?: boolean; now?: Date } = {}
  ): Promise<RangeResult> {
    const dayStartMs = startOfDay(now).getTime();
    const cached = this._cache.get(rangeId);
    if (
      !force &&
      cached &&
      cached.dayStartMs === dayStartMs &&
      Date.now() - cached.at < this.cacheTtlMs
    ) {
      return cached.promise;
    }
    const promise = this._assemble(rangeId, now, force).catch((err) => {
      // Don't cache failures.
      this._cache.delete(rangeId);
      throw err;
    });
    this._cache.set(rangeId, { at: Date.now(), dayStartMs, promise });
    return promise;
  }

  /** Drops the per-range result caches (and, with no args, the ledger too). */
  invalidate(rangeId?: string): void {
    if (rangeId) {
      this._cache.delete(rangeId);
    } else {
      this._cache.clear();
      this._ledger = null;
      this._today = null;
    }
  }
}
