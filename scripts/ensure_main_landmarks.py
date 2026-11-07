#!/usr/bin/env python3
"""Ensure shared accessibility chrome on public Trail Built HTML pages.

1. Every public non-quiz page has exactly one main landmark.
2. Every public page (quiz included) that has a main landmark gives it an id
   (default "main-content") and tabindex="-1" so a skip link can move focus to it.
3. A "Skip to main content" link is the first element in <body>.
4. The header menu toggle has aria-expanded (initial "false") and aria-controls,
   and the header <nav> it controls has an id (default "site-nav").

All steps are idempotent. The build runs this script, so pages produced by
scripts/generate-article.js pick the chrome up at deploy time.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_TOP_LEVEL = {"admin", "newsletters", "email-templates", "node_modules", ".git"}


def public_non_quiz_pages() -> list[Path]:
    pages: list[Path] = []
    for page in ROOT.rglob("*.html"):
        relative = page.relative_to(ROOT)
        if relative.parts[0] in EXCLUDED_TOP_LEVEL:
            continue
        if page.name.lower() == "quiz.html":
            continue
        if relative.parts[0] not in {"articles", "categories"} and len(relative.parts) != 1:
            continue
        pages.append(page)
    return sorted(pages)


def public_chrome_pages() -> list[Path]:
    """Public pages sharing the site header: the landmark pages plus the quiz."""
    pages = set(public_non_quiz_pages())
    quiz = ROOT / "quiz.html"
    if quiz.is_file():
        pages.add(quiz)
    return sorted(pages)


SKIP_LINK_CLASS = "skip-link"
SKIP_LINK_TEXT = "Skip to main content"
DEFAULT_MAIN_ID = "main-content"
DEFAULT_NAV_ID = "site-nav"
MAIN_TAG = re.compile(r"<main\b[^>]*>", re.I)
BODY_TAG = re.compile(r"<body\b[^>]*>", re.I)
HEADER_BLOCK = re.compile(r"<header\b[^>]*>.*?</header\s*>", re.I | re.S)
NAV_TAG = re.compile(r"<nav\b[^>]*>", re.I)
TOGGLE_TAG = re.compile(r"<button\b(?=[^>]*\bclass=[\"'][^\"']*\bmenu-toggle\b)[^>]*>", re.I)
SKIP_LINK_PRESENT = re.compile(r"<a\b[^>]*\bclass=[\"'][^\"']*\bskip-link\b", re.I)


def attr_value(tag: str, name: str) -> str | None:
    match = re.search(rf"\s{name}\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", tag, re.I)
    if not match:
        return None
    return match.group(1) if match.group(1) is not None else match.group(2)


def add_attr(tag: str, name: str, value: str) -> str:
    return re.sub(r"\s*(/?)>$", lambda m: f' {name}="{value}"{m.group(1)}>', tag, count=1)


def ensure_chrome(html: str, label: str) -> str:
    """Add the skip link, main target attributes and menu-toggle ARIA wiring."""
    main = MAIN_TAG.search(html)
    if not main:
        return html
    main_tag = main.group(0)
    main_id = attr_value(main_tag, "id") or DEFAULT_MAIN_ID
    new_main = main_tag
    if attr_value(new_main, "id") is None:
        new_main = add_attr(new_main, "id", main_id)
    if attr_value(new_main, "tabindex") is None:
        new_main = add_attr(new_main, "tabindex", "-1")
    html = html[: main.start()] + new_main + html[main.end():]

    header = HEADER_BLOCK.search(html)
    if header:
        block = header.group(0)
        nav = NAV_TAG.search(block)
        nav_id = DEFAULT_NAV_ID
        if nav:
            existing = attr_value(nav.group(0), "id")
            if existing:
                nav_id = existing
            else:
                block = block[: nav.start()] + add_attr(nav.group(0), "id", nav_id) + block[nav.end():]
        toggle = TOGGLE_TAG.search(block)
        if toggle and nav:
            tag = toggle.group(0)
            new_tag = tag
            if attr_value(new_tag, "aria-expanded") is None:
                new_tag = add_attr(new_tag, "aria-expanded", "false")
            if attr_value(new_tag, "aria-controls") is None:
                new_tag = add_attr(new_tag, "aria-controls", nav_id)
            block = block[: toggle.start()] + new_tag + block[toggle.end():]
        html = html[: header.start()] + block + html[header.end():]

    if not SKIP_LINK_PRESENT.search(html):
        body = BODY_TAG.search(html)
        if not body:
            raise ValueError(f"{label}: missing body element")
        link = f'\n<a class="{SKIP_LINK_CLASS}" href="#{main_id}">{SKIP_LINK_TEXT}</a>'
        html = html[: body.end()] + link + html[body.end():]
    return html


def chrome_problems(html: str) -> list[str]:
    """Describe missing chrome pieces (used by --check)."""
    problems: list[str] = []
    main = MAIN_TAG.search(html)
    if not main:
        return problems
    main_id = attr_value(main.group(0), "id")
    if not main_id:
        problems.append("main landmark has no id")
    if attr_value(main.group(0), "tabindex") is None:
        problems.append("main landmark has no tabindex")
    body = BODY_TAG.search(html)
    first = re.match(r"\s*(<a\b[^>]*>)", html[body.end():]) if body else None
    if not first or not SKIP_LINK_PRESENT.match(first.group(1)):
        problems.append("skip link is not the first element in body")
    elif main_id and attr_value(first.group(1), "href") != f"#{main_id}":
        problems.append("skip link does not target the main landmark")
    header = HEADER_BLOCK.search(html)
    toggle = TOGGLE_TAG.search(header.group(0)) if header else None
    if toggle:
        for name in ("aria-expanded", "aria-controls"):
            if attr_value(toggle.group(0), name) is None:
                problems.append(f"menu toggle has no {name}")
        nav = NAV_TAG.search(header.group(0))
        controls = attr_value(toggle.group(0), "aria-controls")
        if nav and controls and attr_value(nav.group(0), "id") != controls:
            problems.append("header nav id does not match menu toggle aria-controls")
    return problems


def add_landmark(html: str, label: str) -> str:
    if re.search(r"<main\b", html, re.I):
        return html
    header = re.search(r"</header\s*>", html, re.I)
    body = re.search(r"<body\b[^>]*>", html, re.I)
    if not body:
        raise ValueError(f"{label}: missing body element")
    start = header.end() if header else body.end()
    footer = re.search(r"<footer\b", html[start:], re.I)
    end = start + footer.start() if footer else html.lower().rfind("</body>")
    if end <= start:
        raise ValueError(f"{label}: unable to locate main content boundary")
    return f"{html[:start]}\n<main id=\"main-content\">{html[start:end]}\n</main>\n{html[end:]}"


def main_count(html: str) -> int:
    return len(re.findall(r"<main\b", html, re.I))


def main() -> int:
    check_only = "--check" in sys.argv
    changed: list[str] = []
    failures: list[str] = []
    landmark_pages = set(public_non_quiz_pages())
    for page in public_chrome_pages():
        label = str(page.relative_to(ROOT))
        html = page.read_text(encoding="utf-8")
        if check_only:
            count = main_count(html)
            if count != 1:
                failures.append(f"{label} has {count} main landmarks")
            failures.extend(f"{label}: {problem}" for problem in chrome_problems(html))
            continue
        updated = add_landmark(html, label) if page in landmark_pages else html
        updated = ensure_chrome(updated, label)
        if updated != html:
            page.write_text(updated, encoding="utf-8")
            changed.append(label)
        count = main_count(updated)
        if count != 1:
            failures.append(f"{label} has {count} main landmarks")
        failures.extend(f"{label}: {problem}" for problem in chrome_problems(updated))
    if failures:
        print("MAIN_LANDMARKS=FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("MAIN_LANDMARKS=PASS")
    print(f"PAGES_CHECKED={len(public_chrome_pages())}")
    if not check_only:
        print(f"PAGES_UPDATED={len(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
