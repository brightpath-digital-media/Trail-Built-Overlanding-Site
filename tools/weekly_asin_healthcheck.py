#!/usr/bin/env python3
"""Canonical weekly affiliate health-check for all three Bootnylee affiliate sites.

This is the single source of truth for recurring affiliate validation. It checks,
for every product record on Trail Built Overland, SilkierStrands, and
PauseAndFlourish:

1. The local product name maps to one ASIN.
2. The destination affiliate link maps to that same ASIN.
3. The affiliate tag maps to the site's expected Associates tag (static HTML).
4. The ASIN resolves to a real Amazon catalog item.
5. Amazon's returned title fuzzy-matches the local product name.

Primary source of truth: Amazon Creators API GetItems (OAuth 2.0).
Fallback: public Amazon product-page verification when API credentials are absent.

Optional catalog refresh:
  --sync-price-images runs each site's existing Creators API GetItems sync script.
  The sync scripts are never PA-API scripts and use CREATORS_API_* credentials.
  This option writes a report only; committing/pushing any catalog changes is a
  deliberate, separate release action.

Usage:
  python3 tools/weekly_asin_healthcheck.py --dry-run
  python3 tools/weekly_asin_healthcheck.py --sync-price-images

Report recipient: read from the AFFILIATE_REPORT_RECIPIENT environment variable (no default;
the email step is skipped with a log line when it is unset). It is never written to the report.
"""

from __future__ import annotations

import argparse
import html as html_lib
import os
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from deploy_confirmation_remediation import (
    REPORT_RECIPIENT_ENV,
    SITES as DEPLOY_SITES,
    concise_email,
    email_skip_reason,
    reconcile_all,
    remediate_product_finding,
)
from urllib.parse import parse_qs, urlparse

REQUEST_DELAY_SECONDS = 1.25
REPO_ROOT = Path(__file__).resolve().parent.parent
REPORT_PATH = REPO_ROOT / "affiliate_healthcheck_report.json"

SITES = [
    {
        "name": "Trail Built Overland",
        "url": "https://trailbuiltoverland.com",
        "repo": Path("/home/ubuntu/trail-built-overland"),
        "type": "static_html",
        "partner_tag": "trailbuiltove-20",
        "sync_command": ["node", "scripts/fetch-prices.js"],
    },
    {
        "name": "SilkierStrands",
        "url": "https://silkierstrands.com",
        "repo": Path("/home/ubuntu/silkierstrands"),
        "type": "react_products_ts",
        "partner_tag": "silkierstrands-20",
        "products_file": "client/src/lib/products.ts",
        "sync_command": ["node", "scripts/fetch-prices.js"],
    },
    {
        "name": "PauseAndFlourish",
        "url": "https://pauseandflourish.com",
        "repo": Path("/home/ubuntu/pauseandflourish"),
        "type": "react_products_ts",
        "partner_tag": "pauseandflourish-20",
        "products_file": "client/src/lib/products.ts",
        "sync_command": ["node", "scripts/fetch-prices.js"],
    },
]

sys.path.insert(0, str(Path(__file__).parent))
from asin_lookup import _title_matches, verify_asin  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Generic parsing helpers
# ─────────────────────────────────────────────────────────────────────────────
def _attr(opening_tag: str, name: str) -> str:
    match = re.search(rf'\b{re.escape(name)}\s*=\s*["\']([^"\']*)["\']', opening_tag, re.I)
    return html_lib.unescape(match.group(1).strip()) if match else ""


def _amazon_asin_and_tag(url: str) -> tuple[str, str]:
    """Return (ASIN, Associates tag) for an Amazon /dp/ link, or ('', '')."""
    decoded = html_lib.unescape(url)
    asin_match = re.search(r'amazon\.(?:com|co\.uk|ca|de|fr|it|es|co\.jp)/dp/([A-Z0-9]{10})', decoded, re.I)
    asin = asin_match.group(1).upper() if asin_match else ""
    tag = parse_qs(urlparse(decoded).query).get("tag", [""])[0]
    return asin, tag


