#!/usr/bin/env python3
"""Regression coverage for scoped article-chrome normalization."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
import uuid
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


    def test_scoped_normalize_repairs_only_the_requested_article(self):
        temporary_article = ROOT / "articles" / f".chrome-normalizer-{uuid.uuid4().hex}.html"
        relative_path = temporary_article.relative_to(ROOT).as_posix()
        temporary_article.write_text("<html><body><footer>noncanonical</footer></body></html>", encoding="utf-8")
        try:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--only", relative_path],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("footer-social", temporary_article.read_text(encoding="utf-8"))
        finally:
            temporary_article.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
