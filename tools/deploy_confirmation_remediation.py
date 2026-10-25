#!/usr/bin/env python3
"""Shared deploy confirmation and conservative auto-remediation engine.

This module is deliberately strict: it never changes validator thresholds, disables
checks, invents product data, or touches credentials.  It is called in two places:
1) directly by the agent immediately after an agent-initiated `git push`; and
2) by `weekly_asin_healthcheck.py` to reconcile every site's deployed version.

The engine reads GitHub commit-check status via the authenticated `gh` CLI when
available, reads a public `version.txt` marker, and can consume a Netlify/GitHub
failure-log excerpt supplied through --log-file.  Any automatic source edit is
limited to the explicitly approved safe cases and is capped at two attempts.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

from asin_lookup import search_catalog_items, verify_asin
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
HOME = Path("/home/ubuntu")
# The report recipient is deliberately NOT stored in the repo. It is read from the
# environment of whatever scheduled task runs this engine and has no default.
REPORT_RECIPIENT_ENV = "AFFILIATE_REPORT_RECIPIENT"
MAX_AUTO_ATTEMPTS = 2


def report_recipient() -> str | None:
    """Return the configured report recipient, or None when the env var is unset/blank."""
    return os.environ.get(REPORT_RECIPIENT_ENV, "").strip() or None


def email_skip_reason() -> str | None:
    """Return a log line explaining why the email step is skipped, or None when it can run."""
    if report_recipient():
        return None
    return f"{REPORT_RECIPIENT_ENV} is not set; skipping the email step (no recipient configured)."


@dataclass(frozen=True)
class Site:
    key: str
    name: str
    repo: Path
    github_repo: str
    live_url: str
    product_file: Path
    sync_command: tuple[str, ...]


SITES: tuple[Site, ...] = (
    Site(
        "trailbuilt", "Trail Built Overland", REPO_ROOT,
        "bootnylee/Trail-Built-Overlanding-Site", "https://trailbuiltoverland.com",
        REPO_ROOT / "js/products-data.js", ("node", "scripts/fetch-prices.js"),
    ),
    Site(
        "silkierstrands", "SilkierStrands", HOME / "silkierstrands",
        "bootnylee/silkierstrands-website", "https://silkierstrands.com",
        HOME / "silkierstrands/client/src/lib/products.ts", ("node", "scripts/fetch-prices.js"),
    ),
    Site(
        "pauseandflourish", "PauseAndFlourish", HOME / "pauseandflourish",
        "bootnylee/pauseandflourish-website", "https://pauseandflourish.com",
        HOME / "pauseandflourish/client/src/lib/products.ts", ("node", "scripts/fetch-prices.js"),
    ),
)


def _run(command: list[str] | tuple[str, ...], cwd: Path | None = None, timeout: int = 45) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)


def _git_sha(site: Site) -> str:
    process = _run(["git", "rev-parse", "origin/main"], site.repo)
    if process.returncode:
        process = _run(["git", "rev-parse", "HEAD"], site.repo)
    return process.stdout.strip()


def _live_marker(site: Site) -> tuple[str, str]:
    request = urllib.request.Request(
        f"{site.live_url}/version.txt?deploy-check={int(time.time())}",
        headers={"Cache-Control": "no-cache", "User-Agent": "DeployConfirmation/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return str(response.status), response.read().decode("utf-8").strip()
    except urllib.error.HTTPError as exc:
        return str(exc.code), ""
    except Exception as exc:  # Network failures are escalations, never fabricated as deploy failure.
        return "network-error", str(exc)


def _github_checks(site: Site, sha: str) -> list[dict[str, Any]]:
    process = _run([
        "gh", "api", f"repos/{site.github_repo}/commits/{sha}/check-runs",
    ], timeout=35)
    if process.returncode:
        return []
    try:
        return list(json.loads(process.stdout).get("check_runs", []))
    except (json.JSONDecodeError, AttributeError):
        return []


def _wait_for_marker(site: Site, expected_sha: str, wait_seconds: int) -> tuple[str, str]:
    """Poll only after an agent push; weekly reconciliation remains immediate."""
    deadline = time.monotonic() + max(wait_seconds, 0)
    latest = ("", "")
    while True:
        latest = _live_marker(site)
        if latest[0] == "200" and latest[1] == expected_sha:
            return latest
        if time.monotonic() >= deadline:
            return latest
        time.sleep(min(60, max(1, deadline - time.monotonic())))

def _check_failure_text(checks: list[dict[str, Any]]) -> str:
    fragments: list[str] = []
    for check in checks:
        if check.get("conclusion") in {"failure", "timed_out", "cancelled", "action_required"}:
            fragments.append(str(check.get("name", "")))
            output = check.get("output") or {}
            fragments.append(str(output.get("title", "")))
            fragments.append(str(output.get("summary", "")))
            fragments.append(str(output.get("text", "")))
    return "\n".join(fragments)


def _load_log(path: Path | None) -> str:
    if not path or not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def classify_failure(log_text: str) -> dict[str, Any]:
    """Classify only approved remediation patterns. Everything else escalates."""
    lowered = log_text.lower()
    missing = re.search(r"Cannot find module ['\"]?([^'\"\s]+)", log_text, re.I)
    if missing:
        return {"category": "missing_module", "path": missing.group(1), "safe": True}
    if "title mismatch" in lowered or "catalog/title failure" in lowered:
        asin = re.search(r"([A-Z0-9]{10})", log_text)
        return {"category": "asin_title_mismatch", "asin": asin.group(1) if asin else "", "safe": True}
    if any(term in lowered for term in ("dead asin", "unavailable asin", "delisted", "asin not found", "http 404")):
        asin = re.search(r"([A-Z0-9]{10})", log_text)
        return {"category": "dead_or_unavailable_asin", "asin": asin.group(1) if asin else "", "safe": True}
    if "product-data" in lowered and ("parse error" in lowered or "syntaxerror" in lowered):
        return {"category": "product_data_parse_error", "safe": True}
    if "no current offer" in lowered or "price present with no current offer" in lowered:
        return {"category": "stale_price_without_offer", "safe": True}
    return {"category": "unclassified", "safe": False}


def _path_is_safe_repo_path(site: Site, raw_path: str) -> Path | None:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        # Netlify reports /opt/build/repo/<path>; convert only that known prefix.
        marker = "/opt/build/repo/"
        if marker not in raw_path:
            return None
        candidate = Path(raw_path.split(marker, 1)[1])
    resolved = (site.repo / candidate).resolve()
    try:
        resolved.relative_to(site.repo.resolve())
    except ValueError:
        return None
    return resolved


def _commit_and_push(site: Site, paths: list[Path], message: str, dry_run: bool) -> dict[str, Any]:
    relative = [str(path.relative_to(site.repo)) for path in paths]
    if dry_run:
        return {"status": "would_commit", "paths": relative, "message": message}
    _run(["git", "add", *relative], site.repo)
    diff = _run(["git", "diff", "--cached", "--quiet"], site.repo)
    if diff.returncode == 0:
        return {"status": "no_change", "paths": relative}
    commit = _run(["git", "commit", "-m", message], site.repo, timeout=90)
    if commit.returncode:
        return {"status": "escalate", "detail": commit.stderr[-2000:]}
    push = _run(["git", "push", "origin", "main"], site.repo, timeout=120)
    if push.returncode:
        return {"status": "escalate", "detail": push.stderr[-2000:]}
    return {"status": "committed", "paths": relative, "sha": _git_sha(site)}


def remediate_missing_module(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    candidate = _path_is_safe_repo_path(site, str(finding.get("path", "")))
    if candidate and candidate.exists():
        return _commit_and_push(site, [candidate], "fix: add missing deploy validation module", dry_run)
    return {
        "status": "escalate",
        "detail": "Referenced module is not present locally; correcting the build command would require an ambiguous edit.",
    }


def _remove_react_asin_record(content: str, asin: str) -> tuple[str, bool]:
    # Conservative record edit: remove only affiliate-link eligibility from the exact ASIN record.
    pattern = re.compile(r"(\{[^{}]{0,800}?\basin\s*:\s*['\"]" + re.escape(asin) + r"['\"][^{}]{0,2000}?\})", re.S)
    match = pattern.search(content)
    if not match:
        return content, False
    record = match.group(1)
    revised = re.sub(r"\n?\s*asin\s*:\s*['\"]" + re.escape(asin) + r"['\"],?", "", record)
    revised = re.sub(r"\n?\s*affiliateUrl\s*:\s*[^,\n]+,?", "", revised)
    return content[:match.start()] + revised + content[match.end():], revised != record


def _unlink_static_article_product(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    """Remove only an exact unverified ASIN destination from one static guide.

    The rendered product remains available as editorial content; the direct ASIN and
    every matching Amazon anchor are removed so the standardizer renders the required
    No verified link state rather than a broken destination.
    """
    asin = str(finding.get("asin", "")).upper()
    relative = str(finding.get("article", "")).lstrip("/")
    article = site.repo / relative
    if not asin or not article.exists() or article.suffix != ".html":
        return {"status": "escalate", "detail": "Could not identify one static product block to unlink."}
    content = article.read_text(encoding="utf-8")
    original = content
    content = re.sub(r'\sdata-asin=["\']' + re.escape(asin) + r'["\']', ' data-asin="" data-needs-asin="true"', content)
    content = re.sub(
        r'<a([^>]*?)href=["\'][^"\']*(?:amazon\.[^"\']+|amzn\.to)[^"\']*(?:/dp/|dp%2F)' + re.escape(asin) + r'[^"\']*["\']([^>]*)>(.*?)</a>',
        r'<span class="product-link-status" data-needs-asin="true">No verified link</span>',
        content,
        flags=re.I | re.S,
    )
    if content == original:
        return {"status": "escalate", "detail": "No exact static ASIN destination was found to unlink."}
    if not dry_run:
        article.write_text(content, encoding="utf-8")
        standardize = _run([sys.executable, "scripts/standardize-guide-commerce.py"], site.repo, timeout=120)
        if standardize.returncode:
            return {"status": "escalate", "detail": (standardize.stdout + standardize.stderr)[-2000:]}
    return _commit_and_push(site, [article], f"fix: unlink unverified Amazon ASIN {asin}", dry_run)


def remediate_product_finding(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    """Apply strict data-first handling to a detailed weekly validator failure."""
    issue = str(finding.get("issue", "")).lower()
    category = classify_failure(str(finding.get("issue", ""))).get("category")
    normalized = {**finding, "category": category, "asin": str(finding.get("asin", "")).upper()}
    if category == "asin_title_mismatch":
        # A high-confidence same-product rename is handled first.  Any different or
        # ambiguous SKU is unlinked rather than guessed; static pages are safe to edit
        # exactly because the validator identifies the affected article.
        update = remediate_asin_title_mismatch(site, normalized, dry_run)
        if update.get("status") != "escalate":
            return update
        if Path(str(normalized.get("article", ""))).suffix == ".html":
            return _unlink_static_article_product(site, normalized, dry_run)
        return update
    if category == "dead_or_unavailable_asin":
        if Path(str(normalized.get("article", ""))).suffix == ".html":
            return _unlink_static_article_product(site, normalized, dry_run)
        return remediate_dead_asin(site, normalized, dry_run)
    if "no current offer" in issue:
        return remediate_catalog_sync(site, dry_run)
    return {"status": "escalate", "detail": "Weekly finding is not an approved automatic-remediation category."}


def remediate_dead_asin(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    asin = str(finding.get("asin", "")).upper()
    if not asin or not site.product_file.exists() or site.product_file.suffix not in {".ts", ".js"}:
        return {"status": "escalate", "detail": "Unable to safely identify a single product record for this unavailable ASIN."}
    source = site.product_file.read_text(encoding="utf-8")
    updated, changed = _remove_react_asin_record(source, asin)
    if not changed:
        return {"status": "escalate", "detail": "No exact eligible product record was found for the unavailable ASIN."}
    if not dry_run:
        site.product_file.write_text(updated, encoding="utf-8")
    return _commit_and_push(site, [site.product_file], f"fix: unlink unavailable Amazon ASIN {asin}", dry_run)


def _record_name_for_asin(site: Site, asin: str) -> str:
    """Read a product's current display label from a bounded source record."""
    if not site.product_file.exists():
        return ""
    content = site.product_file.read_text(encoding="utf-8", errors="replace")
    # Product records are bounded objects in the sites' JS/TS source.  Never use a
    # broad project-wide replacement when resolving a catalog title.
    match = re.search(r"\{[^{}]{0,3000}?\basin\s*:\s*['\"]" + re.escape(asin) + r"['\"][^{}]{0,5000}?\}", content, re.S)
    if not match:
        return ""
    name = re.search(r"\bname\s*:\s*['\"]([^'\"]+)['\"]", match.group(0))
    return name.group(1).strip() if name else ""


