# Blinkist downloader — 2026 repair and MP3 export

This is a patch for the open-source [vogler/blinkist-downloader](https://github.com/vogler/blinkist-downloader) project (AGPL-3.0-only). The changes are intended for use only where downloading and copying the content is authorized. Blinkist's subscription terms may restrict exporting its material. This patch does not bypass authentication, paywalls, or digital rights management (DRM).

## What was changed

- Fixes the January 2026 crash (`Cannot read properties of undefined (reading 'locator')`, issue #6): optional metadata sections no longer abort book processing.
- Skips disabled/unavailable library cards and non-book items, including the problem reported in issue #4 and partially addressed by unmerged PR #5.
- Makes optional GraphQL metadata nonblocking, handles missing reader/audio elements with actionable warnings, and stops chapter traversal loops if the page stops changing.
- Resumes partial downloads, rather than skipping any existing book folder.
- Verifies HTTP status and rejects obvious HTML/JSON error responses before writing media; retries failures and uses temporary files.
- Adds `npm run export:mp3` to combine locally downloaded `.m4a` chapters into **one MP3 per book**. The MP3s are saved under `books/mp3/`, with title/author metadata.

## Usage

1. Fork the upstream project on GitHub if you want to publish your own changes.
2. Clone the upstream repo or your fork, apply `blinkist-fix.patch` with `git apply blinkist-fix.patch`, and run `npm install` (Node 22 or newer is recommended). Or copy the five updated/new files from the overlay archive into the cloned repository.
3. Have FFmpeg installed: `brew install ffmpeg` on macOS, or `sudo apt install ffmpeg` on Ubuntu.
4. Run `npm start` for supported Blinkist downloads. Sign in interactively using your **own subscription** when prompted. Do not put credentials in source files.
5. Run `npm run export:mp3` to convert what was downloaded. Copy the contents of `books/mp3/` to your device.
6. Run `npm run test:mp3` to test the local MP3 conversion. Run `npm run export:mp3 -- --dry-run` to preview exports. Use `--force` to regenerate existing MP3s.

By default the exporter searches `books/saved` and `books/finished`. `BOOKS_DIR` can point to another downloads directory, and `MP3_DIR` can select a different destination.

## Verification and limitations

- The crash was identified directly in the original source and the selector access is now guarded.
- The MP3 conversion was tested offline with real generated `.m4a` fixtures using FFmpeg. No Blinkist content was used in these tests.
- **End-to-end downloading is not verified**: the updated, authenticated Blinkist 2026 reader and audio URL format cannot be inspected or tested without a Blinkist login. If the reader UI has changed more substantially, the script will warn `Reader UI unavailable/changed` or `No audio URLs found` rather than claim success. A live login session will be needed for the final integration fix.
- The script accesses the **Saved and Finished web library lists**, not necessarily every item that is offline-downloaded in the mobile app.
- Do not commit the `books/` or `browser/` folders; they can contain licensed content and private sessions.
