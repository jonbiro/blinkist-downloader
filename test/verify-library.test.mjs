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

test('local inventory distinguishes complete, partial, legacy and unreadable downloads', () => {
  const root = makeTemp();
  const booksDir = path.join(root, 'books');
  try {
    const complete = addBook(booksDir, 'saved', 'complete-en',
      { title: 'PRIVATE TITLE', readerComplete: true, chapters: [audioChapter] });
    fs.writeFileSync(path.join(complete, 'Introduction.m4a'), Buffer.alloc(512, 1));

    addBook(booksDir, 'saved', 'incomplete-en',
      { readerComplete: false, chapters: [audioChapter] });

    const legacy = addBook(booksDir, 'finished', 'legacy-en',
      { chapters: [audioChapter] });
    fs.writeFileSync(path.join(legacy, 'Introduction.m4a'), Buffer.alloc(512, 1));

    addBook(booksDir, 'finished', 'missing-en', undefined);
    addBook(booksDir, 'finished', 'invalid-en', 'not json');

    fs.mkdirSync(path.join(booksDir, 'mp3'));
    fs.writeFileSync(path.join(booksDir, 'mp3', 'PRIVATE title.mp3'), Buffer.alloc(512, 1));

    const { summary, stdout } = run(booksDir);
    assert.deepEqual(summary, {
      saved: 2, finished: 3, complete: 1, incomplete: 1,
      legacyUnverified: 1, missingMetadata: 1, invalidMetadata: 1,
      audioFiles: 2, mp3Files: 1,
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
