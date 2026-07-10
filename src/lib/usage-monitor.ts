'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { costForEntry } from './pricing';
import { parseUsageEntry } from './entry-parser';

/** Today's running spend + token totals. */
export interface Snapshot {
  totalCostUSD: number;
  inputTokens: number;
  outputTokens: number;
  entryCount: number;
}

export interface UsageMonitorOptions {
  projectsDir?: string;
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

  constructor({ projectsDir, pollMs = 3000 }: UsageMonitorOptions = {}) {
    this.projectsDir =
      projectsDir || path.join(os.homedir(), '.claude', 'projects');
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
    };
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
    if (todayStart.getTime() !== this.currentDayStart.getTime()) {
      this._resetState();
    }

    const previousTotal = this.snapshot.totalCostUSD;
    for (const file of this.discoverCandidateFiles()) {
      this.processFile(file);
    }

    const snap: Snapshot = { ...this.snapshot };
    if (isInitial && this.onInitialScanComplete)
      this.onInitialScanComplete(snap);
    if ((snap.totalCostUSD !== previousTotal || isInitial) && this.onUpdate) {
      this.onUpdate(previousTotal, snap);
    }
  }

  /** All *.jsonl under projectsDir/<project>/ modified since local day start. */
  discoverCandidateFiles(): string[] {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const result: string[] = [];
    for (const dirent of projectDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const projectDir = path.join(this.projectsDir, dirent.name);
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
    return result;
  }

  /** Incrementally reads newly appended bytes and processes complete lines. */
  processFile(filePath: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    const currentSize = stat.size;

    let offset = this.fileOffsets.get(filePath) || 0;
    if (currentSize < offset) {
      // File shrank/truncated/rotated - reset.
      offset = 0;
      this.partialLines.delete(filePath);
    }
    if (currentSize <= offset) {
      this.fileOffsets.set(filePath, offset);
      return;
    }

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return;
    }

    let newData: Buffer | null;
    try {
      const toRead = currentSize - offset;
      newData = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, newData, 0, toRead, offset);
      newData = newData.subarray(0, bytesRead);
    } catch {
      newData = null;
    } finally {
      fs.closeSync(fd);
    }
    if (!newData || newData.length === 0) return;

    this.fileOffsets.set(filePath, offset + newData.length);

    let buffer = this.partialLines.get(filePath) || Buffer.alloc(0);
    buffer = Buffer.concat([buffer, newData]);

    let searchStart = 0;
    let nl: number;
    while ((nl = buffer.indexOf(0x0a, searchStart)) !== -1) {
      const line = buffer.subarray(searchStart, nl);
      searchStart = nl + 1;
      if (line.length > 0) this.processLine(line);
    }
    // Remaining partial line (no trailing newline yet).
    const remainder = buffer.subarray(searchStart);
    if (remainder.length > 0) {
      this.partialLines.set(filePath, Buffer.from(remainder));
    } else {
      this.partialLines.delete(filePath);
    }
  }

  processLine(lineBuffer: Buffer): void {
    const parsed = parseUsageEntry(lineBuffer);
    if (!parsed) return;

    // Local-day filter.
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

    // Dedup key — computed by the shared parser (lib/entry-parser.ts), whose
    // deterministic message.id → uuid → randomUUID fallback keeps id-less
    // entries from double-counting when a truncated/rotated file is re-read.
    if (this.seenKeys.has(parsed.key)) return;
    this.seenKeys.add(parsed.key);

    this.snapshot.totalCostUSD += costForEntry(parsed.usage, parsed.model);
    this.snapshot.inputTokens += parsed.inputTokens;
    this.snapshot.outputTokens += parsed.outputTokens;
    this.snapshot.entryCount += 1;
  }
}
