#!/usr/bin/env node
/**
 * Offline MP3 export of previously downloaded local M4A chapters.
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
const ffprobe = process.env.FFPROBE || 'ffprobe';

const cleanName = (input) => String(input || 'Untitled')
  .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '') || 'Untitled';
const limitBytes = (name, limit) => {
  let result = '';
  for (const char of cleanName(name)) {
    if (Buffer.byteLength(result + char, 'utf8') > limit) break;
    result += char;
  }
  return result || 'Untitled';
};
const safeChapterName = (name) => String(name)
  .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').slice(0, 125).trim() || 'Chapter';
const validFile = (file) => {
  try { const info = fs.statSync(file); return info.isFile() && info.size > 128; }
  catch { return false; }
};
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const quoteForFfconcat = (file) => "'" + file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";

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
        if (!book || typeof book !== 'object' || Array.isArray(book)) {
          throw new Error('Expected a book object');
        }
        entries.push({ dir, book, id: entry.name });
      } catch (e) {
        console.warn('Skipping invalid metadata in ' + json + ': ' + e.message);
      }
    }
  }
  return entries;
}

function filenameForChapter(chapter) {
  if (typeof chapter.fileName === 'string') {
    return /^[^\\/\x00-\x1f:*?"<>|]+\.m4a$/i.test(chapter.fileName) ? chapter.fileName : null;
  }
  return typeof chapter.name === 'string' && chapter.name.trim()
    ? safeChapterName(chapter.name) + '.m4a'
    : null;
}

function orderedTracks({ dir, book }) {
  if (book.readerComplete === false) {
    return { tracks: [], reason: 'reader did not reach the final chapter' };
  }
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (chapters.length) {
    if (chapters.some(c => !c || !c.audio || !filenameForChapter(c))) {
      return { tracks: [], reason: 'missing audio URL/filename in the chapter manifest' };
    }
    const names = chapters.map(filenameForChapter);
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
      return { tracks: [], reason: 'two chapters refer to the same audio file' };
    }
    return { tracks: names.map(name => path.join(dir, name)), reason: null };
  }
  if (book.readerComplete === true) {
    return { tracks: [], reason: 'reader reported complete but produced no chapter manifest' };
  }
  // Legacy downloads (without any chapter manifest): best-effort alphabetical fallback.
  const legacy = fs.readdirSync(dir)
    .filter(file => file.toLowerCase().endsWith('.m4a'))
    .sort((a, b) => {
      const rank = f => /^introduction/i.test(f) ? 0 : /^summary/i.test(f) ? 2 : 1;
      return rank(a) - rank(b) || naturalCompare(a, b);
    }).map(file => path.join(dir, file));
  return { tracks: legacy, reason: legacy.length ? null : 'no downloaded audio chapters' };
}

function probeAudio(file) {
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0 || result.error) return null;
  try {
    const info = JSON.parse(result.stdout);
    if (info.streams?.[0]?.codec_type !== 'audio') return null;
    const duration = Number(info.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

if (!fs.existsSync(booksDir)) {
  console.error('Books folder not found: ' + booksDir);
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
  const { tracks, reason } = orderedTracks(entry);
  if (reason || !tracks.length) {
    console.warn('Skipping ' + title + ': ' + (reason || 'no audio chapters'));
    skipped++;
    continue;
  }
  const missing = tracks.filter(file => !validFile(file));
  if (missing.length) {
    console.warn('Skipping ' + title + ': ' + missing.length + ' of ' + tracks.length + ' audio chapters missing or empty');
    skipped++;
    continue;
  }
  const fileName = limitBytes(title, 100) + ' - ' + limitBytes(author, 55) +
    ' [' + limitBytes(id, 45) + '].mp3';
  const dest = path.join(outDir, fileName);
  if (fs.existsSync(dest) && !force) {
    console.log('Already exported: ' + dest);
    skipped++;
    continue;
  }
  const durations = tracks.map(probeAudio);
  if (durations.some(duration => duration === null)) {
    console.warn('Skipping ' + title + ': one or more chapter files are not valid audio');
    skipped++;
    continue;
  }
  console.log((dryRun ? 'Would export ' : 'Exporting ') + tracks.length + ' chapters → ' + dest);
  if (dryRun) { exported++; continue; }

  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-mp3-'));
  const concatFile = path.join(tmpDir, 'chapters.ffconcat');
  const tmpOutput = path.join(outDir, '.' + path.basename(dest) + '.' + process.pid + '.tmp.mp3');
  try {
    fs.writeFileSync(concatFile, 'ffconcat version 1.0\n' +
      tracks.map(file => 'file ' + quoteForFfconcat(path.resolve(file)) + '\n').join(''));
    const result = spawnSync(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-vn', '-map_metadata', '-1',
      '-metadata', 'title=' + title, '-metadata', 'artist=' + author,
      '-c:a', 'libmp3lame', '-q:a', '4', '-id3v2_version', '3',
      tmpOutput,
    ], { encoding: 'utf8', timeout: 300000 });
    if (result.error) throw result.error;
    if (result.status !== 0 || !validFile(tmpOutput)) {
      throw new Error(result.stderr?.trim() || 'FFmpeg exited with code ' + result.status);
    }
    const outputDuration = probeAudio(tmpOutput);
    const expectedDuration = durations.reduce((sum, duration) => sum + duration, 0);
    if (!outputDuration || outputDuration < expectedDuration * 0.85) {
      throw new Error('Converted MP3 is unexpectedly short; possible missing chapters');
    }
    fs.renameSync(tmpOutput, dest);
    exported++;
  } catch (e) {
    console.error('Failed to export ' + title + ': ' + e.message);
    failed++;
  } finally {
    fs.rmSync(tmpOutput, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
console.log('Completed: ' + exported + ' ' + (dryRun ? 'would export' : 'exported') +
  ', ' + skipped + ' skipped, ' + failed + ' failed');
if (!books.length) console.warn('No book.json files found under books/saved or books/finished.');
if (failed) process.exitCode = 1;
