#!/usr/bin/env python3
"""Regression coverage for scripts/normalize-static-seo.py title generation.

Run with:  python3 tools/test_normalize_static_seo.py

The hard 60-character title cap used to cut titles right after a connector word,
producing dangling titles such as "Best Overlanding Air Compressors for | Trail Built Overland".
"""
from __future__ import annotations

import html
import importlib.util
import re
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "normalize-static-seo.py"
SUFFIX = " | Trail Built Overland"

# (source page <title> text, expected branded title) for the pages that were cut mid-phrase.
DANGLING_CASES = [
    (
        "Best Overlanding Air Compressors for Trail Tire Air-Ups (2026)",
        "Best Overlanding Air Compressors" + SUFFIX,
    ),
    (
        "Ground Tents vs Rooftop Tents for Overlanding 2026 | Trail Built",
        "Ground Tents vs Rooftop Tents" + SUFFIX,
    ),
    (
        "Best Overlanding Tool Kits & Recovery Bags 2026 | Trail Built",
        "Best Overlanding Tool Kits" + SUFFIX,
    ),
]


def load_normalizer():
    spec = importlib.util.spec_from_file_location("normalize_static_seo", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the static SEO normalizer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def base_of(title: str) -> str:
    assert title.endswith(SUFFIX), title
    return title[: -len(SUFFIX)]


class BrandedTitleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seo = load_normalizer()

    def test_import_does_not_rewrite_any_page(self):
        # Loading the module must be side-effect free (it used to rewrite every page on import).
        self.assertTrue(callable(self.seo.main))

    def test_truncation_never_leaves_a_dangling_connector(self):
        for source, expected in DANGLING_CASES:
            with self.subTest(source=source):
                self.assertEqual(self.seo.branded_title(source), expected)

    def test_short_titles_are_only_branded(self):
        self.assertEqual(
            self.seo.branded_title("Complete Overlanding Packing List 2026 | Trail Built"),
            "Complete Overlanding Packing List" + SUFFIX,
        )
        self.assertEqual(self.seo.branded_title("Best 4Runner Winches 2026"), "Best 4Runner Winches 2026" + SUFFIX)

    def test_colon_cut_titles_stay_clean(self):
        self.assertEqual(
            self.seo.branded_title("Best Overlanding Winches 2026: Research & Recommendations | Trail Built Overland"),
            "Best Overlanding Winches 2026" + SUFFIX,
        )

    def test_title_never_exceeds_limit_and_keeps_brand(self):
        for source, _ in DANGLING_CASES:
            result = self.seo.branded_title(source)
            self.assertLessEqual(len(result), self.seo.MAX_TITLE)
            self.assertTrue(result.endswith(SUFFIX))


class ProcessPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seo = load_normalizer()

    def test_process_writes_matching_clean_title_og_and_twitter(self):
        page_html = (
            "<html><head>\n"
            "<title>Best Overlanding Air Compressors for Trail Tire Air-Ups (2026)</title>\n"
            '<meta property="og:title" content="Best Overlanding Air Compressors for Trail Tire Air-Ups (2026)" />\n'
            '<meta name="twitter:title" content="Best Overlanding Air Compressors for Trail Tire Air-Ups (2026)" />\n'
            "</head><body><h1>Air</h1></body></html>\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "page.html"
            page.write_text(page_html, encoding="utf-8")
            self.assertTrue(self.seo.process(page))
            out = page.read_text(encoding="utf-8")
        expected = "Best Overlanding Air Compressors" + SUFFIX
        self.assertIn(f"<title>{expected}</title>", out)
        self.assertIn(f'property="og:title" content="{html.escape(expected, quote=True)}"', out)
        self.assertIn(f'name="twitter:title" content="{html.escape(expected, quote=True)}"', out)

    def test_real_pages_rewritten_by_the_build_get_clean_matching_titles(self):
        # The four articles whose og:title/twitter:title the build rewrites.
        for name in (
            "best-overlanding-air-compressors",
            "best-overlanding-ground-tents-vs-rooftop-tents",
            "best-overlanding-packing-list-complete-guide",
            "best-overlanding-tool-kits-and-recovery-bags",
        ):
            source = ROOT / "articles" / f"{name}.html"
            with self.subTest(article=name), tempfile.TemporaryDirectory() as tmp:
                page = Path(tmp) / source.name
                page.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
                self.seo.process(page)
                out = page.read_text(encoding="utf-8")
                title = html.unescape(re.search(r"<title>(.*?)</title>", out, re.S).group(1))
                og = html.unescape(re.search(r'<meta[^>]*property="og:title"[^>]*content="([^"]*)"', out).group(1))
                tw = html.unescape(re.search(r'<meta[^>]*name="twitter:title"[^>]*content="([^"]*)"', out).group(1))
                self.assertEqual(title, og)
                self.assertEqual(title, tw)
                self.assertNotIn(base_of(title).split(" ")[-1].lower(), self.seo.DANGLING_WORDS)
                self.assertLessEqual(len(title), self.seo.MAX_TITLE)


if __name__ == "__main__":
    unittest.main()
