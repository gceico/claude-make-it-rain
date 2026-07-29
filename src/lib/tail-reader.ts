'use strict';

import * as fs from 'fs';

/**
 * Incremental, append-only JSONL tailing shared by the Claude usage monitor
 * (lib/usage-monitor.ts) and the Codex monitor (lib/codex-monitor.ts).
 *
 * Both watch log files that only ever grow, so on each poll we read just the
 * newly appended bytes, split them on newlines, and hand back the complete
 * lines. A trailing partial line (no newline yet) is buffered and prepended on
 * the next read. If a file shrinks (truncation / rotation) the byte offset is
 * reset to 0 and the whole file is re-read; `onTruncate` lets a stateful
 * consumer (Codex) reset that file's derived state before the replay so the
 * replay reproduces identical results. Stateless consumers (Claude, which
 * dedups by requestId:messageId) can ignore it.
 */

/** Per-file tail bookkeeping: bytes consumed + any trailing partial line. */
export interface TailState {
  /** path -> byte offset already consumed */
  offsets: Map<string, number>;
  /** path -> Buffer of the trailing partial line (no newline yet) */
  partials: Map<string, Buffer>;
}

export function createTailState(): TailState {
  return { offsets: new Map(), partials: new Map() };
}

/**
 * Reads newly appended complete lines from `filePath`, invoking `onLine` for
 * each (empty lines are skipped). On truncation the offset resets to 0,
 * `onTruncate(filePath)` fires (if provided) before the re-read, and the whole
 * file is replayed.
 */
export function tailFile(
  filePath: string,
  state: TailState,
  onLine: (line: Buffer) => void,
  onTruncate?: (filePath: string) => void
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  const currentSize = stat.size;

  let offset = state.offsets.get(filePath) || 0;
  if (currentSize < offset) {
    // File shrank/truncated/rotated - reset and let the consumer drop any
    // per-file derived state before we replay from the top.
    offset = 0;
    state.partials.delete(filePath);
    if (onTruncate) onTruncate(filePath);
  }
  if (currentSize <= offset) {
    state.offsets.set(filePath, offset);
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

  state.offsets.set(filePath, offset + newData.length);

  let buffer = state.partials.get(filePath) || Buffer.alloc(0);
  buffer = Buffer.concat([buffer, newData]);

  let searchStart = 0;
  let nl: number;
  while ((nl = buffer.indexOf(0x0a, searchStart)) !== -1) {
    const line = buffer.subarray(searchStart, nl);
    searchStart = nl + 1;
    if (line.length > 0) onLine(line);
  }
  // Remaining partial line (no trailing newline yet).
  const remainder = buffer.subarray(searchStart);
  if (remainder.length > 0) {
    state.partials.set(filePath, Buffer.from(remainder));
  } else {
    state.partials.delete(filePath);
  }
}
