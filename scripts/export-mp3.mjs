#!/usr/bin/env node
/**
 * Offline MP3 export for previously downloaded, accessible local M4A chapters.
 * Does not authenticate to Blinkist or download/decrypt protected content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const booksDir = path.resolve(process.env.BOOKS_DIR || 'books');
const outDir = path.resolve(process.env.MP3_DIR || path.join(booksDir, 'mp3'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';

const safeFilename = (input) => String(input || 'Untitled')
  .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const safeChapterName = (name) => String(name).replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').slice(0, 140).trim() || 'Chapter';
const isValid = (file) => fs.existsSync(file) && fs.statSync(file).size > 128;
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// FFmpeg's concat demuxer supports single-quoted paths with '\'' escaping.
const quoteForFfconcat = (file) => `'${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;

function listBooks() {
  const entries = [];
  for (const list of ['saved', 'finished']) {
    const libraryDir = path.join(booksDir, list);
    if (!fs.existsSync(libraryDir)) continue;
    for (const entry of fs.readdirSync(libraryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(libraryDir, entry.name);
      const json = path.join(dir, 'book.json');
      if (!fs.existsSync(json)) continue;
      try {
        const book = JSON.parse(fs.readFileSync(json, 'utf8'));
        entries.push({ dir, book, id: entry.name });
      } catch (e) {
        console.warn(`Skipping invalid metadata: ${json}: ${e.message}`);
      }
    }
  }
  return entries;
}

function orderedTracks({ dir, book }) {
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const audioChapters = chapters.filter(c => c && typeof c.name === 'string' && c.audio);
  if (audioChapters.length) {
    return audioChapters.map(c => path.join(dir, safeChapterName(c.name) + '.m4a'));
  }
  // Support old downloads that have audio on disk but no useful chapter metadata.
  return fs.readdirSync(dir)
    .filter(file => file.toLowerCase().endsWith('.m4a'))
    .sort((a, b) => {
      const rank = f => /^introduction/i.test(f) ? 0 : /^summary/i.test(f) ? 2 : 1;
      return rank(a) - rank(b) || naturalCompare(a, b);
    }).map(file => path.join(dir, file));
}

if (!fs.existsSync(booksDir)) {
  console.error(`Books folder not found: ${booksDir}`);
  process.exit(1);
}
const books = listBooks();
let exported = 0;
let skipped = 0;
let failed = 0;
for (const entry of books) {
  const { book, id } = entry;
  const title = book.title || id;
  const author = book.author || 'Unknown Author';
  const tracks = orderedTracks(entry);
  if (!tracks.length) {
    console.warn(`Skipping ${title}: no downloaded audio chapters`);
    skipped++;
    continue;
  }
  const missing = tracks.filter(file => !isValid(file));
  if (missing.length) {
    console.warn(`Skipping ${title}: ${missing.length} of ${tracks.length} audio chapters missing or empty`);
    skipped++;
    continue;
  }
  const dest = path.join(outDir, `${safeFilename(title)} - ${safeFilename(author)} [${safeFilename(id)}].mp3`);
  if (fs.existsSync(dest) && !force) {
    console.log(`Already exported: ${dest}`);
    skipped++;
    continue;
  }
  console.log(`${dryRun ? 'Would export' : 'Exporting'} ${tracks.length} chapters → ${dest}`);
  if (dryRun) { exported++; continue; }

  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-mp3-'));
  const concatFile = path.join(tmpDir, 'chapters.ffconcat');
  const tmpOutput = path.join(outDir, `.${path.basename(dest)}.${process.pid}.tmp.mp3`);
  try {
    fs.writeFileSync(concatFile, 'ffconcat version 1.0\n' +
      tracks.map(file => `file ${quoteForFfconcat(path.resolve(file))}\n`).join(''));
    const result = spawnSync(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-vn', '-map_metadata', '-1',
      '-metadata', `title=${title}`, '-metadata', `artist=${author}`,
      '-c:a', 'libmp3lame', '-q:a', '4', '-id3v2_version', '3',
      tmpOutput,
    ], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 || !isValid(tmpOutput))
      throw new Error(result.stderr?.trim() || `FFmpeg exited with code ${result.status}`);
    fs.renameSync(tmpOutput, dest);
    exported++;
  } catch (e) {
    console.error(`Failed to export ${title}: ${e.message}`);
    failed++;
  } finally {
    fs.rmSync(tmpOutput, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
console.log(`Completed: ${exported} ${dryRun ? 'would export' : 'exported'}, ${skipped} skipped, ${failed} failed`);
if (!books.length) console.warn('No book.json files found under books/saved or books/finished.');
if (failed) process.exitCode = 1;
