import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/export-mp3.mjs', import.meta.url));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-export-test-'));

function createBook(root, chapters = ['Introduction', "Key idea '1'"]) {
  const dir = path.join(root, 'books', 'saved', 'test-title-en');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({
    id: 'test-title-en', title: 'Test / Title', author: "O'Neil", chapters: chapters.map(name => ({ name, audio: 'https://example.invalid/media.m4a' })),
  }));
  return dir;
}
function makeAudio(dir, name, frequency = 400) {
  const file = path.join(dir, name + '.m4a');
  const p = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.6`, '-c:a', 'aac', file], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
}
const runExport = (root, args = []) => spawnSync(process.execPath, [script, ...args], {
  cwd: root, env: { ...process.env, BOOKS_DIR: path.join(root, 'books') }, encoding: 'utf8',
});

test('exports chapters in order as one playable MP3 and preserves metadata', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root);
    makeAudio(dir, 'Introduction', 400);
    makeAudio(dir, "Key idea '1'", 800);
    const result = runExport(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 exported, 0 skipped, 0 failed/);
    const out = path.join(root, 'books', 'mp3');
    const files = fs.readdirSync(out).filter(file => file.endsWith('.mp3'));
    assert.equal(files.length, 1);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist', '-of', 'json', path.join(out, files[0])], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const meta = JSON.parse(probe.stdout).format;
    assert.ok(parseFloat(meta.duration) >= 1.0, meta.duration);
    assert.equal(meta.tags.title, 'Test / Title');
    assert.equal(meta.tags.artist, "O'Neil");
    const rerun = runExport(root);
    assert.match(rerun.stdout, /0 exported, 1 skipped, 0 failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incomplete books are skipped instead of exported as incomplete MP3s', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root);
    makeAudio(dir, 'Introduction');
    const result = runExport(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /1 of 2 audio chapters missing/);
    assert.equal(fs.existsSync(path.join(root, 'books', 'mp3')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dry run leaves the output directory untouched', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction']);
    makeAudio(dir, 'Introduction');
    const result = runExport(root, ['--dry-run']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Would export 1 chapters/);
    assert.equal(fs.existsSync(path.join(root, 'books', 'mp3')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incomplete reader state never produces a deceptively complete MP3', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction']);
    const manifestFile = path.join(dir, 'book.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.readerComplete = false;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    makeAudio(dir, 'Introduction');
    const result = runExport(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reader did not reach the final chapter/);
    assert.equal(fs.existsSync(path.join(root, 'books', 'mp3')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing chapter audio URL or broken media cannot be silently skipped', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction', 'Key idea 1']);
    makeAudio(dir, 'Introduction');
    makeAudio(dir, 'Key idea 1');
    const manifestFile = path.join(dir, 'book.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.readerComplete = true;
    manifest.chapters[1].audio = null;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    let result = runExport(root);
    assert.match(result.stderr, /missing audio URL/);
    manifest.chapters[1].audio = 'https://example.invalid/track.m4a';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'Key idea 1.m4a'), Buffer.alloc(1000, 3));
    result = runExport(root);
    assert.match(result.stderr, /not valid audio/);
    assert.equal(fs.existsSync(path.join(root, 'books', 'mp3')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('indexed chapter filenames work and very long titles still fit in a filename', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction', 'Summary']);
    const manifestFile = path.join(dir, 'book.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.title = '🚀'.repeat(90);
    manifest.author = 'Author'.repeat(40);
    manifest.readerComplete = true;
    manifest.chapters.forEach((c, i) => {
      c.fileName = String(i + 1).padStart(3, '0') + ' - ' + c.name + '.m4a';
      makeAudio(dir, c.fileName.slice(0, -4));
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const result = runExport(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 exported/);
    const out = fs.readdirSync(path.join(root, 'books', 'mp3'));
    assert.equal(out.length, 1);
    assert.ok(Buffer.byteLength(out[0], 'utf8') <= 230);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repairs a corrupt MP3 instead of treating its filename as success', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction', 'Summary']);
    makeAudio(dir, 'Introduction');
    makeAudio(dir, 'Summary');
    const first = runExport(root);
    assert.equal(first.status, 0, first.stderr);
    const outDir = path.join(root, 'books', 'mp3');
    const output = path.join(outDir, fs.readdirSync(outDir).find(file => file.endsWith('.mp3')));
    fs.writeFileSync(output, Buffer.alloc(1024, 1));
    const second = runExport(root);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Rebuilding stale or invalid existing MP3/);
    assert.match(second.stdout, /1 exported, 0 skipped, 0 failed/);
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', output,
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).streams[0].codec_name, 'mp3');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rebuilds an MP3 when chapter sources are newer than the old output', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const dir = createBook(root, ['Introduction']);
    makeAudio(dir, 'Introduction');
    const first = runExport(root);
    assert.equal(first.status, 0, first.stderr);
    const outDir = path.join(root, 'books', 'mp3');
    const output = path.join(outDir, fs.readdirSync(outDir).find(file => file.endsWith('.mp3')));
    // Simulates a previously-exported MP3 whose source was later updated.
    const staleDate = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(output, staleDate, staleDate);
    const second = runExport(root);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Rebuilding stale or invalid existing MP3/);
    assert.match(second.stdout, /1 exported, 0 skipped, 0 failed/);
    const third = runExport(root);
    assert.match(third.stdout, /0 exported, 1 skipped, 0 failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy chapter names with multibyte Unicode match the downloader UTF-8 limit', { skip: !hasFfmpeg }, () => {
  const root = mkRoot();
  try {
    const name = 'Überraschung 🌍 '.repeat(14);
    const dir = createBook(root, [name]);
    const maxBytes = 120;
    let safe = '';
    for (const char of name.trim()) {
      if (Buffer.byteLength(safe + char, 'utf8') > maxBytes) break;
      safe += char;
    }
    safe = safe.replace(/[. ]+$/g, '');
    makeAudio(dir, safe);
    const exported = runExport(root);
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /1 exported, 0 skipped, 0 failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
