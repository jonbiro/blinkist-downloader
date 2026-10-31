# Optional Camoufox (Python + Firefox) backend

This adds an **alternative downloader**, adapted from the approach in [Seldos/blinkist-downloader](https://github.com/Seldos/blinkist-downloader), without replacing the existing TypeScript/Chrome downloader. Both use the same `books/db.json` and `books/{saved,finished}/{book-id}/` layout. The existing Node/FFmpeg offline exporter can convert downloads from **either backend** to MP3, chaptered M4B, or both.

Camoufox runs a modified Firefox browser using **Python**. Its Python integration internally uses Playwright; it is not independent of the Playwright protocol. It does not require Node to browse/download, but the **shared MP3/M4B exporter** still uses Node and FFmpeg.

## Installation (macOS)

From the repository root, use Python **3.12** inside a project-local environment. The Mac's default `python3` may be newer and may not have Camoufox installed.

```sh
uv venv --python 3.12 .venv-camoufox
uv pip install --python .venv-camoufox/bin/python -r requirements-camoufox.txt
.venv-camoufox/bin/python -m camoufox fetch
SHOW=0 npm run start:camoufox -- --smoke-test
npm run test:camoufox
```

Install [uv](https://docs.astral.sh/uv/) if necessary; alternatively create `.venv-camoufox` using Python 3.12's `venv` and install the requirements with its own `pip`. The first Camoufox Firefox download is approximately **1.3 GB**. The Python package is pinned to `camoufox==0.5.8`, which selects its paired browser build. On the connected Mac, the real headless Firefox **smoke test passed on an offline `data:` page**. No Blinkist login or live download was involved.

The `npm run start:camoufox` alias automatically selects `.venv-camoufox` without activating it; using `.venv-camoufox/bin/python -m camoufox_backend` directly avoids Node entirely.

## Run

```sh
# Use visible Firefox; manually sign in. Limits download attempts to ONE book by default.
npm run start:camoufox

# Scan Saved and Finished without downloading any books
npm run start:camoufox -- --list-only

# Preview without writing to books/db.json or downloading media
npm run start:camoufox -- --dry-run

# Controlled one-book test with redacted reader diagnostics
npm run start:camoufox -- --max-books 1 --diagnose

# Only after verifying one-book downloads, allow 10 pending books
npm run start:camoufox -- --max-books 10

# Advanced: direct Python invocation (no Node needed)
.venv-camoufox/bin/python -m camoufox_backend --max-books 1
```

The npm alias selects the project's `.venv-camoufox` interpreter automatically. It does **not** replace the Python downloader with Node; it only launches Python.

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
- It expects manual login, can return to Saved when login lands on a home feed, and waits briefly for the library's client-rendered cards. It does not solve CAPTCHA challenges, decrypt DRM, bypass subscription checks, or copy signed URLs into public logs.
- It writes `readerComplete`, `fileName`, `audio`, `audioSource`, and chapter text in the same JSON shape as the Node downloader. It requires a confirmed Introduction-to-Summary traversal, validates basic media signatures, rejects shorter-than-advertised HTTP responses, preserves better prior manifests on interrupted retries, and retries corrupt previous `book.json` files.
- Settings can be passed with environment variables (`BOOKS_DIR`, `CAMOUFOX_PROFILE`, `SHOW`, `MAX_BOOKS`, `UPDATE`, `DOWNLOAD`, `AUDIO`, `CHECKALL`, `CAPTURE_AUDIO`, `DIAGNOSE`, `TIMEOUT`) or through the documented command-line flags. The Python backend's **default** `MAX_BOOKS` is **1** for safety. `--max-books 0` means unlimited.
- Only the `books/` folder is shared; do **not run both browser backends simultaneously** against it.
- The code and offline test harness have been reviewed locally; a real signed-in browser integration has **not** been demonstrated against the current Blinkist site. Site layout, reader/audio controls, and Blinkist subscription terms may differ.

## Local tests (no GitHub Actions)

```sh
npm run test:camoufox
.venv-camoufox/bin/python -m compileall -q camoufox_backend
```

The unit tests use a fake Camoufox context and fake web pages. No remote browser, paid GitHub Actions, Blinkist login, or Blinkist content is needed to run these tests. GitHub Actions remains disabled for this repository.
