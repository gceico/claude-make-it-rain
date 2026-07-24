'use strict';

import * as fs from 'fs';
import * as path from 'path';

/**
 * Local, versioned analytics store for the "Optimize" release: per-day
 * spend/model/cache/habit rollups, tooling-install state, and the running
 * net-savings total. Nothing here ever leaves the machine except the single
 * `savedUSD` figure reported by leaderboard-client.ts (see docs/DECISIONS.md).
 *
 * Mirrors the shape of lib/config.ts (explicit filePath constructor arg,
 * corrupt/missing file -> defaults, never throws) but is a SEPARATE file
 * (analytics.json) from the shared config.json, and adds:
 *   - schemaVersion + migrate(): so the on-disk shape can evolve safely.
 *   - atomic writes (write to .tmp then rename): a crash mid-write can never
 *     corrupt the file.
 *
 * Persisting past days is safe because history.ts treats completed days as
 * immutable — this also protects old months if Claude prunes the logs.
 */

export const ANALYTICS_FILENAME = 'analytics.json';
export const CURRENT_SCHEMA_VERSION = 1;

/** Per-model cost/token rollup for one calendar day. */
export interface DayModelBucket {
  costUSD: number;
  inTok: number;
  outTok: number;
}

/** One calendar day's accumulated analytics. */
export interface DailySnapshot {
  costUSD: number;
  perModel: Record<string, DayModelBucket>;
  cache: { readTok: number; creationTok: number; hitRatio: number };
  sessions: { count: number; maxContextTokens: number };
  habitCounts: Record<string, number>;
}

/** One completed "Optimize" run (tools installed, when, and the baseline cost
 *  rate at the time — used to attribute savings after the fact). */
export interface OptimizeMilestone {
  atMs: number;
  tools: string[];
  baselineCostRate: number;
}

/** Detected/installed state for one supported tool. */
export interface ToolState {
  installed: boolean;
  version: string | null;
  detectedAtMs: number;
}

export interface ToolingState {
  rtk: ToolState;
  caveman: ToolState;
  ponytail: ToolState;
}

/** Running savings figures — drives the green celebratory animation + the one
 *  KPI sent to the collective board (see leaderboard-client.ts). */
export interface SavingsState {
  lifetimeUSD: number;
  lastReportedUSD: number;
}

export interface AnalyticsData {
  schemaVersion: number;
  dailySnapshots: Record<string, DailySnapshot>;
  optimizeMilestones: OptimizeMilestone[];
  toolingState: ToolingState;
  savings: SavingsState;
}

function emptyToolState(): ToolState {
  return { installed: false, version: null, detectedAtMs: 0 };
}

export function emptyDailySnapshot(): DailySnapshot {
  return {
    costUSD: 0,
    perModel: {},
    cache: { readTok: 0, creationTok: 0, hitRatio: 0 },
    sessions: { count: 0, maxContextTokens: 0 },
    habitCounts: {},
  };
}

export function defaultAnalyticsData(): AnalyticsData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dailySnapshots: {},
    optimizeMilestones: [],
    toolingState: {
      rtk: emptyToolState(),
      caveman: emptyToolState(),
      ponytail: emptyToolState(),
    },
    savings: { lifetimeUSD: 0, lastReportedUSD: 0 },
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function coerceToolState(raw: unknown): ToolState {
  const r =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    installed: typeof r.installed === 'boolean' ? r.installed : false,
    version: typeof r.version === 'string' ? r.version : null,
    detectedAtMs: isFiniteNumber(r.detectedAtMs) ? r.detectedAtMs : 0,
  };
}

function coerceDailySnapshot(raw: unknown): DailySnapshot {
  const r =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const perModel: Record<string, DayModelBucket> = {};
  if (r.perModel && typeof r.perModel === 'object') {
    for (const [model, v] of Object.entries(
      r.perModel as Record<string, unknown>
    )) {
      const b =
        v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      perModel[model] = {
        costUSD: isFiniteNumber(b.costUSD) ? b.costUSD : 0,
        inTok: isFiniteNumber(b.inTok) ? b.inTok : 0,
        outTok: isFiniteNumber(b.outTok) ? b.outTok : 0,
      };
    }
  }
  const cacheRaw =
    r.cache && typeof r.cache === 'object'
      ? (r.cache as Record<string, unknown>)
      : {};
  const sessionsRaw =
    r.sessions && typeof r.sessions === 'object'
      ? (r.sessions as Record<string, unknown>)
      : {};
  const habitCounts: Record<string, number> = {};
  if (r.habitCounts && typeof r.habitCounts === 'object') {
    for (const [id, v] of Object.entries(
      r.habitCounts as Record<string, unknown>
    )) {
      if (isFiniteNumber(v)) habitCounts[id] = v;
    }
  }
  return {
    costUSD: isFiniteNumber(r.costUSD) ? r.costUSD : 0,
    perModel,
    cache: {
      readTok: isFiniteNumber(cacheRaw.readTok) ? cacheRaw.readTok : 0,
      creationTok: isFiniteNumber(cacheRaw.creationTok)
        ? cacheRaw.creationTok
        : 0,
      hitRatio: isFiniteNumber(cacheRaw.hitRatio) ? cacheRaw.hitRatio : 0,
    },
    sessions: {
      count: isFiniteNumber(sessionsRaw.count) ? sessionsRaw.count : 0,
      maxContextTokens: isFiniteNumber(sessionsRaw.maxContextTokens)
        ? sessionsRaw.maxContextTokens
        : 0,
    },
    habitCounts,
  };
}

