import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadMediaFile } from '../lib/media-download.js';

const audio = Uint8Array.from([
  ...Buffer.from('00000018667479704d344120', 'hex'),
  ...new Uint8Array(900).fill(0x41),
]);
const mediaUrl = 'https://media.example.test/chapter.m4a?token=private';

const response = (bytes: Uint8Array, declared = bytes.byteLength, status = 200) =>
  new Response(Uint8Array.from(bytes).buffer, {
    status,
    headers: { 'content-type': 'audio/mp4', 'content-length': String(declared) },
  });

function temporaryDestination() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkist-download-media-'));
  return { root, dest: path.join(root, 'book', 'Introduction.m4a') };
}

test('saves a complete audio response atomically', async () => {
  const { root, dest } = temporaryDestination();
  try {
    await downloadMediaFile(mediaUrl, dest, {
      attempts: 1, fetchImpl: async () => response(audio),
    });
    assert.deepEqual(fs.readFileSync(dest), Buffer.from(audio));
    assert.equal(fs.existsSync(dest + '.part'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects a truncated response without replacing an existing media file', async () => {
  const { root, dest } = temporaryDestination();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, audio);
    await assert.rejects(downloadMediaFile(mediaUrl, dest, {
      attempts: 1, fetchImpl: async () => response(audio.subarray(0, 300), audio.length),
    }), /Truncated or incomplete media response/);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from(audio));
    assert.equal(fs.existsSync(dest + '.part'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects HTTP 206 partial content, even though fetch considers it ok', async () => {
  const { root, dest } = temporaryDestination();
  try {
    await assert.rejects(downloadMediaFile(mediaUrl, dest, {
      attempts: 1, fetchImpl: async () => response(audio, audio.length, 206),
    }), /Expected full HTTP 200/);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects silent HTTPS-to-HTTP redirects and non-audio payloads', async () => {
  const { root, dest } = temporaryDestination();
  try {
    const redirected = response(audio);
    Object.defineProperty(redirected, 'url', { value: 'http://insecure.example.test/file.m4a' });
    await assert.rejects(downloadMediaFile(mediaUrl, dest, {
      attempts: 1, fetchImpl: async () => redirected,
    }), /non-HTTPS destination/);
    await assert.rejects(downloadMediaFile(mediaUrl, dest, {
      attempts: 1, fetchImpl: async () => response(new Uint8Array(800).fill(0x41)),
    }), /recognizable audio header/);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retries a transient fetch error and keeps signed URLs out of errors', async () => {
  const { root, dest } = temporaryDestination();
  try {
    let calls = 0;
    await downloadMediaFile(mediaUrl, dest, {
      attempts: 2, retryDelayMs: 0,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('transient network error');
        return response(audio);
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from(audio));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('streams audio in multiple chunks without using arrayBuffer()', async () => {
  const {root, dest} = temporaryDestination();
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(audio.subarray(0, 7));
        controller.enqueue(audio.subarray(7, 350));
        controller.enqueue(audio.subarray(350));
        controller.close();
      },
    });
    const streamed = new Response(body, {
      status: 200, headers: {'content-type': 'audio/mp4'},
    });
    Object.defineProperty(streamed, 'arrayBuffer', {
      value: () => { throw new Error('Must not buffer full media response'); },
    });
    await downloadMediaFile(mediaUrl, dest, {attempts: 1, fetchImpl: async () => streamed});
    assert.deepEqual(fs.readFileSync(dest), Buffer.from(audio));
    assert.equal(fs.existsSync(dest + '.part'), false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('stream error cleans up partial download and leaves existing audio intact', async () => {
  const {root, dest} = temporaryDestination();
  try {
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.writeFileSync(dest, audio);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(audio.subarray(0, 200));
        controller.error(new Error('connection interrupted'));
      },
    });
    await assert.rejects(downloadMediaFile(mediaUrl, dest, {
      attempts: 1,
      fetchImpl: async () => new Response(body, {
        status: 200, headers: {'content-type': 'audio/mp4'},
      }),
    }), /connection interrupted/);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from(audio));
    assert.equal(fs.existsSync(dest + '.part'), false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