def _first_amazon_link(fragment: str) -> str:
    match = re.search(r'href\s*=\s*["\'](https?://(?:www\.)?amazon\.[^"\']+)["\']', fragment, re.I)
    return html_lib.unescape(match.group(1)) if match else ""


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


# ─────────────────────────────────────────────────────────────────────────────
# Site-specific record extraction
# ─────────────────────────────────────────────────────────────────────────────
def extract_static_html_products(site: dict) -> list[dict]:
    """Extract product boxes, their named ASINs, and linked ASINs from all guides."""
    products: list[dict] = []
    articles_dir = site["repo"] / "articles"
    if not articles_dir.exists():
        return products

    for html_file in sorted(articles_dir.glob("*.html")):
        # Buyer guide convention; build guides/concept articles with no product boxes are skipped.
        if not html_file.name.startswith("best-"):
            continue
        content = html_file.read_text(encoding="utf-8")
        starts = list(re.finditer(
            r'<div\b[^>]*\bclass\s*=\s*["\'](?:[^"\']*\s)?product-box(?:\s[^"\']*)?["\'][^>]*>',
            content,
            re.I,
        ))
        for index, start in enumerate(starts):
            opening_tag = start.group(0)
            end = starts[index + 1].start() if index + 1 < len(starts) else len(content)
            block = content[start.start():end]
            name = _attr(opening_tag, "data-product")
            asin = _attr(opening_tag, "data-asin").upper()
            link = _first_amazon_link(block)
            linked_asin, linked_tag = _amazon_asin_and_tag(link)
            # Older guides omit data-asin but still use a direct, tagged Amazon
            # destination. Treat that destination ASIN as the local canonical
            # value; it is then validated against the visible product name.
            if not asin and linked_asin:
                asin = linked_asin
            heading_match = re.search(r'<h[34][^>]*>\s*(.*?)\s*</h[34]>', block, re.I | re.S)
            heading = re.sub(r'<[^>]+>', '', heading_match.group(1)).strip() if heading_match else ""
            # Concept/comparison cards with neither a product ASIN nor a buy link
            # are not affiliate products and are outside this health-check scope.
            if not asin and not link:
                continue
            products.append({
                "article": f"articles/{html_file.name}",
                "line": _line_number(content, start.start()),
                "name": name or heading,
                "heading": heading,
                "asin": asin,
                "affiliate_url": link,
                "linked_asin": linked_asin,
                "linked_tag": linked_tag,
            })
    return products


def _extract_ts_object_blocks(content: str) -> list[tuple[str, int]]:
    """Return concrete records from typed ``Product[]`` source collections only."""
    declarations = re.finditer(
        r'(?:export\s+)?const\s+[A-Za-z][A-Za-z0-9]*Products\s*:\s*Product\[\]\s*=\s*\[',
        content,
    )
    blocks: list[tuple[str, int]] = []
    for declaration in declarations:
        array_depth = 1
        object_depth = 0
        object_start: int | None = None
        in_quote: str | None = None
        escaped = False
        i = declaration.end()
        while i < len(content) and array_depth:
            char = content[i]
            if in_quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == in_quote:
                    in_quote = None
                i += 1
                continue
            if char in ("'", '"', '`'):
                in_quote = char
            elif char == "/" and content[i + 1:i + 2] == "/":
                newline = content.find("\n", i + 2)
                i = len(content) if newline == -1 else newline
                continue
            elif char == "/" and content[i + 1:i + 2] == "*":
                comment_end = content.find("*/", i + 2)
                i = len(content) if comment_end == -1 else comment_end + 2
                continue
            elif char == "[":
                array_depth += 1
            elif char == "]":
                array_depth -= 1
            elif char == "{" and array_depth == 1:
                if object_depth == 0:
                    object_start = i
                object_depth += 1
            elif char == "}" and object_depth:
                object_depth -= 1
                if object_depth == 0 and object_start is not None:
                    blocks.append((content[object_start:i + 1], object_start))
                    object_start = None
            i += 1
    return blocks


def _ts_field(block: str, field: str) -> str:
    match = re.search(rf'\b{re.escape(field)}\s*:\s*["\']([^"\']*)["\']', block)
    return match.group(1).strip() if match else ""


