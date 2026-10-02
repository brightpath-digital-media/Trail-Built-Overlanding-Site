#!/usr/bin/env python3
"""Standardize Trail Built buyer-guide conversion and schema components.

Only products with a direct, tagged Amazon ASIN already present in the guide or a
manual, live-verified override receive a purchase CTA. The script intentionally
never invents ASINs, prices, availability, customer ratings, or review counts.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup, Tag

REPO = Path(__file__).resolve().parents[1]
ARTICLES = REPO / "articles"
SITE = "https://trailbuiltoverland.com"
TAG = "trailbuiltove-20"
SKIP_PRODUCT_SCHEMA = {"best-diesel-vs-gasoline-for-overlanding.html"}

# These three entries were checked against live Amazon item pages. The remaining
# fridge models intentionally retain no button until the canonical validation
# pipeline has a verified direct ASIN for them.
FRIDGE_PRODUCTS = [
    {"name": "Dometic CFX3 55 Portable Compressor Fridge", "asin": "B083G3NBNZ", "spec": "55 L, dual-zone compressor"},
    {"name": "Dometic CFX3 35 Portable Compressor Fridge", "asin": "B085MM9B2D", "spec": "36 L, single-zone compressor"},
    {"name": "BougeRV 30 Quart 12V Compressor Fridge", "asin": "", "spec": "30 qt, 12V compressor"},
    {"name": "ICECO GO20 Dual Zone Portable Refrigerator", "asin": "B07TJ35L3V", "spec": "20 L / 21 qt, dual zone"},
    {"name": "ARB Elements Fridge 60L", "asin": "", "spec": "60 L, single zone"},
]

# Generated cards may use only product-specific assets already committed to the site.
FRIDGE_PRODUCT_IMAGES = {
    "Dometic CFX3 55 Portable Compressor Fridge": {
        "src": "../assets/product-images/best-overlanding-fridges-dometic-cfx3-55-compressor-fridge-b5110572.png",
        "alt": "Dometic CFX3 55 portable compressor fridge",
    },
    "Dometic CFX3 35 Portable Compressor Fridge": {
        "src": "../assets/product-images/best-overlanding-fridges-dometic-cfx3-35-compressor-fridge-30424462.jpg",
        "alt": "Dometic CFX3 35 portable compressor fridge",
    },
    "ICECO GO20 Dual Zone Portable Refrigerator": {
        "src": "../assets/product-images/best-overlanding-fridges-iceco-go20-dual-zone-portable-refrigerator-7873ef75.jpg",
        "alt": "ICECO GO20 dual-zone portable refrigerator",
    },
}


def amazon_asin(url: str) -> tuple[str, bool]:
    match = re.search(r"amazon\.com/dp/([A-Z0-9]{10})", url or "", re.I)
    tag = parse_qs(urlparse(url or "").query).get("tag", [""])[0]
    return (match.group(1).upper() if match else "", tag == TAG)


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def first_detail(box: Tag, fallback: str) -> str:
    item = box.select_one(".product-box-pros li, .product-card li")
    if item:
        return clean(item.get_text(" ", strip=True))
    return fallback


def product_records(soup: BeautifulSoup, filename: str) -> list[dict]:
    if filename == "best-overlanding-fridges.html":
        return [{**item, "display_name": item["name"]} for item in FRIDGE_PRODUCTS]
    records = []
    for box in soup.select("article .product-box, article .product-card"):
        if "guide-generated-product" in (box.get("class") or []):
            continue
        heading = box.find(["h3", "h4"])
        display_name = clean(heading.get_text(" ", strip=True)) if heading else ""
        name = clean(box.get("data-product", "")) or display_name
        asin = clean(box.get("data-asin", "")).upper()
        verified = False
        for link in box.select("a[href*='amazon.com/dp/']"):
            linked_asin, tag_ok = amazon_asin(link.get("href", ""))
            if linked_asin and tag_ok:
                asin = linked_asin
                verified = True
                break
        # A data ASIN alone is not enough for this migration. It must already
        # have a direct tagged destination in source, except explicit overrides.
        if not verified:
            asin = ""
        records.append({
            "name": name,
            "display_name": display_name or name,
            "asin": asin,
            "spec": first_detail(box, display_name or name),
            "box": box,
        })
    return records


def cta(href: str, label: str = "Check Price on Amazon") -> Tag:
    tag = BeautifulSoup("", "html.parser").new_tag("a", href=href)
    tag["class"] = ["btn-amazon"]
    tag["rel"] = "sponsored nofollow noopener"
    tag["target"] = "_blank"
    tag.string = label
    return tag


def catalog_meta(soup: BeautifulSoup, asin: str) -> Tag:
    meta = soup.new_tag("div", attrs={"class": "guide-product-meta"})
    price = soup.new_tag("span", attrs={"class": "price", "data-asin": asin, "data-catalog-price": "", "hidden": ""})
    availability = soup.new_tag("span", attrs={"class": "guide-availability", "data-asin": asin, "data-catalog-availability": "", "hidden": ""})
    badge = soup.new_tag("span", attrs={"class": "guide-catalog-badge", "data-asin": asin, "data-catalog-badge": "", "hidden": ""})
    meta.extend([price, availability, badge])
    return meta


def normalize_product_boxes(soup: BeautifulSoup, records: list[dict]) -> None:
    for record in records:
        box = record.get("box")
        asin = record["asin"]
        if not box:
            continue
        # Hard-coded editorial price strings are not catalog data. Remove them
        # so the guide displays a price only when the fresh Creators API layer
        # supplies one.
        for static_price in box.select(".product-box-header .price, .product-card-header .price"):
            static_price.decompose()
        if asin:
            box["data-product"] = record["name"]
            box["data-asin"] = asin
            for old in box.select(".guide-product-meta"):
                old.decompose()
            header = box.select_one(".product-box-header, .product-card-header")
            if header:
                header.insert_after(catalog_meta(soup, asin))
            existing = box.select_one("a[href*='amazon.com/dp/']")
            if existing:
                existing["href"] = f"https://www.amazon.com/dp/{asin}?tag={TAG}"
                existing["class"] = ["btn-amazon"]
                existing["rel"] = "sponsored nofollow noopener"
                existing["target"] = "_blank"
                existing.string = "Check Price on Amazon"
            else:
                box.append(cta(f"https://www.amazon.com/dp/{asin}?tag={TAG}"))
        else:
            # Do not leave any generic or malformed Amazon destination behind.
            for link in box.select("a[href*='amazon.com']"):
                link.decompose()


def generated_fridge_cards(soup: BeautifulSoup, records: list[dict]) -> Tag:
    section = soup.new_tag("section", attrs={"class": "guide-fridge-picks", "data-guide-generated": "true"})
    title = soup.new_tag("h2")
    title.string = "Fridge Picks at a Glance"
    section.append(title)
    for record in records:
        box = soup.new_tag("div", attrs={"class": "product-box guide-generated-product"})
        box["data-product"] = record["name"]
        if record["asin"]:
            box["data-asin"] = record["asin"]
        image = FRIDGE_PRODUCT_IMAGES.get(record["name"])
        if image:
            image_wrap = soup.new_tag("div", attrs={"class": "product-box-image"})
            image_tag = soup.new_tag("img", src=image["src"], alt=image["alt"])
            image_tag["width"] = "180"
            image_tag["height"] = "140"
            image_tag["loading"] = "lazy"
            image_tag["decoding"] = "async"
            image_wrap.append(image_tag)
            box.append(image_wrap)
        h4 = soup.new_tag("h4")
        h4.string = record["name"]
        detail = soup.new_tag("p", attrs={"class": "guide-comparison-spec"})
        detail.string = record["spec"]
        box.extend([h4, detail])
        if record["asin"]:
            box.append(catalog_meta(soup, record["asin"]))
            box.append(cta(f"https://www.amazon.com/dp/{record['asin']}?tag={TAG}"))
        else:
            note = soup.new_tag("p", attrs={"class": "guide-unavailable"})
            note.string = "Direct Amazon listing is not linked until this model is verified."
            box.append(note)
        section.append(box)
    return section


def comparison_table(soup: BeautifulSoup, records: list[dict]) -> Tag:
    section = soup.new_tag("section", attrs={"class": "guide-comparison", "data-guide-generated": "true"})
    header = soup.new_tag("div", attrs={"class": "guide-comparison-header"})
    heading = soup.new_tag("h2")
    heading.string = "Compare the Top Picks"
    note = soup.new_tag("p", attrs={"class": "guide-comparison-note"})
    note.string = "Review each product section for current Amazon availability and offer details."
    header.extend([heading, note])
    wrap = soup.new_tag("div", attrs={"class": "guide-table-wrap"})
    table = soup.new_tag("table", attrs={"class": "guide-comparison-table"})
    thead = soup.new_tag("thead")
    tr = soup.new_tag("tr")
    # Amazon offer data is volatile. Do not declare a Price column unless the
    # same render pass supplies a current official catalog value for every row.
    # Static guide HTML has no such payload, so the table intentionally omits it.
    for label in ("Product", "Key spec(s)", "Buy"):
        th = soup.new_tag("th")
        th.string = label
        tr.append(th)
    thead.append(tr)
    tbody = soup.new_tag("tbody")
    for record in records:
        row = soup.new_tag("tr")
        name = soup.new_tag("td")
        name.string = record["display_name"]
        spec = soup.new_tag("td", attrs={"class": "guide-comparison-spec"})
        spec.string = record["spec"]
        buy = soup.new_tag("td")
        if record["asin"]:
            buy.append(cta(f"https://www.amazon.com/dp/{record['asin']}?tag={TAG}"))
        else:
            buy.append(BeautifulSoup("<span class='guide-unavailable'>No verified link</span>", "html.parser"))
        row.extend([name, spec, buy])
        tbody.append(row)
    table.extend([thead, tbody])
    wrap.append(table)
    section.extend([header, wrap])
    return section


def insert_comparison(soup: BeautifulSoup, records: list[dict], filename: str) -> None:
    for node in soup.select(".guide-comparison, .guide-fridge-picks"):
        node.decompose()
    article = soup.select_one("article.article-body")
    if not article:
        return
    table = comparison_table(soup, records)
    toc = article.select_one(".toc")
    if toc:
        toc.insert_after(table)
    else:
        first_heading = article.find(["h2", "h3"])
        if first_heading:
            first_heading.insert_before(table)
        else:
            article.insert(0, table)
    if filename == "best-overlanding-fridges.html":
        table.insert_after(generated_fridge_cards(soup, records))


def faq_pairs(soup: BeautifulSoup) -> list[tuple[str, str]]:
    faq_heading = next((h for h in soup.find_all(["h2", "h3"]) if "faq" in h.get_text(" ", strip=True).lower()), None)
    pairs = []
    if faq_heading:
        for sibling in faq_heading.find_all_next():
            if sibling.name == "h2" and sibling is not faq_heading:
                break
            if sibling.name == "h3":
                answer = sibling.find_next_sibling("p")
                if answer:
                    pairs.append((clean(sibling.get_text(" ", strip=True)), clean(answer.get_text(" ", strip=True))))
    return pairs


def ensure_faq(soup: BeautifulSoup) -> list[tuple[str, str]]:
    pairs = faq_pairs(soup)
    if pairs:
        return pairs
    article = soup.select_one("article.article-body")
    if not article:
        return []
    section = soup.new_tag("section", attrs={"class": "guide-faq", "id": "faq", "data-guide-generated": "true"})
    heading = soup.new_tag("h2")
    heading.string = "Buyer’s Guide FAQ"
    section.append(heading)
    generated = [
        ("How are products selected for this guide?", "Trail Built compares published specifications, fitment, warranty details, availability, and the practical trade-offs explained in this guide. Read the individual product sections and the research methodology before choosing an option for a vehicle and trip plan."),
        ("Why is a price or availability label sometimes missing?", "Amazon prices and availability change frequently. Trail Built shows catalog data only after a recent Amazon catalog refresh; otherwise, it hides the value rather than displaying stale information."),
    ]
    for question, answer in generated:
        h3 = soup.new_tag("h3")
        h3.string = question
        p = soup.new_tag("p")
        p.string = answer
        section.extend([h3, p])
    # Keep sharing controls after editorial content.
    first_non_editorial = article.select_one(".share-bar")
    if first_non_editorial:
        first_non_editorial.insert_before(section)
    else:
        article.append(section)
    return generated


def upsert_schema(soup: BeautifulSoup, records: list[dict], filename: str, faqs: list[tuple[str, str]]) -> None:
    for node in soup.select("script[type='application/ld+json']"):
        try:
            existing = json.loads(node.get_text())
        except json.JSONDecodeError:
            continue
        if isinstance(existing, dict) and existing.get("@type") in {"FAQPage", "ItemList"}:
            node.decompose()
    canonical = soup.select_one("link[rel='canonical']")
    url = canonical.get("href") if canonical else f"{SITE}/articles/{filename}"
    items = []
    for index, record in enumerate(records, 1):
        product = {"@type": "Product", "name": record["display_name"]}
        if record["asin"]:
            product["sku"] = record["asin"]
            product["url"] = f"https://www.amazon.com/dp/{record['asin']}?tag={TAG}"
        product["description"] = record["spec"]
        items.append({"@type": "ListItem", "position": index, "item": product})
    itemlist = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": f"Top Picks — {soup.title.get_text(strip=True) if soup.title else filename}",
        "url": url,
        "numberOfItems": len(items),
        "itemListElement": items,
    }
    faq = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
            for q, a in faqs
        ],
    }
    schemas = [faq] if filename in SKIP_PRODUCT_SCHEMA else [itemlist, faq]
    for schema in schemas:
        tag = soup.new_tag("script", attrs={"type": "application/ld+json", "data-guide-commerce-schema": "true"})
        tag.string = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
        soup.head.append(tag)


def ensure_scripts(soup: BeautifulSoup) -> None:
    catalog_src = "../js/products-data.js?v=20260818"
    sources = {script.get("src", "").split("?", 1)[0] for script in soup.select("script[src]")}
    for script in soup.select("script[src]"):
        if script.get("src", "").split("?", 1)[0] == "../js/products-data.js":
            script["src"] = catalog_src
    for src in (catalog_src, "../js/amazon.js", "../js/guide-commerce.js"):
        if src.split("?", 1)[0] not in sources:
            script = soup.new_tag("script", src=src)
            soup.body.append(script)


def sticky_cta(soup: BeautifulSoup, records: list[dict]) -> None:
    for node in soup.select("[data-guide-sticky]"):
        node.decompose()
    first = next((record for record in records if record["asin"]), None)
    if not first:
        return
    container = soup.new_tag("div", attrs={"class": "guide-mobile-sticky", "data-guide-sticky": "true"})
    container.append(cta(f"https://www.amazon.com/dp/{first['asin']}?tag={TAG}", "View picks on Amazon"))
    soup.body.append(container)


def main() -> None:
    changed = []
    for path in sorted(ARTICLES.glob("best-*.html")):
        source = path.read_text(encoding="utf-8")
        soup = BeautifulSoup(source, "html.parser")
        records = product_records(soup, path.name)
        normalize_product_boxes(soup, records)
        insert_comparison(soup, records, path.name)
        faqs = ensure_faq(soup)
        upsert_schema(soup, records, path.name, faqs)
        ensure_scripts(soup)
        sticky_cta(soup, records)
        output = str(soup)
        if output != source:
            path.write_text(output, encoding="utf-8")
            changed.append((path.name, sum(bool(r['asin']) for r in records), len(records)))
    print(f"Standardized {len(changed)} guide files")
    for name, linked, total in changed:
        print(f"{name}: {linked}/{total} products have verified direct CTAs")


if __name__ == "__main__":
    main()
