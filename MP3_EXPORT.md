# Offline audio export: MP3 and M4B audiobook

The exporter converts **existing local M4A chapter files** into MP3, M4B (chaptered audiobook), or both, one file per book. It does not access Blinkist or bypass login/DRM. Only use it with content you may legally export.

## Commands

From the repository directory:

1. `npm run doctor` — verify local prerequisites.
2. `MAX_BOOKS=1 npm start` — optional one-book website test; you'll sign in manually.
3. `npm run export:both -- --dry-run` — preview eligible books without writing anything.
4. `npm run export:mp3` — save MP3 files to `books/mp3/`.
5. `npm run export:m4b` — save chaptered M4B audiobooks to `books/m4b/`.
6. `npm run export:both` — make both formats from the same saved chapters.
7. Transfer the format supported by your MP3 player or audiobook app.

FFmpeg and FFprobe are required. On macOS install them with `brew install ffmpeg`.

The exporter automatically rebuilds an MP3 or M4B if it is corrupt, stale, abnormally short, or its metadata is outdated. For M4B, it additionally checks the chapter count/titles and expected cover artwork. Existing verified exports are skipped.

Use `npm run export:m4b -- --force` to rebuild every M4B or `npm run export:both -- --force` for both formats. Set `BOOKS_DIR` for input, `MP3_DIR` for MP3 output, or `M4B_DIR` for audiobook output.

Run `npm run verify:library` for local counts of complete/incomplete books, MP3s, and M4Bs. To share only non-identifying counts when troubleshooting, use `npm run verify:library -- --json`. The inventory does not verify that each M4A can be decoded; the exporter performs that check.

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

## M4B audiobook details

M4B contains AAC narration in an MP4 audiobook container. Chapter labels
and start/end times are embedded based on the saved `book.json` manifest (or
filenames for old downloads). It also includes title, author, album and
Audiobook genre tags. If there is a valid `cover.jpg`, `cover.jpeg` or
`cover.png` in the local book directory, artwork is embedded in the M4B.
Otherwise the M4B remains a playable audio-only audiobook.

M4B is ideal for Apple Books and many dedicated audiobook players, but a
simple USB music player may support MP3 only. Converting to M4B does not
modify or remove your original M4A chapters.

## Filename and playback compatibility

Output naming: `Book title - Author [book-id].mp3` or `.m4b`. Long titles are shortened to stay within filesystem limits. Files use ID3v2.3 title and artist tags and are transcoded to MP3 by FFmpeg. Chapter files are concatenated in manifest order.

The export format is intended for ordinary MP3 players but has not been tested on every model. This converter does not modify protected files or remove copy protection.

## Limits of the current repair

- Automated tests use generated audio samples, **not** actual Blinkist audio.
- The live Blinkist login, pagination, reader selectors, audio URLs, and terms may have changed since upstream development. End-to-end web downloading remains **unverified**.
- The web Saved/Finished lists may differ from titles downloaded for offline listening on a phone.
- Browsing chapters can alter reading progress or move a title into Finished.
- Browser profiles (`browser/`), download data (`books/`), and local `.env` files are Git-ignored. Do not upload them to public issues.