def extract_react_products(site: dict) -> list[dict]:
    """Extract product records and generated affiliate-link mappings from products.ts."""
    products_file = site["repo"] / site["products_file"]
    if not products_file.exists():
        return []
    content = products_file.read_text(encoding="utf-8")
    helper_tag_match = re.search(r'export\s+const\s+AFFILIATE_TAG\s*=\s*(["\'])([^"\']+)\1', content)
    helper_tag = helper_tag_match.group(2) if helper_tag_match else ""
    generated_helper = bool(re.search(
        r'function\s+(?:amazonLink|buildAffiliateUrl)\s*\(\s*asin\s*:\s*string\s*\).*?/dp/\$\{asin\}',
        content,
        re.S,
    ))
    products: list[dict] = []
    for block, offset in _extract_ts_object_blocks(content):
        asin = _ts_field(block, "asin").upper()
        name = _ts_field(block, "name")
        if not asin and not name:
            continue
        affiliate_expr_match = re.search(r'\baffiliateUrl\s*:\s*([^,\n]+)', block)
        affiliate_expr = affiliate_expr_match.group(1).strip().strip("\"'") if affiliate_expr_match else ""
        # Typical site pattern: buildAffiliateUrl("ASIN"). Validate the argument
        # against the canonical asin field even though the final URL is generated at runtime.
        linked_asin_match = re.search(r'(?:buildAffiliateUrl|amazonLink)\(\s*["\']([A-Z0-9]{10})["\']\s*\)', affiliate_expr)
        linked_asin = linked_asin_match.group(1).upper() if linked_asin_match else ""
        direct_asin, linked_tag = _amazon_asin_and_tag(affiliate_expr)
        if direct_asin:
            linked_asin = direct_asin
        elif generated_helper and asin:
            # React sites generate tagged destinations from product.asin at render
            # time. The helper is the authoritative link mapping even where a
            # record stores no literal affiliate URL.
            if not linked_asin:
                linked_asin = asin
            linked_tag = helper_tag
            if not affiliate_expr:
                affiliate_expr = "generated amazonLink(asin)"
        products.append({
            "article": site["products_file"],
            "line": _line_number(content, offset),
            "name": name,
            "heading": name,
            "asin": asin,
            "affiliate_url": affiliate_expr,
            "linked_asin": linked_asin,
            "linked_tag": linked_tag,
        })
    return products


def extract_site_products(site: dict) -> list[dict]:
    if not site["repo"].exists():
        return []
    if site["type"] == "static_html":
        return extract_static_html_products(site)
    return extract_react_products(site)


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────
def mapping_issues(product: dict, expected_tag: str, site_type: str) -> list[str]:
    issues: list[str] = []
    if not product["name"]:
        issues.append("missing local product name")
    if not product["asin"]:
        issues.append("missing local ASIN")
        return issues
    if not product["linked_asin"]:
        issues.append("missing Amazon affiliate link/ASIN mapping")
    elif product["linked_asin"] != product["asin"]:
        issues.append(f"affiliate link ASIN {product['linked_asin']} differs from local ASIN {product['asin']}")
    if product["affiliate_url"] and product["linked_tag"] != expected_tag:
        issues.append(f"affiliate tag '{product['linked_tag'] or 'missing'}' should be '{expected_tag}'")
    return issues


