import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page, Response } from 'playwright-chromium';
import {
  ChapterAudioMonitor, chooseAudioSource, isAudioResponse,
} from '../lib/audio-capture.js';

const pageUrl = 'https://www.blinkist.com/en/nc/reader/test-book-en';
const signed = 'https://cdn.example.com/test-book/intro.m4a?Signature=SECRET123';

function fakeResponse(url: string, contentType: string, status = 200): Response {
  return {
    url: () => url,
    headers: () => ({ 'content-type': contentType }),
    status: () => status,
  } as unknown as Response;
}

test('accepts direct HTTPS audio and media responses, not unrelated or protected streams', () => {
  assert.equal(isAudioResponse({ url: signed, status: 200, contentType: 'audio/mp4' }), true);
  assert.equal(isAudioResponse({ url: 'https://cdn.example.com/chapter.mp3', status: 206, contentType: 'application/octet-stream' }), true);
  assert.equal(isAudioResponse({ url: 'https://cdn.example.com/chapter.m4a', status: 200 }), true);
  assert.equal(isAudioResponse({ url: signed, status: 302, contentType: 'audio/mp4' }), false);
  assert.equal(isAudioResponse({ url: signed, status: 403, contentType: 'audio/mp4' }), false);
  assert.equal(isAudioResponse({ url: signed, status: 200, contentType: 'text/html' }), false);
  assert.equal(isAudioResponse({ url: 'https://cdn.example.com/audio.m3u8', status: 200, contentType: 'application/vnd.apple.mpegurl' }), false);
  assert.equal(isAudioResponse({ url: 'https://cdn.example.com/stream.mpd', status: 200, contentType: 'application/dash+xml' }), false);
  assert.equal(isAudioResponse({ url: 'blob:https://www.blinkist.com/token', status: 200, contentType: 'audio/mp4' }), false);
  assert.equal(isAudioResponse({ url: 'http://cdn.example.com/track.m4a', status: 200, contentType: 'audio/mp4' }), false);
  assert.equal(isAudioResponse({ url: 'not a url', status: 200, contentType: 'audio/mp4' }), false);
});

test('uses a direct reader attribute ahead of network candidates', () => {
  const chosen = chooseAudioSource(
    'https://cdn.example.com/key-idea-1.m4a',
    pageUrl,
    [signed, 'https://cdn.example.com/unrelated.m4a'],
  );
  assert.deepEqual(chosen, { url: 'https://cdn.example.com/key-idea-1.m4a', source: 'attribute' });

  const relative = chooseAudioSource('/media/track.m4a', pageUrl, []);
  assert.equal(relative.url, 'https://www.blinkist.com/media/track.m4a');
});

test('blob addresses use one unambiguous network source, never a guessed last response', () => {
  const single = chooseAudioSource('blob:https://www.blinkist.com/abc', pageUrl, [signed, signed]);
  assert.deepEqual(single, { url: signed, source: 'network' });

  const multiple = chooseAudioSource(null, pageUrl, [
    signed, 'https://cdn.example.com/other.m4a',
  ]);
  assert.deepEqual(multiple, { url: null, source: 'none', reason: 'ambiguous-network' });

  assert.deepEqual(chooseAudioSource('blob:opaque', pageUrl, []),
    { url: null, source: 'none', reason: 'no-source' });
});

test('never reuses a chapter media URL for a different chapter', () => {
  const seen = new Set([signed]);
  assert.deepEqual(chooseAudioSource(signed, pageUrl, [signed], seen),
    { url: null, source: 'none', reason: 'already-used' });
  assert.deepEqual(chooseAudioSource(null, pageUrl, [
    signed, 'https://cdn.example.com/next.m4a',
  ], seen),
  { url: 'https://cdn.example.com/next.m4a', source: 'network' });
});

test('network monitor isolates chapters, deduplicates range requests, and detaches', () => {
  const emitter = new EventEmitter();
  const monitor = new ChapterAudioMonitor(emitter as unknown as Pick<Page, 'on' | 'off'>);
  monitor.start();
  monitor.start();
  const firstCursor = monitor.checkpoint();
  emitter.emit('response', fakeResponse('https://cdn.example.com/image.png', 'image/png'));
  emitter.emit('response', fakeResponse(signed, 'audio/mp4', 206));
  emitter.emit('response', fakeResponse(signed, 'audio/mp4', 206));
  assert.deepEqual(monitor.since(firstCursor), [signed]);

  const secondCursor = monitor.checkpoint();
  const next = 'https://cdn.example.com/key-idea-1.m4a?Token=PRIVATE';
  emitter.emit('response', fakeResponse(next, 'audio/mp4'));
  assert.deepEqual(monitor.since(secondCursor), [next]);
  assert.deepEqual(monitor.since(firstCursor), [signed, next]);

  monitor.stop();
  monitor.stop();
  emitter.emit('response', fakeResponse('https://cdn.example.com/another.m4a', 'audio/mp4'));
  assert.deepEqual(monitor.since(secondCursor), [next]);
});

test('network monitor tolerates failed responses without crashing a library run', () => {
  const emitter = new EventEmitter();
  const monitor = new ChapterAudioMonitor(emitter as unknown as Pick<Page, 'on' | 'off'>);
  monitor.start();
  emitter.emit('response', {
    url: () => signed,
    status: () => 200,
    headers: () => { throw new Error('response disposed'); },
  });
  assert.deepEqual(monitor.since(0), []);
  monitor.stop();
});
