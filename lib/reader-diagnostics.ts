import type { Page } from 'playwright-chromium';

export type ReaderDiagnostics = {
  location: 'reader' | 'library' | 'login' | 'other';
  challengeDetected: boolean;
  readerContentElements: number;
  currentChapterNumberElements: number;
  nextChapterElements: number;
  chapterLinkElements: number;
  audioElements: number;
  audioSourceKinds: { https: number; blob: number; other: number; empty: number };
};

function classifyUrl(url: string | null, baseUrl: string): 'https' | 'blob' | 'other' | 'empty' {
  if (!url) return 'empty';
  try {
    const parsed = new URL(url, baseUrl);
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'blob:') return 'blob';
  } catch { /* invalid URL */ }
  return 'other';
}

/**
 * Diagnostics deliberately exclude page HTML, titles, book IDs, cookies,
 * media URLs, query strings, account details, and downloadable content.
 */
export async function collectReaderDiagnostics(page: Page): Promise<ReaderDiagnostics> {
  const pathname = new URL(page.url()).pathname;
  const location: ReaderDiagnostics['location'] = pathname.includes('/reader/')
    ? 'reader'
    : pathname.includes('/library/') ? 'library'
      : pathname.includes('/login') ? 'login' : 'other';
  const title = await page.title().catch(() => '');
  const challengeDetected = /just a moment|verify you are human/i.test(title);
  const selectors = {
    readerContentElements: '.reader-content__text, [data-test-id="readerContent"], [data-test-id="reader-content"]',
    currentChapterNumberElements: '[data-test-id="currentChapterNumber"]',
    nextChapterElements: '[data-test-id="nextChapter"]',
    chapterLinkElements: '[data-test-id="chapterLink"]',
    audioElements: 'audio',
  } as const;

  const counts = await Promise.all(Object.values(selectors).map(selector =>
    page.locator(selector).count().catch(() => 0)));
  const audioAttributes = await Promise.all([
    page.locator('[data-test-id="readerAudio"]').first()
      .getAttribute('audio-url', { timeout: 200 }).catch(() => null),
    ...await page.locator('audio').evaluateAll(els =>
      els.flatMap(el => [
        el.getAttribute('src'),
        ...Array.from(el.querySelectorAll('source')).map(source => source.getAttribute('src')),
      ])),
  ]);
  const audioSourceKinds = { https: 0, blob: 0, other: 0, empty: 0 };
  for (const audioAttribute of audioAttributes) {
    audioSourceKinds[classifyUrl(audioAttribute, page.url())]++;
  }
  return {
    location, challengeDetected,
    readerContentElements: counts[0],
    currentChapterNumberElements: counts[1],
    nextChapterElements: counts[2],
    chapterLinkElements: counts[3],
    audioElements: counts[4],
    audioSourceKinds,
  };
}
