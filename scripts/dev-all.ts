'use strict';

// `bun run start:all` — boot the full local stack in one command:
//
//   1. build the Astro landing page (web/ → web/dist, installing deps if needed)
//   2. build the Electron app (src/ → dist/ + bin/)
//   3. start the leaderboard server (serves the API *and* the landing page)
//   4. launch the Electron client pointed at that local server
//
// The client runs with MIR_API_BASE_URL so its reports and "View leaderboard…"
// menu item hit http://localhost:<port> instead of the production server, and
// with an isolated userData dir (.dev/userdata) so it neither trips the
// single-instance lock of a real running instance nor persists the local URL
// into your real config. Ctrl-C (or quitting the app) tears everything down.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8787;
const baseUrl = `http://localhost:${port}`;

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`start:all: \`${cmd} ${args.join(' ')}\` failed in ${cwd}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Landing page → web/dist (the server serves it as its static dir).
if (!existsSync(join(root, 'web', 'node_modules'))) {
  run('bun', ['install'], join(root, 'web'));
}
run('bun', ['run', 'build'], join(root, 'web'));

// 2. Electron app → dist/ + bin/.
run('bun', ['run', 'build'], root);

// 3. Leaderboard server (API + landing page) on the local port. The dev
// database lives in .dev/ so it never mixes with anything real.
const server = spawn('bun', ['server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    LEADERBOARD_DB: join(root, '.dev', 'leaderboard.db'),
  },
});

let electron: ChildProcess | null = null;
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && electron.exitCode === null) electron.kill();
  if (server.exitCode === null) server.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
server.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`start:all: server exited early (code ${code})`);
    shutdown(code ?? 1);
  }
});

// Wait until the server answers /health before launching the client.
async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`start:all: server never became healthy on ${baseUrl}`);
  shutdown(1);
}

await waitForHealth();
console.log(`start:all: leaderboard + landing page on ${baseUrl}`);

// 4. Electron client pointed at the local server. `require('electron')` from a
// non-Electron process resolves to the path of the Electron binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBinary = require('electron') as unknown as string;
electron = spawn(electronBinary, [root], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MIR_API_BASE_URL: baseUrl,
    MIR_TEST_USER_DATA: join(root, '.dev', 'userdata'),
  },
});

electron.on('exit', (code) => {
  console.log('start:all: app quit — stopping server.');
  shutdown(code ?? 0);
});
