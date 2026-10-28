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

export const confirmedReaderEnd = (name: string, visitedChapters: number): boolean =>
  name === 'Summary' && visitedChapters >= 2;

export const validBookId = (id: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,160}$/i.test(id);

export const validMediaFile = (file: string): boolean => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 128;
  } catch {
    return false;
  }
};

// Metadata is untrusted local input: never let a filename escape its book folder.
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
  if (!claimed.has(numbered.toLowerCase()) && validMediaFile(path.join(bookDir, numbered))) {
    chosen = numbered;
  } else if (!claimed.has(legacy.toLowerCase()) && validMediaFile(path.join(bookDir, legacy))) {
    chosen = legacy;
  }
  claimed.add(chosen.toLowerCase());
  return chosen;
};

// A reader that stopped halfway through must never be treated as fully downloaded.
export const isCompleteManifest = (
  data: unknown, bookDir: string, audioRequired = true,
): boolean => {
  if (!data || typeof data !== 'object') return false;
  const book = data as BookManifest;
  if (book.readerComplete === false) return false;
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) return false;
  if (!audioRequired) return true;

  const paths = book.chapters.map(chapter =>
    chapter && typeof chapter.audio === 'string' && chapter.audio.length > 0
      ? audioFilePath(bookDir, chapter)
      : null,
  );
  return paths.every((file): file is string => Boolean(file) && validMediaFile(file!))
    && new Set(paths.map(file => file?.toLowerCase())).size === paths.length;
};
