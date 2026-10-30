#!/usr/bin/env node
/**
 * List the pool products that are due for the monthly public-page recheck.
 *
 * The recheck is done by a human or a browser-capable agent, NEVER by CI (Amazon bot walls).
 * This script only reads data/verified-products.json and prints a JSON checklist: ASIN,
 * pool name, the plain public product URL (no affiliate tag, so checks earn no clicks), the
 * evidence date, and the exact pass criteria. Oldest evidence first; products with no
 * evidence at all come first. Results go back through scripts/apply-page-recheck.mjs.
 *
 * Usage: node scripts/page-recheck-plan.mjs [--pool file] [--today YYYY-MM-DD]
 *        [--max-age-days 30] [--limit N] [--out file]
 * See docs/PAGE_RECHECK.md.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POOL = path.join(__dirname, '..', 'data', 'verified-products.json');
const DEFAULT_MAX_AGE_DAYS = 30;
const MIN_OVERLAP = 0.35;

// Same stop words as tools/asin_lookup.py, so a human counts the way the repository does.
const STOP_WORDS = new Set(['a', 'an', 'the', 'for', 'and', 'or', 'in', 'on', 'of', 'to', 'with', 'lb', 'lbs', 'by', 'at', 'from', 'shop', 'check', 'view', 'buy', 'price', 'amazon']);

const PASS_CRITERIA = [
  'Open the product URL in a normal browser window (no login, no extension that clicks for you). Record PASS only when ALL three hold:',
  '1. TITLE MATCH: the page title shares at least 35 percent of the significant words of the pool name (CONTENT_RULES.md, Rule 2). Count the words listed in name_words that appear in the page title; you need at least min_words_to_match of them.',
  '2. BUYING OPTIONS: a buying-options area shows (an Add to Cart, Buy Now or See All Buying Options control).',
  '3. NO CAPTCHA: no CAPTCHA, robot check, sign-in wall or error page was shown while loading it.',
  'Record FAIL-DELISTED only when the page loaded normally (no CAPTCHA) and shows that the product is gone: Amazon\'s page-not-found page, a "Currently unavailable" or "no longer available" notice with no buying options, or a title that clearly no longer matches the pool name. Put exactly what you saw in the note.',
  'Record INCONCLUSIVE for anything else: CAPTCHA or robot check, any HTTP error or timeout from a tool (403, 429, 5xx, any non-200), a blank or minimal page, a sign-in wall, or any doubt. Never guess. An inconclusive product changes nothing and stays on the due list.',
].join('\n');

function significantWords(name) {
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

function dayNumber(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) return NaN;
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(time) ? Math.floor(time / 86400000) : NaN;
}

function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Pure planner. A product is due when it has no evidence date, or its evidence date
 * (last_verified_at, which a page-recheck pass also sets) is more than maxAgeDays old.
 */
function buildPlan({ products, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS, limit = 0 }) {
  const todayNumber = dayNumber(today);
  if (!Number.isFinite(todayNumber)) throw new Error(`Invalid --today date: ${today}`);
  const due = [];
  for (const product of products) {
    if (!/^[A-Z0-9]{10}$/.test(product.asin || '') || !product.name) continue;
    const evidenceNumber = dayNumber(product.last_verified_at);
    const age = Number.isFinite(evidenceNumber) ? todayNumber - evidenceNumber : null;
    // A date in the future is not evidence of anything; treat it as unknown and recheck.
    if (age !== null && age >= 0 && age <= maxAgeDays) continue;
    const words = significantWords(product.name);
    due.push({
      asin: product.asin,
      name: product.name,
      url: `https://www.amazon.com/dp/${product.asin}`,
      last_verified_at: age !== null && age >= 0 ? product.last_verified_at : null,
      verification_source: product.verification_source || null,
      days_since_evidence: age !== null && age >= 0 ? age : null,
      currently_flagged_delisted: Boolean(product.delisted_at),
      name_words: words,
      min_words_to_match: Math.ceil(MIN_OVERLAP * words.length),
    });
  }
  due.sort((a, b) => (b.days_since_evidence ?? Infinity) - (a.days_since_evidence ?? Infinity) || a.asin.localeCompare(b.asin));
  const items = limit > 0 ? due.slice(0, limit) : due;
  return {
    schema_version: 1,
    planned_for: today,
    max_age_days: maxAgeDays,
    due_total: due.length,
    count: items.length,
    do_not_automate: 'Never run this check from CI or a script that fetches amazon.com. A person or a browser-capable agent opens each URL.',
    pass_criteria: PASS_CRITERIA,
    results_file_format: {
      checked_at: 'ISO date or datetime of the check (UTC date is used), not in the future',
      results: [{ asin: 'B0XXXXXXXX', outcome: 'pass | fail-delisted | inconclusive', note: 'what you saw; required for fail-delisted' }],
    },
    items,
  };
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function main(args = process.argv.slice(2)) {
  const poolFile = option(args, '--pool', DEFAULT_POOL);
  const parsed = JSON.parse(readFileSync(poolFile, 'utf8'));
  const products = Array.isArray(parsed) ? parsed : parsed.products;
  const plan = buildPlan({
    products,
    today: option(args, '--today', utcToday()),
    maxAgeDays: Number(option(args, '--max-age-days', DEFAULT_MAX_AGE_DAYS)),
    limit: Number(option(args, '--limit', 0)),
  });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  const out = option(args, '--out', '');
  if (out) {
    writeFileSync(out, text, 'utf8');
    console.error(`[page-recheck] ${plan.count} of ${plan.due_total} due product(s) written to ${out}.`);
  } else {
    process.stdout.write(text);
  }
}

export { DEFAULT_MAX_AGE_DAYS, PASS_CRITERIA, buildPlan, dayNumber, significantWords, utcToday };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[page-recheck] ${error.message}`);
    process.exit(1);
  }
}
