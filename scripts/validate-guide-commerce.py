#!/usr/bin/env python3
"""Fail the build if a Trail Built buyer guide drifts from the commerce template.

This production gate deliberately uses only Python's standard library. The local
standardizer may use a third-party parser, but Netlify validates the already-
committed HTML without needing any external Python package.
"""
from __future__ import annotations

import json
import html
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[1]
ARTICLES = REPO / "articles"
TAG = "trailbuiltove-20"
CONCEPT_GUIDES = {"best-diesel-vs-gasoline-for-overlanding.html"}


def attr_value(attrs: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}\s*=\s*(['\"])(.*?)\1", attrs, re.I | re.S)
    return match.group(2) if match else ""


def json_ld(raw: str) -> list[dict]:
    """Parse JSON-LD objects and @graph entries without assuming their shape."""
    parsed: list[dict] = []
    pattern = re.compile(
        r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script>", re.I | re.S
    )
    for node_number, node in enumerate(pattern.finditer(raw), 1):
        if attr_value(node.group("attrs"), "type").lower() != "application/ld+json":
            continue
        try:
            data = json.loads(node.group("body").strip())
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON-LD in script {node_number}: {exc.msg}") from exc

        documents = data if isinstance(data, list) else [data]
        for document in documents:
            if not isinstance(document, dict):
                raise ValueError(
                    f"invalid JSON-LD in script {node_number}: expected an object, array of objects, or @graph object"
                )
            graph = document.get("@graph")
            if graph is None:
                parsed.append(document)
                continue
            if not isinstance(graph, list):
                raise ValueError(f"invalid JSON-LD @graph in script {node_number}: expected an array")
            for graph_index, schema in enumerate(graph, 1):
                if not isinstance(schema, dict):
                    raise ValueError(
                        f"invalid JSON-LD @graph entry {graph_index} in script {node_number}: expected an object"
                    )
                parsed.append(schema)
    return parsed


def validate_itemlists(
    label: str, itemlists: list[dict], visible_product_names: list[str], failures: list[str]
) -> None:
    """Append named ItemList failures without assuming nested JSON-LD shapes."""
    if not itemlists:
        failures.append(f"{label}: missing ItemList JSON-LD")
        return

    for itemlist_number, itemlist in enumerate(itemlists, 1):
        elements = itemlist.get("itemListElement")
        if not isinstance(elements, list):
            failures.append(
                f"{label}: ItemList {itemlist_number} missing itemListElement array"
            )
            continue
        if not elements:
            failures.append(f"{label}: ItemList {itemlist_number} has an empty itemListElement array")
            continue
        declared_count = itemlist.get("numberOfItems")
        if declared_count != len(elements):
            failures.append(
                f"{label}: ItemList {itemlist_number} numberOfItems={declared_count!r} "
                f"does not equal its {len(elements)} itemListElement entries"
            )
        if len(visible_product_names) != len(elements):
            failures.append(
                f"{label}: ItemList {itemlist_number} has {len(elements)} entries but "
                f"the article renders {len(visible_product_names)} product cards"
            )

        for item_number, list_item in enumerate(elements, 1):
            if not isinstance(list_item, dict):
                failures.append(
                    f"{label}: ItemList {itemlist_number} entry {item_number} is not an object"
                )
                continue
            product = list_item.get("item")
            if not isinstance(product, dict):
                failures.append(
                    f"{label}: ItemList {itemlist_number} entry {item_number} missing Product item"
                )
                continue
            if product.get("@type") != "Product" or not product.get("name"):
                failures.append(f"{label}: ItemList contains a non-Product item")
            elif item_number <= len(visible_product_names):
                expected_name = visible_product_names[item_number - 1]
                actual_name = clean_text(str(product.get("name", "")))
                if actual_name != expected_name:
                    failures.append(
                        f"{label}: ItemList product {item_number} name {actual_name!r} "
                        f"does not match rendered product card {expected_name!r}"
                    )
            # Research-based editorial picks must not imply a first-hand product
            # review or a rating backed by unverified review inputs.
            forbidden = {"review", "reviewRating", "aggregateRating", "ratingValue", "ratingCount"}.intersection(product)
            if forbidden:
                failures.append(
                    f"{label}: Product '{product.get('name', 'unknown')}' has prohibited research-only schema field(s): {', '.join(sorted(forbidden))}"
                )


def amazon_anchors(raw: str):
    for match in re.finditer(r"<a\b(?P<attrs>[^>]*)>", raw, re.I | re.S):
        attrs = match.group("attrs")
        href = attr_value(attrs, "href")
        if "amazon.com" in href:
            yield attrs, href


def product_box_asins(raw: str):
    # The standardized builder outputs class + data-asin on product blocks.
    for match in re.finditer(r"<div\b(?P<attrs>[^>]*)>", raw, re.I | re.S):
        attrs = match.group("attrs")
        class_name = attr_value(attrs, "class")
        asin = attr_value(attrs, "data-asin").upper()
        if asin and ("product-box" in class_name or "product-card" in class_name):
            yield asin, match.end()


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value))).strip()


