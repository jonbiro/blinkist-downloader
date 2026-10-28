import type { Page } from 'playwright-chromium';

export type LibraryName = 'saved' | 'finished';

export type LibraryBook = {
  id: string;
  title: string;
  author: string;
  description: string;
  duration: number;
  rating: number;
  url: string;
  img: string;
};

export type ScanOptions = {
  checkAll: boolean;
  dryRun: boolean;
  savedIds?: ReadonlySet<string>;
  checkpoint: () => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ScanResult = { discovered: number; pages: number };

const validBookId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,160}$/i.test(id);

/**
 * Scans the authenticated web library and checkpoints complete pages. A later
 * broken page cannot discard titles discovered on earlier pages.
 *
 * This does not initiate login or access private media and supports mocked
 * Playwright HTML fixtures for regression testing.
 */
export async function scanLibrary(
  page: Page,
  list: LibraryName,
  existing: LibraryBook[],
  options: ScanOptions,
): Promise<ScanResult> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const knownIds = new Set(existing.map(item => item.id));
  const initial = existing.slice();
  const discovered: LibraryBook[] = [];
  const savedIds = options.savedIds ?? new Set<string>();

  const url = 'https://www.blinkist.com/en/app/library/' + list;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error('Unable to open ' + list + ' library (HTTP ' + (response?.status() ?? 'unknown') + ')');

  const allCards = page.locator('a[data-test-id="book-card"]');
  const cards = page.locator('a[data-test-id="book-card"]:not(.pointer-events-none)');
  const heading = page.locator('h1,h2,h3').filter({ hasText: new RegExp('^\\s*' + list + '\\s*$', 'i') });
  const next = page.locator('button:has-text("Next"):not([disabled])').first();

  // It is fine for a library to be empty. It is NOT fine for a changed
  // layout, login interstitial, or challenge page to look like an empty library.
  const ready = await page.locator('a[data-test-id="book-card"], h1, h2, h3')
    .first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!ready || !(await heading.count()) && !(await allCards.count())) {
    throw new Error('The ' + list + ' library layout could not be verified (login or page layout may have changed).');
  }

  const seenPages = new Set<string>();
  let pageCount = 0;
  let stopEarly = false;
  while (pageCount < 250) {
    pageCount++;
    const current = await allCards.evaluateAll(els => els.map(el => el.getAttribute('href')).join('|'));
    const fingerprint = current || 'empty:' + (await page.url());
    if (seenPages.has(fingerprint)) {
      throw new Error('Library pagination repeated a page. Previously scanned pages were checkpointed.');
    }
    seenPages.add(fingerprint);

    const onThisPage = await cards.all();
    if (!onThisPage.length) warn('No available book cards on ' + list + ' page ' + pageCount + '.');
    for (const card of onThisPage) {
      const slug = await card.getAttribute('href');
      if (!slug) continue;
      let parsed: URL;
      try {
        parsed = new URL(slug, 'https://www.blinkist.com');
      } catch {
        continue;
      }
      if (parsed.origin !== 'https://www.blinkist.com' ||
          !parsed.pathname.startsWith('/en/app/books/')) continue;
      const id = parsed.pathname.split('/').pop() ?? '';
      if (!validBookId(id)) {
        warn('Ignoring invalid book ID in ' + list + ' list.');
        continue;
      }
      if (knownIds.has(id)) {
        if (!options.checkAll) {
          stopEarly = true;
          break;
        }
        continue;
      }
      if (list === 'finished' && savedIds.has(id)) continue;

      const title = await card.getAttribute('aria-label')
        || await card.locator('[data-test-id="title"]').textContent({ timeout: 500 }).catch(() => null);
      if (!title?.trim()) {
        warn('Skipping card without a title in ' + list + ' list.');
        continue;
      }
      const img = await card.locator('img').getAttribute('src', { timeout: 500 }).catch(() => null) ?? '';
      const author = await card.locator('[data-test-id="subtitle"]').innerText({ timeout: 1000 }).catch(() => '');
      const description = await card.locator('[data-test-id="description"]').innerText({ timeout: 1000 }).catch(() => '');
      const meta = (await card.locator('div.text-mid-grey.text-caption.mt-2').last()
        .innerText({ timeout: 500 }).catch(() => '')).split('\n');
      const book: LibraryBook = {
        id, title: title.trim(), author, description,
        duration: parseFloat(meta[0] ?? '') || 0,
        rating: parseFloat(meta[1] ?? '') || 0,
        url: parsed.origin + parsed.pathname,
        img,
      };
      discovered.push(book);
      knownIds.add(id);
    }

    // Newest entries are first in Blinkist's library; preserve the old
    // database ordering plus the newly found entries in oldest-first order.
    if (!options.dryRun) {
      existing.splice(0, existing.length, ...initial, ...discovered.slice().reverse());
      await options.checkpoint();
    }
    log('Scanned ' + list + ' page ' + pageCount + '; ' + discovered.length + ' new books so far.');

    if (stopEarly || !(await next.isVisible().catch(() => false))) break;
    await next.click({ timeout: 8000 });
    try {
      await page.waitForFunction(previous =>
        [...document.querySelectorAll('a[data-test-id="book-card"]')]
          .map(el => el.getAttribute('href')).join('|') !== previous,
        current, { timeout: 15000 });
    } catch {
      throw new Error('Library next page did not load. Earlier pages were checkpointed.');
    }
  }
  if (pageCount === 250 && await next.isVisible().catch(() => false)) {
    throw new Error('Library scan exceeded 250 pages and stopped to prevent a loop.');
  }
  return { discovered: discovered.length, pages: pageCount };
}
