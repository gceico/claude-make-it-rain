'use strict';

import * as crypto from 'crypto';
import type { CacheCreationBreakdown, Usage } from './pricing';

const intValue = (v: unknown): number =>
  typeof v === 'number' && isFinite(v) ? Math.trunc(v) : 0;

/**
 * One-way hash of a project directory path (`rec.cwd`), used to GROUP entries
 * by project locally (e.g. per-project habit counts) without ever storing or
 * transmitting the raw path. `sha256` truncated to 16 hex chars is plenty of
 * entropy to distinguish a user's own projects from each other while being
 * irreversible. Returns null when there is nothing to hash.
 */
export function hashProjectKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** A normalized assistant-usage entry parsed from one JSONL log line. */
export interface ParsedEntry {
  kind: 'assistant';
  timestamp: Date;
  key: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  usage: Usage;
  sessionId: string | null;
  /** Hash of the project dir — never the raw path (see hashProjectKey). */
  projectKey: string | null;
}

/**
 * A normalized user-turn entry. Only the summed character length of the
 * turn's text blocks is kept — the actual prompt text is discarded on
 * purpose so this can power content-shape habits (giant-paste, rage-retry)
 * without ever storing or transmitting prompt content.
 */
export interface ParsedUserEntry {
  kind: 'user';
  timestamp: Date;
  sessionId: string | null;
  projectKey: string | null;
  /** Summed character length of the turn's text blocks. */
  userTextLength: number;
}

/** Sum the character length of every string/`{type:'text',text}` block in a
 *  user message's `content`, which may be a plain string or an array of
 *  content blocks. Non-text blocks (images, tool_result, …) contribute 0. */
function userTextLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (typeof block === 'string') {
      total += block.length;
      continue;
    }
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        total += b.text.length;
      }
    }
  }
  return total;
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
export function parseUsageEntry(
  line: string | Buffer
): ParsedEntry | ParsedUserEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.timestamp !== 'string') return null;
  const timestampCandidate = new Date(rec.timestamp);
  if (isNaN(timestampCandidate.getTime())) return null;
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null;
  const projectKey = hashProjectKey(
    typeof rec.cwd === 'string' ? rec.cwd : null
  );

  if (rec.type === 'user') {
    const message = rec.message;
    if (!message || typeof message !== 'object') return null;
    const msg = message as Record<string, unknown>;
    return {
      kind: 'user',
      timestamp: timestampCandidate,
      sessionId,
      projectKey,
      userTextLength: userTextLength(msg.content),
    };
  }

  if (rec.type !== 'assistant') return null;
  const message = rec.message;
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const usageDict = msg.usage;
  if (!usageDict || typeof usageDict !== 'object') return null;
  const u = usageDict as Record<string, unknown>;

  const timestamp = timestampCandidate;

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
    kind: 'assistant',
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
    sessionId,
    projectKey,
  };
}
