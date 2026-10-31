"""Launch the optional Python/Camoufox browser backend."""

from __future__ import annotations

import argparse
import dataclasses
from pathlib import Path

from .core import Downloader, Settings


def main() -> int:
    parser = argparse.ArgumentParser(description="Camoufox backend (manual login; use only authorized content)")
    parser.add_argument("--max-books", type=int, help="Maximum pending books to attempt (0 = no limit)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing book data or audio")
    parser.add_argument("--list-only", action="store_true", help="Scan library; do not download any books")
    parser.add_argument("--skip-update", action="store_true", help="Use the saved local library listing")
    parser.add_argument("--no-audio", action="store_true", help="Save text/metadata but not audio")
    parser.add_argument("--headless", action="store_true", help="Use headless mode after login is saved")
    parser.add_argument("--profile", type=Path, help="Separate persistent Camoufox browser profile")
    parser.add_argument("--books-dir", type=Path, help="Directory shared with MP3/M4B exporter")
    parser.add_argument("--diagnose", action="store_true", help="Redacted reader diagnostics")
    parser.add_argument("--smoke-test", action="store_true", help="Launch Camoufox on an offline data: fixture; never access Blinkist")
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
        load_dotenv(".env")
    except ImportError:
        pass  # Environment variables and CLI options work without python-dotenv.

    settings = Settings.from_env()
    overrides = {}
    if args.max_books is not None:
        if args.max_books < 0:
            parser.error("--max-books must be 0 or greater")
        overrides["max_books"] = args.max_books
    if args.dry_run:
        overrides["dry_run"] = True
    if args.list_only:
        overrides["download"] = False
    if args.skip_update:
        overrides["update"] = False
    if args.no_audio:
        overrides["audio"] = False
    if args.headless:
        overrides["headless"] = True
    if args.profile:
        overrides["browser_dir"] = args.profile
    if args.books_dir:
        overrides["books_dir"] = args.books_dir
    if args.diagnose:
        overrides["diagnose"] = True
    settings = dataclasses.replace(settings, **overrides)

    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        parser.exit(2, "Camoufox is not installed. Run: python3 -m pip install -r requirements-camoufox.txt\n")

    print("Launching Camoufox (Firefox). Sign in manually; no CAPTCHA automation.")
    try:
        with Camoufox(
            headless=settings.headless,
            persistent_context=True,
            user_data_dir=str(settings.browser_dir),
        ) as context:
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(settings.timeout_ms)
            if args.smoke_test:
                page.goto("data:text/html,<title>Camoufox local smoke test</title>")
                if page.title() != "Camoufox local smoke test":
                    raise RuntimeError("Local browser smoke test failed")
                print("Camoufox Firefox launched successfully on an offline fixture.")
                return 0
            return Downloader(settings, page).run()
    except Exception as error:
        parser.exit(1, "Camoufox run failed: " + type(error).__name__ + ": " + str(error).splitlines()[0] + "\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
