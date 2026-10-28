# MP3 export: usage and limitations

The exporter converts **existing local M4A chapter files** into one MP3 per book. It does not access Blinkist or bypass login/DRM. Only use it with content you may legally export.

## Commands

From the repository directory:

1. `npm run doctor` — verify local prerequisites.
2. `MAX_BOOKS=1 npm start` — optional one-book website test; you'll sign in manually.
3. `npm run export:mp3 -- --dry-run` — preview which books are eligible.
4. `npm run export:mp3` — export eligible books to `books/mp3/`.
5. Copy the MP3 files to your music player over USB or its management software.

FFmpeg and FFprobe are required. On macOS install them with `brew install ffmpeg`.

To replace files already exported, run `npm run export:mp3 -- --force`. To change paths, set `BOOKS_DIR` or `MP3_DIR` in the command environment.

### Experimental network-media fallback

When Blinkist's player exposes only a `blob:` source, the downloader can
observe ordinary HTTPS audio network responses during chapter navigation.
Only one unambiguous response per chapter is accepted; uncertain matches
leave the chapter incomplete. Signed media links are not printed to logs,
but **the local book.json manifest may contain signed URLs**, so keep your
`books/` directory private. To disable this feature, run
`CAPTURE_AUDIO=0 MAX_BOOKS=1 npm start`. This does not bypass DRM or login,
and has not been verified against a live October 2026 Blinkist session.

## How completeness is determined

Each downloaded book has a `book.json` with the ordered chapter list. Modern manifests also have `readerComplete` and, for each chapter, `fileName`.

- `readerComplete: false` means chapter traversal stopped early. **The MP3 is not produced.**
- All chapters must have audio URLs and corresponding locally saved files. Missing chapters cause a skip rather than a partial export.
- The exporter verifies that each source file actually contains decodable audio (using FFprobe) and validates the combined MP3 duration.
- Failed transcoding never replaces an existing MP3; output is staged in a temporary file and renamed only after validation.
- Older manifests without `readerComplete` are supported on a best-effort basis. Without a known manifest, legacy M4A files are sorted by their filenames; completeness cannot be guaranteed.

If a book is skipped, read the reason in the output. To retry interrupted downloads, run `MAX_BOOKS=1 npm start` again (or remove the limit after a successful test). The downloader reuses chapters that already exist.

## Filename and playback compatibility

Output naming: `Book title - Author [book-id].mp3`. Long titles are shortened to stay within filesystem limits. Files use ID3v2.3 title and artist tags and are transcoded to MP3 by FFmpeg. Chapter files are concatenated in manifest order.

The export format is intended for ordinary MP3 players but has not been tested on every model. This converter does not modify protected files or remove copy protection.

## Limits of the current repair

- Automated tests use generated audio samples, **not** actual Blinkist audio.
- The live Blinkist login, pagination, reader selectors, audio URLs, and terms may have changed since upstream development. End-to-end web downloading remains **unverified**.
- The web Saved/Finished lists may differ from titles downloaded for offline listening on a phone.
- Browsing chapters can alter reading progress or move a title into Finished.
- Browser profiles (`browser/`), download data (`books/`), and local `.env` files are Git-ignored. Do not upload them to public issues.
