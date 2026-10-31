# Optional Camoufox (Python + Firefox) backend

This adds an **alternative downloader**, adapted from the approach in [Seldos/blinkist-downloader](https://github.com/Seldos/blinkist-downloader), without replacing the existing TypeScript/Chrome downloader. Both use the same `books/db.json` and `books/{saved,finished}/{book-id}/` layout. The existing Node/FFmpeg offline exporter can convert downloads from **either backend** to MP3, chaptered M4B, or both.

Camoufox runs a modified Firefox browser using **Python**. Its Python integration internally uses Playwright; it is not independent of the Playwright protocol. It does not require Node to browse/download, but the **shared MP3/M4B exporter** still uses Node and FFmpeg.

## Installation (macOS)

From the repo root:

```sh
python3 -m venv .venv-camoufox
source .venv-camoufox/bin/activate
python -m pip install -r requirements-camoufox.txt
python -m camoufox fetch
python -m camoufox_backend --smoke-test
```

The browser download is separate from Google Chrome and is not performed by `pip install`. Camoufox requires Python 3.10 or newer. The pinned version is the October 2026 stable `0.5.8`; no prerelease or auto-update is needed. A browser launch is not verified until the **smoke test** succeeds on your machine.

## Run

```sh
# Use visible Firefox; manually log in when prompted. Limits downloads to ONE book by default.
python -m camoufox_backend

# Scan Saved and Finished without downloading audio or books
python -m camoufox_backend --list-only

# Preview without changing books/db.json or creating audio files
python -m camoufox_backend --dry-run

# One-book test with redacted reader diagnostics
python -m camoufox_backend --max-books 1 --diagnose

# After confirming it works, explicitly enable more books
python -m camoufox_backend --max-books 10

# (Use only when authorized and ready) No per-run book limit
python -m camoufox_backend --max-books 0
```

If Python is active in the virtual environment, `npm run start:camoufox` is a convenience alias for `python3 -m camoufox_backend`.

### Shared export

```sh
npm run verify:library
npm run export:m4b
npm run export:mp3
npm run export:both
```

These commands run **offline** on saved `.m4a` files and do not access Blinkist. The M4B format includes chapter titles and optional cover art.

### Profiles, privacy and compatibility

- Camoufox uses `browser-camoufox/` as its own persistent login profile; it never opens the Node backend's `browser/` Chrome profile. Both directories, `books/`, and `.venv-camoufox/` are Git-ignored.
- It expects manual login. It does not solve CAPTCHA challenges, decrypt DRM, bypass subscription checks, or copy signed URLs into public logs.
- It writes `readerComplete`, `fileName`, `audio`, `audioSource`, and chapter text in the same JSON shape as the Node downloader; incomplete downloads remain incomplete and can be retried.
- Settings can be passed with environment variables (`BOOKS_DIR`, `CAMOUFOX_PROFILE`, `SHOW`, `MAX_BOOKS`, `UPDATE`, `DOWNLOAD`, `AUDIO`, `CHECKALL`, `CAPTURE_AUDIO`, `DIAGNOSE`, `TIMEOUT`) or through the documented command-line flags. The Python backend's **default** `MAX_BOOKS` is **1** for safety. `--max-books 0` means unlimited.
- Only the `books/` folder is shared; do **not run both browser backends simultaneously** against it.
- The code and offline test harness have been reviewed locally; a real signed-in browser integration has **not** been demonstrated against the current Blinkist site. Site layout, reader/audio controls, and Blinkist subscription terms may differ.

## Local tests (no GitHub Actions)

```sh
python -m unittest discover -s tests -p 'test_camoufox_backend.py' -v
python -m compileall -q camoufox_backend
```

The unit tests use a fake Camoufox context and fake web pages. No remote browser, paid GitHub Actions, Blinkist login, or Blinkist content is needed to run these tests. GitHub Actions remains disabled for this repository.
