#!/usr/bin/env node
/**
 * Offline MP3/M4B export of previously saved local M4A chapters.
 * Does not sign in, request remote media, or decrypt protected content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const listOnly = args.includes('--list');
function optionValue(flag) {
  const equals = args.find(value => value.startsWith(flag + '='));
  if (equals !== undefined) {
    const value = equals.slice(flag.length + 1).trim();
    if (!value) throw new Error('Expected a non-empty value for ' + flag);
    return value;
  }
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Expected a value for ' + flag);
  return value.trim();
}
let selectedBookId;
let searchTerm;
try {
  selectedBookId = optionValue('--book');
  searchTerm = optionValue('--search')?.toLowerCase();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const formatFlag = args.find(a => a.startsWith('--format='));
const formatIndex = args.indexOf('--format');
const format = formatFlag?.slice('--format='.length) ??
  (formatIndex >= 0 ? args[formatIndex + 1] : 'mp3');
if (!['mp3', 'm4b', 'both'].includes(format)) {
  console.error('Invalid output format. Use --format mp3, --format m4b, or --format both.');
  process.exit(2);
}
const requestedFormats = format === 'both' ? ['mp3', 'm4b'] : [format];
const booksDir = path.resolve(process.env.BOOKS_DIR || 'books');
const outputDirs = {
  mp3: path.resolve(process.env.MP3_DIR || path.join(booksDir, 'mp3')),
  m4b: path.resolve(process.env.M4B_DIR || path.join(booksDir, 'm4b')),
};
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

const cleanName = input => String(input || 'Untitled')
  .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').replace(/\s+/g, ' ')
  .trim().replace(/[. ]+$/g, '') || 'Untitled';
const limitBytes = (name, limit) => {
  let result = '';
  for (const char of cleanName(name)) {
    if (Buffer.byteLength(result + char, 'utf8') > limit) break;
    result += char;
  }
  return result || 'Untitled';
};
// Match the downloader's UTF-8 byte-bound filename limit for old audio files.
const safeChapterName = name => {
  const clean = String(name).replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').trim();
  let result = '';
  for (const char of clean) {
    if (Buffer.byteLength(result + char, 'utf8') > 120) break;
    result += char;
  }
  return result.replace(/[. ]+$/g, '') || 'Chapter';
};
const validFile = file => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 128;
  } catch {
    return false;
  }
};
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const quoteForFfconcat = file =>
  "'" + file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";

// ffmetadata treats =, ;, #, \, and newlines specially.
const escapeForFfmetadata = input => String(input ?? '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\\/g, '\\\\')
  .replace(/([=;#])/g, '\\$1');

function listBooks() {
  const entries = [];
  for (const list of ['saved', 'finished']) {
    const listDir = path.join(booksDir, list);
    if (!fs.existsSync(listDir)) continue;
    for (const entry of fs.readdirSync(listDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(listDir, entry.name);
      const manifestFile = path.join(dir, 'book.json');
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const book = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (!book || typeof book !== 'object' || Array.isArray(book)) {
          throw new Error('Expected a book object');
        }
        entries.push({ dir, book, id: entry.name, manifestFile });
      } catch (error) {
        console.warn('Skipping invalid metadata in ' + manifestFile + ': ' + error.message);
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
    return { tracks: [], chapterNames: [], reason: 'reader did not reach the final chapter' };
  }
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (book.readerComplete === true && (chapters.length < 2 ||
      chapters[0]?.name !== 'Introduction' || chapters[chapters.length - 1]?.name !== 'Summary')) {
    return { tracks: [], chapterNames: [], reason: 'saved reader manifest lacks complete Introduction-to-Summary coverage' };
  }
  if (chapters.length) {
    if (chapters.some(c => !c || !c.audio || !filenameForChapter(c))) {
      return { tracks: [], chapterNames: [], reason: 'missing audio URL/filename in the chapter manifest' };
    }
    const names = chapters.map(filenameForChapter);
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
      return { tracks: [], chapterNames: [], reason: 'two chapters refer to the same audio file' };
    }
    return {
      tracks: names.map(name => path.join(dir, name)),
      chapterNames: chapters.map((c, i) => c.name || 'Chapter ' + (i + 1)),
      reason: null,
    };
  }
  if (book.readerComplete === true) {
    return { tracks: [], chapterNames: [], reason: 'reader reported complete but produced no chapter manifest' };
  }
  // Legacy books without a chapter manifest: ordering/completeness is best-effort.
  const legacy = fs.readdirSync(dir).filter(file => file.toLowerCase().endsWith('.m4a'))
    .sort((a, b) => {
      const rank = f => /^introduction/i.test(f) ? 0 : /^summary/i.test(f) ? 2 : 1;
      return rank(a) - rank(b) || naturalCompare(a, b);
    });
  return {
    tracks: legacy.map(file => path.join(dir, file)),
    chapterNames: legacy.map(file => file.replace(/\.m4a$/i, '').replace(/^\d+\s*-\s*/, '')),
    reason: legacy.length ? null : 'no downloaded audio chapters',
  };
}

