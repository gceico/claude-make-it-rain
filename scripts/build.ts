'use strict';

// Build the Electron app from TypeScript sources with `bun build`.
//
// Electron embeds its own Node and cannot run on Bun, so Bun is only the
// bundler here: it compiles the TS sources to plain CommonJS JavaScript that
// Electron loads. Outputs:
//   dist/main.js      — Electron main process (loaded via package.json "main")
//   dist/preload.js   — standalone CJS preload for the overlay renderer
//   bin/make-it-rain.js — CLI launcher (node shebang, executable)
// `electron` stays external in every bundle (it is a runtime require, never
// inlined).

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SHEBANG = '#!/usr/bin/env node\n';

async function run(): Promise<void> {
  // main + preload → dist/ (standalone CJS; electron external)
  const appBuild = await Bun.build({
    entrypoints: ['src/main.ts', 'src/preload.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (!appBuild.success) {
    for (const log of appBuild.logs) console.error(log);
    process.exit(1);
  }

  // CLI launcher → bin/make-it-rain.js (electron external — resolved at runtime)
  const cliBuild = await Bun.build({
    entrypoints: ['src/bin/make-it-rain.ts'],
    outdir: 'bin',
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (!cliBuild.success) {
    for (const log of cliBuild.logs) console.error(log);
    process.exit(1);
  }

  // Ensure the CLI is a valid, executable node script with a shebang. Bun does
  // not emit one for a bundled entrypoint, so inject it if missing.
  const cliPath = 'bin/make-it-rain.js';
  const code = readFileSync(cliPath, 'utf8');
  if (!code.startsWith('#!')) {
    writeFileSync(cliPath, SHEBANG + code);
  }
  chmodSync(cliPath, 0o755);

  // Guard against machine-specific paths leaking into the artifacts: Bun's
  // bundler inlines __dirname/__filename as build-time constants, so any use
  // of them in src/ would bake this checkout's absolute path into files that
  // ship to other machines. Sources must resolve paths at runtime instead
  // (app.getAppPath() in Electron code, process.argv[1] in the CLI).
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const out of ['dist/main.js', 'dist/preload.js', cliPath]) {
    if (readFileSync(out, 'utf8').includes(repoRoot)) {
      console.error(
        `build: ${out} contains the absolute repo path (${repoRoot}) — ` +
          'a __dirname/__filename was inlined at build time.'
      );
      process.exit(1);
    }
  }

  console.log('build: dist/main.js, dist/preload.js, bin/make-it-rain.js');
}

run();
