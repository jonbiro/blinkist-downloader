"""Optional Camoufox (Firefox) backend for Blinkist's Saved/Finished web library.

The browser library is imported only by the CLI entry point. The data model
matches the Node backend and the shared offline MP3/M4B exporter.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import urlopen

SAVED_URL = "https://www.blinkist.com/en/app/library/saved"
BASE_URL = "https://www.blinkist.com"
READER_SELECTOR = '.reader-content__text, [data-test-id="readerContent"], [data-test-id="reader-content"]'
BOOK_CARD_SELECTOR = 'a[data-test-id="book-card"]'
MAX_MEDIA_BYTES = 100 * 1024 * 1024
AUDIO_MIMES = {
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac",
    "audio/x-aac", "audio/wav", "audio/ogg", "audio/webm",
}
BAD_NAME = re.compile(r'[\\/\x00-\x1f:*?"<>|]')
BOOK_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,160}$")


@dataclass(frozen=True)
class Settings:
    books_dir: Path = Path("books")
    browser_dir: Path = Path("browser-camoufox")
    headless: bool = False
    dry_run: bool = False
    update: bool = True
    download: bool = True
    audio: bool = True
    check_all: bool = True
    capture_audio: bool = True
    diagnose: bool = False
    max_books: int = 1  # safe initial cap; set explicitly to 0 for an unlimited run
    timeout_ms: int = 30_000
    login_timeout_s: int = 120

    @classmethod
    def from_env(cls) -> "Settings":
        def flag(name: str, default: str) -> bool:
            return os.environ.get(name, default) == "1"
        max_books = int(os.environ.get("MAX_BOOKS", "1"))
        if max_books < 0:
            raise ValueError("MAX_BOOKS cannot be negative")
        return cls(
            books_dir=Path(os.environ.get("BOOKS_DIR", "books")),
            browser_dir=Path(os.environ.get("CAMOUFOX_PROFILE", "browser-camoufox")),
            headless=not flag("SHOW", "1"),
            dry_run=flag("DRYRUN", "0"),
            update=flag("UPDATE", "1"),
            download=flag("DOWNLOAD", "1"),
            audio=flag("AUDIO", "1"),
            check_all=flag("CHECKALL", "1"),
            capture_audio=flag("CAPTURE_AUDIO", "1"),
            diagnose=flag("DIAGNOSE", "0"),
            max_books=max_books,
            timeout_ms=max(1000, int(os.environ.get("TIMEOUT", "30")) * 1000),
        )


def safe_name(name: str) -> str:
    """Same 120 UTF-8 byte limit as the TypeScript chapter filenames."""
    clean = BAD_NAME.sub("_", str(name)).strip()
    chars: list[str] = []
    used = 0
    for char in clean:
        size = len(char.encode("utf-8"))
        if used + size > 120:
            break
        chars.append(char)
        used += size
    return "".join(chars).rstrip(". ") or "Chapter"


def valid_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 128
    except OSError:
        return False


def valid_audio_file(path: Path) -> bool:
    """Reject HTML, JSON and random bytes masquerading as saved M4A audio.

    Header validation is deliberately inexpensive. FFprobe checks actual
    decodability when generating MP3/M4B exports.
    """
    if not valid_file(path):
        return False
    try:
        with path.open("rb") as stream:
            header = stream.read(16)
    except OSError:
        return False
    if len(header) < 12:
        return False
    return (
        header[4:8] == b"ftyp"
        or header[:4] in {b"OggS", b"fLaC"}
        or (header[:4] == b"RIFF" and header[8:12] == b"WAVE")
        or header[:4] == bytes([0x1a, 0x45, 0xdf, 0xa3])
        or header[:3] == b"ID3"
        or (header[0] == 0xff and (header[1] & 0xe0) == 0xe0)
    )


def chapter_file(chapter: dict[str, Any]) -> str | None:
    if "fileName" in chapter:
        file = chapter["fileName"]
        if not isinstance(file, str) or BAD_NAME.search(file) or not file.lower().endswith(".m4a"):
            return None
        return file if file not in {".", ".."} else None
    name = chapter.get("name")
    return safe_name(name) + ".m4a" if isinstance(name, str) and name.strip() else None


def complete_book(book: Any, directory: Path, audio_required: bool) -> bool:
    if not isinstance(book, dict) or book.get("readerComplete") is False:
        return False
    chapters = book.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        return False
    # Recheck saved manifests from older versions that incorrectly considered
    # a mid-book suffix complete because it ended with Summary.
    if book.get('readerComplete') is True and not reached_complete_summary(chapters):
        return False
    if not audio_required:
        return True
    used: set[str] = set()
    for chapter in chapters:
        if not isinstance(chapter, dict) or not isinstance(chapter.get("audio"), str) or not chapter["audio"]:
            return False
        filename = chapter_file(chapter)
        if not filename or filename.lower() in used or not valid_audio_file(directory / filename):
            return False
        used.add(filename.lower())
    return True


def choose_file(name: str, index: int, directory: Path, used: set[str]) -> str:
    clean = safe_name(name)
    legacy = clean + ".m4a"
    numbered = f"{index + 1:03d} - {clean}.m4a"
    if numbered.lower() not in used and valid_audio_file(directory / numbered):
        result = numbered
    elif legacy.lower() not in used and valid_audio_file(directory / legacy):
        result = legacy
    else:
        result = numbered
    used.add(result.lower())
    return result


def clean_book_url(href: str) -> tuple[str, str] | None:
    try:
        url = urlsplit(urljoin(BASE_URL, href))
    except ValueError:
        return None
    if (url.scheme, url.netloc) != ("https", "www.blinkist.com"):
        return None
    prefix = "/en/app/books/"
    if not url.path.startswith(prefix):
        return None
    ident = url.path[len(prefix):]
    if not BOOK_ID.fullmatch(ident):
        return None
    return ident, urlunsplit((url.scheme, url.netloc, url.path, "", ""))


def https_media(raw: str | None, base: str = BASE_URL) -> str | None:
    if not raw:
        return None
    try:
        url = urlsplit(urljoin(base, raw))
    except ValueError:
        return None
    return url.geturl() if url.scheme == "https" and url.hostname else None


def is_audio_response(url: str, status: int, content_type: str) -> bool:
    media_url = https_media(url)
    if not media_url or status not in (200, 206):
        return False
    mime = content_type.split(";", 1)[0].strip().lower()
    if "mpegurl" in mime or "dash+xml" in mime:
        return False
    if mime in AUDIO_MIMES:
        return True
    if mime and mime not in {"application/octet-stream", "binary/octet-stream"}:
        return False
    return bool(re.search(r"\.(m4a|mp3|aac|mp4|ogg|webm|wav)$", urlsplit(media_url).path, re.I))


def choose_audio(raw: str | None, current_url: str, responses: list[str], used: set[str]) -> tuple[str | None, str]:
    dom = https_media(raw, current_url)
    if dom and dom not in used:
        return dom, "attribute"
    candidates = list(dict.fromkeys(url for raw_url in responses if (url := https_media(raw_url, current_url)) and url not in used))
    if len(candidates) == 1:
        return candidates[0], "network"
    return None, "ambiguous" if candidates else "missing"


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(path.name + ".part")
    try:
        staged.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)


def download_file(url: str, dest: Path, opener: Callable[..., Any] = urlopen) -> None:
    """Download accessible HTTPS media; never write partial files as complete."""
    if not https_media(url) or not url.startswith("https://"):
        raise ValueError("Only HTTPS media URLs can be downloaded")
    dest.parent.mkdir(parents=True, exist_ok=True)
    staged = dest.with_name(dest.name + ".part")
    try:
        with opener(url, timeout=30) as response, staged.open("wb") as handle:
            final_url = getattr(response, "geturl", lambda: url)()
            if not final_url.startswith("https://"):
                raise ValueError("Media response redirected outside HTTPS")
            status = getattr(response, "status", 200)
            if status != 200:
                raise ValueError("Unexpected partial or failed media response")
            content_type = response.headers.get("Content-Type", "").lower()
            if content_type.startswith("text/") or "json" in content_type:
                raise ValueError("Response is not media")
            length = int(response.headers.get("Content-Length") or 0)
            if length > MAX_MEDIA_BYTES:
                raise ValueError("Media exceeds 100 MB limit")
            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MEDIA_BYTES:
                    raise ValueError("Media exceeds 100 MB limit")
                handle.write(chunk)
            if length and total != length:
                raise ValueError('Truncated or incomplete media response (length mismatch)')
        if not (valid_audio_file(staged) if dest.suffix.lower() == '.m4a' else valid_file(staged)):
            raise ValueError("Empty or suspiciously short media response")
        with staged.open("rb") as handle:
            prefix = handle.read(96).strip().lower()
        if prefix.startswith((b"<html", b"<!doctype html", b'{"error"')):
            raise ValueError("Server returned HTML/JSON instead of media")
        staged.replace(dest)
    finally:
        staged.unlink(missing_ok=True)


def optional_text(locator: Any, timeout: int = 500) -> str:
    try:
        return locator.inner_text(timeout=timeout)
    except Exception:
        return ""


def optional_attr(locator: Any, attribute: str) -> str | None:
    try:
        return locator.get_attribute(attribute, timeout=500)
    except Exception:
        return None


def reached_complete_summary(chapters: list[dict[str, Any]]) -> bool:
    """Require explicit Introduction -> ... -> Summary, not an arbitrary suffix."""
    return (
        len(chapters) >= 2
        and all(isinstance(chapter, dict) for chapter in chapters)
        and chapters[0].get("name") == "Introduction"
        and chapters[-1].get("name") == "Summary"
    )


def select_saved_manifest(previous: Any, incoming: dict[str, Any]) -> dict[str, Any]:
    """Keep an earlier, more complete chapter inventory after a failed retry."""
    if not isinstance(previous, dict):
        return incoming
    old_chapters = previous.get("chapters")
    new_chapters = incoming.get("chapters")
    old_chapters = old_chapters if isinstance(old_chapters, list) else []
    new_chapters = new_chapters if isinstance(new_chapters, list) else []
    if not old_chapters or not all(isinstance(c, dict) for c in old_chapters):
        return incoming
    if not new_chapters or not all(isinstance(c, dict) for c in new_chapters):
        return previous

    old_full = previous.get("readerComplete") is True and reached_complete_summary(old_chapters)
    new_full = incoming.get("readerComplete") is True and reached_complete_summary(new_chapters)
    if new_full:
        return incoming
    if old_full:
        return previous
    if (old_chapters[0].get("name") == "Introduction" and
            new_chapters[0].get("name") != "Introduction"):
        return previous
    if len(old_chapters) > len(new_chapters):
        return previous
    return incoming


def infer_chapter_label(number: str, heading: str) -> str:
    if number.strip():
        return number.strip()
    return "Summary" if heading.strip().lower() in {"summary", "conclusion"} else "Unknown"


class Downloader:
    def __init__(self, settings: Settings, page: Any):
        self.settings = settings
        self.page = page
        self.db_path = settings.books_dir / "db.json"
        self.db: dict[str, list[dict[str, Any]]] = read_json(self.db_path, {"guides": [], "saved": [], "finished": []})
        for key in ("saved", "finished", "guides"):
            if not isinstance(self.db.get(key), list):
                raise ValueError("Invalid books/db.json: " + key + " should be a list")
        self.attempted = 0
        self.completed = 0
        self.failed = 0

    def checkpoint(self) -> None:
        if not self.settings.dry_run:
            write_json_atomic(self.db_path, self.db)

    def library_ready(self) -> bool:
        url = urlsplit(self.page.url)
        if url.path != "/en/app/library/saved":
            return False
        title = self.page.title().lower()
        if "just a moment" in title or "verify you are human" in title:
            return False
        return bool(self.page.locator('a[data-test-id="book-card"], h1:has-text("Saved"), h2:has-text("Saved"), h3:has-text("Saved")').count())

    def login(self) -> None:
        self.page.goto(SAVED_URL, wait_until="domcontentloaded")
        if self.library_ready():
            return
        if self.settings.headless:
            raise RuntimeError("Login requires a visible Camoufox browser (SHOW=1).")
        print("Sign in and complete any verification yourself in the Camoufox window.")
        deadline = time.monotonic() + self.settings.login_timeout_s
        last_library_retry = 0.0
        while time.monotonic() < deadline:
            if self.library_ready():
                return
            # Login may land on the home feed instead of Saved. Once signed
            # in, re-open Saved without interrupting the actual login form.
            location = urlsplit(self.page.url)
            pathname = location.path.lower()
            route_segments = set(pathname.strip('/').split('/'))
            is_login_form = bool(route_segments & {
                'login', 'sign-in', 'signin', 'auth', 'authentication',
                'register', 'signup', 'sign-up',
            })
            if (location.scheme == "https"
                    and location.hostname == "www.blinkist.com"
                    and pathname.startswith("/en/app/")
                    and pathname != "/en/app/library/saved"
                    and not is_login_form
                    and time.monotonic() - last_library_retry > 5):
                last_library_retry = time.monotonic()
                try:
                    self.page.goto(SAVED_URL, wait_until="domcontentloaded")
                    if self.library_ready():
                        return
                except Exception:
                    pass
            self.page.wait_for_timeout(1000)
        raise RuntimeError("Could not verify the Saved library; no books were downloaded.")

    def _wait_for_library_page(self, list_name: str) -> None:
        """Wait for the client-rendered cards/heading, not just DOMContentLoaded."""
        deadline = time.monotonic() + 8
        while True:
            cards = self.page.locator(BOOK_CARD_SELECTOR).count()
            headings = self.page.locator("h1,h2,h3").all()
            if cards or any(optional_text(h).strip().lower() == list_name for h in headings):
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Library did not render book cards or the expected heading")
            self.page.wait_for_timeout(200)

    def scan(self, list_name: str) -> int:
        url = BASE_URL + "/en/app/library/" + list_name
        response = self.page.goto(url, wait_until="domcontentloaded")
        if not response or not response.ok:
            raise RuntimeError("Cannot open " + list_name + " library")
        existing = self.db[list_name]
        known = {b.get("id") for b in existing if isinstance(b, dict)}
        saved = {b.get("id") for b in self.db["saved"] if isinstance(b, dict)}
        new_books: list[dict[str, Any]] = []
        pages_seen: set[str] = set()
        for page_number in range(1, 251):
            self._wait_for_library_page(list_name)
            all_cards = self.page.locator(BOOK_CARD_SELECTOR)
            cards = all_cards.all()
            heading = self.page.locator("h1,h2,h3").all()
            if not cards and not any(optional_text(h).strip().lower() == list_name for h in heading):
                raise RuntimeError("Unrecognized " + list_name + " page; refusing to treat as an empty library")
            hrefs = [optional_attr(card, "href") or "" for card in cards]
            fingerprint = "|".join(hrefs) or "empty:" + self.page.url
            if fingerprint in pages_seen:
                raise RuntimeError("Repeated library page; previous pages are checkpointed")
            pages_seen.add(fingerprint)
            stop = False
            for card, href in zip(cards, hrefs):
                if "pointer-events-none" in (optional_attr(card, "class") or "").split():
                    continue
                parsed = clean_book_url(href)
                if not parsed:
                    continue
                ident, book_url = parsed
                if ident in known:
                    if not self.settings.check_all:
                        stop = True
                        break
                    continue
                if list_name == "finished" and ident in saved:
                    continue
                title = optional_attr(card, "aria-label") or optional_text(card.locator('[data-test-id="title"]'))
                if not title.strip():
                    continue
                meta = optional_text(card.locator('div.text-mid-grey.text-caption.mt-2').last).splitlines()
                def number(idx: int) -> float:
                    try:
                        return float(re.search(r"[\d.]+", meta[idx]).group())
                    except (IndexError, AttributeError, ValueError):
                        return 0.0
                book = {
                    "id": ident, "title": title.strip(),
                    "author": optional_text(card.locator('[data-test-id="subtitle"]')),
                    "description": optional_text(card.locator('[data-test-id="description"]')),
                    "duration": number(0), "rating": number(1),
                    "url": book_url,
                    "img": optional_attr(card.locator("img"), "src") or "",
                }
                new_books.append(book)
                known.add(ident)
            if not self.settings.dry_run:
                # Keep references to original list for future scans/downloads.
                self.db[list_name] = existing + list(reversed(new_books))
                self.checkpoint()
            print(f"Scanned {list_name} page {page_number}; {len(new_books)} new books")
            next_button = self.page.locator('button:has-text("Next"):not([disabled])').first
            if stop or not next_button.is_visible():
                return len(new_books)
            next_button.click(timeout=8000)
            try:
                self.page.wait_for_function(
                    "prev => [...document.querySelectorAll('a[data-test-id=\"book-card\"]')]" 
                    ".map(a => a.getAttribute('href')).join('|') !== prev",
                    arg="|".join(hrefs), timeout=15000,
                )
            except Exception as error:
                raise RuntimeError("Next library page failed; earlier pages were saved") from error
        raise RuntimeError("Library scan exceeded 250 pages")

    def _chapter_name(self) -> str:
        number = optional_text(self.page.locator('[data-test-id="currentChapterNumber"]').first, timeout=200)
        heading = optional_text(self.page.locator("h2").first, timeout=500) if not number else ""
        return infer_chapter_label(number, heading)

    def _reset_reader(self) -> None:
        if self._chapter_name() == "Introduction":
            return
        menu = self.page.locator('[data-test-id="keyIdeas"]')
        links = self.page.locator('[data-test-id="chapterLink"]')
        if not menu.count():
            print("Reader cannot be reset; keeping current chapter")
            return
        menu.click(timeout=3000)
        if not links.count():
            print("No chapter links available; keeping current chapter")
            return
        links.first.click(timeout=3000)
        try:
            self.page.wait_for_function(
                "() => document.querySelector('[data-test-id=\"currentChapterNumber\"]')?.textContent?.trim() === 'Introduction'",
                timeout=5000,
            )
        except Exception:
            print("Could not verify reset to Introduction")

    def _audio_monitor(self, received: list[str]) -> Callable[[Any], None]:
        def on_response(response: Any) -> None:
            try:
                content_type = response.headers.get("content-type", "")
                if is_audio_response(response.url, response.status, content_type):
                    received.append(response.url)
            except Exception:
                pass
        return on_response

    def _media_source(self, checkpoint: int, received: list[str], used: set[str]) -> tuple[str | None, str]:
        candidates = [
            optional_attr(self.page.locator('[data-test-id="readerAudio"]').first, "audio-url"),
            optional_attr(self.page.locator("audio").first, "src"),
            optional_attr(self.page.locator("audio source").first, "src"),
        ]
        raw = next((c for c in candidates if https_media(c, self.page.url)), None)
        if raw is None:
            raw = next((c for c in candidates if c), None)
        if self.settings.capture_audio and (not raw or raw.startswith("blob:")) and not received[checkpoint:]:
            self.page.wait_for_timeout(700)
        return choose_audio(raw, self.page.url, received[checkpoint:] if self.settings.capture_audio else [], used)

    def _download_with_retry(self, url: str, path: Path) -> None:
        for attempt in range(3):
            try:
                download_file(url, path)
                return
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))

    def _details(self, book: dict[str, Any]) -> dict[str, Any]:
        # Optional metadata must never prevent audio discovery.
        self.page.goto(book["url"], wait_until="domcontentloaded")
        if "missing-title=" in self.page.url:
            raise RuntimeError("Book is no longer available")
        details = {**book}
        details_box = self.page.locator("div:has(h4)").last
        try:
            divs = details_box.locator("div").all() if details_box.count() else []
        except Exception:
            divs = []
        try:
            details["categories"] = [optional_text(link) for link in divs[1].locator("a").all()] if len(divs) > 1 else []
        except Exception:
            details["categories"] = []
        try:
            details["descriptionLong"] = divs[2].inner_html() if len(divs) > 2 else ""
        except Exception:
            details["descriptionLong"] = ""
        try:
            details["authorDetails"] = divs[3].inner_html() if len(divs) > 3 else ""
        except Exception:
            details["authorDetails"] = ""
        details["ratings"] = optional_text(self.page.locator('span:has-text(" ratings")').first)
        details["durationDetail"] = optional_text(self.page.locator('span:has-text(" mins")').first)
        return details

    def download_book(self, list_name: str, book: dict[str, Any]) -> bool:
        ident = book.get("id", "")
        if not isinstance(ident, str) or not BOOK_ID.fullmatch(ident):
            raise ValueError("Invalid book ID")
        if book.get("url") != BASE_URL + "/en/app/books/" + ident:
            raise ValueError("Unexpected book URL")
        directory = self.settings.books_dir / list_name / ident
        manifest = directory / "book.json"
        try:
            existing = read_json(manifest, {})
        except (OSError, json.JSONDecodeError):
            print('Existing book metadata is unreadable; retrying from the reader')
            existing = {}
        if complete_book(existing, directory, self.settings.audio):
            print("Skipping already complete book")
            return True
        if self.settings.dry_run:
            print("DRYRUN: would download one pending book")
            return True

        details = self._details(book)
        chapters: list[dict[str, Any]] = []
        used_names: set[str] = set()
        used_urls: set[str] = set()
        received: list[str] = []
        on_response = self._audio_monitor(received)
        if self.settings.capture_audio:
            self.page.on("response", on_response)
        reader_complete = False
        original_chapter = "Unknown"
        try:
            response = self.page.goto(BASE_URL + "/en/nc/reader/" + ident, wait_until="domcontentloaded")
            content = self.page.locator(READER_SELECTOR).first
            if not response or not response.ok or not content.count():
                print("Reader layout unavailable (no chapter metadata captured)")
            else:
                original_chapter = self._chapter_name()
                try:
                    self._reset_reader()
                except Exception:
                    print("Reader navigation could not reset to first chapter")
                seen: set[str] = set()
                checkpoint = 0
                for step in range(100):
                    name = self._chapter_name()
                    heading = optional_text(self.page.locator("h2").first) or name
                    html = content.inner_html(timeout=4000)
                    signature = name + ":" + heading + ":" + html[:100]
                    if signature in seen:
                        print("Reader repeated a chapter; book remains incomplete")
                        break
                    seen.add(signature)
                    audio_url, source = self._media_source(checkpoint, received, used_urls)
                    chapter = {"name": name, "title": heading, "text": html, "audio": audio_url, "audioSource": source}
                    chapter["fileName"] = choose_file(name, step, directory, used_names)
                    chapters.append(chapter)
                    if audio_url:
                        used_urls.add(audio_url)
                        if self.settings.audio:
                            target = directory / chapter["fileName"]
                            if not valid_audio_file(target):
                                try:
                                    self._download_with_retry(audio_url, target)
                                except Exception:
                                    print("Audio download failed for a chapter (URL redacted)")
                    else:
                        print("No unambiguous downloadable audio URL for chapter")
                    checkpoint = len(received)
                    nxt = self.page.locator('[data-test-id="nextChapter"]').first
                    if not nxt.is_visible():
                        reader_complete = reached_complete_summary(chapters)
                        break
                    nxt.click(timeout=5000)
                    try:
                        self.page.wait_for_function(
                            "previous => document.querySelector(" + json.dumps(READER_SELECTOR) + ")?.innerHTML !== previous",
                            arg=html, timeout=5000,
                        )
                    except Exception:
                        print("Reader did not advance; book remains incomplete")
                        break
        finally:
            if self.settings.capture_audio:
                self.page.remove_listener("response", on_response)

        refreshed = {
            **details, "downloadDate": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "orgChapter": original_chapter, "readerComplete": reader_complete,
            "chapters": chapters,
        }
        selected = select_saved_manifest(existing, refreshed)
        if selected is existing:
            print("Preserved previously saved chapter inventory after incomplete retry")
        write_json_atomic(manifest, selected)
        if details.get("img"):
            cover = directory / "cover.png"
            if not valid_file(cover):
                try:
                    self._download_with_retry(https_media(str(details["img"])) or "", cover)
                except Exception:
                    print("Cover unavailable; continuing without artwork")
        success = complete_book(read_json(manifest, {}), directory, self.settings.audio)
        if not success and self.settings.diagnose:
            print("Reader diagnostics: " + json.dumps({
                "readerContentCount": self.page.locator(READER_SELECTOR).count(),
                "chapterNumberCount": self.page.locator('[data-test-id="currentChapterNumber"]').count(),
                "nextChapterCount": self.page.locator('[data-test-id="nextChapter"]').count(),
                "downloadableAudioCount": sum(bool(c.get("audio")) for c in chapters),
            }))
        return success

    def run(self) -> int:
        self.login()
        if self.settings.update:
            for list_name in ("saved", "finished"):
                self.scan(list_name)
        if self.settings.download:
            for list_name in ("saved", "finished"):
                for book in self.db[list_name]:
                    if not isinstance(book, dict):
                        continue
                    ident = book.get("id", "")
                    if not isinstance(ident, str) or not BOOK_ID.fullmatch(ident):
                        continue
                    directory = self.settings.books_dir / list_name / ident
                    try:
                        saved_record = read_json(directory / 'book.json', {})
                    except (OSError, json.JSONDecodeError):
                        saved_record = {}
                    if complete_book(saved_record, directory, self.settings.audio):
                        continue
                    if self.settings.max_books and self.attempted >= self.settings.max_books:
                        print("MAX_BOOKS reached")
                        break
                    self.attempted += 1
                    try:
                        success = self.download_book(list_name, book)
                    except Exception as error:
                        print("Book failed: " + type(error).__name__ + " (private URL not logged)")
                        success = False
                    self.completed += int(success)
                    self.failed += int(not success)
        self.checkpoint()
        print(f"Camoufox summary: {self.attempted} attempted, {self.completed} complete, {self.failed} incomplete")
        return 1 if self.failed else 0
