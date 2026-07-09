#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

let electronBinary;
try {
  electronBinary = require('electron');
} catch {
  console.error('Could not load Electron. Try: npm install -g make-it-rain');
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');
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

if (!foreground) child.unref();
