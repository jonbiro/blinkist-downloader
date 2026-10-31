#!/usr/bin/env tsx
// Local inventory only. Never signs in, downloads, or prints private book data.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isCompleteManifest, validAudioFile, validMediaFile } from '../lib/book-files.js';

const booksDir = path.resolve(process.env.BOOKS_DIR || 'books');
const jsonOutput = process.argv.includes('--json');
const deep = process.argv.includes('--deep'); // optional full decode of local files (CPU-intensive)
const showProblems = deep && process.argv.includes('--details');
let deepChecked = 0;
let deepPlayable = 0;
let deepDamaged = 0;

function inspectAudio(file: string): void {
  if (!deep) return;
  deepChecked++;
  const goodFile = validMediaFile(file);
  const result = goodFile ? spawnSync(process.env.FFMPEG || 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', file, '-map', '0:a:0', '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 }) : null;
  if (result?.status === 0 && !result.error) deepPlayable++;
  else {
    deepDamaged++;
    if (showProblems) console.error('Invalid local media: ' + path.relative(booksDir, file));
  }
}

type Summary = {
  saved: number;
  finished: number;
  complete: number;
  incomplete: number;
  legacyUnverified: number;
  missingMetadata: number;
  invalidMetadata: number;
  audioFiles: number;
  mp3Files: number;
  m4bFiles: number;
  deepVerification?: { checked: number; playable: number; damaged: number };
};

const summary: Summary = {
  saved: 0, finished: 0, complete: 0, incomplete: 0,
  legacyUnverified: 0, missingMetadata: 0, invalidMetadata: 0,
  audioFiles: 0, mp3Files: 0, m4bFiles: 0,
};

for (const list of ['saved', 'finished'] as const) {
  const directory = path.join(booksDir, list);
  if (!fs.existsSync(directory)) continue;
  for (const folder of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    summary[list]++;
    const bookDir = path.join(directory, folder.name);
    const mediaNames = fs.readdirSync(bookDir)
      .filter(file => file.toLowerCase().endsWith('.m4a'));
    const audioFiles = mediaNames.filter(file => validAudioFile(path.join(bookDir, file)));
    summary.audioFiles += audioFiles.length;
    for (const file of mediaNames) inspectAudio(path.join(bookDir, file));

    const metadata = path.join(bookDir, 'book.json');
    if (!fs.existsSync(metadata)) {
      summary.missingMetadata++;
      continue;
    }
    let book: unknown;
    try { book = JSON.parse(fs.readFileSync(metadata, 'utf8')); }
    catch { summary.invalidMetadata++; continue; }
    if (!book || typeof book !== 'object' || Array.isArray(book)) {
      summary.invalidMetadata++;
      continue;
    }
    const record = book as { readerComplete?: boolean };
    if (isCompleteManifest(book, bookDir, true)) {
      if (record.readerComplete === true) summary.complete++;
      else summary.legacyUnverified++;
    } else {
      summary.incomplete++;
    }
  }
}

for (const [format, field, variable] of [
  ['mp3', 'mp3Files', 'MP3_DIR'],
  ['m4b', 'm4bFiles', 'M4B_DIR'],
] as const) {
  const dir = path.resolve(process.env[variable] || path.join(booksDir, format));
  if (fs.existsSync(dir)) {
    const mediaNames = fs.readdirSync(dir)
      .filter(file => file.toLowerCase().endsWith('.' + format));
    summary[field] = mediaNames.filter(file => validMediaFile(path.join(dir, file))).length;
    for (const file of mediaNames) inspectAudio(path.join(dir, file));
  }
}

if (deep) summary.deepVerification = {
  checked: deepChecked, playable: deepPlayable, damaged: deepDamaged,
};
if (deepDamaged) process.exitCode = 1;

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const total = summary.saved + summary.finished;
  console.log('Downloaded book folders: ' + total +
    ' (' + summary.saved + ' saved, ' + summary.finished + ' finished)');
  console.log('Complete (based on manifest and file presence): ' + summary.complete);
  console.log('Incomplete: ' + summary.incomplete);
  console.log('Legacy files without confirmed reader completion: ' + summary.legacyUnverified);
  console.log('Missing/invalid metadata: ' +
    (summary.missingMetadata + summary.invalidMetadata));
  console.log('Local audio chapters: ' + summary.audioFiles);
  console.log('MP3s created: ' + summary.mp3Files);
  console.log('M4B audiobooks created: ' + summary.m4bFiles);
  if (deep) {
    console.log('Deep audio verification (decoded without saving): ' +
      deepPlayable + ' passed, ' + deepDamaged + ' damaged/unreadable out of ' + deepChecked);
    if (deepDamaged) console.log('Use --deep --details to see local paths that need attention.');
  } else {
    console.log('Inventory is local-only. File presence is not proof of decodable audio.');
    console.log('Use --deep to decode-check locally saved audio without writing new media files.');
  }
}
