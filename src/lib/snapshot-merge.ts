'use strict';

import type { ModelBucket, Snapshot } from './usage-monitor';
import type { CodexSnapshot } from './codex-monitor';

/**
 * Folds a Codex snapshot into a Claude snapshot to produce ONE combined
 * `Snapshot` in the exact existing shape. This is the single seam that lets the
 * whole downstream pipeline — tray title, milestone animations, leaderboard
 * report, habit detectors, analytics — treat both coding agents as one running
 * total without any awareness that a second source exists.
 *
 * Model/tool identity never leaves the machine (the board stores only a USD
 * total), so combining is just arithmetic:
 *  - dollars and tokens sum;
 *  - `perModel` is a union — Codex's `gpt-*` keys never collide with Claude's,
 *    so the combined per-model view naturally separates the two tools for the
 *    local "See your numbers" breakdown;
 *  - Codex's cached-input feeds the combined cache-read total (Codex has no
 *    cache-*creation* concept);
 *  - user turns concatenate (giant-paste / rage-retry habits apply to both);
 *  - `fileReads` concatenates too — Codex always contributes an empty array
 *    (its rollout logs have no Read-tool-result equivalent), so this is a
 *    no-op for Codex but keeps big-file-reads correct for Claude;
 *  - `sessionGaps` stays Claude-only: the stale-cache-idle detector keys off a
 *    >5min gap followed by a cache-*creation* spike, which Codex never emits, so
 *    that one habit simply never counts Codex sessions;
 *  - `projectDirs` stays Claude-only too, same reasoning: it exists solely to
 *    resolve CLAUDE.md chains for the bloated-claude-md habit, a Claude Code
 *    concept Codex has no equivalent of;
 *  - `agentsMdLines` is the mirror image: Claude always contributes 0 (no
 *    AGENTS.md concept), so the merged value is simply codex.agentsMdLines —
 *    Codex writes the exact instructions block it loaded straight into the
 *    transcript (see codex-entry-parser.ts's agents_md record), so unlike
 *    CLAUDE.md this needs no disk read/resolution step at all.
 */
export function mergeSnapshots(
  claude: Snapshot,
  codex: CodexSnapshot
): Snapshot {
  const perModel: Record<string, ModelBucket> = {};
  const add = (src: Record<string, ModelBucket>): void => {
    for (const [model, b] of Object.entries(src)) {
      const bucket = perModel[model] || {
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      bucket.costUSD += b.costUSD;
      bucket.inputTokens += b.inputTokens;
      bucket.outputTokens += b.outputTokens;
      perModel[model] = bucket;
    }
  };
  add(claude.perModel);
  add(codex.perModel);

  return {
    totalCostUSD: claude.totalCostUSD + codex.totalCostUSD,
    inputTokens: claude.inputTokens + codex.inputTokens,
    outputTokens: claude.outputTokens + codex.outputTokens,
    entryCount: claude.entryCount + codex.entryCount,
    perModel,
    cache: {
      // Codex cached_input_tokens are cache reads; it has no cache-creation.
      readTokens: claude.cache.readTokens + codex.cachedInputTokens,
      creationTokens: claude.cache.creationTokens,
    },
    sessions: {
      count: claude.sessions.count + codex.sessions.count,
      maxContextTokens: Math.max(
        claude.sessions.maxContextTokens,
        codex.sessions.maxContextTokens
      ),
    },
    userTurns: [...claude.userTurns, ...codex.userTurns],
    fileReads: [...claude.fileReads, ...codex.fileReads],
    // Claude-only — see the doc comment above.
    sessionGaps: claude.sessionGaps,
    projectDirs: claude.projectDirs,
    // Codex-only, mirror image of projectDirs/sessionGaps — see doc comment.
    agentsMdLines: codex.agentsMdLines,
  };
}
