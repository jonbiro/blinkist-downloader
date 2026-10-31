# Blinkist Downloader (2026 maintenance fork)

Fork of [Ralf Vogler's blinkist-downloader](https://github.com/vogler/blinkist-downloader), licensed **AGPL-3.0-only**. It uses Playwright to inspect your **Saved** and **Finished** Blinkist web libraries. It also includes an **offline MP3 and M4B audiobook exporter** for accessible M4A chapter files already saved on your computer.

> **Status:** MP3/M4B exports and their offline tests work. Blinkist's current authenticated book reader and audio URLs **have not been tested in 2026**. Expect that its web UI may have changed. The program does not bypass login, paywalls, or DRM. Only download/export material where you have permission; Blinkist's terms may prohibit copying.

## Quick start on macOS

Google Chrome and FFmpeg are supported. The application uses installed Google Chrome automatically on macOS, avoiding an unavailable older Chromium download.

1. Install [Node.js 22+](https://nodejs.org/) and FFmpeg (`brew install ffmpeg`).
2. In this repository, run `npm ci --ignore-scripts` and `npm run doctor`.
3. **Safest first test:** run `MAX_BOOKS=1 npm start`. A browser window will open for you to sign in and complete any verification yourself.
4. Run `npm run verify:library` to see chapter, complete-book, MP3 and M4B counts.
5. Preview conversion with `npm run export:both -- --dry-run`.
6. Export using `npm run export:m4b` for a chaptered audiobook, `npm run export:mp3` for a basic music player, or `npm run export:both` for both.

On Linux, install Chromium using `npx playwright install chromium`, or specify `BROWSER_CHANNEL=chrome` if Chrome is installed.

### Before downloading anything

Run `DRYRUN=1 npm start` to inspect library listings without saving book metadata or audio files (a browser profile may still be written). Or run `DOWNLOAD=0 npm start` to update only the `books/db.json` library index.

**Safe first-run default:** Both downloader backends now attempt at most one pending book unless you explicitly set `MAX_BOOKS=0` (unlimited) or a different positive limit. Mistyped limits are rejected rather than treated as unlimited. Test a single book before increasing the cap.

## Commands

| Command | What it does |
|---|---|
| `npm run doctor` | Checks Node.js, FFmpeg, FFprobe, browser setup and available disk space without logging into Blinkist |
| `MAX_BOOKS=1 npm start` | Test up to one pending book; manual Blinkist login |
| `DOWNLOAD=0 npm start` | Update library index only |
| `DRYRUN=1 npm start` | Preview without writing book files |
| `npm run export:mp3 -- --dry-run` | Preview local MP3 conversions |
| `npm run export:mp3` | One MP3 per complete book in `books/mp3/` |
| `npm run export:m4b` | One chaptered M4B audiobook per book in `books/m4b/`, with cover art when available |
| `npm run export:both` | Produce both MP3 and M4B from the same saved chapters |
| `npm run export:m4b -- --list` | Show local book titles and IDs without exporting |
| `npm run export:m4b -- --book book-id-en` | Export a specific book by its exact local ID |
| `npm run export:both -- --search "title words"` | Export titles matching the specified text (title, author, or book ID) |
| `npm run export:m4b -- --force` | Re-export eligible M4Bs (also supported for MP3 or both formats) |
| `npm run verify:library` | Offline counts of complete/incomplete books, chapters, MP3s and M4Bs |
| `npm run verify:library -- --json` | Machine-readable local counts with no book titles or media URLs |
| `npm run verify:library -- --deep` | Decode-test existing audio locally without writing new files (can be CPU-intensive) |
| `npm run verify:library -- --deep --details` | Show relative paths of damaged files, only when explicitly requested |
| `npm run check` | TypeScript type-check of the downloader |
| `npm run test:browser` | Chrome fixture tests for audio detection, pagination, and redacted diagnostics; no Blinkist login |
| `npm test` | Run offline storage and media conversion tests |

Configure environment variables in your shell or a local `.env` file (which is ignored by Git).

| Variable | Default | Purpose |
|---|---|---|
| `MAX_BOOKS` | `1` | Maximum pending download attempts across both lists; explicit `0` means unlimited. Invalid values fail instead of downloading everything |
| `UPDATE` | `1` | Set `0` to skip refreshing library lists |
| `DOWNLOAD` | `1` | Set `0` to skip downloading books |
| `DRYRUN` | `0` | Preview without writing book data or media |
| `AUDIO` | `1` | Set `0` to save text/metadata only |
| `CHECKALL` | `1` | Full library scan; set `0` for the faster but potentially incomplete legacy early-stop behavior |
| `SHOW` | `1` | Visible browser; needed for interactive sign-in |
| `BROWSER_CHANNEL` | Chrome on macOS | Override Playwright browser channel |
| `BROWSER_DIR` | `browser` | Persistent local browser profile |
| `CAPTURE_AUDIO` | `1` | Set `0` to turn off the experimental network audio fallback |
| `DIAGNOSE` | `0` | Set `1` to show redacted reader-selector counts when a book is incomplete |
| `BOOKS_DIR` | `books` | Shared book directory used by the Chrome downloader, Camoufox, and MP3/M4B exporter |
| `MP3_DIR` | `books/mp3` | Output MP3 directory |
| `M4B_DIR` | `books/m4b` | Output M4B audiobook directory |

## Storage and file safety

Long audiobooks are now concatenated through FFmpeg's streaming audio filters,
including when chapter sample rates differ. No multi-gigabyte temporary WAV
tracks are created. Before each export, the app estimates output size and
keeps a free-space margin; if there is insufficient room it reports an error
without replacing your existing MP3/M4B file.

Run `npm run doctor` to see how much space is available. It warns when below
2 GiB, and bulk exports are best done with more free space. You may also export
directly to another volume by setting `M4B_DIR` or `MP3_DIR`, for example:
`M4B_DIR="/Volumes/External/Audiobooks" npm run export:m4b`.

Files linked via symlinks are not trusted as saved audio, and stale
`.part` symlinks cannot overwrite other files. Downloads and exports
remain local to your machine.

## Choosing MP3 or M4B

**M4B** is intended for audiobook playback (for example, Apple Books and compatible
audiobook players). Each file retains chapter markers such as Introduction,
Key idea 1 and Summary, with title/author/album metadata and optional embedded
cover art. A missing cover does not prevent conversion. **MP3** has wider
compatibility with inexpensive USB music players, but the single-book MP3
does not have navigable chapters. Run `npm run export:both` to keep both formats.

All exports are entirely offline and use only existing local M4A chapters.

## No GitHub Actions usage

GitHub Actions is disabled for this repository, and the workflow was deleted
at the owner's request. No GitHub Actions runs are triggered by pushes.
Run `npm run check`, `npm test`, and `npm run test:browser` locally instead.

## Network audio fallback (experimental)

A December 2025 fork by DominicBoettger used browser network responses as a
fallback when the Blinkist reader supplied only a `blob:` audio URL. Our fork
now records candidate audio responses during **each individual chapter**, but
only uses them when there is exactly one unambiguous HTTPS media candidate.
It never assigns the last arbitrary response to a chapter or logs signed URLs.
Ordinary audio files are downloaded as soon as a source becomes available.

If a chapter has multiple candidate URLs, the program reports ambiguity and
leaves the chapter incomplete rather than exporting the wrong audio. This
fallback has **not** been tested on the current authenticated Blinkist website.

- `CAPTURE_AUDIO=0 MAX_BOOKS=1 npm start` disables this fallback for comparison.
- `npm run test:browser` runs an optional mocked Chrome test; it does not
  contact Blinkist or require your account.
- See [alternative downloader review](docs/alternative-downloaders.md) for
  the DominicBoettger comparison and our security review of ErhardRainer's
  manual Chrome extension.

## Library recovery and safe diagnostics

The Saved/Finished scanner checkpoints newly discovered titles after **each completed page**, preserving earlier results if a later page fails. It fails rather than declaring an unfamiliar login page an empty library. `DRYRUN=1 npm start` previews the scan without saving library data.

When the reader changes or audio cannot be located, use `DIAGNOSE=1 MAX_BOOKS=1 npm start` to print only counts of recognized reader/audio elements and URL *types*, never book text, query strings, signed media URLs, or cookies. This mode still needs you to sign in manually and may move a book into Finished; do not upload `browser/`, `books/`, or complete browser logs.

`npm run verify:library` is completely offline and does not require a Blinkist login. It summarizes partial/complete downloads, MP3s and M4Bs using lightweight file checks. Add `--deep` to decode-test audio (including MP3/M4B outputs) without creating files; this can take longer for a large library. By default it prints only counts. Use `--deep --details` if you want the relative paths of damaged tracks, which may reveal book IDs on your screen.

## File layout

- `books/db.json`: library listing.
- `books/saved/{book-id}/book.json`: chapter manifest, HTML text, optional metadata, and reader completeness status.
- `books/saved/{book-id}/*.m4a`: saved audio chapters (also under `books/finished/`).
- `books/mp3/*.mp3`: one MP3 per complete book.
- `books/m4b/*.m4b`: AAC audiobooks with chapter markers, title/author/album tags, and embedded artwork when available.
- `browser/`: saved login session, private to your computer.

**Incomplete downloads are never intentionally exported as complete books.** HTTP transfers must return the full response, including the declared byte count when provided; short/partial responses are discarded. A download is marked complete only when extraction starts at Introduction, reaches Summary, and has recognizable audio files for every chapter. A failed retry preserves a more complete previous chapter manifest; old false-positive completion markers and obvious non-audio files are rejected. Existing good chapters are reused when possible.

See [the audio export guide](MP3_EXPORT.md) for MP3/M4B compatibility and chapter metadata details. The `viewer/` directory is the original upstream experimental viewer and is not part of the MP3 workflow.

## Limitations

- Downloaded titles in the **mobile app** are not necessarily identical to the web Saved/Finished lists.
- The reader navigation may update your Blinkist reading progress or Finished list, even if a download is interrupted.
- A changed web interface may prevent a download despite passing offline tests. If so, the downloader should warn or mark the book incomplete; it is **not** proven functional against the live Blinkist website.
- Legacy `book.json` files created before the completeness marker are best-effort; a previous version may have created partial metadata.
- Do not commit `books/`, `browser/`, or `.env`; they can contain copyrighted content and private session data.

Original project and license: [vogler/blinkist-downloader](https://github.com/vogler/blinkist-downloader).

## Alternative browser: Camoufox (Python + Firefox)

The original `npm start` continues to use Node and Google Chrome. There is now also an optional **Python Camoufox backend** inspired by Seldos's Firefox implementation. It downloads to the same local `books/` structure so the existing MP3/M4B exporter works with either backend. Camoufox's Python API uses the Playwright protocol internally, but it launches a different Firefox-based browser and does not require Node for scanning/downloading.

To install and test on a Mac with [uv](https://docs.astral.sh/uv/) (recommended because macOS may use a newer system Python):

```sh
uv venv --python 3.12 .venv-camoufox
uv pip install --python .venv-camoufox/bin/python -r requirements-camoufox.txt
.venv-camoufox/bin/python -m camoufox fetch
SHOW=0 npm run start:camoufox -- --smoke-test  # offline browser test
```

The first Camoufox browser download is substantial (approximately 1.3 GB). `npm run start:camoufox` automatically uses `.venv-camoufox` when installed; you **do not need to activate it**. For a first real test with a visible Firefox browser, use `npm run start:camoufox -- --max-books 1 --diagnose` and sign in manually. You can also use `.venv-camoufox/bin/python -m camoufox_backend` directly without Node.

Camoufox has a separate persistent login profile in `browser-camoufox/` (Git-ignored), does not perform automated sign-in or CAPTCHA solving, and **limits the first run to one pending book by default**. Do not run both backends concurrently. For comprehensive options, limitations, and offline tests, see [Camoufox setup](docs/CAMOUFOX.md). MP3/M4B exports still use the same Node/FFmpeg commands, and GitHub Actions remains disabled.
