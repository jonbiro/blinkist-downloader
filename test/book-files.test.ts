import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  audioFileName, audioFilePath, confirmedReaderEnd, inferChapterLabel, isCompleteManifest, selectAudioFileName, selectSavedManifest, validAudioFile, validBookId,
} from '../lib/book-files.js';

const exampleM4a = new Uint8Array([
  ...Buffer.from('00000018667479704d344120', 'hex'),
  ...new Uint8Array(500).fill(1),
]);

test('partial reader traversal and missing tracks cannot count as complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-manifest-test-'));
  try {
    const chapter = { name: 'Introduction', audio: 'https://example.test/intro.m4a' };
    fs.writeFileSync(path.join(dir, 'Introduction.m4a'), exampleM4a);
    fs.writeFileSync(path.join(dir, 'Summary.m4a'), exampleM4a);
    const summary = { name: 'Summary', audio: 'https://example.test/sum.m4a' };
    const book = { readerComplete: false, chapters: [chapter, summary] };
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
    fs.writeFileSync(path.join(dir, 'Summary.m4a'), exampleM4a);
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
  assert.equal(confirmedReaderEnd('Introduction', 1, true), false);
  assert.equal(confirmedReaderEnd('Summary', 1, true), false);
  assert.equal(confirmedReaderEnd('Key idea 2', 3, true), false);
  assert.equal(confirmedReaderEnd('Summary', 4, true), true);
});

test('missing chapter labels are not silently misclassified as final Summary', () => {
  assert.equal(inferChapterLabel(null, 'Key idea 3'), 'Unknown');
  assert.equal(inferChapterLabel(null, null), 'Unknown');
  assert.equal(inferChapterLabel(null, 'Summary'), 'Summary');
  assert.equal(inferChapterLabel(null, 'Conclusion'), 'Summary');
  assert.equal(inferChapterLabel('  Key idea 4  ', 'Summary'), 'Key idea 4');
});

test('cannot mark a book complete if chapter navigation starts in the middle', () => {
  assert.equal(confirmedReaderEnd('Summary', 2, false), false);
  assert.equal(confirmedReaderEnd('Summary', 10, false), false);
  assert.equal(confirmedReaderEnd('Summary', 2, true), true);
});

test('rejects fake audio despite file size and old false-positive completion markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-invalid-audio-'));
  try {
    const intro = { name: 'Introduction', audio: 'https://example.test/1.m4a' };
    const summary = { name: 'Summary', audio: 'https://example.test/2.m4a' };
    fs.writeFileSync(path.join(dir, 'Introduction.m4a'), new Uint8Array(1024).fill(1));
    fs.writeFileSync(path.join(dir, 'Summary.m4a'), exampleM4a);
    const book = { readerComplete: true, chapters: [intro, summary] };
    assert.equal(validAudioFile(path.join(dir, 'Introduction.m4a')), false);
    assert.equal(isCompleteManifest(book, dir), false);
    fs.writeFileSync(path.join(dir, 'Introduction.m4a'), exampleM4a);
    assert.equal(isCompleteManifest(book, dir), true);
    assert.equal(isCompleteManifest({ readerComplete: true, chapters: [
      { name: 'Key idea 4', audio: intro.audio }, summary,
    ] }, dir, false), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('interrupted retries preserve longer, more complete chapter manifests', () => {
  const previous = { readerComplete: true, chapters: [
    { name: 'Introduction', audio: 'old1' },
    { name: 'Key idea 1', audio: 'old2' },
    { name: 'Summary', audio: 'old3' },
  ], provenance: 'original' };
  const empty = { readerComplete: false, chapters: [] as {name: string; audio: string}[] };
  const suffix = { readerComplete: false, chapters: [
    { name: 'Key idea 1', audio: 'fresh2' }, { name: 'Summary', audio: 'fresh3' },
  ] };
  assert.equal(selectSavedManifest(previous, empty), previous);
  assert.equal(selectSavedManifest(previous, suffix), previous);
  const repaired = { readerComplete: true, chapters: [
    { name: 'Introduction', audio: 'new1' },
    { name: 'Key idea 1', audio: 'new2' },
    { name: 'Summary', audio: 'new3' },
  ] };
  assert.equal(selectSavedManifest(previous, repaired), repaired);
  assert.equal(selectSavedManifest(null, empty), empty);
});

test('shorter retry refreshes matching signed chapter links without losing known chapters', () => {
  const old = {readerComplete: true, chapters: [
    {name: 'Introduction', title: 'Intro', audio: 'https://cdn.test/expired', fileName: '001 - Introduction.m4a'},
    {name: 'Key idea 1', title: 'Idea', audio: 'https://cdn.test/expired2', fileName: '002 - Key idea 1.m4a'},
    {name: 'Summary', title: 'Summary', audio: 'https://cdn.test/expired3', fileName: '003 - Summary.m4a'},
  ]};
  const newPartial = {readerComplete: false, chapters: [
    {name: 'Introduction', title: 'Intro', audio: 'https://cdn.test/fresh'},
    {name: 'Key idea 1', title: 'DIFFERENT TITLE', audio: 'https://cdn.test/wrong'},
  ]};
  const chosen = selectSavedManifest(old, newPartial);
  assert.equal(chosen.chapters?.length, 3);
  assert.equal(chosen.chapters?.[0].audio, 'https://cdn.test/fresh');
  assert.equal(chosen.chapters?.[0].fileName, '001 - Introduction.m4a');
  assert.equal(chosen.chapters?.[1].audio, 'https://cdn.test/expired2');
  assert.equal(chosen.chapters?.[2].audio, 'https://cdn.test/expired3');
  assert.equal(old.chapters[0].audio, 'https://cdn.test/expired');
});
