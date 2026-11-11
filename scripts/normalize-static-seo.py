#!/usr/bin/env python3
"""Normalize static SEO values from each page's existing content.

This generator deliberately reuses only page-local titles, headings, and product
attributes. It does not source images, ASINs, or new editorial copy.
"""
from __future__ import annotations

import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUFFIX = " | Trail Built Overland"
MAX_TITLE = 60


def text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


# Words that cannot end a title. A hard cut that lands right after one of these leaves a
# dangling fragment such as "Best Overlanding Air Compressors for | Trail Built Overland".
DANGLING_WORDS = {
    "&", "and", "or", "for", "vs", "vs.", "versus", "to", "in", "of", "with", "without",
    "the", "a", "an", "on", "at", "by", "from", "your", "plus",
}
TRAILING_PUNCTUATION = " ,:;—–-"


def trim_dangling(fragment: str) -> str:
    """Drop trailing connector words/punctuation left behind by a hard truncation."""
    words = fragment.rstrip(TRAILING_PUNCTUATION).split(" ")
    while len(words) > 1 and words[-1].lower() in DANGLING_WORDS:
        words.pop()
        words[-1] = words[-1].rstrip(TRAILING_PUNCTUATION)
    return " ".join(words).rstrip(TRAILING_PUNCTUATION)


def branded_title(value: str) -> str:
    base = re.sub(r"\s*\|\s*Trail Built(?: Overland)?\s*$", "", html.unescape(value), flags=re.I).strip()
    limit = MAX_TITLE - len(SUFFIX)
    if len(base) > limit:
        truncated = trim_dangling(base[:limit].rsplit(" ", 1)[0])
        base = truncated or base[:limit].rstrip(TRAILING_PUNCTUATION)
    return f"{base}{SUFFIX}"[:MAX_TITLE].rstrip()


def nearest_context(source: str, position: int, fallback: str) -> str:
    prefix = source[:position]
    product_matches = list(re.finditer(r'data-product=["\']([^"\']+)["\']', prefix, re.I))
    heading_matches = list(re.finditer(r"<h[1-4][^>]*>(.*?)</h[1-4]>", prefix, re.I | re.S))
    product = product_matches[-1].group(1).strip() if product_matches else ""
    heading = text(heading_matches[-1].group(1)) if heading_matches else ""
    return product or heading or fallback


def add_missing_alt(source: str, fallback: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tag = match.group(0)
        if re.search(r"\balt\s*=", tag, re.I):
            return tag
        alt = html.escape(nearest_context(source, match.start(), fallback), quote=True)
        return re.sub(r"(/?>)$", f' alt="{alt}"\\1', tag)

    return re.sub(r"<img\b[^>]*>", replace, source, flags=re.I)


def replace_meta(source: str, attribute: str, value: str) -> str:
    escaped = html.escape(value, quote=True)
    pattern = rf'(<meta\b[^>]*\b{attribute}=["\'](?:og:title|twitter:title)["\'][^>]*\bcontent=["\'])[^"\']*(["\'])'
    return re.sub(pattern, rf"\g<1>{escaped}\g<2>", source, flags=re.I)


def process(path: Path) -> bool:
    source = path.read_text(encoding="utf-8")
    title_match = re.search(r"<title>(.*?)</title>", source, re.I | re.S)
    if not title_match:
        return False

    title = branded_title(text(title_match.group(1)))
    updated = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", source, count=1, flags=re.I | re.S)
    updated = replace_meta(updated, "property", title)
    updated = replace_meta(updated, "name", title)
    updated = add_missing_alt(updated, re.sub(r"\s*\|\s*Trail Built Overland$", "", title))

    if updated == source:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def main() -> None:
    pages = [ROOT / "index.html", ROOT / "reviews.html", ROOT / "build-guides.html", ROOT / "quiz.html", ROOT / "about.html"]
    pages.extend((ROOT / "articles").glob("*.html"))
    pages.extend((ROOT / "categories").glob("*.html"))

    changed = 0
    for page in pages:
        changed += int(process(page))

    print(f"Normalized titles and missing alt text on {changed} static pages.")


if __name__ == "__main__":
    main()
