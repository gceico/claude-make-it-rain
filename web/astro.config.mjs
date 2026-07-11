// @ts-check
import { defineConfig } from 'astro/config';

// Static site. The build output (web/dist) is served same-origin by the
// leaderboard backend, so all runtime API calls use relative URLs
// (/api/leaderboard, /api/stars). No SSR, no adapter, no UI framework.
export default defineConfig({
  // Public origin the built page is served from. Drives the canonical link and
  // absolute og:url in the layout head (used for SEO / social share cards).
  site: 'https://aiburn.dev',
  output: 'static',
  // web/dist is Astro's default outDir; kept explicit for the build contract.
  outDir: './dist',
  build: {
    // Emit hashed assets under _astro/ (same-origin).
    assets: '_astro',
    // Inline ALL CSS into <style> tags. The client script is already inlined by
    // Astro (it's tiny), so the built page is fully self-contained like the
    // original: it works under the backend's strict CSP as-is
    // (script-src/style-src 'unsafe-inline', no 'self' needed) and makes zero
    // extra asset requests beyond the same-origin favicon.
    inlineStylesheets: 'always',
  },
});