function probeMedia(file) {
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) return null;
  try {
    const info = JSON.parse(result.stdout);
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const audio = info.streams?.find(stream => stream.codec_type === 'audio');
    if (!audio) return null;
    return {
      duration,
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate) || 0,
      channels: Number(audio.channels) || 0,
      tags: info.format?.tags ?? {},
      chapters: info.chapters ?? [],
      hasCover: Boolean(info.streams?.some(stream => stream.disposition?.attached_pic === 1)),
    };
  } catch {
    return null;
  }
}

function selectCover(bookDir) {
  for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png']) {
    const file = path.join(bookDir, name);
    if (!validFile(file)) continue;
    const result = spawnSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file,
    ], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) continue;
    try {
      const streams = JSON.parse(result.stdout).streams;
      if (streams?.[0]?.codec_type === 'video' &&
          streams[0].width > 0 && streams[0].height > 0) return file;
    } catch {
      // Ignore unusable cover files; export audio without artwork instead.
    }
  }
  return null;
}

function matchesExport(file, format, details) {
  const { tracks, manifestFile, expectedDuration, title, author, chapterNames, cover } = details;
  if (!validFile(file)) return false;
  const media = probeMedia(file);
  if (!media || media.codec !== (format === 'mp3' ? 'mp3' : 'aac')) return false;
  if (media.duration < expectedDuration * 0.85 || media.duration > expectedDuration * 1.15) return false;
  if (media.tags.title !== title || media.tags.artist !== author) return false;
  if (format === 'm4b') {
    if (media.tags.album !== title || media.chapters.length !== chapterNames.length) return false;
    if (media.chapters.some((chapter, i) =>
      chapter.tags?.title !== chapterNames[i] || Number(chapter.end_time) <= Number(chapter.start_time)
    )) return false;
    if (cover && !media.hasCover) return false;
  }
  try {
    const fileModified = fs.statSync(file).mtimeMs;
    return [manifestFile, ...tracks, ...(cover && format === 'm4b' ? [cover] : [])]
      .every(input => fs.statSync(input).mtimeMs <= fileModified);
  } catch {
    return false;
  }
}

function writeChapterMetadata(dest, chapterNames, sourceInfos) {
  let start = 0;
  let metadata = ';FFMETADATA1\n';
  for (let i = 0; i < sourceInfos.length; i++) {
    const end = start + Math.max(1, Math.round(sourceInfos[i].duration * 1000));
    metadata += '[CHAPTER]\nTIMEBASE=1/1000\nSTART=' + start + '\nEND=' + end +
      '\ntitle=' + escapeForFfmetadata(chapterNames[i]) + '\n';
    start = end;
  }
  fs.writeFileSync(dest, metadata);
}

// FFmpeg's concat demuxer silently assumes identical audio stream layouts.
// If chapters differ, decode to uniform lossless PCM before the single final
// MP3/AAC encoding pass. This preserves duration without double lossy encoding.
function prepareConcatTracks(tracks, sourceInfos, tmpDir) {
  const first = sourceInfos[0];
  const compatible = sourceInfos.every(info =>
    info.codec === first.codec &&
    info.sampleRate === first.sampleRate &&
    info.channels === first.channels
  );
  if (compatible) return tracks;

  const normalized = [];
  for (const [index, file] of tracks.entries()) {
    const dest = path.join(tmpDir, String(index).padStart(3, '0') + '.wav');
    const result = spawnSync(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
      dest,
    ], { encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0 || !validFile(dest)) {
      throw new Error('Could not normalize chapter ' + (index + 1) + ': ' +
        (result.stderr?.trim() || result.error?.message || String(result.status)));
    }
    normalized.push(dest);
  }
  return normalized;
}

