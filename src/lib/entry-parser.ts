'use strict';

import * as crypto from 'crypto';
import type { CacheCreationBreakdown, Usage } from './pricing';

const intValue = (v: unknown): number =>
  typeof v === 'number' && isFinite(v) ? Math.trunc(v) : 0;

/** A normalized assistant-usage entry parsed from one JSONL log line. */
export interface ParsedEntry {
  timestamp: Date;
  key: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  usage: Usage;
}

/**
 * Parses a single *.jsonl line into a normalized assistant-usage entry.
 *
 * Shared by the live monitor (lib/usage-monitor.ts) and the retroactive
 * history scanner (lib/history.ts) so the parse + dedup-key logic lives in
 * exactly one place. Returns `null` for anything that is not a well-formed
 * assistant entry carrying a usage object.
 *
 * The returned object intentionally does NOT apply any date-window filtering;
 * callers decide which timestamps they care about. `usage` is shaped for
 * `costForEntry` in lib/pricing.ts.
 *
 * @param line one JSONL record (no trailing newline required)
 */
export function parseUsageEntry(line: string | Buffer): ParsedEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== 'assistant') return null;
  if (typeof rec.timestamp !== 'string') return null;
  const message = rec.message;
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const usageDict = msg.usage;
  if (!usageDict || typeof usageDict !== 'object') return null;
  const u = usageDict as Record<string, unknown>;

  const timestamp = new Date(rec.timestamp);
  if (isNaN(timestamp.getTime())) return null;

  // Dedup key: requestId:messageId, matching how ccusage deduplicates.
  // When message.id is absent, fall back to the entry's stable top-level
  // `uuid` (every Claude Code log line has one) before a random UUID. A
  // deterministic fallback is important: if a file is truncated/rotated the
  // byte offset resets to 0 and every line is re-read, so a random key would
  // let an id-less entry double-count on the re-scan. `uuid` is unique per
  // log line, so it never over-dedups distinct entries either.
  const requestId = typeof rec.requestId === 'string' ? rec.requestId : '';
  const msgId =
    (typeof msg.id === 'string' && msg.id) ||
    (typeof rec.uuid === 'string' && rec.uuid) ||
    crypto.randomUUID();
  const key = requestId + ':' + msgId;

  const inputTokens = intValue(u.input_tokens);
  const outputTokens = intValue(u.output_tokens);
  const cacheReadInputTokens = intValue(u.cache_read_input_tokens);
  const cacheCreationInputTokens = intValue(u.cache_creation_input_tokens);

  let cacheCreationBreakdown: CacheCreationBreakdown | null = null;
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') {
    const ccRec = cc as Record<string, unknown>;
    cacheCreationBreakdown = {
      ephemeral5mInputTokens: intValue(ccRec.ephemeral_5m_input_tokens),
      ephemeral1hInputTokens: intValue(ccRec.ephemeral_1h_input_tokens),
    };
  }

  const model = typeof msg.model === 'string' ? msg.model : null;

  return {
    timestamp,
    key,
    model,
    inputTokens,
    outputTokens,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      cacheCreationBreakdown,
    },
  };
}
