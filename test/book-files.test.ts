import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  audioFileName, audioFilePath, confirmedReaderEnd, inferChapterLabel, isCompleteManifest, selectAudioFileName, validBookId,
} from '../lib/book-files.js';

test('partial reader traversal and missing tracks cannot count as complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-manifest-test-'));
  try {
    const chapter = { name: 'Introduction', audio: 'https://example.test/intro.m4a' };
    fs.writeFileSync(path.join(dir, 'Introduction.m4a'), new Uint8Array(500).fill(1));
    const book = { readerComplete: false, chapters: [chapter] };
    assert.equal(isCompleteManifest(book, dir), false);
    book.readerComplete = true;
    assert.equal(isCompleteManifest(book, dir), true);
    assert.equal(isCompleteManifest({ ...book, chapters: [chapter, { name: 'Key idea 1', audio: chapter.audio }] }, dir), false);
    assert.equal(isCompleteManifest({ readerComplete: true, chapters: [{ name: 'Introduction', audio: null }] }, dir), false);
    assert.equal(isCompleteManifest({ readerComplete: true, chapters: [] }, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated chapter names get unique media filenames and prior downloads can be reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-names-test-'));
  try {
    const chapter = { name: 'Summary', audio: 'https://example.test/a.m4a' };
    fs.writeFileSync(path.join(dir, 'Summary.m4a'), new Uint8Array(500).fill(1));
    const used = new Set<string>();
    const first = selectAudioFileName(chapter, 0, dir, used);
    const second = selectAudioFileName(chapter, 1, dir, used);
    assert.equal(first, 'Summary.m4a');
    assert.equal(second, '002 - Summary.m4a');
    assert.notEqual(first, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('untrusted filenames cannot escape the book directory', () => {
  const folder = '/tmp/book';
  assert.equal(audioFileName({ name: 'Safe', fileName: '../secrets.m4a' }), null);
  assert.equal(audioFilePath(folder, { name: 'Safe', fileName: '/tmp/secrets.m4a' }), null);
  assert.equal(audioFileName({ name: 'Key / idea', audio: 'x' }), 'Key _ idea.m4a');
  assert.equal(validBookId('../other'), false);
  assert.equal(validBookId('how-to-talk-to-anyone-en'), true);
});

test('reader cannot claim completion just because the Next control disappeared', () => {
  assert.equal(confirmedReaderEnd('Introduction', 1), false);
  assert.equal(confirmedReaderEnd('Summary', 1), false);
  assert.equal(confirmedReaderEnd('Key idea 2', 3), false);
  assert.equal(confirmedReaderEnd('Summary', 4), true);
});

test('missing chapter labels are not silently misclassified as final Summary', () => {
  assert.equal(inferChapterLabel(null, 'Key idea 3'), 'Unknown');
  assert.equal(inferChapterLabel(null, null), 'Unknown');
  assert.equal(inferChapterLabel(null, 'Summary'), 'Summary');
  assert.equal(inferChapterLabel(null, 'Conclusion'), 'Summary');
  assert.equal(inferChapterLabel('  Key idea 4  ', 'Summary'), 'Key idea 4');
});
