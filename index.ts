#!/usr/bin/env tsx

import { cfg } from './config.js';
import { context, page } from './playwright.js';
import type { BrowserContext, Page } from 'playwright-chromium';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

type library = 'saved' | 'finished';
type book = {
  id: string,
  title: string,
  author: string,
  description: string,
  duration: number,
  rating: number,
  url: string,
  img: string,
};

fs.mkdirSync('books', { recursive: true });
// json database to save lists from https://www.blinkist.com/en/app/library
import { JSONFilePreset } from 'lowdb/node';
const defaultData : { guides: book[], saved: book[], finished: book[] } = { guides: [], saved: [], finished: [] };
const db = await JSONFilePreset('books/db.json', defaultData);

const cookieConsent = async (context: BrowserContext) => {
  return context.addCookies([
    { name: 'CookieConsent', value: JSON.stringify({stamp:'V2Zm11G30yff5ZZ8WLu8h+BPe03juzWMZGOyPF4bExMdyYwlFj+3Hw==',necessary:true,preferences:true,statistics:true,marketing:true,method:'explicit',ver:1,utc:1716329838000,region:'de'}), domain: 'www.blinkist.com', path: '/' }, // Accept cookies since consent banner overlays and blocks screen
  ]);
  // page.locator('button:has-text("Allow all cookies")').click().catch(() => {}); // solved by setting cookie above
};

const login = async (page: Page) => {
  await page.goto('https://www.blinkist.com/en/app/library/saved');
  if (page.url().includes('/login') || await page.locator('input[type="password"]').first().isVisible()) {
    console.log('Please log in using the browser window (up to 2 minutes).');
    await page.waitForURL(url => url.hostname === 'www.blinkist.com' && url.pathname.includes('/app/'), { timeout: 120000 });
    await page.goto('https://www.blinkist.com/en/app/library/saved');
  }
};

const updateLibrary = async (page: Page, list: library = 'saved') => {
  const dbList = db.data[list]; // sorted by date added ascending
  // sorted by date added descending
  const url = 'https://www.blinkist.com/en/app/library/' + list;
  await page.goto(url);
  const newBooks = [];

  console.log('Updating library:', url);
  console.log(list, 'books in db.json:', dbList.length);

  const nextBtn = page.locator('button:has-text("Next"):not([disabled])');
  pages: do { // go through pages
    // Ignore disabled/removed books and non-book cards (e.g. episodes).
    const cards = page.locator('a[data-test-id="book-card"]:not(.pointer-events-none)');
    await cards.first().waitFor({ timeout: 10000 }).catch(() => {});
    const oldPage = await cards.evaluateAll(els => els.map(el => el.getAttribute('href')).join('|'));
    const books = await cards.all();
    if (!books.length) {
      console.warn(`No downloadable book cards found in ${list}. If your library is not empty, Blinkist may have changed its layout.`);
      break;
    }
    for (const book of books) {
      const slug = await book.getAttribute('href');
      if (!slug || !slug.includes('/app/books/')) continue;
      const id = slug.split('/').pop() ?? slug;
      const url = new URL(slug, 'https://www.blinkist.com').toString();
      const title = await book.getAttribute('aria-label') ||
        await book.locator('[data-test-id="title"]').textContent({ timeout: 500 }).catch(() => null);
      if (!title) { console.warn('Skipping card without a title:', slug); continue; }
      const img = await book.locator('img').getAttribute('src', { timeout: 500 }).catch(() => null) ?? '';
      const author = await book.locator('[data-test-id="subtitle"]').innerText({ timeout: 1000 }).catch(() => '');
      const description = await book.locator('[data-test-id="description"]').innerText({ timeout: 1000 }).catch(() => '');
      const meta = (await book.locator('div.text-mid-grey.text-caption.mt-2').last().innerText({ timeout: 500 }).catch(() => '')).split('\n');
      const duration = parseFloat(meta[0] ?? '') || 0;
      const rating = parseFloat(meta[1] ?? '') || 0;
      const item: book = { id, title: title.trim(), author, description, duration, rating, url, img };
      if (dbList.find(i => i.id === id)) {
        if (!cfg.checkall) {
          console.log('Stopping at book already found in db.json:', item);
          break pages;
        } else {
          console.log('Book already in db.json:', item.id);
        }
      } else if (list === 'finished' && db.data.saved.find(i => i.id === id)) {
        // after downloading a book (even with reset to start), it will also appear in finished list
        // since we don't want to download it in finished as well, we skip it here
        // TODO to mark a book as finished, move it from saved to finished in books/db.json and books/
        console.log('Skipping book already in saved list:', item.id);
      } else {
        console.log('New book:', item);
        newBooks.push(item);
      }
    }
    if (await nextBtn.count()) {
      await nextBtn.click();
      try {
        await page.waitForFunction(previous =>
          [...document.querySelectorAll('a[data-test-id="book-card"]:not(.pointer-events-none)')]
            .map(el => el.getAttribute('href')).join('|') !== previous,
          oldPage, { timeout: 15000 });
      } catch {
        console.warn('Library pagination did not change; stopping to avoid an infinite loop.');
        break;
      }
    } else break;
  } while (true);
  // add new books to db.json in reverse order
  dbList.push(...newBooks.toReversed());
  await db.write(); // write out json db
  console.log('New books:', newBooks.length);
  console.log();
};

