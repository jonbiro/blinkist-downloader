import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exporter = fileURLToPath(new URL('../scripts/export-audio.mjs', import.meta.url));
const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync('ffprobe', ['-version']).status === 0;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-m4b-test-'));
const exampleTitle = 'The Future: Plans = Progress #1';
const exampleAuthor = 'Dr. García';

function createBook(home, chapters = ['Introduction', 'Key idea = 1; #Focus', 'Summary']) {
  const dir = path.join(home, 'books', 'saved', 'focus-en');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'focus-en', title: exampleTitle, author: exampleAuthor, readerComplete: true,
    chapters: chapters.map(name => ({
      name, audio: 'https://example.invalid/audio.m4a',
    })),
  };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(manifest));
  return dir;
}

function createAudio(dir, name, frequency = 440, sampleRate = 44100) {
  const result = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=' + frequency + ':duration=0.7',
    '-ar', String(sampleRate), '-c:a', 'aac', path.join(dir, name + '.m4a'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function createCover(dir) {
  const result = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=1',
    '-frames:v', '1', path.join(dir, 'cover.png'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function run(home, format = 'm4b', extra = []) {
  return spawnSync(process.execPath, [exporter, '--format', format, ...extra], {
    cwd: home,
    env: { ...process.env, BOOKS_DIR: path.join(home, 'books') },
    encoding: 'utf8',
  });
}

function outputFile(home, format) {
  const folder = path.join(home, 'books', format);
  const files = fs.readdirSync(folder).filter(file => file.endsWith('.' + format));
  assert.equal(files.length, 1, 'Expected exactly one ' + format + ' file');
  return path.join(folder, files[0]);
}

function probe(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('creates chaptered M4B with metadata, Unicode, reserved characters and embedded cover', {
  skip: !hasTools,
}, () => {
  const home = root();
  try {
    const names = ['Introduction', 'Key idea = 1; #Focus', 'Summary'];
    const dir = createBook(home, names);
    names.forEach((name, index) => createAudio(dir, name, 400 + index * 200));
    createCover(dir);

    const result = run(home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 exported, 0 skipped, 0 failed/);

    const file = outputFile(home, 'm4b');
    const data = probe(file);
    assert.equal(data.format.tags.title, exampleTitle);
    assert.equal(data.format.tags.artist, exampleAuthor);
    assert.equal(data.format.tags.album, exampleTitle);
    assert.equal(data.format.tags.genre, 'Audiobook');
    assert.equal(data.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    assert.ok(data.streams.some(stream => stream.disposition?.attached_pic === 1), 'Cover not embedded');
    assert.deepEqual(data.chapters.map(chapter => chapter.tags.title), names);
    assert.ok(Number(data.format.duration) > 1.8);

    const rerun = run(home);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /0 exported, 1 skipped, 0 failed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('exports audiobook without artwork if cover was not downloaded', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Introduction', 'Summary']);
    createAudio(dir, 'Introduction');
    createAudio(dir, 'Summary', 800);
    const result = run(home);
    assert.equal(result.status, 0, result.stderr);
    const output = probe(outputFile(home, 'm4b'));
    assert.equal(output.chapters.length, 2);
    assert.equal(output.streams.some(stream => stream.disposition?.attached_pic === 1), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('exports both MP3 and M4B without downloading the source twice', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Introduction', 'Summary']);
    createAudio(dir, 'Introduction');
    createAudio(dir, 'Summary', 660);
    const result = run(home, 'both');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 exported, 0 skipped, 0 failed/);
    assert.equal(probe(outputFile(home, 'mp3')).streams[0].codec_name, 'mp3');
    assert.equal(probe(outputFile(home, 'm4b')).chapters.length, 2);
    assert.match(run(home, 'both').stdout, /0 exported, 2 skipped, 0 failed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('M4B dry-run never creates output and incomplete books are skipped', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Introduction', 'Summary']);
    createAudio(dir, 'Introduction');
    createAudio(dir, 'Summary', 800);
    const preview = run(home, 'm4b', ['--dry-run']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /1 would export, 0 skipped, 0 failed/);
    assert.equal(fs.existsSync(path.join(home, 'books', 'm4b')), false);

    const file = path.join(dir, 'book.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.readerComplete = false;
    fs.writeFileSync(file, JSON.stringify(manifest));
    const rejected = run(home);
    assert.match(rejected.stderr, /reader did not reach the final chapter/);
    assert.equal(fs.existsSync(path.join(home, 'books', 'm4b')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('rebuilds corrupt and stale M4B files instead of silently skipping them', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Introduction', 'Summary']);
    createAudio(dir, 'Introduction');
    createAudio(dir, 'Summary', 650);
    createCover(dir);
    assert.equal(run(home).status, 0);
    const file = outputFile(home, 'm4b');

    fs.writeFileSync(file, Buffer.alloc(1024, 5));
    const corrupt = run(home);
    assert.equal(corrupt.status, 0, corrupt.stderr);
    assert.match(corrupt.stdout, /Rebuilding stale or invalid existing M4B/);
    assert.equal(probe(file).chapters.length, 2);

    const date = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, date, date);
    const stale = run(home);
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /1 exported, 0 skipped, 0 failed/);
    assert.match(run(home).stdout, /0 exported, 1 skipped, 0 failed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('exports legacy filename-based chapters in listening order', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home);
    const manifest = path.join(dir, 'book.json');
    fs.writeFileSync(manifest, JSON.stringify({ title: 'Legacy Audiobook', author: 'Test Author' }));
    for (const [i, name] of ['Key idea 2', 'Introduction', 'Summary', 'Key idea 1'].entries()) {
      createAudio(dir, name, 350 + i * 100);
    }
    const result = run(home);
    assert.equal(result.status, 0, result.stderr);
    const data = probe(outputFile(home, 'm4b'));
    assert.deepEqual(data.chapters.map(chapter => chapter.tags.title),
      ['Introduction', 'Key idea 1', 'Key idea 2', 'Summary']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('duplicate Saved/Finished book ID is exported once without overwriting the first copy', { skip: !hasTools }, () => {
  const home = root();
  try {
    const saved = createBook(home, ['Introduction', 'Summary']);
    createAudio(saved, 'Introduction', 400);
    createAudio(saved, 'Summary', 600);

    const finished = path.join(home, 'books', 'finished', 'focus-en');
    fs.mkdirSync(finished, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'book.json'), 'utf8'));
    manifest.chapters.splice(1, 0, { name: 'Key idea 1', audio: 'https://example.invalid/audio.m4a' });
    fs.writeFileSync(path.join(finished, 'book.json'), JSON.stringify(manifest));
    createAudio(finished, 'Introduction', 800);
    createAudio(finished, 'Key idea 1', 900);
    createAudio(finished, 'Summary', 950);

    const result = run(home, 'm4b');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 exported, 1 skipped, 0 failed/);
    assert.equal(probe(outputFile(home, 'm4b')).chapters.length, 3);
    const again = run(home, 'm4b');
    assert.match(again.stdout, /0 exported, 2 skipped, 0 failed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('mixed source sample rates preserve correct audiobook duration and chapter positions', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Introduction', 'Summary']);
    createAudio(dir, 'Introduction', 440, 22050);
    createAudio(dir, 'Summary', 660, 48000);
    const result = run(home, 'm4b');
    assert.equal(result.status, 0, result.stderr);
    const info = probe(outputFile(home, 'm4b'));
    assert.ok(Math.abs(Number(info.format.duration) - 1.4) < 0.2,
      'Mixed sample rates produced incorrect total duration: ' + info.format.duration);
    assert.equal(info.chapters.length, 2);
    assert.ok(Math.abs(Number(info.chapters[1].start_time) - 0.7) < 0.12);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('rejects old false-positive reader completion that started in the middle', { skip: !hasTools }, () => {
  const home = root();
  try {
    const dir = createBook(home, ['Key idea 4', 'Summary']);
    createAudio(dir, 'Key idea 4');
    createAudio(dir, 'Summary', 650);
    const result = run(home);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /lacks complete Introduction-to-Summary coverage/);
    assert.equal(fs.existsSync(path.join(home, 'books', 'm4b')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
