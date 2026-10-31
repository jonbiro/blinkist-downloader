#!/usr/bin/env node
// Optional convenience launcher. Camoufox itself runs entirely in Python;
// this only selects the project's Python virtual environment for npm commands.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const localPython = path.resolve(
  '.venv-camoufox',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const python = process.env.CAMOUFOX_PYTHON
  || (fs.existsSync(localPython) ? localPython : 'python3');
const args = process.argv.slice(2);
const offlineTests = args[0] === '--offline-tests';
const command = offlineTests
  ? ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_camoufox_backend.py', '-v']
  : ['-m', 'camoufox_backend', ...args];

const result = spawnSync(python, command, {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) {
  console.error('Camoufox Python launcher failed:', result.error.message);
  console.error('Install the optional Python environment described in docs/CAMOUFOX.md');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
