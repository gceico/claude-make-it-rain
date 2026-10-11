'use strict';

import { costForEntry, pricingForCodexModel } from './pricing';
import type { Usage } from './pricing';
import { parseCodexLine } from './codex-entry-parser';
import type { CodexTokenTotals } from './codex-entry-parser';
import { createTailState, tailFile } from './tail-reader';
import type { TailState } from './tail-reader';
import { discoverCodexFiles, resolveCodexSessionsDir } from './codex-dirs';
import type { ModelBucket, UserTurn } from './usage-monitor';

/**
 * Live monitor for OpenAI Codex spend, the counterpart to lib/usage-monitor.ts.
 *
 * Codex differs from Claude Code in two ways that rule out reusing UsageMonitor
 * verbatim: the active model lives on a separate `turn_context` line (not on
 * each usage entry), and token counts are reported *cumulatively per session
 * file* rather than per-entry. So instead of accumulating de-duplicated entries
 * into a monotonic total, this monitor keeps per-file cumulative state and
 * derives the snapshot as a pure fold over that state on every tick. That makes
 * the accounting idempotent: on truncation/rotation the affected file's state
 * is reset and the file replayed, reproducing identical per-model totals — no
 * double counting, no dedup keys required.
 *
 * Only today's spend is counted. A session that spans local midnight is handled
 * by always advancing each file's `lastTotal` (even for pre-today events) while
 * attributing a delta to the running totals only when the event's own timestamp
 * falls in today's window — so today's first delta measures today's growth, not
 * the whole session's cumulative history.
 */

/** Today's Codex running spend + token totals (parallel to Snapshot). */
export interface CodexSnapshot {
  totalCostUSD: number;
  /** Non-cached input tokens, summed across models. */
  inputTokens: number;
  outputTokens: number;
  /** Cached (cache-read) input tokens, summed — feeds the combined cache view. */
  cachedInputTokens: number;
  /** Number of token_count deltas attributed to today. */
  entryCount: number;
  /** Per-model cost/token split, keyed by the raw gpt-* model id (or 'unknown'). */
  perModel: Record<string, ModelBucket>;
  sessions: { count: number; maxContextTokens: number };
  userTurns: UserTurn[];
}

export function emptyCodexSnapshot(): CodexSnapshot {
  return {
    totalCostUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    entryCount: 0,
    perModel: {},
    sessions: { count: 0, maxContextTokens: 0 },
    userTurns: [],
  };
}

export interface CodexMonitorOptions {
  /** Codex sessions root; `null` disables Codex tracking. Defaults to the real
   *  `~/.codex/sessions` when omitted (see resolveCodexSessionsDir). */
  sessionsDir?: string | null;
  pollMs?: number;
}

/** Per-file derived state, reset on truncation and at midnight. */
interface CodexFileState {
  model: string | null; // latest turn_context model
  sessionId: string | null; // from session_meta
  lastTotal: CodexTokenTotals; // last cumulative reading (zeros initially)
  // today's attributed deltas per model, plus their cost — priced per delta
  // (one request each) so long-context tiers see the request's own prompt
  perModel: Map<string, CodexTokenTotals & { costUSD: number }>;
  maxContextTokens: number; // peak per-request prompt size seen today
  activeToday: boolean; // any today delta attributed => counts as a session
  deltaCount: number; // token_count deltas attributed to today
  userTurns: UserTurn[]; // today's user turns (length only)
}

export const zeroTotals = (): CodexTokenTotals => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
});

/** Component-wise max(0, a - b): the growth of each cumulative counter. */
export function delta(
  a: CodexTokenTotals,
  b: CodexTokenTotals
): CodexTokenTotals {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    cacheWriteInputTokens: Math.max(
      0,
      a.cacheWriteInputTokens - b.cacheWriteInputTokens
    ),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  };
}

/** Codex token totals → the Usage shape costForEntry expects. Codex's
 *  `input_tokens` includes both the cached (read) and cache-write subsets, so
 *  the remainder is plain input; writes bill at the 1.25x cache-write rate.
 *  `promptTokens` is the request's own prompt size (last_token_usage), used
 *  for long-context tiers when the delta may span more than one request. */
export function mapCodexUsage(
  t: CodexTokenTotals,
  promptTokens?: number
): Usage {
  return {
    inputTokens: Math.max(
      0,
      t.inputTokens - t.cachedInputTokens - t.cacheWriteInputTokens
    ),
    outputTokens: t.outputTokens,
    cacheReadInputTokens: t.cachedInputTokens,
    cacheCreationInputTokens: t.cacheWriteInputTokens,
    cacheCreationBreakdown: null,
    promptTokens: promptTokens || undefined,
  };
}

/** Everything downstream (tray, board, habits) reads off these; if none moved,
 *  the snapshot is equivalent and needs no emit. */
function snapshotSignature(s: CodexSnapshot): string {
  return [
    s.totalCostUSD,
    s.entryCount,
    s.inputTokens,
    s.outputTokens,
    s.cachedInputTokens,
    s.sessions.count,
    s.sessions.maxContextTokens,
    s.userTurns.length,
  ].join('|');
}

export class CodexMonitor {
  sessionsDir: string | null;
  pollMs: number;

  /** Called whenever a tick recomputes the snapshot: (snapshot). No prevTotal —
   *  the combined Claude+Codex transition is tracked centrally in main.ts. */
  onUpdate: ((snapshot: CodexSnapshot) => void) | null;
  /** Called once after the very first scan completes: (snapshot). */
  onInitialScanComplete: ((snapshot: CodexSnapshot) => void) | null;

