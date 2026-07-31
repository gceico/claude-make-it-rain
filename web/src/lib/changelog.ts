/**
 * Customer-facing changelog for the About dialog's "changelog" tab.
 *
 * Only main versions with a user-visible change are listed (internal
 * toolchain/CI work — the Bun port, TS7, oxlint — is skipped on purpose,
 * since it shipped with zero runtime change for end users). Keep entries
 * short: what changed, from the user's seat, not how it was built.
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  highlights: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.13',
    date: '2026-07-25',
    highlights: [
      'Tracks Cowork (local agent mode) sessions alongside regular Claude Code usage.',
      'Added Opus 5 to the pricing table.',
    ],
  },
  {
    version: '1.0.12',
    date: '2026-07-24',
    highlights: [
      'Added “Optimize your spend”: a local, privacy-safe coach that spots costly habits (caching left off, giant pastes, model mismatches) and suggests a fix, one tip a day — including offering to install RTK, Caveman, or Ponytail when one would help.',
      'Landing page overhaul.',
    ],
  },
  {
    version: '1.0.10',
    date: '2026-07-13',
    highlights: [
      'Replaced the competitive leaderboard with a collective-spend curve: the community’s hourly total, plus your own total translated into a tangible equivalence (burgers, a slice of a trip).',
      'Added the personal reflection view (open the board with your tag).',
    ],
  },
  {
    version: '1.0.9',
    date: '2026-07-11',
    highlights: [
      'Added this About dialog, with a searchable, SEO-indexed FAQ.',
    ],
  },
  {
    version: '1.0.3',
    date: '2026-07-09',
    highlights: ['Leaderboard shows a reset countdown and a readable date.'],
  },
  {
    version: '1.0.2',
    date: '2026-07-09',
    highlights: [
      'Added the optional daily cloud leaderboard for collective Claude Code spend.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-09',
    highlights: [
      'Initial release: a menu-bar app that estimates today’s Claude Code spend, flies a bill across the screen for every dollar, and rains cash at every $100.',
    ],
  },
];
