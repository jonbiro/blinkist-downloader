# Blinkist Downloader (2026 maintenance fork)

Fork of [Ralf Vogler's blinkist-downloader](https://github.com/vogler/blinkist-downloader), licensed **AGPL-3.0-only**. It uses Playwright to inspect your **Saved** and **Finished** Blinkist web libraries. It also includes an **offline MP3 exporter** for accessible M4A chapter files already saved on your computer.

> **Status:** MP3 export and its offline tests work. Blinkist's current authenticated book reader and audio URLs **have not been tested in 2026**. Expect that its web UI may have changed. The program does not bypass login, paywalls, or DRM. Only download/export material where you have permission; Blinkist's terms may prohibit copying.

## Quick start on macOS

Google Chrome and FFmpeg are supported. The application uses installed Google Chrome automatically on macOS, avoiding an unavailable older Chromium download.

1. Install [Node.js 22+](https://nodejs.org/) and FFmpeg (`brew install ffmpeg`).
2. In this repository, run `npm ci --ignore-scripts` and `npm run doctor`.
3. **Safest first test:** run `MAX_BOOKS=1 npm start`. A browser window will open for you to sign in and complete any verification yourself.
4. If audio was downloaded successfully, preview conversion with `npm run export:mp3 -- --dry-run`.
5. Export with `npm run export:mp3`. Copy the files from `books/mp3/` to your MP3 player.

On Linux, install Chromium using `npx playwright install chromium`, or specify `BROWSER_CHANNEL=chrome` if Chrome is installed.

### Before downloading anything

Run `DRYRUN=1 npm start` to inspect library listings without saving book metadata or audio files (a browser profile may still be written). Or run `DOWNLOAD=0 npm start` to update only the `books/db.json` library index.

**Do not run an unlimited download as your first test.** `MAX_BOOKS=1` limits the downloader to one book across both lists; omit it only when you've verified a single book.

## Commands

| Command | What it does |
|---|---|
| `npm run doctor` | Checks Node.js, FFmpeg, FFprobe, and the local browser setup without logging into Blinkist |
| `MAX_BOOKS=1 npm start` | Test up to one pending book; manual Blinkist login |
| `DOWNLOAD=0 npm start` | Update library index only |
| `DRYRUN=1 npm start` | Preview without writing book files |
| `npm run export:mp3 -- --dry-run` | Preview local MP3 conversions |
| `npm run export:mp3` | Convert complete local books to MP3 |
| `npm run export:mp3 -- --force` | Re-export existing MP3s |
| `npm run check` | TypeScript type-check of the downloader |
| `npm test` | Run offline storage and media conversion tests |

Configure environment variables in your shell or a local `.env` file (which is ignored by Git).

| Variable | Default | Purpose |
|---|---|---|
| `MAX_BOOKS` | `0` (unlimited) | Limit pending download attempts across both library lists |
| `UPDATE` | `1` | Set `0` to skip refreshing library lists |
| `DOWNLOAD` | `1` | Set `0` to skip downloading books |
| `DRYRUN` | `0` | Preview without writing book data or media |
| `AUDIO` | `1` | Set `0` to save text/metadata only |
| `CHECKALL` | `1` | Full library scan; set `0` for the faster but potentially incomplete legacy early-stop behavior |
| `SHOW` | `1` | Visible browser; needed for interactive sign-in |
| `BROWSER_CHANNEL` | Chrome on macOS | Override Playwright browser channel |
| `BROWSER_DIR` | `browser` | Persistent local browser profile |
| `BOOKS_DIR` | `books` | Input directory for offline MP3 exporter |
| `MP3_DIR` | `books/mp3` | Output MP3 directory |

## File layout

- `books/db.json`: library listing.
- `books/saved/{book-id}/book.json`: chapter manifest, HTML text, optional metadata, and reader completeness status.
- `books/saved/{book-id}/*.m4a`: saved audio chapters (also under `books/finished/`).
- `books/mp3/*.mp3`: one MP3 per complete book.
- `browser/`: saved login session, private to your computer.

**Incomplete downloads are never intentionally exported as complete books.** Missing URLs, invalid audio tracks, duplicate filenames, and interrupted reader traversal are reported and skipped. Existing valid chapter files are reused when possible.

See [MP3_EXPORT.md](MP3_EXPORT.md) for compatibility details. The `viewer/` directory is the original upstream experimental viewer and is not part of the MP3 workflow.

## Limitations

- Downloaded titles in the **mobile app** are not necessarily identical to the web Saved/Finished lists.
- The reader navigation may update your Blinkist reading progress or Finished list, even if a download is interrupted.
- A changed web interface may prevent a download despite passing offline tests. If so, the downloader should warn or mark the book incomplete; it is **not** proven functional against the live Blinkist website.
- Legacy `book.json` files created before the completeness marker are best-effort; a previous version may have created partial metadata.
- Do not commit `books/`, `browser/`, or `.env`; they can contain copyrighted content and private session data.

Original project and license: [vogler/blinkist-downloader](https://github.com/vogler/blinkist-downloader).