def _strict_same_product(expected: str, catalog_title: str) -> bool:
    """Allow a label rename only with a high-confidence same-product identity.

    We require the brand token plus a strong line/form/size token overlap.  Generic
    terms and mutable merchandising terms are excluded; an uncertain SKU remains an
    escalation rather than a guessed title update.
    """
    def tokens(value: str) -> set[str]:
        ignored = {
            "the", "and", "for", "with", "hair", "product", "new", "improved",
            "formula", "professional", "care", "treatment", "original", "refillable",
            "amazon", "pack", "count", "oz", "ounce", "ml", "fl", "us",
        }
        return {word for word in re.findall(r"[a-z0-9]+", value.lower()) if len(word) > 2 and word not in ignored}
    expected_tokens = tokens(expected)
    catalog_tokens = tokens(catalog_title)
    if len(expected_tokens) < 2 or not expected_tokens:
        return False
    overlap = expected_tokens & catalog_tokens
    # Brand is first meaningful token in the stored display name; at least 75% of
    # the non-generic record identity must remain present in the official title.
    brand = next(iter(tokens(expected.split()[0])), "")
    return bool(brand and brand in catalog_tokens and len(overlap) / len(expected_tokens) >= 0.75)


def _replace_record_name(site: Site, asin: str, new_name: str, dry_run: bool) -> dict[str, Any]:
    if not site.product_file.exists():
        return {"status": "escalate", "detail": "Product source file is unavailable."}
    content = site.product_file.read_text(encoding="utf-8")
    pattern = re.compile(r"(\{[^{}]{0,3000}?\basin\s*:\s*['\"]" + re.escape(asin) + r"['\"][^{}]{0,5000}?\})", re.S)
    match = pattern.search(content)
    if not match:
        return {"status": "escalate", "detail": "No exact product record was found for the catalog ASIN."}
    record = match.group(1)
    changed_record, replacements = re.subn(
        r"(\bname\s*:\s*['\"])([^'\"]+)(['\"])",
        lambda item: item.group(1) + new_name.replace("\\", "\\\\").replace("'", "\\'") + item.group(3),
        record,
        count=1,
    )
    if replacements != 1:
        return {"status": "escalate", "detail": "Record has no single editable display-name field."}
    if not dry_run:
        site.product_file.write_text(content[:match.start()] + changed_record + content[match.end():], encoding="utf-8")
    return _commit_and_push(site, [site.product_file], f"fix: align product label with verified catalog title for {asin}", dry_run)


