#!/usr/bin/env tsx
// Local inventory only. Never signs in, downloads, or prints private book data.
import fs from 'node:fs';
import path from 'node:path';
import { isCompleteManifest, validMediaFile } from '../lib/book-files.js';

const booksDir = path.resolve(process.env.BOOKS_DIR || 'books');
const jsonOutput = process.argv.includes('--json');

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
    const audioFiles = fs.readdirSync(bookDir)
      .filter(file => file.toLowerCase().endsWith('.m4a') &&
        validMediaFile(path.join(bookDir, file)));
    summary.audioFiles += audioFiles.length;

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
    summary[field] = fs.readdirSync(dir)
      .filter(file => file.toLowerCase().endsWith('.' + format) &&
        validMediaFile(path.join(dir, file))).length;
  }
}

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
  console.log('Inventory is local-only. File presence is not proof of decodable audio.');
}
