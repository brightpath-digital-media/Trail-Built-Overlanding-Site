# Content Generation Rules — Trail Built Overland

**Version:** 1.1 | **Effective:** 2026-08-07 | **Applies to:** All buyer's guides and product reviews

These rules are mandatory for any AI-assisted or human content generation on this site.
They exist to prevent phantom part numbers, wrong affiliate links, and product mismatches
from reaching readers.

---

## Rule 1: Part Numbers and Model Numbers Must Come from a Real Catalog Lookup

**Never state a specific model number, part number, or SKU in an article unless it was retrieved from a verified source.**

Acceptable sources (in order of preference):
1. Amazon Creators API — the system of record (see setup below)
2. The manufacturer's official product catalog page (URL must be accessible)
3. A live Amazon product listing (ASIN must be confirmed)

If a specific model number cannot be verified from one of the above sources, use a **generic descriptor** instead.

| ✅ Correct | ❌ Incorrect |
|---|---|
| "Warn's VR EVO 10-S winch" (verified ASIN B07SJHVQTJ) | "Warn 703 High-Lift Jack" (phantom — Warn doesn't make jacks) |
| "a high-capacity ARB skid plate" | "ARB RS6614 skid plate" (fabricated part number) |
| "the Smittybilt X2O 10,000 lb winch" (verified) | "Smittybilt 76899 skid plate" (wrong ASIN, different product) |

---

## Rule 2: Every Amazon Affiliate Link Must Use a Verified ASIN

Before adding or updating a `data-asin` attribute or `href` to an Amazon product:

1. **Look up the ASIN** using `tools/asin_lookup.py`:
   ```bash
   python3 tools/asin_lookup.py B07SJHVQTJ "Warn VR EVO 10-S Winch"
   ```
2. **Confirm the Amazon title fuzzy-matches** the product name in the article (≥35% word overlap)
3. **If no ASIN can be verified**, leave `data-asin=""` and `href=""` — do not use a placeholder ASIN

**Never reuse an ASIN from another product as a placeholder.** A wrong ASIN sends readers to the wrong product and earns commission on a product you didn't recommend.

---

## Rule 3: Pre-Publish Validation Is Mandatory

The Netlify build runs `tools/validate_asins.py` automatically. This script:
- Scans every product box in every buyer's guide
- Verifies each ASIN resolves to a live Amazon listing
- Checks that the Amazon title matches the product name
- **Blocks the deploy** if any product fails

To add a product with no Amazon listing (e.g., ARB direct-only products), add its name to the `KNOWN_BLANK_ASINS` set in `tools/validate_asins.py` so the gate skips it intentionally.

To run validation manually before pushing:
```bash
python3 tools/validate_asins.py --warn-only
```

---

## Rule 4: Weekly Health-Check Monitors All Three Sites

Every Monday at 8:00 AM PT, an automated health-check runs across:
- trailbuiltoverland.com
- silkierstrands.com
- pauseandflourish.com

It re-validates every ASIN for delistings, title changes, and mismatches, and emails a report to **the owner (address kept out of the repo; set in the environment)**. If you receive a health-check email with failures, fix them before the next publish cycle.

---

## Rule 5: Product Name Format in HTML

When writing a product box, the `data-product` attribute and `<h4>` heading must match:

```html
<!-- ✅ Correct -->
<div class="product-box" data-product="Warn VR EVO 10-S Winch" data-asin="B07SJHVQTJ">
  <h4>Warn VR EVO 10-S Winch</h4>

<!-- ❌ Incorrect — data-product and h4 disagree -->
<div class="product-box" data-product="Warn 703" data-asin="B0B4V6H9C2">
  <h4>Warn 703 High-Lift Jack</h4>
```

---

## Quick Reference: ASIN Validation Commands

```bash
# Verify a single ASIN
python3 tools/asin_lookup.py B07SJHVQTJ "Warn VR EVO 10-S Winch"

# Validate all articles (warn-only, won't block)
python3 tools/validate_asins.py --warn-only

# Validate a single article
python3 tools/validate_asins.py --article articles/best-overlanding-winches.html

# Run the weekly health-check manually (dry run, no email)
python3 tools/weekly_asin_healthcheck.py --dry-run
```

---

## Amazon Creators API Setup (One-Time, Enables Reliable Validation)

The guardrail uses the **Amazon Creators API** (OAuth 2.0 via Login with Amazon).
This replaced the deprecated PA-API 5.0 in 2026.

### Credential Portal
https://affiliate-program.amazon.com/creatorsapi

### Steps
1. Sign in to Associates Central and navigate to the Creators API portal above
2. Create an application — you will receive a **Client ID** and **Client Secret**
3. Set these environment variables in **each site's Netlify dashboard**
   (Site settings → Environment variables) and in the Manus scheduled task:

| Environment Variable | Value | Where to set |
|---|---|---|
| `CREATORS_API_CLIENT_ID` | Your Creators API client ID | Netlify (all 3 sites) + Manus task |
| `CREATORS_API_CLIENT_SECRET` | Your Creators API client secret | Netlify (all 3 sites) + Manus task |
| `CREATORS_API_PARTNER_TAG` | `trailbuiltove-20` (TrailBuilt) | Netlify TrailBuilt |
| `CREATORS_API_PARTNER_TAG` | `silkierstrands-20` (SilkierStrands) | Netlify SilkierStrands |
| `CREATORS_API_PARTNER_TAG` | `pauseandflourish-20` (PauseAndFlourish) | Netlify PauseAndFlourish |

### Auth Flow (for reference)
- **Token endpoint:** `https://api.amazon.com/auth/o2/token`
- **Grant type:** `client_credentials`
- **Scope:** `creatorsapi::default`
- **API endpoint:** `https://creatorsapi.amazon/catalog/v1/getItems`
- **Auth header:** `Authorization: Bearer <access_token>`

Without Creators API credentials, validation falls back to public Amazon page scraping
(works but may occasionally hit Amazon's bot-check on cloud build IPs).

### Prerequisite
Your Associates account must have ≥10 qualifying sales in the trailing 30 days to
access the Creators API. This is an ongoing requirement.

## Rule 6: Customer Ratings and Amazon Merchandising Claims

**Do not display, publish, or place in structured data any numeric Amazon star rating or Amazon review count unless the exact value was retrieved from a supported current catalog response and stored with its retrieval timestamp.** Static source values, estimates, copied listing text, and manually entered values are not acceptable sources. When a current verifiable source is unavailable, omit the rating rather than approximating it. Genuine, approved first-party user reviews remain eligible for `AggregateRating` only under the existing feature-flag and moderation rules.

**Never claim or imply Amazon merchandising designations**, including `Amazon's Choice`, `Amazon Choice`, `Best Seller`, `Best-Seller`, `Bestseller`, or numbered variants such as `#1 Best Seller`. The Amazon Creators API catalog response does not provide these badges as an approved content source. Do not scrape them, infer them, or restate them in body copy, pros/cons, product cards, metadata, or structured data. Use neutral, independently supportable editorial language instead.

The pre-publish validation gates enforce these restrictions. A prohibited badge phrase or static card-rating renderer is a blocking deployment error.
