'use strict';

// CLI launcher for the installed `claude-make-it-rain` command. Runs under the
// user's plain Node (not Electron), resolves the Electron binary path from the
// `electron` npm package, and spawns the app (detached by default; pass
// `--foreground` to stay attached and inherit stdio). Built to bin/make-it-rain.js
// with a `#!/usr/bin/env node` shebang injected at build time.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

let electronBinary: string;
try {
  // `require('electron')` from a plain Node process yields the path to the
  // Electron executable (a string), not the Electron API namespace.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  electronBinary = require('electron') as unknown as string;
} catch {
  console.error(
    'Could not load Electron. Try: npm install -g @gceico/claude-make-it-rain'
  );
  process.exit(1);
}

// Resolve the package root from the executing script's real path (following
// the npm bin symlink) rather than __dirname: Bun's bundler inlines __dirname
// as a build-time constant, which would bake the build machine's absolute
// source path into the published launcher. At runtime this file lives at
// <package>/bin/make-it-rain.js, so the app root is one directory up.
const scriptPath = fs.realpathSync(process.argv[1]);
const appPath = path.resolve(path.dirname(scriptPath), '..');
const foreground = process.argv.includes('--foreground');

const child = spawn(electronBinary, [appPath], {
  detached: !foreground,
  stdio: foreground ? 'inherit' : 'ignore',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('Failed to start make-it-rain:', err.message);
  process.exit(1);
});

if (!foreground) {
  child.unref();
} else {
  // Propagate Electron's exit status so scripts/CI can detect a failed launch.
  // 'exit' (not 'close') is correct here: stdio is inherited, so there are no
  // parent-side pipes left to flush.
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
