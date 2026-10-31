"""No live Blinkist login, browser installation, or network access required."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from camoufox_backend.core import (
    Downloader, Settings, choose_audio, choose_file, clean_book_url,
    complete_book, download_file, https_media, infer_chapter_label,
    is_audio_response, read_json, safe_name, reached_complete_summary, valid_audio_file, select_saved_manifest,
)


FAKE_AUDIO = bytes.fromhex('00000018667479704d344120') + b'A' * 500


def record(ident):
    return {
        'id': ident, 'title': f'Title {ident}', 'author': 'Author', 'description': '',
        'duration': 12.0, 'rating': 4.5,
        'url': 'https://www.blinkist.com/en/app/books/' + ident, 'img': '',
    }


class Locator:
    def __init__(self, data, page=None):
        self.data = data
        self.page = page

    @property
    def first(self):
        return self

    @property
    def last(self):
        return self

    def get_attribute(self, name, timeout=500):
        return self.data.get(name) if isinstance(self.data, dict) else None

    def inner_text(self, timeout=500):
        return self.data if isinstance(self.data, str) else ''

    def all(self):
        if isinstance(self.data, list):
            return self.data
        return []

    def count(self):
        return len(self.data) if isinstance(self.data, list) else int(bool(self.data))

    def is_visible(self):
        return bool(self.page and self.page.page_index < len(self.page.pages) - 1)

    def click(self, timeout=3000):
        if self.page:
            self.page.page_index += 1

    def locator(self, selector):
        info = self.data if isinstance(self.data, dict) else {}
        if selector == '[data-test-id="title"]':
            return Locator(info.get('title', ''))
        if selector == 'img':
            return Locator({'src': info.get('img', '')})
        if selector == '[data-test-id="subtitle"]':
            return Locator(info.get('author', ''))
        if selector == '[data-test-id="description"]':
            return Locator(info.get('description', ''))
        if 'text-mid-grey' in selector:
            return Locator('12 min\n4.5')
        return Locator(None)


def fake_card(ident, **flags):
    data = {'href': '/en/app/books/' + ident, 'aria-label': 'Title ' + ident}
    data.update(flags)
    return Locator(data)


class FakePage:
    def __init__(self, pages, list_name='saved', fail_next=False, title='Saved'):
        self.pages = pages
        self.list_name = list_name
        self.page_index = 0
        self.url = 'https://www.blinkist.com/en/app/library/' + list_name
        self.fail_next = fail_next
        self.document_title = title

    def title(self):
        return self.document_title

    def goto(self, url, wait_until='domcontentloaded'):
        self.url = url
        self.page_index = 0
        return types.SimpleNamespace(ok=True)

    def locator(self, selector):
        if selector == 'a[data-test-id="book-card"]':
            return Locator(self.pages[self.page_index])
        if selector == 'h1,h2,h3':
            return Locator([Locator(self.list_name.capitalize())])
        if 'button:has-text("Next")' in selector:
            return Locator({'button': True}, self)
        if selector.startswith('a[data-test-id="book-card"],'):
            return Locator([Locator('Saved')])
        return Locator(None)

    def wait_for_function(self, code, arg=None, timeout=15000):
        if self.fail_next:
            raise TimeoutError('synthetic next page stalled')


class FakeHttp(io.BytesIO):
    def __init__(self, data=FAKE_AUDIO, content_type='audio/mp4', length=None):
        super().__init__(data)
        self.headers = {'Content-Type': content_type, 'Content-Length': str(length if length is not None else len(data))}


class Helpers(unittest.TestCase):
    def test_utf8_filenames_match_the_node_backend(self):
        result = safe_name('🌏' * 100 + '/..')
        self.assertLessEqual(len(result.encode('utf8')), 120)
        self.assertFalse(result.endswith('.'))
        with tempfile.TemporaryDirectory() as tmp:
            filename = choose_file('Summary', 0, Path(tmp), set())
            self.assertEqual(filename, '001 - Summary.m4a')
            Path(tmp, 'Summary.m4a').write_bytes(FAKE_AUDIO)
            self.assertEqual(choose_file('Summary', 0, Path(tmp), set()), 'Summary.m4a')

    def test_books_are_complete_only_with_all_media_and_no_reused_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = {'readerComplete': True, 'chapters': [
                {'name': 'Introduction', 'audio': 'https://cdn.example.com/a.m4a', 'fileName': '001 - Introduction.m4a'},
                {'name': 'Summary', 'audio': 'https://cdn.example.com/b.m4a', 'fileName': '002 - Summary.m4a'}
            ]}
            self.assertFalse(complete_book(manifest, directory, True))
            for c in manifest['chapters']:
                (directory / c['fileName']).write_bytes(FAKE_AUDIO)
            self.assertTrue(complete_book(manifest, directory, True))
            manifest['chapters'][1]['fileName'] = manifest['chapters'][0]['fileName']
            self.assertFalse(complete_book(manifest, directory, True))
            manifest['readerComplete'] = False
            self.assertFalse(complete_book(manifest, directory, False))

    def test_rejects_unsafe_urls_and_media_sources(self):
        self.assertEqual(clean_book_url('/en/app/books/test-en?ignore=123'),
                         ('test-en', 'https://www.blinkist.com/en/app/books/test-en'))
        for url in ['https://evil.com/en/app/books/test-en', '/en/app/books/../../admin',
                    '/en/app/episodes/abc', 'http://www.blinkist.com/en/app/books/abc']:
            self.assertIsNone(clean_book_url(url), url)
        self.assertIsNone(https_media('blob:https://www.blinkist.com/123'))
        self.assertIsNone(https_media('file:///etc/passwd'))

    def test_retry_preserves_prior_complete_or_longer_chapter_inventory(self):
        previous = {
            'readerComplete': True,
            'chapters': [
                {'name': 'Introduction', 'audio': 'old1'},
                {'name': 'Key idea 1', 'audio': 'old2'},
                {'name': 'Summary', 'audio': 'old3'},
            ],
        }
        empty = {'readerComplete': False, 'chapters': []}
        suffix = {'readerComplete': False, 'chapters': [
            {'name': 'Key idea 1'}, {'name': 'Summary'},
        ]}
        self.assertIs(select_saved_manifest(previous, empty), previous)
        self.assertIs(select_saved_manifest(previous, suffix), previous)
        repaired = {'readerComplete': True, 'chapters': list(previous['chapters'])}
        self.assertIs(select_saved_manifest(previous, repaired), repaired)

    def test_short_retry_refreshes_matching_signed_media_links(self):
        previous = {
            'readerComplete': True,
            'chapters': [
                {'name': 'Introduction', 'title': 'Intro',
                 'audio': 'https://cdn.example/expired', 'fileName': '001 - Introduction.m4a'},
                {'name': 'Key idea 1', 'title': 'Idea',
                 'audio': 'https://cdn.example/expired2', 'fileName': '002 - Key idea 1.m4a'},
                {'name': 'Summary', 'audio': 'https://cdn.example/expired3'},
            ],
        }
        partial = {
            'readerComplete': False,
            'chapters': [
                {'name': 'Introduction', 'title': 'Intro',
                 'audio': 'https://cdn.example/new'},
                {'name': 'Key idea 1', 'title': 'DIFFERENT TITLE',
                 'audio': 'https://cdn.example/not-matching'},
            ],
        }
        selected = select_saved_manifest(previous, partial)
        self.assertEqual(len(selected['chapters']), 3)
        self.assertEqual(selected['chapters'][0]['audio'], 'https://cdn.example/new')
        self.assertEqual(selected['chapters'][0]['fileName'], '001 - Introduction.m4a')
        self.assertEqual(selected['chapters'][1]['audio'], 'https://cdn.example/expired2')
        self.assertEqual(previous['chapters'][0]['audio'], 'https://cdn.example/expired')

    def test_reader_must_start_at_introduction_to_be_complete(self):
        self.assertFalse(reached_complete_summary([
            {"name": "Key idea 4"}, {"name": "Summary"},
        ]))
        self.assertFalse(reached_complete_summary([
            {"name": "Unknown"}, {"name": "Summary"},
        ]))
        self.assertFalse(reached_complete_summary([
            {"name": "Introduction"}, {"name": "Key idea 1"},
        ]))
        self.assertTrue(reached_complete_summary([
            {"name": "Introduction"}, {"name": "Summary"},
        ]))

    def test_network_audio_matching_is_conservative(self):
        a = 'https://media.example.com/a.m4a?Signature=secret'
        b = 'https://media.example.com/b.m4a?Signature=secret'
        self.assertEqual(choose_audio('blob:fake', 'https://www.blinkist.com/', [a, a], set()), (a, 'network'))
        self.assertEqual(choose_audio('blob:fake', 'https://www.blinkist.com/', [a, b], set()), (None, 'ambiguous'))
        self.assertEqual(choose_audio(a, 'https://www.blinkist.com/', [b], set()), (a, 'attribute'))
        self.assertEqual(choose_audio(a, 'https://www.blinkist.com/', [a], {a}), (None, 'missing'))
        self.assertTrue(is_audio_response(a, 206, 'audio/mp4'))
        self.assertFalse(is_audio_response('https://x/stream.m3u8', 200, 'application/vnd.apple.mpegurl'))
        self.assertFalse(is_audio_response(a, 403, 'audio/mp4'))
        self.assertFalse(is_audio_response('blob:https://x/stream', 200, 'audio/mp4'))
        self.assertEqual(infer_chapter_label('', 'Key idea 4'), 'Unknown')
        self.assertEqual(infer_chapter_label('', 'Summary'), 'Summary')

    def test_download_is_atomic_and_rejects_html(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'chapter.m4a'
            def good(url, timeout): return FakeHttp()
            download_file('https://media.example.com/signed.m4a', path, good)
            self.assertEqual(path.stat().st_size, 512)
            self.assertFalse(path.with_name(path.name + '.part').exists())
            def bad(url, timeout): return FakeHttp(b'<html>' + b' ' * 400, 'text/html')
            with self.assertRaises(ValueError):
                download_file('https://media.example.com/signed.m4a', path, bad)
            self.assertEqual(path.stat().st_size, 512)
            self.assertFalse(path.with_name(path.name + '.part').exists())
            def too_big(url, timeout): return FakeHttp(b'0' * 512, length=101 * 1024 * 1024)
            with self.assertRaises(ValueError):
                download_file('https://media.example.com/signed.m4a', path, too_big)
            def truncated(url, timeout): return FakeHttp(FAKE_AUDIO[:300], length=len(FAKE_AUDIO))
            with self.assertRaisesRegex(ValueError, 'truncated|incomplete|length'):
                download_file('https://media.example.com/signed.m4a', path, truncated)
            self.assertEqual(path.stat().st_size, 512)

    def test_symlink_chapters_and_stale_part_files_cannot_escape_book_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'private-file.m4a'
            outside.write_bytes(FAKE_AUDIO)
            chapter = root / 'chapter.m4a'
            chapter.symlink_to(outside)
            self.assertFalse(valid_audio_file(chapter))

            chapter.unlink()
            private = root / 'private-notes.txt'
            private.write_text('IMPORTANT PRIVATE DATA', encoding='utf-8')
            part = root / 'chapter.m4a.part'
            part.symlink_to(private)
            def local_response(url, timeout):
                return FakeHttp()
            download_file('https://media.example.com/a.m4a', chapter, local_response)
            self.assertEqual(outside.read_bytes(), FAKE_AUDIO)
            self.assertEqual(private.read_text(encoding='utf-8'), 'IMPORTANT PRIVATE DATA')
            self.assertEqual(chapter.read_bytes(), FAKE_AUDIO)
            self.assertFalse(part.exists())

    def test_corrupt_audio_and_misclassified_saved_manifests_are_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            chapters = [
                {'name': 'Introduction', 'audio': 'https://example.test/a.m4a'},
                {'name': 'Summary', 'audio': 'https://example.test/b.m4a'},
            ]
            book = {'readerComplete': True, 'chapters': chapters}
            (directory / 'Introduction.m4a').write_bytes(b'<html>' + b'A' * 512)
            (directory / 'Summary.m4a').write_bytes(FAKE_AUDIO)
            self.assertFalse(valid_audio_file(directory / 'Introduction.m4a'))
            self.assertFalse(complete_book(book, directory, True))
            (directory / 'Introduction.m4a').write_bytes(FAKE_AUDIO)
            self.assertTrue(complete_book(book, directory, True))
            book['chapters'][0]['name'] = 'Key idea 3'
            self.assertFalse(complete_book(book, directory, False))

    def test_library_scanner_waits_for_delayed_client_side_rendering(self):
        class LateRenderedLibrary(FakePage):
            def __init__(self):
                super().__init__([[fake_card('ready-after-render-en')]])
                self.rendered = False
                self.waits = 0

            def locator(self, selector):
                if not self.rendered and selector in ('a[data-test-id="book-card"]', 'h1,h2,h3'):
                    return Locator([])
                return super().locator(selector)

            def wait_for_timeout(self, milliseconds):
                self.waits += 1
                self.rendered = True

        with tempfile.TemporaryDirectory() as tmp:
            page = LateRenderedLibrary()
            worker = Downloader(Settings(books_dir=Path(tmp) / 'books'), page)
            self.assertEqual(worker.scan('saved'), 1)
            self.assertGreater(page.waits, 0)
            self.assertEqual(worker.db['saved'][0]['id'], 'ready-after-render-en')

    def test_scanner_checkpoints_each_page_and_skips_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(books_dir=Path(tmp) / 'books', download=False)
            page = FakePage([
                [fake_card('newer-en'), fake_card('middle-en'), fake_card('blocked-en', **{'class': 'pointer-events-none'})],
                [fake_card('older-en'), fake_card('newer-en')]
            ])
            worker = Downloader(settings, page)
            worker.db['saved'].append(record('already-en'))
            self.assertEqual(worker.scan('saved'), 3)
            self.assertEqual([b['id'] for b in worker.db['saved']], ['already-en', 'older-en', 'middle-en', 'newer-en'])
            disk = read_json(settings.books_dir / 'db.json')
            self.assertEqual(disk['saved'], worker.db['saved'])

    def test_failed_later_page_preserves_earlier_book_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(books_dir=Path(tmp) / 'books')
            page = FakePage([[fake_card('new-en')], [fake_card('never-reached-en')]], fail_next=True)
            worker = Downloader(settings, page)
            with self.assertRaises(RuntimeError):
                worker.scan('saved')
            disk = read_json(settings.books_dir / 'db.json')
            self.assertEqual([b['id'] for b in disk['saved']], ['new-en'])

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(books_dir=Path(tmp) / 'books', dry_run=True)
            worker = Downloader(settings, FakePage([[fake_card('only-en')]]))
            self.assertEqual(worker.scan('saved'), 1)
            self.assertFalse(settings.books_dir.exists())
            self.assertEqual(worker.db['saved'], [])

    def test_first_run_is_limited_to_one_pending_book(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(books_dir=Path(tmp) / 'books', update=False, max_books=1)
            worker = Downloader(settings, FakePage([]))
            worker.db['saved'] = [record('first-en'), record('second-en')]
            worker.login = lambda: None
            attempted = []
            worker.download_book = lambda list_name, book: attempted.append(book['id']) or True
            self.assertEqual(worker.run(), 0)
            self.assertEqual(attempted, ['first-en'])

    def test_corrupt_previous_book_json_is_retried_instead_of_blocking_all_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(books_dir=Path(tmp) / 'books', update=False, max_books=1)
            worker = Downloader(settings, FakePage([]))
            worker.db['saved'] = [record('corrupt-en')]
            folder = settings.books_dir / 'saved' / 'corrupt-en'
            folder.mkdir(parents=True)
            (folder / 'book.json').write_text('{invalid', encoding='utf-8')
            worker.login = lambda: None
            attempted = []
            worker.download_book = lambda list_name, book: attempted.append(book['id']) or True
            self.assertEqual(worker.run(), 0)
            self.assertEqual(attempted, ['corrupt-en'])

    def test_login_follows_authenticated_home_redirect_back_to_saved(self):
        class LoginRedirect:
            def __init__(self):
                self.url = 'https://www.blinkist.com/en/login'
                self.navigations = 0

            def goto(self, url, wait_until='domcontentloaded'):
                self.navigations += 1
                if self.navigations == 1:
                    self.url = 'https://www.blinkist.com/en/login'
                else:
                    self.url = url

            def title(self):
                return 'Blinkist'

            def locator(self, selector):
                return Locator([Locator('Saved')] if self.url.endswith('/library/saved') else [])

            def wait_for_timeout(self, milliseconds):
                self.url = 'https://www.blinkist.com/en/app/authors'

        with tempfile.TemporaryDirectory() as tmp:
            page = LoginRedirect()
            worker = Downloader(Settings(books_dir=Path(tmp) / 'books', login_timeout_s=5), page)
            worker.login()
            self.assertEqual(page.navigations, 2)
            self.assertEqual(page.url, 'https://www.blinkist.com/en/app/library/saved')

    def test_camoufox_starts_with_its_own_persistent_profile(self):
        from camoufox_backend import __main__ as cli
        fake_context = types.SimpleNamespace(pages=[], new_page=lambda: types.SimpleNamespace(set_default_timeout=lambda ms: None))
        class Browser:
            options = None
            def __init__(self, **kwargs): Browser.options = kwargs
            def __enter__(self): return fake_context
            def __exit__(self, *args): pass
        module = types.ModuleType('camoufox.sync_api')
        module.Camoufox = Browser
        fake_camoufox = types.ModuleType('camoufox')
        fake_camoufox.sync_api = module
        with patch.dict(sys.modules, {'camoufox': fake_camoufox, 'camoufox.sync_api': module}), \
            patch.object(sys, 'argv', ['python', '--max-books', '1', '--list-only']), \
            patch.object(cli, 'Downloader') as downloader_mock:
            downloader_mock.return_value.run.return_value = 0
            self.assertEqual(cli.main(), 0)
            self.assertTrue(Browser.options['persistent_context'])
            self.assertEqual(Browser.options['user_data_dir'], 'browser-camoufox')
            self.assertTrue(downloader_mock.call_args.args[0].download is False)
            self.assertEqual(downloader_mock.call_args.args[0].max_books, 1)


if __name__ == '__main__':
    unittest.main()
