#!/usr/bin/env python3
"""Normalize and validate Trail Built article comparison chrome.

This tool deliberately omits static Price columns. A price can appear only through
an Amazon Creators API refresh that is current at render time; the site does not
retain or display stale catalog values.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parents[1]
ARTICLES = ROOT / "articles"
FOOTER_TEMPLATE = ROOT / "templates" / "article-footer.html"
CURRENT_YEAR = "2026"
TABLE_PATTERN = re.compile(r"<table\b[^>]*>.*?</table\s*>", re.IGNORECASE | re.DOTALL)
FOOTER_PATTERN = re.compile(r"<footer\b[^>]*>.*?</footer\s*>", re.IGNORECASE | re.DOTALL)


def canonical_footer() -> Tag:
    template = FOOTER_TEMPLATE.read_text(encoding="utf-8").replace("{{CURRENT_YEAR}}", CURRENT_YEAR)
    footer = BeautifulSoup(template, "html.parser").find("footer")
    if footer is None:
        raise RuntimeError("Canonical article footer template does not contain a footer element")
    return footer


def footer_signature(node: Tag) -> str:
    normalized = BeautifulSoup(str(node), "html.parser").find("footer")
    if normalized is None:
        return ""
    return normalized.decode(formatter="minimal")


def table_headers(table: Tag) -> list[str]:
    return [header.get_text(" ", strip=True) for header in table.select(":scope > thead > tr > th")]


def omit_price_column(table: Tag) -> bool:
    headers = table_headers(table)
    if "Price" not in headers:
        return False
    index = headers.index("Price")
    header_row = table.select_one(":scope > thead > tr")
    if header_row is None:
        raise RuntimeError("Comparison table has a Price header without a header row")
    header_cells = header_row.find_all("th", recursive=False)
    if len(header_cells) <= index:
        raise RuntimeError("Comparison table Price header index cannot be resolved")
    header_cells[index].decompose()
    for row in table.select(":scope > tbody > tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) <= index:
            raise RuntimeError("Comparison table Price-cell index cannot be resolved")
        cells[index].decompose()
    return True


def normalize_article(path: Path, footer: Tag) -> tuple[bool, int]:
    original = path.read_text(encoding="utf-8")
    rendered = original
    price_tables = 0

    def normalize_table(match: re.Match[str]) -> str:
        nonlocal price_tables
        table_soup = BeautifulSoup(match.group(0), "html.parser")
        table = table_soup.find("table")
        if table is None:
            return match.group(0)
        if omit_price_column(table):
            price_tables += 1
            return table.decode(formatter="minimal")
        return match.group(0)

    rendered = TABLE_PATTERN.sub(normalize_table, rendered)
    if price_tables:
        rendered = rendered.replace(
            "Prices and offer details appear only after a fresh Amazon catalog refresh.",
            "Review each product section for current Amazon availability and offer details.",
        )
    footer_match = FOOTER_PATTERN.search(rendered)
    if footer_match is None:
        raise RuntimeError(f"{path.name}: article footer is missing")
    current_footer = BeautifulSoup(footer_match.group(0), "html.parser").find("footer")
    if current_footer is None:
        raise RuntimeError(f"{path.name}: article footer cannot be parsed")
    if footer_signature(current_footer) != footer_signature(footer):
        canonical = footer.decode(formatter="minimal")
        rendered = FOOTER_PATTERN.sub(canonical, rendered, count=1)
    if rendered != original:
        path.write_text(rendered, encoding="utf-8")
        return True, price_tables
    return False, price_tables


def validate_article(path: Path, expected_footer: str) -> list[str]:
    failures: list[str] = []
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
    footer = soup.find("footer")
    if footer is None:
        return [f"{path.name}: missing footer"]
    if footer_signature(footer) != expected_footer:
        failures.append(f"{path.name}: footer differs from templates/article-footer.html")
    for number, table in enumerate(soup.select("table"), start=1):
        headers = table_headers(table)
        if "Price" in headers:
            failures.append(f"{path.name}: table {number} retains unsupported Price column")
        for row_number, row in enumerate(table.select(":scope > tbody > tr"), start=1):
            cells = row.find_all("td", recursive=False)
            if headers and len(cells) != len(headers):
                failures.append(
                    f"{path.name}: table {number} row {row_number} has {len(cells)} data cells for {len(headers)} headers"
                )
    return failures


def select_articles(only_paths: list[str] | None) -> list[Path]:
    if not only_paths:
        return sorted(ARTICLES.glob("*.html"))

    articles_root = ARTICLES.resolve()
    selected: list[Path] = []
    for raw_path in only_paths:
        candidate = Path(raw_path)
        resolved = (ROOT / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        try:
            resolved.relative_to(articles_root)
        except ValueError as exc:
            raise ValueError(f"--only path must be inside {ARTICLES.relative_to(ROOT)}/: {raw_path}") from exc
        if resolved.suffix.lower() != ".html" or not resolved.is_file():
            raise ValueError(f"--only path must name an existing article HTML file: {raw_path}")
        if resolved not in selected:
            selected.append(resolved)
    return sorted(selected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without changing article files")
    parser.add_argument(
        "--only",
        action="append",
        metavar="PATH",
        help="Normalize and validate only this article path; repeat for additional articles",
    )
    args = parser.parse_args()
    footer = canonical_footer()
    expected_footer = footer_signature(footer)
    try:
        articles = select_articles(args.only)
    except ValueError as exc:
        parser.error(str(exc))
    if not args.check:
        changed = 0
        price_tables = 0
        for article in articles:
            did_change, table_count = normalize_article(article, footer)
            changed += int(did_change)
            price_tables += table_count
        print(f"Normalized article chrome: {changed} article files updated; {price_tables} Price columns omitted.")
    failures = [failure for article in articles for failure in validate_article(article, expected_footer)]
    if failures:
        print("Article chrome validation failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(f"Article chrome validation passed: {len(articles)} article files use the canonical footer and omit static Price columns.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