  timer: NodeJS.Timeout | null;
  /** Signature of the last snapshot handed to onUpdate (see snapshotSignature). */
  lastSignature: string | null;
  tailState!: TailState;
  fileStates!: Map<string, CodexFileState>;
  currentDayStart!: Date;

  constructor({ sessionsDir, pollMs = 3000 }: CodexMonitorOptions = {}) {
    this.sessionsDir = resolveCodexSessionsDir(sessionsDir);
    this.pollMs = pollMs;
    this.onUpdate = null;
    this.onInitialScanComplete = null;
    this.timer = null;
    this.lastSignature = null;
    this._resetState();
  }

  _resetState(): void {
    this.tailState = createTailState();
    this.fileStates = new Map();
    this.currentDayStart = CodexMonitor.startOfToday();
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
    const todayStart = CodexMonitor.startOfToday();
    if (todayStart.getTime() !== this.currentDayStart.getTime()) {
      this._resetState();
    }

    for (const file of this.discoverCandidateFiles()) {
      this.processFile(file);
    }

    const snap = this.buildSnapshot();
    if (isInitial && this.onInitialScanComplete) {
      this.onInitialScanComplete(snap);
    }
    // Emit only when something actually moved. onUpdate rebuilds the tray menu,
    // and on macOS replacing the context menu while it is open dismisses it —
    // an unconditional emit every pollMs would close the menu under the user.
    const sig = snapshotSignature(snap);
    const changed = isInitial || sig !== this.lastSignature;
    this.lastSignature = sig;
    if (changed && this.onUpdate) this.onUpdate(snap);
  }

  discoverCandidateFiles(): string[] {
    if (!this.sessionsDir) return [];
    return discoverCodexFiles(this.sessionsDir, this.currentDayStart.getTime());
  }

  processFile(filePath: string): void {
    tailFile(
      filePath,
      this.tailState,
      (line) => this.processLine(filePath, line),
      (p) => this.fileStates.delete(p) // truncation: drop derived state, replay
    );
  }

  private stateFor(filePath: string): CodexFileState {
    let s = this.fileStates.get(filePath);
    if (!s) {
      s = {
        model: null,
        sessionId: null,
        lastTotal: zeroTotals(),
        perModel: new Map(),
        maxContextTokens: 0,
        activeToday: false,
        deltaCount: 0,
        userTurns: [],
      };
      this.fileStates.set(filePath, s);
    }
    return s;
  }

  private isToday(ts: Date): boolean {
    const now = new Date();
    if (
      ts.getFullYear() !== now.getFullYear() ||
      ts.getMonth() !== now.getMonth() ||
      ts.getDate() !== now.getDate()
    )
      return false;
    return ts.getTime() >= this.currentDayStart.getTime();
  }

  processLine(filePath: string, lineBuffer: Buffer): void {
    const parsed = parseCodexLine(lineBuffer);
    if (!parsed) return;
    const s = this.stateFor(filePath);

    switch (parsed.kind) {
      case 'session_meta':
        if (parsed.sessionId) s.sessionId = parsed.sessionId;
        return;
      case 'turn_context':
        s.model = parsed.model;
        return;
      case 'user_turn':
        if (!this.isToday(parsed.timestamp)) return;
        s.userTurns.push({
          sessionId: s.sessionId,
          userTextLength: parsed.userTextLength,
          timestampMs: parsed.timestamp.getTime(),
        });
        return;
      case 'token_count': {
        const d = delta(parsed.total, s.lastTotal);
        // Always advance the cumulative baseline, even for pre-today events, so
        // today's first delta measures only today's growth (midnight-spanning
        // session) — but attribute the delta only when the event is today's.
        s.lastTotal = parsed.total;
        if (!this.isToday(parsed.timestamp)) return;

        const modelKey = s.model || 'unknown';
        const bucket = s.perModel.get(modelKey) || {
          ...zeroTotals(),
          costUSD: 0,
        };
        bucket.inputTokens += d.inputTokens;
        bucket.cachedInputTokens += d.cachedInputTokens;
        bucket.cacheWriteInputTokens += d.cacheWriteInputTokens;
        bucket.outputTokens += d.outputTokens;
        bucket.costUSD += costForEntry(
          mapCodexUsage(d, parsed.contextTokens),
          s.model,
          pricingForCodexModel
        );
        s.perModel.set(modelKey, bucket);

        if (parsed.contextTokens > s.maxContextTokens) {
          s.maxContextTokens = parsed.contextTokens;
        }
        s.activeToday = true;
        s.deltaCount += 1;
        return;
      }
    }
  }

  /** Pure fold over per-file state → today's CodexSnapshot. */
  buildSnapshot(): CodexSnapshot {
    const snap = emptyCodexSnapshot();
    for (const s of this.fileStates.values()) {
      if (s.activeToday) {
        snap.sessions.count += 1;
        snap.entryCount += s.deltaCount;
        if (s.maxContextTokens > snap.sessions.maxContextTokens) {
          snap.sessions.maxContextTokens = s.maxContextTokens;
        }
      }
      for (const [model, cum] of s.perModel) {
        const cost = cum.costUSD;
        const nonCachedInput = Math.max(
          0,
          cum.inputTokens - cum.cachedInputTokens
        );
        snap.totalCostUSD += cost;
        snap.inputTokens += nonCachedInput;
        snap.outputTokens += cum.outputTokens;
        snap.cachedInputTokens += cum.cachedInputTokens;

        const bucket = snap.perModel[model] || {
          costUSD: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        bucket.costUSD += cost;
        bucket.inputTokens += nonCachedInput;
        bucket.outputTokens += cum.outputTokens;
        snap.perModel[model] = bucket;
      }
      for (const t of s.userTurns) snap.userTurns.push(t);
    }
    return snap;
  }
}