def _candidate_title(item: dict) -> str:
    return str((((item.get("itemInfo") or {}).get("title") or {}).get("displayValue")) or "")


def _find_exact_replacement_asin(expected: str) -> tuple[str, str] | None:
    """Return exactly one high-confidence official catalog candidate, or None.

    SearchItems is used only with Creators API credentials.  Multiple plausible
    candidates, absent titles, or weak identity overlap are intentionally ambiguous.
    """
    candidates: list[tuple[str, str]] = []
    for item in search_catalog_items(expected, 10):
        asin = str(item.get("asin") or "").upper()
        title = _candidate_title(item)
        if re.fullmatch(r"[A-Z0-9]{10}", asin or "") and title and _strict_same_product(expected, title):
            candidates.append((asin, title))
    unique = {(asin, title) for asin, title in candidates}
    return next(iter(unique)) if len(unique) == 1 else None


def _replace_record_asin(site: Site, old_asin: str, new_asin: str, new_title: str, dry_run: bool) -> dict[str, Any]:
    if not site.product_file.exists() or site.product_file.suffix not in {".ts", ".js"}:
        return {"status": "escalate", "detail": "No bounded dynamic product record is available for exact ASIN replacement."}
    content = site.product_file.read_text(encoding="utf-8")
    pattern = re.compile(r"(\{[^{}]{0,3000}?\basin\s*:\s*['\"]" + re.escape(old_asin) + r"['\"][^{}]{0,5000}?\})", re.S)
    match = pattern.search(content)
    if not match:
        return {"status": "escalate", "detail": "No exact eligible product record was found for ASIN replacement."}
    record = match.group(1)
    revised = re.sub(r"(\basin\s*:\s*['\"])" + re.escape(old_asin) + r"(['\"])", r"\g<1>" + new_asin + r"\2", record, count=1)
    safe_title = new_title.replace("\\", "\\\\").replace("'", "\\'")
    revised = re.sub(r"(\bname\s*:\s*['\"])([^'\"]+)(['\"])", lambda item: item.group(1) + safe_title + item.group(3), revised, count=1)
    if revised == record:
        return {"status": "escalate", "detail": "Bounded record edit did not produce one exact ASIN replacement."}
    if not dry_run:
        site.product_file.write_text(content[:match.start()] + revised + content[match.end():], encoding="utf-8")
    return _commit_and_push(site, [site.product_file], f"fix: relink verified exact Amazon ASIN {new_asin}", dry_run)


