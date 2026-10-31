import fs from 'node:fs';
import path from 'node:path';

export type AudioChapter = {
  name: string;
  title?: string;
  text?: string;
  audio?: string | null;
  audioSource?: 'attribute' | 'network' | 'none';
  fileName?: string;
};

export type BookManifest = {
  chapters?: AudioChapter[];
  readerComplete?: boolean;
};

export const safeChapterName = (name: string): string => {
  const clean = name.replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').trim();
  let result = '';
  for (const char of clean) {
    if (Buffer.byteLength(result + char, 'utf8') > 120) break;
    result += char;
  }
  return result.replace(/[. ]+$/g, '') || 'Chapter';
};

// A missing chapter-number element is not by itself proof that this is Summary.
export const inferChapterLabel = (number: string | null, heading: string | null): string => {
  if (number?.trim()) return number.trim();
  return /^(?:summary|conclusion)$/i.test(heading?.trim() ?? '') ? 'Summary' : 'Unknown';
};

// Finishing at Summary is NOT proof of full traversal if reset-to-Introduction failed.
export const confirmedReaderEnd = (
  name: string, visitedChapters: number, startedAtIntroduction: boolean,
): boolean =>
  name === 'Summary' && visitedChapters >= 2 && startedAtIntroduction;

export const validBookId = (id: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,160}$/i.test(id);

export const validMediaFile = (file: string): boolean => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size > 128;
  } catch {
    return false;
  }
};

// A size check alone accepts HTML/JSON error pages as audio. Recognize
// standard M4A/MP4, MP3/AAC, Ogg, WAV and WebM headers cheaply; FFprobe
// performs full decoding validation during MP3/M4B export.
export const validAudioFile = (file: string): boolean => {
  if (!validMediaFile(file)) return false;
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, 'r');
    const header = new Uint8Array(16);
    const bytes = fs.readSync(handle, header, 0, header.length, 0);
    if (bytes < 12) return false;
    const ascii = Buffer.from(header);
    const magic = ascii.toString('ascii', 0, 4);
    return ascii.toString('ascii', 4, 8) === 'ftyp'
      || magic === 'OggS'
      || magic === 'fLaC'
      || (magic === 'RIFF' && ascii.toString('ascii', 8, 12) === 'WAVE')
      || (header[0] === 0x1a && header[1] === 0x45 &&
          header[2] === 0xdf && header[3] === 0xa3)
      || ascii.toString('ascii', 0, 3) === 'ID3'
      || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
};

// Metadata is untrusted local input: filenames must never escape a book folder.
export const audioFileName = (chapter: AudioChapter): string | null => {
  if (typeof chapter.fileName === 'string') {
    const file = chapter.fileName;
    if (!/^[^\\/\x00-\x1f:*?"<>|]+\.m4a$/i.test(file) || file === '..') return null;
    return file;
  }
  if (typeof chapter.name !== 'string' || !chapter.name.trim()) return null;
  return safeChapterName(chapter.name) + '.m4a'; // Backward compatibility with older downloads.
};

export const audioFilePath = (bookDir: string, chapter: AudioChapter): string | null => {
  const fileName = audioFileName(chapter);
  return fileName ? path.join(bookDir, fileName) : null;
};

// Distinct filenames for duplicate names, while reusing previously downloaded legacy tracks.
export const selectAudioFileName = (
  chapter: AudioChapter, index: number, bookDir: string, claimed: Set<string>,
): string => {
  const name = safeChapterName(chapter.name);
  const legacy = name + '.m4a';
  const numbered = String(index + 1).padStart(3, '0') + ' - ' + name + '.m4a';
  let chosen = numbered;
  if (!claimed.has(numbered.toLowerCase()) && validAudioFile(path.join(bookDir, numbered))) {
    chosen = numbered;
  } else if (!claimed.has(legacy.toLowerCase()) && validAudioFile(path.join(bookDir, legacy))) {
    chosen = legacy;
  }
  claimed.add(chosen.toLowerCase());
  return chosen;
};

// A failed re-scan must not replace a useful chapter listing with an empty
// result or a shorter suffix. Saved audio files remain available for retry.
export const selectSavedManifest = <T extends BookManifest>(
  previous: unknown, incoming: T,
): BookManifest => {
  if (!previous || typeof previous !== 'object') return incoming;
  const old = previous as BookManifest;
  const earlier = Array.isArray(old.chapters) ? old.chapters : [];
  const latest = Array.isArray(incoming.chapters) ? incoming.chapters : [];
  if (!earlier.length) return incoming;
  if (!latest.length) return old;

  const oldFull = old.readerComplete === true && confirmedReaderEnd(
    earlier[earlier.length - 1]?.name, earlier.length, earlier[0]?.name === 'Introduction',
  );
  const newFull = incoming.readerComplete === true && confirmedReaderEnd(
    latest[latest.length - 1]?.name, latest.length, latest[0]?.name === 'Introduction',
  );
  if (newFull) return incoming;
  const keepOld = oldFull
    || (earlier[0]?.name === 'Introduction' && latest[0]?.name !== 'Introduction')
    || earlier.length > latest.length;
  if (!keepOld) return incoming;

  // Preserve the longer existing list, but retain fresh, time-limited URLs
  // from a shorter retry ONLY where chapter labels (and titles) agree.
  // File names and chapter ordering always come from the preserved manifest.
  let refreshed = false;
  const merged = earlier.map((chapter, index) => {
    const fresh = latest[index];
    if (!chapter || !fresh || chapter.name !== fresh.name ||
        (chapter.title && fresh.title && chapter.title !== fresh.title) ||
        typeof fresh.audio !== 'string' || !fresh.audio.startsWith('https://') ||
        fresh.audio === chapter.audio) return chapter;
    refreshed = true;
    return { ...chapter, audio: fresh.audio, audioSource: fresh.audioSource };
  });
  return refreshed ? { ...old, chapters: merged } : old;
};

// A reader that stopped halfway through must never be treated as fully downloaded.
export const isCompleteManifest = (
  data: unknown, bookDir: string, audioRequired = true,
): boolean => {
  if (!data || typeof data !== 'object') return false;
  const book = data as BookManifest;
  if (book.readerComplete === false) return false;
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) return false;
  // Older versions sometimes marked a mid-book suffix as complete. Audit
  // previously saved manifests as well, not just new traversals.
  if (book.readerComplete === true && !confirmedReaderEnd(
    book.chapters[book.chapters.length - 1]?.name,
    book.chapters.length,
    book.chapters[0]?.name === 'Introduction',
  )) return false;
  if (!audioRequired) return true;

  const paths = book.chapters.map(chapter =>
    chapter && typeof chapter.audio === 'string' && chapter.audio.length > 0
      ? audioFilePath(bookDir, chapter)
      : null,
  );
  return paths.every((file): file is string => Boolean(file) && validAudioFile(file!))
    && new Set(paths.map(file => file?.toLowerCase())).size === paths.length;
};
