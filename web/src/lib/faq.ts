/**
 * Single source of truth for the About FAQ.
 *
 * Rendered visibly inside the About dialog (About.astro) AND emitted as
 * FAQPage JSON-LD in the document head (Layout.astro). Keeping both from one
 * array means the structured data always matches what a visitor actually sees,
 * which is what Google's structured-data guidelines require.
 */
export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'What is Make It Rain?',
    a: "Make It Rain is an open-source menu-bar app that watches your Claude Code usage and puts the day's estimated spend where you can't ignore it. Each dollar of spend flies a bill across your screen, and each $100 milestone sets off a downpour of cash. It turns a number you'd usually skip past into a cost meter you feel as it happens.",
  },
  {
    q: 'What data does Make It Rain send to the leaderboard?',
    a: "Only a random tag like TurboLlama7392 (which you can reroll any time) and today's estimated total ever leave your machine, and the leaderboard resets every day (UTC). There is no account, no email, no prompts, and nothing that points back at you. Leaderboard reporting is optional, and disabling it stops all network activity.",
  },
  {
    q: 'Is Make It Rain free and open source?',
    a: 'Yes. Make It Rain is free and open source, it runs on your own machine, and even the leaderboard server is a few hundred dependency-free lines you can run yourself.',
  },
  {
    q: 'How accurate is the Claude Code spend figure?',
    a: 'The dollar figure is a rough estimate on purpose. The point is attention, not accounting. It should make you feel the spend as it happens, not reconcile against an invoice.',
  },
  {
    q: 'Can you cheat on the leaderboard?',
    a: 'You could. The board takes your word for it, up to a $10,000-a-day sanity cap, because a self-reported number has no referee. But padding your burn to impress strangers means lying about your own bill, and unlearning that habit is the reason the app exists.',
  },
];
