import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-chromium';
import { ChapterAudioMonitor, chooseAudioSource } from '../lib/audio-capture.js';
import { collectReaderDiagnostics } from '../lib/reader-diagnostics.js';

const browserEnabled = process.env.RUN_BROWSER_TESTS === '1';

test('a real Chrome page reports intercepted audio responses without a Blinkist login', {
  skip: !browserEnabled,
}, async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined),
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const readerUrl = 'https://www.blinkist.com/en/nc/reader/offline-test';
    const mediaUrl = 'https://media.example.test/offline-test.m4a?Signature=PRIVATE';
    await page.route(readerUrl, route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><head><title>Fixture</title></head><body>' +
        '<div id="chapter">Introduction</div><audio id="player" audio-url="blob:mocked"></audio></body></html>',
    }));
    await page.route('https://media.example.test/**', route => route.fulfill({
      status: 206,
      headers: {
        'content-type': 'audio/mp4',
        'access-control-allow-origin': '*',
        'content-range': 'bytes 0-512/513',
      },
      body: Buffer.alloc(513, 1),
    }));

    const monitor = new ChapterAudioMonitor(page);
    monitor.start();
    const checkpoint = monitor.checkpoint();
    await page.goto(readerUrl, { waitUntil: 'domcontentloaded' });
    const status = await page.evaluate(async url => {
      const response = await fetch(url);
      return response.status;
    }, mediaUrl);
    assert.equal(status, 206);

    const candidateUrls = monitor.since(checkpoint);
    assert.deepEqual(candidateUrls, [mediaUrl]);
    const blobAddress = await page.locator('#player').getAttribute('audio-url');
    const resolved = chooseAudioSource(blobAddress, page.url(), candidateUrls);
    assert.deepEqual(resolved, { url: mediaUrl, source: 'network' });
    monitor.stop();
    await context.close();
  } finally {
    await browser.close();
  }
});

test('diagnostics reveal layout problems without exposing page content or signed URLs', {
  skip: !browserEnabled,
}, async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined),
  });
  try {
    const page = await browser.newPage();
    const fixtureUrl = 'https://www.blinkist.com/en/nc/reader/private-book-id-en?session=SECRET_TOKEN';
    await page.route(fixtureUrl, route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<html><head><title>My Private Book</title></head><body>' +
        '<div class="reader-content__text">Private chapter text</div>' +
        '<span data-test-id="currentChapterNumber">Introduction</span>' +
        '<button data-test-id="nextChapter">Next</button>' +
        '<audio src="blob:https://www.blinkist.com/private-object"></audio>' +
        '<div data-test-id="readerAudio" audio-url="https://media.example.com/file.m4a?Signature=SECRET_SIGNATURE"></div>' +
        '</body></html>',
    }));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    const diagnostics = await collectReaderDiagnostics(page);
    assert.equal(diagnostics.location, 'reader');
    assert.equal(diagnostics.readerContentElements, 1);
    assert.equal(diagnostics.currentChapterNumberElements, 1);
    assert.equal(diagnostics.nextChapterElements, 1);
    assert.equal(diagnostics.audioElements, 1);
    assert.equal(diagnostics.audioSourceKinds.https, 1);
    assert.equal(diagnostics.audioSourceKinds.blob, 1);
    const printed = JSON.stringify(diagnostics);
    assert.doesNotMatch(printed, /SECRET|private-book-id|Private chapter|media\.example|My Private Book/i);
    await page.close();
  } finally { await browser.close(); }
});