function transcode(format, dest, details) {
  const { tracks, title, author, chapterNames, cover, sourceInfos, expectedDuration } = details;
  const dir = outputDirs[format];
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-audio-'));
  const concatFile = path.join(tmpDir, 'chapters.ffconcat');
  const metaFile = path.join(tmpDir, 'chapters.ffmeta');
  const tmpOutput = path.join(dir, '.' + path.basename(dest) + '.' + process.pid + '.part.' + format);
  try {
    const concatTracks = prepareConcatTracks(tracks, sourceInfos, tmpDir);
    fs.writeFileSync(concatFile, 'ffconcat version 1.0\n' +
      concatTracks.map(file => 'file ' + quoteForFfconcat(path.resolve(file)) + '\n').join(''));
    const argv = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
    ];
    if (format === 'm4b') {
      writeChapterMetadata(metaFile, chapterNames, sourceInfos);
      argv.push('-f', 'ffmetadata', '-i', metaFile);
      if (cover) argv.push('-i', cover);
      argv.push(
        '-map', '0:a:0', '-map_metadata', '1', '-map_chapters', '1',
        '-metadata', 'title=' + title, '-metadata', 'artist=' + author,
        '-metadata', 'album=' + title, '-metadata', 'genre=Audiobook',
        '-c:a', 'aac', '-b:a', '96k',
      );
      if (cover) {
        argv.push('-map', '2:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
      } else {
        argv.push('-vn');
      }
      argv.push('-movflags', '+faststart', '-f', 'mp4');
    } else {
      argv.push(
        '-vn', '-map_metadata', '-1',
        '-metadata', 'title=' + title, '-metadata', 'artist=' + author,
        '-c:a', 'libmp3lame', '-q:a', '4', '-id3v2_version', '3',
      );
    }
    argv.push(tmpOutput);
    const processResult = spawnSync(ffmpeg, argv, {
      encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024,
    });
    if (processResult.error) throw processResult.error;
    if (processResult.status !== 0 || !validFile(tmpOutput)) {
      throw new Error(processResult.stderr?.trim() || 'FFmpeg exited with code ' + processResult.status);
    }
    const output = probeMedia(tmpOutput);
    if (!output || output.duration < expectedDuration * 0.85 ||
        output.duration > expectedDuration * 1.15) {
      throw new Error('Converted ' + format.toUpperCase() + ' has an unexpected duration');
    }
    if (format === 'm4b' && (!output.chapters || output.chapters.length !== chapterNames.length ||
      output.chapters.some((chapter, i) => chapter.tags?.title !== chapterNames[i]) ||
      (cover && !output.hasCover))) {
      throw new Error('M4B chapter markers or cover art did not survive conversion');
    }
    fs.renameSync(tmpOutput, dest);
    return true;
  } finally {
    fs.rmSync(tmpOutput, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Saved and Finished can both contain the same Blinkist book. Choose one
// usable copy before exporting so a second entry cannot overwrite the first.
function selectBestCopies(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.id)) groups.set(entry.id, []);
    groups.get(entry.id).push(entry);
  }

  function quality(entry) {
    const { tracks, reason } = orderedTracks(entry);
    if (reason || !tracks.length) return [0, 0, 0];
    const usable = tracks.every(file => validFile(file) && Boolean(probeMedia(file)));
    return [Number(usable), Number(entry.book.readerComplete === true), tracks.length];
  }

  const chosen = [];
  for (const candidates of groups.values()) {
    let best = candidates[0];
    if (candidates.length > 1) {
      let bestScore = quality(best);
      for (const candidate of candidates.slice(1)) {
        const candidateScore = quality(candidate);
        const better = candidateScore.findIndex((score, index) => score !== bestScore[index]);
        if (better >= 0 && candidateScore[better] > bestScore[better]) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
    }
    chosen.push(best);
  }
  return { books: chosen, duplicateCopies: entries.length - chosen.length };
}

if (!fs.existsSync(booksDir)) {
  console.error('Books folder not found: ' + booksDir);
  process.exit(1);
}
const entries = listBooks().filter(entry => {
  const title = typeof entry.book.title === 'string' ? entry.book.title : '';
  const author = typeof entry.book.author === 'string' ? entry.book.author : '';
  return (!selectedBookId || entry.id === selectedBookId) &&
    (!searchTerm || (title + ' ' + author + ' ' + entry.id).toLowerCase().includes(searchTerm));
});
const { books, duplicateCopies } = selectBestCopies(entries);
if ((selectedBookId || searchTerm) && books.length === 0) {
  console.error('No matching local books. Use --list to inspect available titles and IDs.');
  process.exit(1);
}
if (listOnly) {
  for (const book of books) {
    console.log(book.id + ' | ' + (book.book.title || 'Untitled') +
      ' | ' + (book.book.author || 'Unknown Author'));
  }
  console.log(books.length + ' local book(s) matched. No exports were created.');
  process.exit(0);
}
let exported = 0;
let skipped = duplicateCopies * requestedFormats.length;
let failed = 0;
if (duplicateCopies) {
  console.log('Skipped ' + duplicateCopies + ' redundant Saved/Finished book copies.');
}
for (const entry of books) {
  const { book, id } = entry;
  const title = typeof book.title === 'string' && book.title ? book.title : id;
  const author = typeof book.author === 'string' && book.author ? book.author : 'Unknown Author';
  const { tracks, chapterNames, reason } = orderedTracks(entry);
  if (reason || !tracks.length) {
    console.warn('Skipping ' + title + ': ' + (reason || 'no audio chapters'));
    skipped += requestedFormats.length;
    continue;
  }
  const missing = tracks.filter(file => !validFile(file));
  if (missing.length) {
    console.warn('Skipping ' + title + ': ' + missing.length +
      ' of ' + tracks.length + ' audio chapters missing or empty');
    skipped += requestedFormats.length;
    continue;
  }
  const sourceInfos = tracks.map(probeMedia);
  if (sourceInfos.some(info => info === null)) {
    console.warn('Skipping ' + title + ': one or more chapter files are not valid audio');
    skipped += requestedFormats.length;
    continue;
  }
  const expectedDuration = sourceInfos.reduce((sum, info) => sum + info.duration, 0);
  const cover = selectCover(entry.dir);
  const details = {
    tracks, chapterNames, sourceInfos, expectedDuration, title, author,
    cover, manifestFile: entry.manifestFile,
  };
  // Keep historical names for ordinary IDs. Include a stable hash when an
  // unusually long ID is truncated, so distinct books cannot overwrite each other.
  const idPrefix = limitBytes(id, 45);
  const uniqueId = Buffer.byteLength(cleanName(id), 'utf8') > 45
    ? idPrefix + '~' + createHash('sha256').update(id).digest('hex').slice(0, 12)
    : idPrefix;
  const baseName = limitBytes(title, 100) + ' - ' + limitBytes(author, 55) +
    ' [' + uniqueId + ']';

  for (const outputFormat of requestedFormats) {
    const dest = path.join(outputDirs[outputFormat], baseName + '.' + outputFormat);
    if (!force && matchesExport(dest, outputFormat, details)) {
      console.log('Already exported and verified: ' + dest);
      skipped++;
      continue;
    }
    if (fs.existsSync(dest)) {
      console.log('Rebuilding stale or invalid existing ' + outputFormat.toUpperCase() + ': ' + title);
    }
    console.log((dryRun ? 'Would export ' : 'Exporting ') + tracks.length +
      ' chapters → ' + dest);
    if (dryRun) {
      exported++;
      continue;
    }
    try {
      transcode(outputFormat, dest, details);
      exported++;
    } catch (error) {
      console.error('Failed to export ' + title + ' as ' + outputFormat + ': ' + error.message);
      failed++;
    }
  }
}
console.log('Completed: ' + exported + ' ' + (dryRun ? 'would export' : 'exported') +
  ', ' + skipped + ' skipped, ' + failed + ' failed');
if (!books.length) {
  console.warn('No book.json files found under books/saved or books/finished.');
}
if (failed) process.exitCode = 1;