def visible_product_card_names(raw: str) -> list[str]:
    """Return canonical product-card names, including standardized fridge cards."""
    names: list[str] = []
    for match in re.finditer(r"<div\b(?P<attrs>[^>]*)>", raw, re.I | re.S):
        attrs = match.group("attrs")
        classes = set(attr_value(attrs, "class").split())
        if "product-box" in classes or "product-card" in classes:
            heading = re.search(r"<h[34]\b[^>]*>(.*?)</h[34]>", raw[match.end():match.end() + 5000], re.I | re.S)
            name = clean_text(heading.group(1)) if heading else clean_text(attr_value(attrs, "data-product"))
            if name:
                names.append(name)
    return names


def main() -> int:
    failures: list[str] = []
    for path in sorted(ARTICLES.glob("best-*.html")):
        raw = path.read_text(encoding="utf-8")
        label = path.name

        if "guide-comparison-table" not in raw:
            failures.append(f"{label}: missing comparison table")
        if "guide-rating" in raw or re.search(r">\s*Rating\s*<", raw, re.I) or "Editorial assessment" in raw:
            failures.append(f"{label}: contains a removed Rating column or placeholder assessment text")
        if re.search(r"Amazon['’]?s Choice|Amazon Choice|Best[- ]?Seller|Bestseller|#\d+\s+Best[- ]?Seller", raw, re.I):
            failures.append(f"{label}: contains a prohibited Amazon merchandising badge claim")
        if 'src="../js/guide-commerce.js"' not in raw:
            failures.append(f"{label}: missing guide commerce renderer")

        try:
            parsed_schemas = json_ld(raw)
        except ValueError as exc:
            failures.append(f"{label}: {exc}")
            continue
        types = [schema.get("@type", "") for schema in parsed_schemas]
        for required in ("Article", "BreadcrumbList", "FAQPage"):
            if required not in types:
                failures.append(f"{label}: missing {required} JSON-LD")

        itemlists = [schema for schema in parsed_schemas if schema.get("@type") == "ItemList"]
        if label not in CONCEPT_GUIDES:
            validate_itemlists(label, itemlists, visible_product_card_names(raw), failures)

        if label not in CONCEPT_GUIDES and "data-guide-sticky=" not in raw:
            failures.append(f"{label}: missing mobile sticky CTA")

        for asin, offset in product_box_asins(raw):
            # A 5 KB window safely covers one product block and avoids parsing a
            # custom DOM in the production build image.
            block = raw[offset:offset + 5000]
            if not re.search(rf"https://www\.amazon\.com/dp/{re.escape(asin)}\?tag={re.escape(TAG)}", block, re.I):
                failures.append(f"{label}: product ASIN {asin} is missing an in-block direct CTA")

        for attrs, href in amazon_anchors(raw):
            match = re.search(r"amazon\.com/dp/([A-Z0-9]{10})", href, re.I)
            if not match:
                failures.append(f"{label}: non-direct Amazon link: {href}")
                continue
            tag = parse_qs(urlparse(href).query).get("tag", [""])[0]
            rel = set(attr_value(attrs, "rel").lower().split())
            target = attr_value(attrs, "target")
            if tag != TAG:
                failures.append(f"{label}: wrong associate tag for {match.group(1)}")
            if not {"sponsored", "nofollow"}.issubset(rel):
                failures.append(f"{label}: Amazon link {match.group(1)} missing sponsored nofollow")
            if target != "_blank":
                failures.append(f"{label}: Amazon link {match.group(1)} missing target=_blank")

    if failures:
        print("Buyer-guide commerce gate failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Buyer-guide commerce gate passed for all guides.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
