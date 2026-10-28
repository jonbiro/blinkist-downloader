import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-chromium';
import { ChapterAudioMonitor, chooseAudioSource } from '../lib/audio-capture.js';

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
