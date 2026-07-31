/**
 * Single source of truth for the About FAQ.
 *
 * Rendered visibly inside the About dialog (About.astro) AND emitted as
 * FAQPage JSON-LD in the document head (Layout.astro). Keeping both from one
 * array means the structured data always matches what a visitor actually sees,
 * which is what Google's structured-data guidelines require.
 *
 * Answers may contain a handful of inline HTML tags (just <a>, matching
 * Google's FAQPage guidance) — About.astro renders them with set:html.
 */
export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'What is Make It Rain?',
    a: "Make It Rain is an open-source menu-bar app that watches your AI coding agents' usage — Claude Code, Codex, and the like — and puts the day's estimated spend where you can't ignore it. Each dollar of spend flies a bill across your screen, and each $100 milestone sets off a downpour of cash. It turns a number you'd usually skip past into a cost meter you feel as it happens.",
  },
  {
    q: 'Which coding agents does it track?',
    a: 'Claude Code and OpenAI Codex, both read straight off the session logs they already write to your own disk (~/.claude/projects, including Cowork sessions, and ~/.codex/sessions). The menu bar shows one combined running total for the day, because what you care about is the bill, not which tool wrote it; the per-tool split is under "See your numbers", along with the per-model breakdown. Nothing needs configuring: if an agent is not installed, it simply contributes nothing.',
  },
  {
    q: 'What is "Optimize your spend"?',
    a: 'A local coach built into the menu bar. It watches the same privacy-safe numbers as the spend meter — token counts, cache hit rate, which tools you have installed — and surfaces one tip a day when it spots a costly habit: caching left off, a giant paste, a task run on a pricier model than it needed. It can also offer to install <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener">RTK</a>, <a href="https://github.com/JuliusBrussee/caveman" target="_blank" rel="noopener">Caveman</a>, or <a href="https://github.com/DietrichGebert/ponytail" target="_blank" rel="noopener">Ponytail</a> when one would cut your token spend, always with your confirmation first. Nothing about the tip, the numbers behind it, or which tools you have, ever leaves your machine.',
  },
  {
    q: 'Why show collective spend instead of a ranking?',
    a: 'A leaderboard that ranks who spent the most quietly rewards spending more, which is the opposite of what the app is for. So aiburn.dev shows the collective curve instead: how much everyone using AI coding agents spent today, and when the peaks and valleys hit. Your own total sits next to a tangible equivalence — a couple of burgers, a slice of a trip — so the number means something. The point is awareness, not a race.',
  },
  {
    q: 'What data does Make It Rain send to the board?',
    a: "Only a random tag like TurboLlama7392 (which you can reroll any time) and today's estimated total ever leave your machine, and the board resets every day (UTC). The server keeps just an aggregate hourly curve, no per-user history. There is no account, no email, no prompts, and nothing that points back at you. Reporting is optional, and disabling it stops all network activity.",
  },
  {
    q: 'Is Make It Rain free and open source?',
    a: 'Yes. Make It Rain is free and open source, it runs on your own machine, and even the collective-spend server is a few hundred dependency-free lines you can run yourself.',
  },
  {
    q: 'How accurate is the spend figure?',
    a: 'The dollar figure is a rough estimate on purpose. The point is attention, not accounting. It should make you feel the spend as it happens, not reconcile against an invoice.',
  },
  {
    q: 'Can you cheat the collective board?',
    a: "You could pad your own number, up to a $10,000-a-day sanity cap, because a self-reported figure has no referee. But there's nothing to win: the board is a shared curve, not a ranking, so one inflated total barely moves it and impresses no one. Lying just means lying about your own bill — and unlearning that habit is the reason the app exists.",
  },
];
