#!/usr/bin/env python3
"""Regression coverage for scoped article-chrome normalization."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "normalize-article-chrome.py"
TARGET = "articles/best-overlanding-packing-list-complete-guide.html"


def load_normalizer():
    spec = importlib.util.spec_from_file_location("normalize_article_chrome", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the article-chrome normalizer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScopedArticleSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.normalizer = load_normalizer()

    def test_default_selection_remains_all_article_files(self):
        self.assertEqual(
            self.normalizer.select_articles(None),
            sorted(self.normalizer.ARTICLES.glob("*.html")),
        )

    def test_only_selection_returns_one_requested_article(self):
        self.assertEqual(
            self.normalizer.select_articles([TARGET]),
            [ROOT / TARGET],
        )

    def test_only_selection_rejects_non_article_paths(self):
        with self.assertRaises(ValueError):
            self.normalizer.select_articles(["index.html"])

    def test_scoped_check_accepts_the_canonical_packing_list_footer(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--check", "--only", TARGET],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_scoped_normalize_repairs_only_the_requested_temporary_copy(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            temporary_articles = temporary_root / "articles"
            temporary_articles.mkdir()
            temporary_article = temporary_articles / "generated.html"
            temporary_article.write_text("<html><body><footer>noncanonical</footer></body></html>", encoding="utf-8")

            original_root = self.normalizer.ROOT
            original_articles = self.normalizer.ARTICLES
            try:
                self.normalizer.ROOT = temporary_root
                self.normalizer.ARTICLES = temporary_articles
                selected = self.normalizer.select_articles(["articles/generated.html"])
                self.assertEqual(selected, [temporary_article])
                changed, _ = self.normalizer.normalize_article(selected[0], self.normalizer.canonical_footer())
            finally:
                self.normalizer.ROOT = original_root
                self.normalizer.ARTICLES = original_articles

            self.assertTrue(changed)
            self.assertIn("footer-social", temporary_article.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
