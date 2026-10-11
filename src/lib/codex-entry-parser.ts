'use strict';

import { hashProjectKey } from './entry-parser';

/**
 * Parser for a single line of an OpenAI Codex rollout log
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * Codex logs are heterogeneous: each line is `{timestamp, type, payload}` where
 * `type` is one of `session_meta`, `turn_context`, `response_item`, or
 * `event_msg`. Unlike Claude Code — where every assistant line carries its own
 * self-contained usage + model — Codex spreads the information a cost needs
 * across line types and reports token counts *cumulatively*:
 *
 *  - `session_meta` (first line): the session id + cwd.
 *  - `turn_context`: the model in effect for the turns that follow.
 *  - `event_msg` / `payload.type === "token_count"`: the running
 *    `total_token_usage` for the session so far (diff successive events).
 *  - `response_item` user `message`: a user prompt (we keep only its text
 *    length, never the text — see codexUserTextLength). If the message is the
 *    injected AGENTS.md instructions block instead (Codex writes the exact
 *    text it loaded into the transcript, once per session, prefixed
 *    `# AGENTS.md instructions for <path>`), it is classified as `agents_md`
 *    and we keep only its LINE COUNT — never the text, never the path in the
 *    header — same privacy stance as codexUserTextLength. It is deliberately
 *    NOT also emitted as a `user_turn`: it's an injected instruction block,
 *    not something a human typed.
 *
 * The stateful stitching (model attribution, cumulative deltas) lives in the
 * CodexMonitor; this module only classifies and extracts one line.
 */

const intValue = (v: unknown): number =>
  typeof v === 'number' && isFinite(v) ? Math.trunc(v) : 0;

/** Cumulative token totals as logged by Codex (input includes the cached and
 *  cache-write subsets; output already includes reasoning tokens). */
export interface CodexTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  /** Prompt-cache writes (gpt-5.6 / gpt-6 bill them at 1.25x input). Older
   *  Codex builds don't log the field, so it reads as 0. */
  cacheWriteInputTokens: number;
  outputTokens: number;
}

export type CodexRecord =
  | {
      kind: 'session_meta';
      sessionId: string | null;
      projectKey: string | null;
    }
  | { kind: 'turn_context'; model: string | null }
  | {
      kind: 'token_count';
      timestamp: Date;
      total: CodexTokenTotals;
      /** Prompt size of the *last* request (`last_token_usage.input_tokens`,
       *  cached subset included) — the real context size, unlike the cumulative
       *  `total`. Analogue of Claude's input + cacheRead. */
      contextTokens: number;
    }
  | { kind: 'user_turn'; timestamp: Date; userTextLength: number }
  | { kind: 'agents_md'; timestamp: Date; lines: number }
  | null;

/** Sum the character length of every `{..., text: string}` content block (or a
 *  plain string content) in a user message. Codex uses `input_text` blocks for
 *  user input, but we match on the presence of a string `text` field so the
 *  parser is resilient to block-type renames. Only the LENGTH is kept; the
 *  prompt text itself is discarded, mirroring lib/entry-parser.ts. */
function codexUserTextLength(content: unknown): number {
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
      if (typeof b.text === 'string') total += b.text.length;
    }
  }
  return total;
}

/** Prefixes Codex uses for the synthetic first-turn messages it injects as
 *  `role: "user"` (environment blurb, user instructions). They are model
 *  input, not something a human typed, so they must not count as turns.
 *  AGENTS.md gets its own prefix/kind below (agents_md) instead of living in
 *  this list, since unlike these it carries a countable signal (line count). */
const SYNTHETIC_TURN_PREFIXES = ['<environment_context', '<user_instructions'];

/** The literal header Codex writes ahead of the AGENTS.md instructions block
 *  it loaded for a session (see the module doc comment). */
const AGENTS_MD_PREFIX = '# AGENTS.md instructions for ';

/** Extracts the first text block's raw string from a response_item message's
 *  `content` (plain string, or an array of blocks each possibly carrying a
 *  string `text`). Used only to classify the message (prefix check / line
 *  count) — the string is never retained on the returned CodexRecord. */
function firstBlockText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === 'string') return block;
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') return b.text;
    }
  }
  return null;
}

function isSyntheticTurn(text: string | null): boolean {
  if (text === null) return false;
  const head = text.trimStart();
  return SYNTHETIC_TURN_PREFIXES.some((p) => head.startsWith(p));
}

/** Line count of a text block, mirroring lib/claude-md.ts's countLines (a
 *  trailing newline doesn't count as an extra empty line). */
function countTextLines(text: string): number {
  if (text === '') return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/** Parses one JSONL line into a normalized CodexRecord, or `null` for anything
 *  irrelevant to spend/habits (assistant/tool items, unknown types, malformed
 *  lines, token_count events with no usage payload). */
export function parseCodexLine(line: string | Buffer): CodexRecord {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const type = rec.type;
  const payload =
    rec.payload && typeof rec.payload === 'object'
      ? (rec.payload as Record<string, unknown>)
      : null;

  if (type === 'session_meta') {
    if (!payload)
      return { kind: 'session_meta', sessionId: null, projectKey: null };
    const sessionId = typeof payload.id === 'string' ? payload.id : null;
    const projectKey = hashProjectKey(
      typeof payload.cwd === 'string' ? payload.cwd : null
    );
    return { kind: 'session_meta', sessionId, projectKey };
  }

  if (type === 'turn_context') {
    const model =
      payload && typeof payload.model === 'string' ? payload.model : null;
    return { kind: 'turn_context', model };
  }

  // A valid timestamp is required for the two time-gated record kinds below.
  const ts = typeof rec.timestamp === 'string' ? new Date(rec.timestamp) : null;
  const tsValid = ts !== null && !isNaN(ts.getTime());

  if (type === 'event_msg' && payload && payload.type === 'token_count') {
    if (!tsValid) return null;
    const info =
      payload.info && typeof payload.info === 'object'
        ? (payload.info as Record<string, unknown>)
        : null;
    // token_count events can carry a null `info` (e.g. an interrupted turn);
    // nothing to attribute, so skip.
    const totals =
      info &&
      info.total_token_usage &&
      typeof info.total_token_usage === 'object'
        ? (info.total_token_usage as Record<string, unknown>)
        : null;
    const last =
      info && info.last_token_usage && typeof info.last_token_usage === 'object'
        ? (info.last_token_usage as Record<string, unknown>)
        : null;
    if (!totals) return null;
    return {
      kind: 'token_count',
      timestamp: ts as Date,
      total: {
        inputTokens: intValue(totals.input_tokens),
        cachedInputTokens: intValue(totals.cached_input_tokens),
        cacheWriteInputTokens: intValue(totals.cache_write_input_tokens),
        outputTokens: intValue(totals.output_tokens),
      },
      contextTokens: last ? intValue(last.input_tokens) : 0,
    };
  }

  if (type === 'response_item' && payload && payload.type === 'message') {
    if (payload.role !== 'user') return null;
    if (!tsValid) return null;
    const text = firstBlockText(payload.content);
    if (text !== null && text.trimStart().startsWith(AGENTS_MD_PREFIX)) {
      return {
        kind: 'agents_md',
        timestamp: ts as Date,
        lines: countTextLines(text),
      };
    }
    if (isSyntheticTurn(text)) return null;
    return {
      kind: 'user_turn',
      timestamp: ts as Date,
      userTextLength: codexUserTextLength(payload.content),
    };
  }

  return null;
}
