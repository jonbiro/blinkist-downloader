import * as dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { parseMaxBooks } from './lib/run-options.js';

dotenv.config({ path: '.env' }); // loads env vars from file - will not set vars that are already set, i.e., can overwrite values from file by prefixing, e.g., VAR=VAL node ...

// Options - also see table in README.md
export const cfg = {
  debug: process.env.PWDEBUG == '1', // runs non-headless and opens https://playwright.dev/docs/inspector
  record: process.env.RECORD == '1', // `recordHar` (network) + `recordVideo`
  dryrun: process.env.DRYRUN == '1', // don't save anything
  show: process.env.SHOW != '0', // run non-headless by default to avoid captcha, TODO make headless work
  get headless() { return !this.debug && !this.show },
  width: Number(process.env.WIDTH) || 1280, // width of the opened browser
  height: Number(process.env.HEIGHT) || 1280, // height of the opened browser
  timeout: (Number(process.env.TIMEOUT) || 30) * 1000, // default timeout for playwright is 30s
  browserDir: process.env.BROWSER_DIR || 'browser', // for multiple accounts or testing
  booksDir: process.env.BOOKS_DIR || 'books', // same library directory as the Python backend and offline exporter
  // Prefer installed Chrome on macOS; upstream's pinned 2024 Chromium build may no longer download.
  browserChannel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'chrome' : undefined),
  update: process.env.UPDATE != '0', // set to 0 to disable updating library
  checkall: process.env.CHECKALL != '0', // full scan by default; set 0 only if your library is strictly append-only
  maxBooks: parseMaxBooks(process.env.MAX_BOOKS), // 1 pending book by default; explicit 0 = unlimited
  download: process.env.DOWNLOAD != '0', // set to 0 to disable downloading books
  audio: process.env.AUDIO != '0', // set to 0 to disable downloading audio
  captureAudio: process.env.CAPTURE_AUDIO != '0', // observe ordinary HTTPS audio responses when reader exposes blob: sources
  diagnose: process.env.DIAGNOSE == '1', // optional redacted selector diagnostics; no page HTML, URLs, cookies, or signed tokens
};
