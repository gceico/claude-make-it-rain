'use strict';

const crypto = require('crypto');

const intValue = (v) => (typeof v === 'number' && isFinite(v) ? Math.trunc(v) : 0);

/**
 * Parses a single *.jsonl line into a normalized assistant-usage entry.
 *
 * Shared by the live monitor (lib/usage-monitor.js) and the retroactive
 * history scanner (lib/history.js) so the parse + dedup-key logic lives in
 * exactly one place. Returns `null` for anything that is not a well-formed
 * assistant entry carrying a usage object.
 *
 * The returned object intentionally does NOT apply any date-window filtering;
 * callers decide which timestamps they care about. `usage` is shaped for
 * `costForEntry` in lib/pricing.js.
 *
 * @param {string|Buffer} line one JSONL record (no trailing newline required)
 * @returns {?{
 *   timestamp: Date,
 *   key: string,
 *   model: ?string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   usage: {
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheReadInputTokens: number,
 *     cacheCreationInputTokens: number,
 *     cacheCreationBreakdown: ?{ephemeral5mInputTokens: number, ephemeral1hInputTokens: number}
 *   }
 * }}
 */
function parseUsageEntry(line) {
  let obj;
  try {
    obj = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || obj.type !== 'assistant') return null;
  if (typeof obj.timestamp !== 'string') return null;
  const message = obj.message;
  if (!message || typeof message !== 'object') return null;
  const usageDict = message.usage;
  if (!usageDict || typeof usageDict !== 'object') return null;

  const timestamp = new Date(obj.timestamp);
  if (isNaN(timestamp.getTime())) return null;

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

  const model = typeof message.model === 'string' ? message.model : null;

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

module.exports = { parseUsageEntry };