def validate_site(site: dict) -> dict:
    products = extract_site_products(site)
    report = {
        "site": site["name"],
        "url": site["url"],
        "total": len(products),
        "passed": 0,
        "failed": 0,
        "mapping_failures": 0,
        "catalog_failures": 0,
        "inconclusive": 0,
        "failures": [],
    }
    print(f"\nChecking {site['name']} — {len(products)} product records")

    # Verify each unique ASIN once, then apply the catalog result to all occurrences.
    asin_cache: dict[tuple[str, str], object] = {}
    for product in products:
        local_issues = mapping_issues(product, site["partner_tag"], site["type"])
        catalog_result = None
        asin = product["asin"]
        if asin and product["name"]:
            cache_key = (asin, product["name"])
            if cache_key not in asin_cache:
                asin_cache[cache_key] = verify_asin(asin, product["name"])
                time.sleep(REQUEST_DELAY_SECONDS)
            catalog_result = asin_cache[cache_key]
            if not catalog_result.ok:
                if catalog_result.source == "scrape" and catalog_result.error and any(
                    token in catalog_result.error.lower() for token in ("bot-check", "rate-limit", "http 500", "http 503")
                ):
                    report["inconclusive"] += 1
                elif not catalog_result.resolves:
                    local_issues.append(f"Amazon catalog does not resolve: {catalog_result.error or 'not found'}")
                    report["catalog_failures"] += 1
                else:
                    local_issues.append(
                        f"Amazon title mismatch ({catalog_result.match_score:.0%}): "
                        f"{catalog_result.amazon_title or 'no title returned'}"
                    )
                    report["catalog_failures"] += 1
        elif not asin:
            report["mapping_failures"] += 1

        if local_issues:
            report["failed"] += 1
            if any("affiliate" in issue or "missing local" in issue or "heading" in issue for issue in local_issues):
                report["mapping_failures"] += 1
            report["failures"].append({
                "article": product["article"],
                "line": product["line"],
                "product": product["name"],
                "asin": product["asin"],
                "linked_asin": product["linked_asin"],
                "issue": "; ".join(local_issues),
                "amazon_title": getattr(catalog_result, "amazon_title", None),
                "source": getattr(catalog_result, "source", None),
            })
            print(f"  ✗ {product['name']} ({product['asin'] or 'no ASIN'}): {'; '.join(local_issues)}")
        else:
            report["passed"] += 1
    return report


