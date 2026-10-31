import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify-library.ts', import.meta.url));
const repository = path.dirname(path.dirname(script));
const makeTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-library-inventory-'));

function run(booksDir) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--json'], {
    cwd: repository,
    env: { ...process.env, BOOKS_DIR: booksDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return { summary: JSON.parse(result.stdout), stdout: result.stdout };
}

function addBook(booksDir, list, id, metadata) {
  const folder = path.join(booksDir, list, id);
  fs.mkdirSync(folder, { recursive: true });
  if (metadata !== undefined) {
    fs.writeFileSync(path.join(folder, 'book.json'),
      typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  }
  return folder;
}

const audioChapter = { name: 'Introduction', audio: 'https://audio.example.test/secret.m4a' };
const summaryChapter = { name: 'Summary', audio: 'https://audio.example.test/summary.m4a' };
const fakeAudio = Buffer.concat([
  Buffer.from('00000018667479704d344120','hex'), Buffer.alloc(500,1),
]);

test('local inventory distinguishes complete, partial, legacy and unreadable downloads', () => {
  const root = makeTemp();
  const booksDir = path.join(root, 'books');
  try {
    const complete = addBook(booksDir, 'saved', 'complete-en',
      { title: 'PRIVATE TITLE', readerComplete: true, chapters: [audioChapter, summaryChapter] });
    fs.writeFileSync(path.join(complete, 'Introduction.m4a'), fakeAudio);
    fs.writeFileSync(path.join(complete, 'Summary.m4a'), fakeAudio);

    addBook(booksDir, 'saved', 'incomplete-en',
      { readerComplete: false, chapters: [audioChapter] });

    const legacy = addBook(booksDir, 'finished', 'legacy-en',
      { chapters: [audioChapter] });
    fs.writeFileSync(path.join(legacy, 'Introduction.m4a'), fakeAudio);

    addBook(booksDir, 'finished', 'missing-en', undefined);
    addBook(booksDir, 'finished', 'invalid-en', 'not json');

    fs.mkdirSync(path.join(booksDir, 'mp3'));
    fs.writeFileSync(path.join(booksDir, 'mp3', 'PRIVATE title.mp3'), Buffer.alloc(512, 1));
    fs.mkdirSync(path.join(booksDir, 'm4b'));
    fs.writeFileSync(path.join(booksDir, 'm4b', 'PRIVATE title.m4b'), Buffer.alloc(512, 1));

    const { summary, stdout } = run(booksDir);
    assert.deepEqual(summary, {
      saved: 2, finished: 3, complete: 1, incomplete: 1,
      legacyUnverified: 1, missingMetadata: 1, invalidMetadata: 1,
      audioFiles: 3, mp3Files: 1, m4bFiles: 1,
    });
    assert.doesNotMatch(stdout, /PRIVATE|secret\.m4a|complete-en|legacy-en/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty inventory reports zeros without creating a download directory', () => {
  const root = makeTemp();
  const booksDir = path.join(root, 'not-created');
  try {
    const { summary } = run(booksDir);
    assert.ok(Object.values(summary).every(value => value === 0));
    assert.equal(fs.existsSync(booksDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deep verification decodes valid audio and flags corrupt files without revealing titles', {
  skip: spawnSync('ffmpeg', ['-version'], {stdio: 'ignore'}).status !== 0,
}, () => {
  const root = makeTemp();
  const booksDir = path.join(root, 'books');
  try {
    const bookDir = addBook(booksDir, 'saved', 'private-book-en', {
      title: 'PRIVATE BOOK TITLE',
      readerComplete: false,
      chapters: [],
    });
    const good = path.join(bookDir, 'Introduction.m4a');
    const conversion = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=600:duration=0.3',
      '-c:a', 'aac', good,
    ], {encoding: 'utf8'});
    assert.equal(conversion.status, 0, conversion.stderr);
    fs.writeFileSync(path.join(bookDir, 'Damaged.m4a'), fakeAudio);
    const before = fs.readdirSync(bookDir).sort();
    const command = ['--import', 'tsx', script, '--deep', '--json'];
    const result = spawnSync(process.execPath, command, {
      cwd: repository,
      env: {...process.env, BOOKS_DIR: booksDir},
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.deepVerification, {checked: 2, playable: 1, damaged: 1});
    assert.doesNotMatch(result.stdout, /PRIVATE BOOK TITLE|private-book-en|Damaged\.m4a/);
    assert.deepEqual(fs.readdirSync(bookDir).sort(), before);

    const details = spawnSync(process.execPath, [...command, '--details'], {
      cwd: repository, env: {...process.env, BOOKS_DIR: booksDir}, encoding: 'utf8',
    });
    assert.equal(details.status, 1);
    assert.match(details.stderr, /Damaged\.m4a/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