// Preserve the old per-chapter filenames, while blocking path separators and invalid names.
const safeChapterName = (name: string) => name.replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').slice(0, 140).trim() || 'Chapter';
const chapterPath = (bookDir: string, name: string) => path.join(bookDir, safeChapterName(name) + '.m4a');
const validFile = (file: string) => fs.existsSync(file) && fs.statSync(file).size > 128;

const isComplete = (bookJson: string, bookDir: string) => {
  if (!fs.existsSync(bookJson)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(bookJson, 'utf8'));
    if (!cfg.audio) return true;
    const audioChapters = (saved.chapters ?? []).filter((c: { audio?: string }) => c.audio);
    return audioChapters.length > 0 && audioChapters.every((c: { name: string }) => validFile(chapterPath(bookDir, c.name)));
  } catch { return false; }
};

const downloadFile = async (url: string, file: string) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tmp = file + '.part';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
      const mime = (res.headers.get('content-type') ?? '').toLowerCase();
      if (mime.startsWith('text/') || mime.includes('application/json'))
        throw new Error(`Unexpected response type ${mime}; not an audio/image file`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length <= 128) throw new Error('Empty or suspiciously short download');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
};

const downloadBooks = async (page: Page, list: library = 'saved') => {
  const dbList = db.data[list]; // sorted by date added ascending
  console.log('Check/download new books:', list);
  console.log(list, 'books in db.json:', dbList.length);

  let i = 0;
  for (const book of dbList) {
    i++;
    const bookDir = `books/${list}/${book.id}/`;
    const bookJson = bookDir + 'book.json';
    const complete = isComplete(bookJson, bookDir);
    console.log(`Book ${i}:`, book.id, complete ? chalk.green('complete') : chalk.yellow('needs download/resume'));
    if (complete) continue;
    console.log(`Downloading book (${dbList.length - i} left):`, book.url);
    try {
      // Reading progress is optional. A change to the GraphQL endpoint must not prevent downloads.
      const gql = page.waitForResponse(r => r.request().method() === 'POST' &&
        r.url().includes('gql-gateway.blinkist.com/graphql'), { timeout: 2500 }).catch(() => undefined);
      await page.goto(book.url);
      const gqlResponse = await gql;
      const gqlData = await gqlResponse?.json().catch(() => undefined);
      const contentState = gqlData?.data?.user?.contentStateByContentTypeAndId;
      if (page.url().includes('missing-title=')) {
        console.warn('Book is no longer available:', book.id);
        continue;
      }
      // The old site used positional nested divs. They are optional metadata, not prerequisites for audio.
      const detailsBox = page.locator('div:has(h4)').last();
      const detailDivs = await detailsBox.locator('div').all();
      const categories = detailDivs[1] ? await detailDivs[1].locator('a').all()
        .then(links => Promise.all(links.map(link => link.innerText().catch(() => '')))) : [];
      const descriptionLong = detailDivs[2] ? await detailDivs[2].innerHTML().catch(() => '') : '';
      const authorDetails = detailDivs[3] ? await detailDivs[3].innerHTML().catch(() => '') : '';
      const ratings = await page.locator('span:has-text(" ratings)")').first().innerText({ timeout: 500 }).catch(() => undefined);
      const durationDetail = await page.locator('span:has-text(" mins")').first().innerText({ timeout: 500 }).catch(() => undefined);
      const details = { ...book, ratings, durationDetail, categories, descriptionLong, authorDetails, contentState };

    const chapters = [];
    let orgChapter = undefined;
    const resp = await page.goto('https://www.blinkist.com/en/nc/reader/' + book.id);
    if (resp?.ok() && await page.locator('.reader-content__text').first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false)) {
      // chapter number (Introduction, Key idea 1...), but last chapter (summary) has no name, so we time out and return Summary
      const chapterNumber = () => page.locator('[data-test-id="currentChapterNumber"]').innerText({ timeout: 200 }).catch(() => 'Summary');
      orgChapter = await chapterNumber();
      console.log('Original chapter:', orgChapter);
      const reset = async () => {
        const chapter = await chapterNumber();
        if (chapter === 'Introduction') return;
        const menu = page.locator('[data-test-id="keyIdeas"]');
        const links = page.locator('[data-test-id="chapterLink"]');
        if (!(await menu.count())) return; // changed reader UI: keep available chapters
        await menu.click();
        if (!(await links.count())) return;
        await links.first().click();
        await page.waitForFunction(previous =>
          document.querySelector('[data-test-id="currentChapterNumber"]')?.textContent?.trim() !== previous,
          chapter, { timeout: 5000 }).catch(() => {});
      }
      await reset().catch(err => console.warn('Could not reset reader:', err));
      const seen = new Set<string>();
      for (let step = 0; step < 100; step++) {
        const name = await chapterNumber();
        const title = await page.locator('h2').first().innerText({ timeout: 3000 }).catch(() => name);
        const content = page.locator('.reader-content__text').first();
        const text = await content.innerHTML();
        const key = name + ':' + title + ':' + text.slice(0, 100);
        if (seen.has(key)) break;
        seen.add(key);
        const audio = await page.locator('[data-test-id="readerAudio"]').first().getAttribute('audio-url', { timeout: 500 }).catch(() => null)
          ?? await page.locator('audio').first().getAttribute('src', { timeout: 500 }).catch(() => null)
          ?? await page.locator('audio source').first().getAttribute('src', { timeout: 500 }).catch(() => null);
        chapters.push({ name, title, text, audio });
        console.log(name, title, audio ? 'audio available' : 'audio URL not found');
        const nextBtn = page.locator('[data-test-id="nextChapter"]');
        if (!(await nextBtn.isVisible())) break;
        await nextBtn.click();
        await page.waitForFunction(previous =>
          document.querySelector('.reader-content__text')?.innerHTML !== previous,
          text, { timeout: 5000 }).catch(() => {});
      }
      await reset().catch(() => {});
    } else {
      console.warn('Reader UI unavailable/changed:', book.id, page.url());
    }

    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(bookJson, JSON.stringify({ ...details, downloadDate: new Date(), orgChapter, chapters }, null, 2));
    if (book.img && !validFile(bookDir + 'cover.png'))
      await downloadFile(book.img, bookDir + 'cover.png').catch(err => console.warn('Cover failed:', err));
    if (cfg.audio) {
      console.log('Downloading audio files:', chapters.filter(c => c.audio).length);
      for (const { name, audio } of chapters) {
        if (!audio || validFile(chapterPath(bookDir, name))) continue;
        await downloadFile(audio, chapterPath(bookDir, name)).catch(err =>
          console.warn(`Audio failed for ${book.id} / ${name}:`, err));
      }
      if (!chapters.some(c => c.audio))
        console.warn(`No audio URLs found for ${book.id}. Reader selectors may need a live update.`);
    }
    console.log();
    } catch (error) {
      console.error(chalk.red(`Failed to process ${book.id}; continuing:`), error);
    }
  }
  console.log();
};

try {
  await cookieConsent(context);
  await login(page);
  
  page.locator('h2:has-text("Verify you are human by completing the action below.")').waitFor().then(() => {;
    console.error('Verify you are human by completing the action below.');
    if (cfg.headless) {
      console.error('Can not solve captcha in headless mode. Exiting...');
      process.exit(1);
    } else {
      return page.waitForTimeout(30*1000); // TODO wait until captcha is solved
    }
  }).catch(() => {});

  if (cfg.update) {
    await updateLibrary(page, 'saved');
    await updateLibrary(page, 'finished');
  }
  if (cfg.download) {
    await downloadBooks(page, 'saved');
    await downloadBooks(page, 'finished');
  }
} catch (error) {
  console.error(error); // .toString()?
  process.exitCode ||= 1;
} finally { // not reached on ctrl-c
  await db.write(); // write out json db
  await context.close();
}
