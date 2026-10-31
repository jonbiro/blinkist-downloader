#!/usr/bin/env tsx

import { cfg } from './config.js';
import { context, page } from './playwright.js';
import type { Page } from 'playwright-chromium';
import fs from 'node:fs';
import path from 'node:path';
import { audioFilePath, confirmedReaderEnd, inferChapterLabel, isCompleteManifest, selectAudioFileName, selectSavedManifest, validAudioFile, validBookId, validMediaFile, type AudioChapter } from './lib/book-files.js';
import chalk from 'chalk';
import { ChapterAudioMonitor, chooseAudioSource } from './lib/audio-capture.js';
import { scanLibrary } from './lib/library-scan.js';
import { collectReaderDiagnostics } from './lib/reader-diagnostics.js';
import { openLibraryDatabase } from './lib/database.js';
import { downloadMediaFile } from './lib/media-download.js';

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

// Opening a dry run must not create books/ or books/db.json.
const defaultData: { guides: book[], saved: book[], finished: book[] } = { guides: [], saved: [], finished: [] };
const db = await openLibraryDatabase(path.join(cfg.booksDir, 'db.json'), defaultData, cfg.dryrun);

const SAVED_LIBRARY = 'https://www.blinkist.com/en/app/library/saved';

const login = async (page: Page) => {
  const libraryReady = async () => {
    if (new URL(page.url()).pathname !== '/en/app/library/saved') return false;
    if (/just a moment|verify you are human/i.test(await page.title().catch(() => ''))) return false;
    return page.locator('h1:has-text("Saved"), h2:has-text("Saved"), h3:has-text("Saved"), a[data-test-id="book-card"]')
      .first().isVisible().catch(() => false);
  };

  await page.goto(SAVED_LIBRARY);
  if (await libraryReady()) return;
  if (cfg.headless) throw new Error('Blinkist login requires a visible browser. Re-run with SHOW=1.');
  console.log('Sign in to Blinkist and complete any browser verification yourself (up to 2 minutes).');
  const deadline = Date.now() + 120000;
  let lastLibraryRetry = 0;
  while (Date.now() < deadline) {
    if (await libraryReady()) return;
    // A successful sign-in may land on the home feed rather than the saved library.
    const location = new URL(page.url());
    if (location.hostname === 'www.blinkist.com' && location.pathname.startsWith('/en/app/')
      && location.pathname !== '/en/app/library/saved' && Date.now() - lastLibraryRetry > 5000) {
      lastLibraryRetry = Date.now();
      await page.goto(SAVED_LIBRARY).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Could not confirm your Blinkist library. No books were downloaded. Sign in and check whether Blinkist changed its library layout.');
};

const updateLibrary = async (page: Page, list: library = 'saved') => {
  const result = await scanLibrary(page, list, db.data[list], {
    checkAll: cfg.checkall,
    dryRun: cfg.dryrun,
    savedIds: new Set(db.data.saved.map(item => item.id)),
    checkpoint: () => db.write(),
  });
  console.log('Updated ' + list + ': ' + result.discovered + ' new books across ' +
    result.pages + ' pages. Each completed page was checkpointed.');
};

const isComplete = (bookJson: string, bookDir: string) => {
  if (!fs.existsSync(bookJson)) return false;
  try {
    return isCompleteManifest(JSON.parse(fs.readFileSync(bookJson, 'utf8')), bookDir, cfg.audio);
  } catch { return false; }
};

const downloadBooks = async (page: Page, list: library = 'saved') => {
  const dbList = db.data[list]; // sorted by date added ascending
  console.log('Check/download new books:', list);
  console.log(list, 'books in db.json:', dbList.length);

  let i = 0;
  for (const book of dbList) {
    i++;
    if (!validBookId(book.id)) { console.warn('Skipping unsafe book ID:', book.id); continue; }
    if (book.url !== 'https://www.blinkist.com/en/app/books/' + book.id) {
      console.warn('Skipping unexpected/off-site book URL:', book.id);
      continue;
    }
    const bookDir = path.join(cfg.booksDir, list, book.id);
    const bookJson = path.join(bookDir, 'book.json');
    const complete = isComplete(bookJson, bookDir);
    console.log(`Book ${i}:`, book.id, complete ? chalk.green('complete') : chalk.yellow('needs download/resume'));
    if (complete) continue;
    if (cfg.maxBooks > 0 && attemptedDownloads >= cfg.maxBooks) {
      console.log('MAX_BOOKS reached. Remaining books will be handled on a later run.');
      break;
    }
    attemptedDownloads++;
    if (cfg.dryrun) {
      console.log('DRYRUN: Would download/resume', book.title);
      continue;
    }
    console.log('Downloading book (' + (dbList.length - i) + ' left):', book.url);
    try {
      // Do not stall every book waiting for optional GraphQL reading-progress metadata.
      await page.goto(book.url);
      if (page.url().includes('missing-title=')) {
        console.warn('Book is no longer available:', book.id);
        failedDownloads++;
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
      const details = { ...book, ratings, durationDetail, categories, descriptionLong, authorDetails };

    const chapters: AudioChapter[] = [];
    const claimedFiles = new Set<string>();
    let readerComplete = false;
    let orgChapter: string | undefined;
    // DominicBoettger's 2025 network-capture idea, scoped to one book/reader.
    // The response monitor never reads bodies or logs signed media URLs.
    const audioMonitor = new ChapterAudioMonitor(page);
    if (cfg.captureAudio) audioMonitor.start();
    const usedAudioUrls = new Set<string>();
    let mediaCheckpoint = audioMonitor.checkpoint();
    try {
      const resp = await page.goto('https://www.blinkist.com/en/nc/reader/' + book.id);
      // These additional selectors are tentative fallbacks, not known current Blinkist selectors.
      const readerContent = page.locator(
        '.reader-content__text, [data-test-id="readerContent"], [data-test-id="reader-content"]'
      ).first();
      if (resp?.ok() && await readerContent.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)) {
        // The old summary lacked a number label. Don't assume any missing label means Summary.
        const chapterNumber = async () => {
          const number = await page.locator('[data-test-id="currentChapterNumber"]').first()
            .innerText({ timeout: 200 }).catch(() => null);
          const heading = number ? null : await page.locator('h2').first()
            .innerText({ timeout: 500 }).catch(() => null);
          return inferChapterLabel(number, heading);
        };
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
          const content = readerContent;
          const text = await content.innerHTML();
          const key = name + ':' + title + ':' + text.slice(0, 100);
          if (seen.has(key)) { console.warn('Reader repeated a chapter; marking this book incomplete:', book.id); break; }
          seen.add(key);
          const audioAttributes = await Promise.all([
            page.locator('[data-test-id="readerAudio"]').first().getAttribute('audio-url', { timeout: 500 }).catch(() => null),
            page.locator('audio').first().getAttribute('src', { timeout: 500 }).catch(() => null),
            page.locator('audio source').first().getAttribute('src', { timeout: 500 }).catch(() => null),
          ]);
          // Prefer an actual HTTPS URL over blob:/data: placeholders.
          const rawAudio = audioAttributes.find(value => {
            if (!value) return false;
            try { return new URL(value, page.url()).protocol === 'https:'; }
            catch { return false; }
          }) ?? audioAttributes.find(Boolean) ?? null;
          if (cfg.captureAudio && (!rawAudio || rawAudio.startsWith('blob:'))) {
            await page.waitForTimeout(250);
            if (audioMonitor.since(mediaCheckpoint).length === 0) {
              await page.waitForTimeout(750);
            }
          }
          const choice = chooseAudioSource(
            rawAudio, page.url(), audioMonitor.since(mediaCheckpoint), usedAudioUrls
          );
          const audio = choice.url;
          if (audio) usedAudioUrls.add(audio);
          const chapter: AudioChapter = { name, title, text, audio, audioSource: choice.source };
          chapter.fileName = selectAudioFileName(chapter, chapters.length, bookDir, claimedFiles);
          chapters.push(chapter);
          if (choice.reason === 'ambiguous-network') {
            console.warn('Multiple audio responses for this chapter; refusing to guess:', name);
          }
          console.log(name, title, audio ? 'audio via ' + choice.source : 'audio URL not found');
          // Download while signed URLs are fresh, instead of collecting every URL first.
          if (cfg.audio && audio) {
            const file = audioFilePath(bookDir, chapter);
            if (file && !validAudioFile(file)) {
              await downloadMediaFile(audio, file).catch(error =>
                console.warn('Audio failed for ' + book.id + ' / ' + name + ':', error));
            }
          }
          // The following network window begins immediately before chapter navigation.
          mediaCheckpoint = audioMonitor.checkpoint();
          const nextBtn = page.locator('[data-test-id="nextChapter"]');
          if (!(await nextBtn.isVisible().catch(() => false))) {
            // Without a visible next button the UI may have changed, not necessarily ended.
            // Require the known end-of-book Summary and evidence we advanced past chapter one.
            readerComplete = confirmedReaderEnd(name, chapters.length, chapters[0]?.name === 'Introduction');
            if (!readerComplete) console.warn('Reader stopped before a confirmed Summary:', book.id);
            break;
          }
          await nextBtn.click();
          const advanced = await page.waitForFunction(previous =>
            document.querySelector(
              '.reader-content__text, [data-test-id="readerContent"], [data-test-id="reader-content"]'
            )?.innerHTML !== previous,
            text, { timeout: 5000 }).then(() => true).catch(() => false);
          if (!advanced) {
            console.warn('Reader did not advance. Saved chapters will be marked incomplete:', book.id);
            break;
          }
        }
        await reset().catch(() => {});
      } else {
        console.warn('Reader UI unavailable/changed:', book.id);
      }
    } finally {
      audioMonitor.stop(); // Never allow responses from later books to leak into this one.
    }

    if (cfg.diagnose && (!readerComplete || chapters.some(chapter => !chapter.audio))) {
      const diagnostics = await collectReaderDiagnostics(page).catch(() => null);
      if (diagnostics) {
        console.warn('Reader diagnostics (redacted; no HTML or URLs):', JSON.stringify(diagnostics));
      }
    }

    fs.mkdirSync(bookDir, { recursive: true });
    const jsonPart = bookJson + '.part';
    let previous: unknown;
    try { if (fs.existsSync(bookJson)) previous = JSON.parse(fs.readFileSync(bookJson, 'utf8')); }
    catch { /* invalid previous metadata can be safely replaced */ }
    const refreshed = { ...details, downloadDate: new Date(), orgChapter, readerComplete, chapters };
    const selected = selectSavedManifest(previous, refreshed);
    if (selected === previous) console.warn('Preserved previous, more complete chapter manifest:', book.id);
    fs.writeFileSync(jsonPart, JSON.stringify(selected, null, 2));
    fs.renameSync(jsonPart, bookJson);
    if (!readerComplete) console.warn('Incomplete reader traversal:', book.id);
    if (book.img && !validMediaFile(path.join(bookDir, 'cover.png'))) {
      let coverUrl: string | null = null;
      try { coverUrl = new URL(book.img, 'https://www.blinkist.com').toString(); }
      catch { /* invalid or missing cover URL */ }
      if (coverUrl) await downloadMediaFile(coverUrl, path.join(bookDir, 'cover.png'))
        .catch(err => console.warn('Cover failed:', err));
    }
    if (cfg.audio) {
      // When an incomplete retry retained an older, longer manifest, attempt
      // its missing chapters too, not only the shorter list visited today.
      const savedChapters = Array.isArray(selected.chapters) ? selected.chapters : [];
      console.log('Downloading audio files:', savedChapters.filter(c => c.audio).length);
      for (const chapter of savedChapters) {
        const file = audioFilePath(bookDir, chapter);
        if (!chapter.audio || !file || validAudioFile(file)) continue;
        await downloadMediaFile(chapter.audio, file).catch(err =>
          console.warn('Audio failed for ' + book.id + ' / ' + chapter.name + ':', err));
      }
      if (!chapters.some(c => c.audio))
        console.warn(`No audio URLs found for ${book.id}. Reader selectors may need a live update.`);
    }
    if (isComplete(bookJson, bookDir)) succeededDownloads++;
    else {
      failedDownloads++;
      console.warn('Book remains incomplete and will be retried on the next run:', book.id);
    }
    console.log();
    } catch (error) {
      failedDownloads++;
      console.error(chalk.red(`Failed to process ${book.id}; continuing:`), error);
    }
  }
  console.log();
};

let attemptedDownloads = 0;
let succeededDownloads = 0;
let failedDownloads = 0;

try {
  await login(page);
  
  if (cfg.update) {
    await updateLibrary(page, 'saved');
    await updateLibrary(page, 'finished');
  }
  if (cfg.download) {
    await downloadBooks(page, 'saved');
    await downloadBooks(page, 'finished');
    console.log('Download summary:', attemptedDownloads, 'attempted,', succeededDownloads,
      'complete,', failedDownloads, 'incomplete/unavailable.');
    if (failedDownloads) process.exitCode = 1;
  }
} catch (error) {
  console.error(error); // .toString()?
  process.exitCode ||= 1;
} finally { // not reached on ctrl-c
  if (!cfg.dryrun) await db.write(); // write out json db
  await context.close();
}
