import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-chromium';
import { scanLibrary, type LibraryBook } from '../lib/library-scan.js';

const enabled = process.env.RUN_BROWSER_TESTS === '1';

const book = (id: string): LibraryBook => ({
  id, title: 'Title ' + id, author: 'Test Author', description: 'Description', duration: 12,
  rating: 4.3, url: 'https://www.blinkist.com/en/app/books/' + id,
  img: 'https://images.blinkist.io/covers/test.png',
});

const card = (id: string, flags: { disabled?: boolean; link?: string } = {}): string => {
  const href = flags.link ?? '/en/app/books/' + id;
  return '<a href="' + href + '" aria-label="Title ' + id +
    '" data-test-id="book-card" class="' + (flags.disabled ? 'pointer-events-none' : '') + '">' +
    '<img src="https://images.blinkist.io/covers/test.png">' +
    '<div data-test-id="subtitle">Test Author</div>' +
    '<div data-test-id="description">Description</div>' +
    '<div class="text-mid-grey text-caption mt-2">12 min\n4.3</div>' +
    '</a>';
};

function pageHtml(list: 'saved' | 'finished', pages: string[]): string {
  return '<!doctype html><html><head><title>Fixture library</title></head><body>' +
    '<h1>' + list + '</h1><main id="cards"></main><button id="next">Next</button>' +
    '<script>const pages = ' + JSON.stringify(pages) + '; let index = 0;' +
    "const button = document.querySelector('#next');" +
    "function render() { document.querySelector('#cards').innerHTML = pages[index];" +
    "button.disabled = index === pages.length - 1; }" +
    "button.addEventListener('click', () => { index++; render(); });render();" +
    '</script></body></html>';
}

async function fixtureBrowser(
  list: 'saved' | 'finished', pages: string[],
): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined),
  });
  const page = await browser.newPage();
  await page.route('https://www.blinkist.com/en/app/library/' + list, route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(list, pages) }));
  return { browser, page };
}

test('scans multiple pages, ignores unavailable/episode cards and checkpoints each page', {
  skip: !enabled,
}, async () => {
  const { browser, page } = await fixtureBrowser('saved', [
    card('latest-en') + card('middle-en') +
    card('unavailable-en', { disabled: true }) +
    card('episode-en', { link: '/en/app/episodes/episode-en' }),
    card('early-en') + card('old-en'),
  ]);
  try {
    const existing = [book('old-en')];
    const checkpoints: string[][] = [];
    const result = await scanLibrary(page, 'saved', existing, {
      checkAll: true,
      dryRun: false,
      checkpoint: async () => { checkpoints.push(existing.map(item => item.id)); },
      log: () => {}, warn: () => {},
    });
    assert.deepEqual(result, { discovered: 3, pages: 2 });
    assert.deepEqual(checkpoints, [
      ['old-en', 'middle-en', 'latest-en'],
      ['old-en', 'early-en', 'middle-en', 'latest-en'],
    ]);
    assert.deepEqual(existing.map(item => item.id), [
      'old-en', 'early-en', 'middle-en', 'latest-en',
    ]);
  } finally { await browser.close(); }
});

test('dry run previews safely without mutating the library or writing checkpoints', {
  skip: !enabled,
}, async () => {
  const { browser, page } = await fixtureBrowser('saved', [card('new-en')]);
  try {
    const existing = [book('old-en')];
    let writes = 0;
    const result = await scanLibrary(page, 'saved', existing, {
      checkAll: true,
      dryRun: true,
      checkpoint: async () => { writes++; },
      log: () => {}, warn: () => {},
    });
    assert.deepEqual(result, { discovered: 1, pages: 1 });
    assert.deepEqual(existing.map(item => item.id), ['old-en']);
    assert.equal(writes, 0);
  } finally { await browser.close(); }
});

test('early-stop mode keeps discoveries before a known book on the same page', {
  skip: !enabled,
}, async () => {
  const { browser, page } = await fixtureBrowser('saved', [
    card('new-en') + card('old-en') + card('should-not-visit-en'),
  ]);
  try {
    const existing = [book('old-en')];
    const result = await scanLibrary(page, 'saved', existing, {
      checkAll: false,
      dryRun: false,
      checkpoint: async () => {},
      log: () => {}, warn: () => {},
    });
    assert.deepEqual(result, { discovered: 1, pages: 1 });
    assert.deepEqual(existing.map(item => item.id), ['old-en', 'new-en']);
  } finally { await browser.close(); }
});

test('skips finished books already saved', { skip: !enabled }, async () => {
  const { browser, page } = await fixtureBrowser('finished', [
    card('already-saved-en') + card('finished-only-en'),
  ]);
  try {
    const existing: LibraryBook[] = [];
    await scanLibrary(page, 'finished', existing, {
      checkAll: true,
      dryRun: false,
      savedIds: new Set(['already-saved-en']),
      checkpoint: async () => {},
      log: () => {}, warn: () => {},
    });
    assert.deepEqual(existing.map(item => item.id), ['finished-only-en']);
  } finally { await browser.close(); }
});

test('fails rather than treating an unexpected login page as an empty library', {
  skip: !enabled,
}, async () => {
  const { browser, page } = await fixtureBrowser('saved', [card('unused-en')]);
  await page.route('https://www.blinkist.com/en/app/library/saved', route =>
    route.fulfill({
      status: 200, contentType: 'text/html', body: '<html><title>Login</title><h1>Sign in</h1></html>',
    }));
  try {
    const existing: LibraryBook[] = [];
    await assert.rejects(() => scanLibrary(page, 'saved', existing, {
      checkAll: true, dryRun: false, checkpoint: async () => {},
      log: () => {}, warn: () => {},
    }), /layout could not be verified/);
  } finally { await browser.close(); }
});