# ─────────────────────────────────────────────────────────────────────────────
# Trail Built context-aware direct-link mapping stage
# ─────────────────────────────────────────────────────────────────────────────
def run_trail_context_mapping() -> dict:
    """Run the legacy two-stage HTML context validator inside this canonical job.

    This preserves coverage for direct Amazon anchors outside product-box markup,
    nearby visible product labels, and vehicle-fitment mismatches on build guides.
    The former standalone GitHub Actions workflow is retired; this function is its
    single canonical execution path.
    """
    reports_dir = REPO_ROOT / "reports"
    reports_dir.mkdir(exist_ok=True)
    direct_report = reports_dir / "canonical_direct_asin_validation.json"
    context_report = reports_dir / "canonical_context_mapping_validation.json"
    direct = subprocess.run(
        [sys.executable, "tools/validate_asins.py", "--output", str(direct_report)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=900,
    )
    context = subprocess.run(
        [
            sys.executable,
            "tools/validate_asin_mappings.py",
            "--primary-report",
            str(direct_report),
            "--output",
            str(context_report),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=900,
    )
    summary = {}
    try:
        summary = json.loads(context_report.read_text(encoding="utf-8")).get("summary", {})
    except (OSError, json.JSONDecodeError):
        summary = {"status": "inconclusive", "detail": "Context report was not generated"}
    return {
        "status": "ok" if direct.returncode == 0 and context.returncode == 0 else "findings_or_inconclusive",
        "direct_exit_code": direct.returncode,
        "context_exit_code": context.returncode,
        "summary": summary,
        "direct_report": str(direct_report.relative_to(REPO_ROOT)),
        "context_report": str(context_report.relative_to(REPO_ROOT)),
        "output_tail": (direct.stdout + "\n" + direct.stderr + "\n" + context.stdout + "\n" + context.stderr).strip()[-2000:],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Optional Creators API price/image refresh
# ─────────────────────────────────────────────────────────────────────────────
def run_weekly_finding_remediation(site_reports: list[dict], dry_run: bool) -> list[dict]:
    """Route explicit validator failures through the same strict remediation engine.

    The weekly job never lowers a threshold.  It can only apply the engine's approved
    data fixes, capped separately at two attempted actions per site; all other cases
    are recorded for escalation in the concise email report.
    """
    engine_sites = {site.name: site for site in DEPLOY_SITES}
    actions: list[dict] = []
    per_site_attempts: dict[str, int] = {}
    for report in site_reports:
        engine_site = engine_sites.get(report["site"])
        if not engine_site:
            continue
        for failure in report.get("failures", []):
            if per_site_attempts.get(report["site"], 0) >= 2:
                actions.append({"site": report["site"], "product": failure.get("product"), "status": "escalate", "detail": "Two-attempt cap reached; gate remains intact."})
                continue
            action = remediate_product_finding(engine_site, failure, dry_run)
            per_site_attempts[report["site"]] = per_site_attempts.get(report["site"], 0) + 1
            actions.append({"site": report["site"], "product": failure.get("product"), "asin": failure.get("asin"), **action})
    return actions


def run_catalog_sync(site: dict) -> dict:
    """Run a site's existing Creators API GetItems price/image script when requested."""
    child_env = os.environ.copy()
    child_env["CREATORS_API_PARTNER_TAG"] = site["partner_tag"]
    process = subprocess.run(
        site["sync_command"],
        cwd=site["repo"],
        capture_output=True,
        text=True,
        timeout=300,
        env=child_env,
    )
    return {
        "site": site["name"],
        "exit_code": process.returncode,
        "status": "ok" if process.returncode == 0 else "failed",
        "summary": (process.stdout + "\n" + process.stderr).strip()[-2000:],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────
def _plain_report(site_reports: list[dict], context_mapping: dict, sync_reports: list[dict], remediation_actions: list[dict], deploy_reconciliation: dict, run_date: str) -> str:
    total = sum(report["total"] for report in site_reports)
    passed = sum(report["passed"] for report in site_reports)
    failed = sum(report["failed"] for report in site_reports)
    mapping = sum(report["mapping_failures"] for report in site_reports)
    catalog = sum(report["catalog_failures"] for report in site_reports)
    inconclusive = sum(report["inconclusive"] for report in site_reports)
    lines = [
        f"Weekly Affiliate Link Health-Check — {run_date}",
        "=" * 64,
        f"Canonical job: full product → ASIN → affiliate-link → Amazon-title validation",
        f"Products checked: {total} | Passed: {passed} | Failures: {failed}",
        f"Mapping failures: {mapping} | Catalog/title failures: {catalog} | Inconclusive: {inconclusive}",
        "",
    ]
    for report in site_reports:
        lines.append(f"--- {report['site']} ({report['url']}) ---")
        lines.append(
            f"{report['passed']}/{report['total']} valid | "
            f"mapping: {report['mapping_failures']} | catalog: {report['catalog_failures']} | "
            f"inconclusive: {report['inconclusive']}"
        )
        if report["failures"]:
            for failure in report["failures"]:
                lines.append(
                    f"  ✗ [{failure['article']}:{failure['line']}] {failure['product']} "
                    f"(local ASIN {failure['asin'] or 'none'}; linked ASIN {failure['linked_asin'] or 'none'}): "
                    f"{failure['issue']}"
                )
        else:
            lines.append("  ✓ No mapping or catalog failures.")
        lines.append("")
    lines.append("--- Trail Built direct-link context / vehicle-fitment mapping ---")
    lines.append(
        f"status: {context_mapping.get('status', 'not run')} | "
        f"direct gate exit: {context_mapping.get('direct_exit_code', 'n/a')} | "
        f"context gate exit: {context_mapping.get('context_exit_code', 'n/a')}"
    )
    if context_mapping.get("summary"):
        lines.append(f"summary: {json.dumps(context_mapping['summary'], sort_keys=True)}")
    lines.append("")
    if sync_reports:
        lines.append("--- Optional Creators API price/image sync ---")
        for sync in sync_reports:
            lines.append(f"{sync['site']}: {sync['status']} (exit {sync['exit_code']})")
        lines.append("")
    if remediation_actions:
        lines.append("--- Strict data remediation actions ---")
        for action in remediation_actions:
            lines.append(
                f"{action['site']}: {action.get('product', 'product')} | {action.get('status', 'unknown')} | "
                f"{action.get('detail', action.get('sha', 'no detail'))}"
            )
        lines.append("")
    lines.append("--- Deploy confirmation reconciliation ---")
    for deploy in deploy_reconciliation.get("sites", []):
        actions = deploy.get("auto_attempts") or []
        action_summary = ", ".join(action.get("status", "") for action in actions) or "none"
        lines.append(
            f"{deploy['site']}: {deploy['status']} | expected {deploy['expected_sha'][:10]} | "
            f"live {deploy['live_marker'][:10] if deploy.get('live_marker') else '<unavailable>'} | "
            f"auto-fixed: {action_summary} | escalated: {'yes' if deploy.get('escalated') else 'no'}"
        )
    lines.append("")
    lines.extend([
        "Notes:",
        "- Amazon bot-check/rate-limit responses are reported as inconclusive, not as delistings.",
        "- Set CREATORS_API_CLIENT_ID, CREATORS_API_CLIENT_SECRET, and the per-site",
        "  CREATORS_API_PARTNER_TAG to use Amazon's official Creators API rather than scrape fallback.",
        f"- Report recipient: set via the {REPORT_RECIPIENT_ENV} environment variable (not stored in this report).",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Canonical affiliate health-check")
    parser.add_argument("--dry-run", action="store_true", help="Preserved for scheduled task compatibility; validation is always read-only.")
    parser.add_argument("--sync-price-images", action="store_true", help="Also invoke each site's Creators API GetItems catalog sync script.")
    args = parser.parse_args()

    run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"Canonical Weekly Affiliate Link Health-Check — {run_date}")
    skip_reason = email_skip_reason()
    if skip_reason:
        print(skip_reason)
    else:
        print(f"Report recipient: configured via {REPORT_RECIPIENT_ENV}")
    print("Source of truth: Amazon Creators API GetItems with public-page fallback")

    site_reports = [validate_site(site) for site in SITES]
    context_mapping = run_trail_context_mapping()
    creators_credentials_present = bool(
        os.environ.get("CREATORS_API_CLIENT_ID")
        and os.environ.get("CREATORS_API_CLIENT_SECRET")
    )
    if args.sync_price_images and creators_credentials_present:
        sync_reports = [run_catalog_sync(site) for site in SITES]
    elif args.sync_price_images:
        sync_reports = [{
            "site": "All sites",
            "exit_code": None,
            "status": "skipped",
            "summary": "Skipped: CREATORS_API_CLIENT_ID and CREATORS_API_CLIENT_SECRET are not configured for this run.",
        }]
    else:
        sync_reports = []
    # First route explicit ASIN/data findings into the shared strict remediation engine.
    # Only enumerated safe actions are attempted; all ambiguity remains an escalation.
    remediation_actions = run_weekly_finding_remediation(site_reports, dry_run=args.dry_run)
    # Canonical weekly deployment reconcile. This catches manual/third-party Netlify
    # deploys by comparing each live version.txt marker to origin/main and preserves
    # strict gates: only approved safe fixes can be attempted by the shared engine.
    deploy_reconciliation = reconcile_all(auto_remediate=True, dry_run=args.dry_run)
    deploy_subject, deploy_body = concise_email(deploy_reconciliation)
    plain = _plain_report(site_reports, context_mapping, sync_reports, remediation_actions, deploy_reconciliation, run_date)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "canonical_job": "Weekly Affiliate Link Health-Check",
        "validation_scope": "product-to-ASIN-to-affiliate-link-to-Amazon-title",
        "sites": site_reports,
        "trail_context_mapping": context_mapping,
        "catalog_sync": sync_reports,
        "strict_remediation_actions": remediation_actions,
        "deploy_confirmation": deploy_reconciliation,
        "deploy_confirmation_email": (
            {"skipped": True, "reason": skip_reason}
            if skip_reason
            else {"recipient_env": REPORT_RECIPIENT_ENV, "subject": deploy_subject, "body": deploy_body}
        ),
        "summary": {
            "total_products": sum(report["total"] for report in site_reports),
            "passed": sum(report["passed"] for report in site_reports),
            "failed": sum(report["failed"] for report in site_reports),
            "mapping_failures": sum(report["mapping_failures"] for report in site_reports),
            "catalog_failures": sum(report["catalog_failures"] for report in site_reports),
            "inconclusive": sum(report["inconclusive"] for report in site_reports),
        },
    }
    REPORT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("\n" + "=" * 64)
    print(plain)
    print(f"\nJSON report: {REPORT_PATH}")
    # Weekly reporting should continue even if failures are discovered; failures are the report.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
