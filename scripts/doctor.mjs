#!/usr/bin/env node
// Preflight checks only: never signs in or downloads any content.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFreeBytes, formatFreeSpace } from '../lib/storage.mjs';

const checks = [
  { name: 'Node.js 22+', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
  { name: 'FFmpeg available', ok: spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 },
  { name: 'FFprobe available', ok: spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0 },
  { name: 'npm dependencies installed', ok: existsSync(path.resolve('node_modules/tsx')) },
];
if (os.platform() === 'darwin') {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  checks.push({
    name: 'Chrome or Playwright Chromium available',
    ok: existsSync(chrome) || existsSync(path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1117')),
    detail: existsSync(chrome) ? 'Google Chrome installed' : 'May require npx playwright install chromium',
  });
}
for (const item of checks) {
  console.log((item.ok ? '✓ ' : '✗ ') + item.name + (item.detail ? ': ' + item.detail : ''));
}
const freeSpace = getFreeBytes(process.cwd());
console.log('Available local disk space: ' + formatFreeSpace(freeSpace));
if (freeSpace !== null && freeSpace < 2 * 1024 * 1024 * 1024) {
  console.warn('⚠ Low free space. Free at least 2 GiB before a bulk audiobook export; ' +
    'the exporter checks each output size and will refuse unsafe conversions.');
}
console.log('Run MAX_BOOKS=1 npm start for a one-book test after signing in.');
console.log('No Blinkist login, download, or account change was performed by this preflight.');
if (checks.some(item => !item.ok)) process.exitCode = 1;