def _replace_static_article_asin(site: Site, finding: dict[str, Any], new_asin: str, dry_run: bool) -> dict[str, Any]:
    old_asin = str(finding.get("asin", "")).upper()
    article = site.repo / str(finding.get("article", "")).lstrip("/")
    if not old_asin or not article.exists() or article.suffix != ".html":
        return {"status": "escalate", "detail": "Could not identify one static guide product for exact ASIN replacement."}
    content = article.read_text(encoding="utf-8")
    revised = content.replace(old_asin, new_asin)
    if revised == content:
        return {"status": "escalate", "detail": "No exact static ASIN reference was found for replacement."}
    if not dry_run:
        article.write_text(revised, encoding="utf-8")
        standardize = _run([sys.executable, "scripts/standardize-guide-commerce.py"], site.repo, timeout=120)
        if standardize.returncode:
            return {"status": "escalate", "detail": (standardize.stdout + standardize.stderr)[-2000:]}
    return _commit_and_push(site, [article], f"fix: relink verified exact Amazon ASIN {new_asin}", dry_run)


def remediate_asin_title_mismatch(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    asin = str(finding.get("asin", "")).upper()
    expected = _record_name_for_asin(site, asin)
    if not asin or not expected:
        return {"status": "escalate", "detail": "Could not map the mismatch to one exact product source record."}
    verified = verify_asin(asin, expected)
    if not verified.resolves or not verified.amazon_title:
        return {"status": "escalate", "detail": f"Official catalog could not resolve the ASIN: {verified.error or 'no title returned'}."}
    if _strict_same_product(expected, verified.amazon_title):
        return _replace_record_name(site, asin, verified.amazon_title, dry_run)
    replacement = _find_exact_replacement_asin(expected)
    if not replacement:
        return {"status": "escalate", "detail": "No unique high-confidence Creators API SearchItems result matched brand, line, form, and size."}
    replacement_asin, replacement_title = replacement
    if Path(str(finding.get("article", ""))).suffix == ".html":
        return _replace_static_article_asin(site, finding, replacement_asin, dry_run)
    return _replace_record_asin(site, asin, replacement_asin, replacement_title, dry_run)


def remediate_catalog_sync(site: Site, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {"status": "would_run_safe_sync", "command": " ".join(site.sync_command)}
    if not (os.environ.get("CREATORS_API_CLIENT_ID") and os.environ.get("CREATORS_API_CLIENT_SECRET")):
        return {"status": "escalate", "detail": "Creators API credentials unavailable; cannot verify or safely refresh catalog data."}
    process = _run(list(site.sync_command), site.repo, timeout=300)
    if process.returncode:
        return {"status": "escalate", "detail": (process.stdout + process.stderr)[-2000:]}
    return _commit_and_push(site, [site.product_file], "fix: refresh verified catalog offer data", dry_run)


def remediate(site: Site, finding: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    category = finding.get("category")
    if category == "missing_module":
        return remediate_missing_module(site, finding, dry_run)
    if category == "dead_or_unavailable_asin":
        return remediate_dead_asin(site, finding, dry_run)
    if category in {"stale_price_without_offer", "product_data_parse_error"}:
        return remediate_catalog_sync(site, dry_run)
    if category == "asin_title_mismatch":
        return remediate_asin_title_mismatch(site, finding, dry_run)
    return {"status": "escalate", "detail": "Failure is not an approved automatic-remediation category."}


def inspect_site(site: Site, expected_sha: str | None = None, log_text: str = "", wait_seconds: int = 0) -> dict[str, Any]:
    expected = expected_sha or _git_sha(site)
    http_status, marker = _wait_for_marker(site, expected, wait_seconds) if wait_seconds else _live_marker(site)
    checks = _github_checks(site, expected)
    check_text = _check_failure_text(checks)
    failed_checks = [check for check in checks if check.get("conclusion") in {"failure", "timed_out", "cancelled", "action_required"}]
    green = http_status == "200" and marker == expected and not failed_checks
    status = "GREEN" if green else "BLOCKED"
    finding = classify_failure(log_text or check_text) if not green else {"category": "none", "safe": False}
    return {
        "site": site.name,
        "key": site.key,
        "expected_sha": expected,
        "http_status": http_status,
        "live_marker": marker,
        "github_checks": [{"name": c.get("name"), "status": c.get("status"), "conclusion": c.get("conclusion")} for c in checks],
        "status": status,
        "finding": finding,
        "failure_excerpt": (log_text or check_text)[-2500:],
    }


def reconcile_all(expected_shas: dict[str, str] | None = None, log_file: Path | None = None, auto_remediate: bool = False, dry_run: bool = False, wait_seconds: int = 0) -> dict[str, Any]:
    """Reconcile all sites; shared entrypoint used by post-push and weekly runs."""
    log_text = _load_log(log_file)
    results: list[dict[str, Any]] = []
    for site in SITES:
        result = inspect_site(site, (expected_shas or {}).get(site.key), log_text, wait_seconds)
        attempts: list[dict[str, Any]] = []
        if auto_remediate and result["status"] == "BLOCKED":
            for _ in range(MAX_AUTO_ATTEMPTS):
                action = remediate(site, result["finding"], dry_run)
                attempts.append(action)
                if action.get("status") not in {"committed", "would_commit", "would_run_safe_sync"}:
                    break
                expected_after_fix = action.get("sha") or _git_sha(site)
                result = inspect_site(site, expected_after_fix, log_text, wait_seconds)
                if result["status"] == "GREEN" or dry_run:
                    break
        result["auto_attempts"] = attempts
        result["escalated"] = result["status"] == "BLOCKED" and (not attempts or attempts[-1].get("status") == "escalate")
        results.append(result)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "weekly-reconcile" if not expected_shas else "post-push",
        "max_auto_attempts": MAX_AUTO_ATTEMPTS,
        "sites": results,
    }


def concise_email(report: dict[str, Any]) -> tuple[str, str]:
    blocked = [site for site in report["sites"] if site["status"] != "GREEN"]
    subject = f"{'⚠️ ' if blocked else ''}Deploy Confirmation — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    lines = ["Deploy Confirmation Check", "=" * 32]
    for site in report["sites"]:
        actions = site.get("auto_attempts") or []
        fixed = "; ".join(action.get("status", "") for action in actions) or "none"
        lines.extend([
            f"{site['site']}: {site['status']}",
            f"  expected commit: {site['expected_sha'][:10]}",
            f"  live marker: {site['live_marker'][:10] if site['live_marker'] else '<unavailable>'} (HTTP {site['http_status']})",
            f"  auto-fixed: {fixed}",
            f"  escalated: {'yes' if site.get('escalated') else 'no'}",
        ])
        if site.get("escalated"):
            lines.append(f"  recommended fix: {site['finding'].get('category', 'inspect deploy log')}")
    return subject, "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy confirmation and strict auto-remediation engine")
    parser.add_argument("--mode", choices=("post-push", "weekly-reconcile"), default="post-push")
    parser.add_argument("--site", choices=("all", *(site.key for site in SITES)), default="all")
    parser.add_argument("--expected-sha", help="Commit expected on the selected site; otherwise origin/main is used.")
    parser.add_argument("--log-file", type=Path, help="Optional Netlify/GitHub failure-log excerpt for strict classification.")
    parser.add_argument("--auto-remediate", action="store_true", help="Apply only approved safe fixes, capped at two attempts.")
    parser.add_argument("--dry-run", action="store_true", help="Report intended actions without changing any source file or pushing.")
    args = parser.parse_args()

    selected = {site.key: (args.expected_sha or _git_sha(site)) for site in SITES if args.site in {"all", site.key}}
    wait_seconds = 1200 if args.mode == "post-push" else 0
    report = reconcile_all(selected if args.mode == "post-push" else None, args.log_file, args.auto_remediate, args.dry_run, wait_seconds)
    if args.site != "all":
        report["sites"] = [site for site in report["sites"] if site["key"] == args.site]
    subject, body = concise_email(report)
    skip_reason = email_skip_reason()
    if skip_reason:
        print(skip_reason, file=sys.stderr)
        report["email_draft"] = {"skipped": True, "reason": skip_reason}
    else:
        # The address itself is never written to the output; the sender resolves it from the environment.
        report["email_draft"] = {"recipient_env": REPORT_RECIPIENT_ENV, "subject": subject, "body": body}
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
