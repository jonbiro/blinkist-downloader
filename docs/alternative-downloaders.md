# Review of alternative Blinkist downloader approaches

Reviewed October 28, 2026. This is a **source-code comparison**, not a claim that
either alternative still downloads Blinkist audio in the current website.

## DominicBoettger's December 2025 audio fix

Source: [commit 06acadba, "fix: audio Download"](https://github.com/DominicBoettger/blinkist-downloader/commit/06acadba39ab9a3a778c709c97a4bd84e537c14e).

The fork listens for browser `response` events to find audio requests, tries
alternate selectors for changed reader content, and adds navigation fallbacks.
It can help when a player exposes only a `blob:` source rather than the
underlying HTTPS media request.

**Incorporated into this fork:**
- Listen only while visiting a specific book, and detach the listener afterwards.
- Accept only successful HTTPS responses that look like ordinary audio; reject
  playlists, non-media responses, blob URLs and HTTP failures.
- Use a response window for each chapter; deduplicate HTTP range requests.
- Prefer a valid direct audio attribute, or exactly **one** matching network URL.
- Never assign the most recent URL when multiple responses may be unrelated.
- Save each chapter promptly while its time-limited media link may still work.
- Try two narrowly scoped alternate reader-content selectors, without treating
  unrelated page sections as reader chapters.

**Not adopted:** Selecting the last network URL, keyboard navigation that has
not been verified against current reader markup, broad `article` and
`[data-test-id*="reader"]` selectors, or printing signed media URLs to logs.
All of those introduce misidentification or privacy risks.

## ErhardRainer's Chrome extension

Source: [ErhardRainer/blinkist_downloader](https://github.com/ErhardRainer/blinkist_downloader),
`Chrome_Plugin/manifest.json`, `content.js` and `popup.js` (December 2025).

The extension scans the current tab for `audio[src]` values beginning with
`blob:` and can attempt to save a blob manually with a title-derived filename.
It is not a library crawler, does not associate tracks with numbered chapters,
and does not export a complete book or library automatically.

**Limitations found in the source:**
- The manifest includes `<all_urls>`, so the content script runs on unrelated
  sites. That is unnecessarily broad for a Blinkist-specific extension.
- It detects only blob addresses attached directly to `audio[src]`, missing
  some other HTML or streaming approaches.
- The resulting files use a page-title-derived name; chapter naming and ordering
  are not handled, and repeated downloads could collide.
- Browser blob URLs are not durable direct media URLs. Fetching them from an
  extension content script may fail depending on origin and browser isolation.
- Current Blinkist compatibility and any DRM restrictions were not verified.

**Decision:** Do not silently install or bundle this extension. It is at most
an **optional, manual fallback** for users who review its code and have
permission to save the audio. Before any manual trial, restrict
`content_scripts.matches` to `["https://www.blinkist.com/*"]`, load the
extension unpacked in a temporary Chrome profile, and disable it afterwards.
There is no guarantee that it can access the current player audio.

## Tests and behavior of this fork

- `npm run test:core` checks audio-response classification, ambiguous sources,
  duplicate requests, chapter boundaries, and listener cleanup.
- `npm run test:browser` launches an installed Chrome browser with **mocked local
  browser responses**; no Blinkist login or content is used.
- `npm test` also verifies FFmpeg's conversion of synthetic chapter audio.
- `CAPTURE_AUDIO=0 MAX_BOOKS=1 npm start` turns off the new network fallback
  for comparison during a permitted, controlled single-book test.
- `MAX_BOOKS=1 npm start` enables the default capture, without downloading
  an unlimited library.

**Important:** No live account/reader integration was tested. Passing synthetic
tests does not prove that Blinkist still serves directly downloadable audio.
The downloader does not decrypt DRM-protected streams or bypass authentication.
Private browser sessions, saved media URLs, and downloaded content must stay
out of Git and public bug reports.
