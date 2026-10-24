# Affiliate Automation — Single Source of Truth

**Effective:** 2026-08-17

This document defines the single approved automation path for affiliate product integrity across **Trail Built Overland**, **SilkierStrands**, and **PauseAndFlourish**.

## Canonical Job

| Setting | Canonical configuration |
|---|---|
| Job name | **Weekly Affiliate Link Health-Check** |
| Cadence | Every Monday at **15:00 Pacific Time** |
| Report recipient | The owner (address kept out of the repo; set in the environment) |
| Product source of truth | Amazon **Creators API** `GetItems` |
| Fallback | Public Amazon product-page check when Creators API credentials are not available |
| Script | `tools/weekly_asin_healthcheck.py` in the Trail Built Overland repository |
| Scope | Trail Built Overland, SilkierStrands, and PauseAndFlourish |

The job verifies each product record through the full mapping chain:

```text
Local product name → local ASIN → outbound affiliate-link ASIN → Amazon catalog title
```

A record fails if its named ASIN is missing, its affiliate-link ASIN differs from the named ASIN, an affiliate tag is wrong or missing on a static product box, Amazon cannot resolve the ASIN, or Amazon’s returned title does not sufficiently match the local product name. Amazon bot checks, rate limits, and transient 5xx responses are reported as **inconclusive**, not as confirmed delistings.

## Optional Catalog Refresh

The canonical tool also supports a deliberate Creators API `GetItems` price/image refresh:

```bash
python3 tools/weekly_asin_healthcheck.py --sync-price-images
```

The refresh invokes each site’s `scripts/fetch-prices.js` implementation. It uses only the Creators API credentials below and writes a report. It does not silently commit or publish changes.

| Environment variable | Purpose |
|---|---|
| `CREATORS_API_CLIENT_ID` | Amazon Creators API OAuth client ID |
| `CREATORS_API_CLIENT_SECRET` | Amazon Creators API OAuth client secret |
| `CREATORS_API_PARTNER_TAG` | Per-site Associates tag |

The per-site partner tags are `trailbuiltove-20`, `silkierstrands-20`, and `pauseandflourish-20`.

## Retired / Superseded Work

The following legacy jobs and guides are retired. They must not be re-enabled, duplicated, or used as a source of product truth.

| Retired item | Status | Replacement |
|---|---|---|
| **Extend weekly ASIN health-check: site-wide mapping validation (all 3 repos)** | Superseded | Mapping validation is now part of the canonical weekly health-check. |
| **PA-API Price Sync and Link Checker Verification Steps** | Retired | Canonical health-check plus optional Creators API catalog refresh. |
| **Integration of Link Checker and Price Sync Scripts** | Retired | Canonical health-check. |
| **Amazon PA-API 5.0 Price and Image Sync Implementation** | Retired | Creators API `GetItems` optional catalog refresh. |
| **Fix PA-API Live Sync Failure for Bootnylee Websites** | Retired | Creators API OAuth implementation and failure reporting. |

The historical daily price-sync GitHub workflows and the duplicate weekly affiliate checks are intentionally removed. Content-generation workflows remain, but they no longer run independent affiliate link checks or price syncs.

## Operating Rules

> Never invent an ASIN, part number, model number, product name, price, or image source. If a product cannot be verified through the Creators API or a documented catalog source, remove its affiliate link and flag it for manual review.

The health-check is the only recurring affiliate integrity job. Any future affiliate automation must extend this tool rather than introduce a second scheduled validator.

## Credential Source

Credentials are created and managed in [Amazon Associates Central — Creators API](https://affiliate-program.amazon.com/creatorsapi). PA-API 5.0 credentials and `PAAPI_*` environment variable names are retired and must not be configured for these sites.

## Deploy Confirmation and Strict Remediation

The same shared engine covers two non-duplicative invocation paths:

| Trigger | Invocation | Purpose |
|---|---|---|
| Agent-initiated push | `python3 tools/deploy_confirmation_remediation.py --mode post-push --site <site> --expected-sha <sha> --auto-remediate` | Waits for the expected `version.txt` commit, produces the concise deploy-confirmation email draft, and applies only approved safe remediation. |
| Canonical weekly job | `weekly_asin_healthcheck.py` calls `reconcile_all(auto_remediate=True, dry_run=args.dry_run)` from `deploy_confirmation_remediation.py` | Reconciles every live `version.txt` marker to `origin/main`; this catches manual or third-party deploy outcomes without a second schedule. |

The post-push flow sends the engine-generated concise email draft to the owner (address kept out of the repo; set in the environment) through the existing authorized Gmail reporting path. The weekly task includes the same reconciliation in its report and sends the weekly email through that same reporting path. No GitHub Actions credentials, Netlify tokens, Amazon credentials, or email secrets are committed.

### Strict auto-remediation policy

The engine never weakens a gate, lowers a threshold, changes credentials, spends money, or manufactures data. It caps approved automatic remediation at **two attempts**. Approved actions are limited to committing a locally present referenced module; unlinking an exact confirmed dead/unavailable ASIN; rerunning the safe Creators API catalog sync to null an offer price with no current offer or reserialize product data; and verified display-label corrections after a full official catalog identity match. Ambiguous SKU swaps, threshold/gate changes, unavailable credentials, recurring failures, and all unverifiable claims are escalated with the exact log excerpt and recommended next action.

The engine path is `tools/deploy_confirmation_remediation.py`. Its JSON output always includes an `email_draft` for the owner (address kept out of the repo; set in the environment), expected commit, live marker, green/blocked state, automatic actions, and escalation status.
