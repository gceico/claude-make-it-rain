'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { costForEntry } = require('./pricing');

/**
 * Monitors the *.jsonl session logs under ~/.claude/projects for assistant usage entries,
 * accumulating today's estimated spend. Port of UsageMonitor.swift.
 *
 * Files are read incrementally (only newly appended bytes), entries are
 * deduplicated by requestId:messageId, and all state resets at local midnight.
 */
class UsageMonitor {
  constructor({ projectsDir, pollMs = 3000 } = {}) {
    this.projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.pollMs = pollMs;

    /** Called whenever the running total changes: (previousTotal, snapshot). */
    this.onUpdate = null;
    /** Called once after the very first scan completes: (snapshot). */
    this.onInitialScanComplete = null;

    this.timer = null;
    this._resetState();
  }

  _resetState() {
    this.fileOffsets = new Map();     // path -> byte offset consumed
    this.partialLines = new Map();    // path -> Buffer of trailing partial line
    this.seenKeys = new Set();        // requestId:messageId dedup
    this.snapshot = { totalCostUSD: 0, inputTokens: 0, outputTokens: 0, entryCount: 0 };
    this.currentDayStart = UsageMonitor.startOfToday();
  }

  static startOfToday(now = new Date()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  start() {
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(isInitial) {
    // Detect local-midnight rollover.
    const todayStart = UsageMonitor.startOfToday();
    if (todayStart.getTime() !== this.currentDayStart.getTime()) {
      this._resetState();
    }

    const previousTotal = this.snapshot.totalCostUSD;
    for (const file of this.discoverCandidateFiles()) {
      this.processFile(file);
    }

    const snap = { ...this.snapshot };
    if (isInitial && this.onInitialScanComplete) this.onInitialScanComplete(snap);
    if ((snap.totalCostUSD !== previousTotal || isInitial) && this.onUpdate) {
      this.onUpdate(previousTotal, snap);
    }
  }

  /** All *.jsonl under projectsDir/<project>/ modified since local day start. */
  discoverCandidateFiles() {
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const result = [];
    for (const dirent of projectDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const projectDir = path.join(this.projectsDir, dirent.name);
      let files;
      try {
        files = fs.readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, name);
        let stat;
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
  processFile(filePath) {
    let stat;
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

    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return;
    }

    let newData;
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
    let nl;
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

  processLine(lineBuffer) {
    let obj;
    try {
      obj = JSON.parse(lineBuffer.toString('utf8'));
    } catch {
      return;
    }
    if (!obj || obj.type !== 'assistant') return;
    if (typeof obj.timestamp !== 'string') return;
    const message = obj.message;
    if (!message || typeof message !== 'object') return;
    const usageDict = message.usage;
    if (!usageDict || typeof usageDict !== 'object') return;

    // Local-day filter.
    const timestamp = new Date(obj.timestamp);
    if (isNaN(timestamp.getTime())) return;
    const now = new Date();
    if (
      timestamp.getFullYear() !== now.getFullYear() ||
      timestamp.getMonth() !== now.getMonth() ||
      timestamp.getDate() !== now.getDate()
    ) return;
    // Also make sure it's within the tracked "today" window (handles the
    // rare race right at midnight rollover).
    if (timestamp.getTime() < this.currentDayStart.getTime()) return;

    // Dedup key: requestId:messageId, matching how ccusage deduplicates.
    // When message.id is absent, fall back to the entry's stable top-level
    // `uuid` (every Claude Code log line has one) before a random UUID. A
    // deterministic fallback is important: if a file is truncated/rotated the
    // byte offset resets to 0 and every line is re-read, so a random key would
    // let an id-less entry double-count on the re-scan. `uuid` is unique per
    // log line, so it never over-dedups distinct entries either.
    const requestId = typeof obj.requestId === 'string' ? obj.requestId : '';
    const msgId =
      (typeof message.id === 'string' && message.id) ||
      (typeof obj.uuid === 'string' && obj.uuid) ||
      crypto.randomUUID();
    const key = requestId + ':' + msgId;
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);

    const intValue = (v) => (typeof v === 'number' && isFinite(v) ? Math.trunc(v) : 0);

    const inputTokens = intValue(usageDict.input_tokens);
    const outputTokens = intValue(usageDict.output_tokens);
    const cacheReadInputTokens = intValue(usageDict.cache_read_input_tokens);
    const cacheCreationInputTokens = intValue(usageDict.cache_creation_input_tokens);

    let cacheCreationBreakdown = null;
    const cc = usageDict.cache_creation;
    if (cc && typeof cc === 'object') {
      cacheCreationBreakdown = {
        ephemeral5mInputTokens: intValue(cc.ephemeral_5m_input_tokens),
        ephemeral1hInputTokens: intValue(cc.ephemeral_1h_input_tokens),
      };
    }

    const entry = {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      cacheCreationBreakdown,
    };

    const model = typeof message.model === 'string' ? message.model : null;
    this.snapshot.totalCostUSD += costForEntry(entry, model);
    this.snapshot.inputTokens += inputTokens;
    this.snapshot.outputTokens += outputTokens;
    this.snapshot.entryCount += 1;
  }
}

module.exports = { UsageMonitor };