/**
 * Coerce an arbitrary parsed object into a valid, current-schema
 * AnalyticsData, filling in defaults for anything missing/malformed. Never
 * throws. `migrate()` upgrades an older `schemaVersion` before normalizing.
 */
export function normalizeAnalyticsData(raw: unknown): AnalyticsData {
  const migrated = migrate(raw);
  const r =
    migrated && typeof migrated === 'object'
      ? (migrated as Record<string, unknown>)
      : {};

  const dailySnapshots: Record<string, DailySnapshot> = {};
  if (r.dailySnapshots && typeof r.dailySnapshots === 'object') {
    for (const [day, snap] of Object.entries(
      r.dailySnapshots as Record<string, unknown>
    )) {
      dailySnapshots[day] = coerceDailySnapshot(snap);
    }
  }

  const optimizeMilestones: OptimizeMilestone[] = Array.isArray(
    r.optimizeMilestones
  )
    ? r.optimizeMilestones
        .filter(
          (m): m is Record<string, unknown> => !!m && typeof m === 'object'
        )
        .map((m) => ({
          atMs: isFiniteNumber(m.atMs) ? m.atMs : 0,
          tools: Array.isArray(m.tools)
            ? m.tools.filter((t): t is string => typeof t === 'string')
            : [],
          baselineCostRate: isFiniteNumber(m.baselineCostRate)
            ? m.baselineCostRate
            : 0,
        }))
    : [];

  const toolingRaw =
    r.toolingState && typeof r.toolingState === 'object'
      ? (r.toolingState as Record<string, unknown>)
      : {};
  const toolingState: ToolingState = {
    rtk: coerceToolState(toolingRaw.rtk),
    caveman: coerceToolState(toolingRaw.caveman),
    ponytail: coerceToolState(toolingRaw.ponytail),
  };

  const savingsRaw =
    r.savings && typeof r.savings === 'object'
      ? (r.savings as Record<string, unknown>)
      : {};
  const savings: SavingsState = {
    lifetimeUSD: isFiniteNumber(savingsRaw.lifetimeUSD)
      ? savingsRaw.lifetimeUSD
      : 0,
    lastReportedUSD: isFiniteNumber(savingsRaw.lastReportedUSD)
      ? savingsRaw.lastReportedUSD
      : 0,
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dailySnapshots,
    optimizeMilestones,
    toolingState,
    savings,
  };
}

/**
 * Upgrades an older on-disk shape to the current schema. Version 1 is the
 * first shipped schema, so there is nothing to migrate from yet; this is the
 * seam future migrations hook into (bump CURRENT_SCHEMA_VERSION, add a case
 * here). Anything unrecognized (missing/non-numeric schemaVersion, or a
 * version newer than we know) is treated as-is and normalized defensively by
 * normalizeAnalyticsData's field-by-field coercion.
 */
export function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const version = isFiniteNumber(r.schemaVersion) ? r.schemaVersion : 0;
  if (version >= CURRENT_SCHEMA_VERSION) return raw;
  // No prior versions exist yet — future `if (version < 2) { ... }` steps go
  // here, each upgrading in place before falling through to the next.
  return raw;
}

function readRaw(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null; // missing, corrupt, or unreadable
  }
}

/**
 * Small, robust JSON store for analytics.json. Reads once on construction
 * (corrupt/missing -> defaults, never throws) and writes atomically
 * (tmp file + rename) so a crash mid-write can never corrupt the file.
 */
export class AnalyticsStore {
  filePath: string;
  data: AnalyticsData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = normalizeAnalyticsData(readRaw(filePath));
  }

  /** Re-read from disk, discarding in-memory changes since the last save. */
  reload(): void {
    this.data = normalizeAnalyticsData(readRaw(this.filePath));
  }

  save(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch {
      return false; // best-effort persistence; a failed write shouldn't crash
    }
  }

  getDay(dayKey: string): DailySnapshot {
    return this.data.dailySnapshots[dayKey] || emptyDailySnapshot();
  }

  /** Upsert one day's snapshot and persist. */
  setDay(dayKey: string, snapshot: DailySnapshot): void {
    this.data.dailySnapshots[dayKey] = snapshot;
    this.save();
  }

  /** Upsert many days' snapshots in one atomic write (the ledger scan writes
   *  a whole window at once — one file write, not one per day). */
  setDays(snapshots: Iterable<[string, DailySnapshot]>): void {
    for (const [dayKey, snapshot] of snapshots) {
      this.data.dailySnapshots[dayKey] = snapshot;
    }
    this.save();
  }

  setToolingState(tool: keyof ToolingState, state: ToolState): void {
    this.data.toolingState[tool] = state;
    this.save();
  }

  addOptimizeMilestone(m: OptimizeMilestone): void {
    this.data.optimizeMilestones.push(m);
    this.save();
  }

  setSavings(savings: SavingsState): void {
    this.data.savings = savings;
    this.save();
  }
}
