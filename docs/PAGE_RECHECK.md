# Monthly public-page recheck (runbook)

Written for someone with no prior context. Read it top to bottom once; the steps are short.

## Why this exists

Trail Built recommends products by exact Amazon ASIN. Articles make no price, stock, rating or review-count claim, so nothing at publish time tells us that Amazon has removed a product. This monthly check is how a removed or replaced product is caught. A person (or a browser-capable agent) opens each product's public Amazon page and records what they see. The repository then remembers the result in `data/verified-products.json`.

It protects against one thing: recommending a product that is gone. It is not a price check and records no price.

## Do not automate this from CI (read this)

**Do not automate this check from GitHub Actions or any script that fetches `amazon.com`.** Amazon serves CAPTCHAs and bot walls to automated requests. A script cannot tell a CAPTCHA page from a real answer, and an automated check that "passes" on a bot-wall page is worse than no check. The two scripts below never touch the network: one lists what to check, the other writes down what a human saw.

Also do not run `tools/validate_asins.py` without `--static-only` for this purpose; it makes network calls and hangs.

## The monthly routine

Do this once a month, or whenever someone asks for a recheck.

1. **Get the checklist** (offline, from a checkout of the repository):

   ```bash
   node scripts/page-recheck-plan.mjs --out recheck-plan.json
   ```

   Add `--limit 25` to do a batch at a time. The list is ordered oldest evidence first. A product is due when it has no evidence date, or its evidence date (`last_verified_at`) is more than 30 days old. The first run will list nearly everything; that is expected.

2. **Check each product.** For every item in `items`, open its `url` in a normal browser (not logged in is fine; do not use a script). The URL is the plain public page without our affiliate tag, so checking earns and costs nothing. Decide one outcome:

   - **pass** only if ALL three are true:
     1. the page title shares at least 35 percent of the significant words of the pool `name` (the rule in `CONTENT_RULES.md`, Rule 2). The checklist gives `name_words` and `min_words_to_match`; count how many of those words appear in the page title;
     2. a buying-options area shows (Add to Cart, Buy Now or See All Buying Options);
     3. no CAPTCHA, robot check, sign-in wall or error page appeared.
   - **fail-delisted** only if the page loaded normally (no CAPTCHA) and shows the product is gone: Amazon's page-not-found page, a "Currently unavailable" or "no longer available" notice with no buying options, or a title that clearly no longer matches the pool name. You must write a note saying exactly what you saw (at least 10 characters). This flag is reversible: a later pass clears it.
   - **inconclusive** for everything else: a CAPTCHA or robot check, any HTTP error or timeout from a tool (403, 429, 5xx, any non-200), a blank or minimal page, a sign-in wall, or any doubt at all. Never guess. If a CAPTCHA appears, stop for the day (see the CAPTCHA rule below).

   **CAPTCHA rule.** A CAPTCHA or robot check is NEVER solved or bypassed, by a person's tool, script, extension or agent. No CAPTCHA-solving services, no proxies or IP rotation, no stealth or fingerprint-spoofing browsers, no retry loops. Record the product as inconclusive and stop for the day.

3. **Write the results file** (any name, for example `recheck-results.json`):

   ```json
   {
     "checked_at": "2026-11-02",
     "results": [
       { "asin": "B0XXXXXXXX", "outcome": "pass", "note": "title matches, Add to Cart shown" },
       { "asin": "B0YYYYYYYY", "outcome": "fail-delisted", "note": "Amazon page-not-found page shown" },
       { "asin": "B0ZZZZZZZZ", "outcome": "inconclusive", "note": "CAPTCHA" }
     ]
   }
   ```

   `checked_at` is the date of the check (not in the future). Use only ASINs from the checklist.

4. **Preview, then apply** (offline):

   ```bash
   node scripts/apply-page-recheck.mjs recheck-results.json          # dry run, prints what would change
   node scripts/apply-page-recheck.mjs recheck-results.json --write  # changes data/verified-products.json
   ```

   One invalid entry (unknown ASIN, duplicate, bad outcome, fail-delisted without a note, a future date) rejects the whole file and changes nothing. Fix the file and run again.

5. **Keep the evidence.** Attach the results file to the pull request, or commit it under `reports/page-recheck/` (for example `reports/page-recheck/2026-11-02.json`). The data file records the outcome but not the notes, so the results file is the only record of what was seen.

6. **Commit the change to `data/verified-products.json`** on a branch and open a pull request, as for any change to that file. Do not push to `main` directly.

## What the data file records

| Outcome | Effect on the product in `data/verified-products.json` |
| --- | --- |
| pass | `last_verified_at` = the check date, `verification_source` = `page-recheck`. A `delisted_at` flag is cleared if this check is not older than the flag. |
| fail-delisted | `delisted_at` = the check date. The generator never uses a product with `delisted_at`. `last_verified_at` is left alone. |
| inconclusive | **No change.** Printed as "inconclusive: stays due, NOT excluded from articles (hold-out is a follow-up)". The product stays on the next checklist, but nothing stops the generator from using it meanwhile. |

Rules the script enforces: it never sets `verification_status` (only a live Creators API run in CI can mark a product `verified`); it never adds a product; it never moves a date backwards (an older result than the current evidence is skipped as stale); notes are printed in the report but never written to the data file.

## Limits to know

- The first `--write` re-serializes `data/verified-products.json` with standard JSON formatting. Characters that the file currently stores as `\uXXXX` escapes are written as the characters themselves, so the first write shows a one-time diff on those lines (the data is unchanged). Review it, then later writes are quiet.

- In the carry-forward tier proposed in the evidence-tier pull request (off unless Kyle enables it), a `pass` counts only while the product stays within 45 days of `last_verified_at` and has a local image in `assets/product-images/`. The monthly cadence keeps it inside that window.
- Inconclusive products are NOT held out of articles (hold-out is a follow-up). It is by report and checklist only: the data file has no field for it, so an inconclusive product with a still-fresh date remains usable until its date ages out. Enforcing the hold in the generator needs a data-field decision (listed as follow-up in the pull request).
- With no live price lookup, a product that Amazon removes is caught by this monthly check, not at publish time.
