#!/usr/bin/env node
/**
 * Apply the results of a monthly public-page recheck to data/verified-products.json.
 *
 * Input: { checked_at, results: [{ asin, outcome: 'pass' | 'fail-delisted' | 'inconclusive', note }] }
 * produced by a person or browser agent following docs/PAGE_RECHECK.md (never by CI).
 *
 *   pass          last_verified_at = checked_at (UTC date), verification_source = 'page-recheck'.
 *                 Clears delisted_at when this check is not older than the flag (the product is back).
 *   fail-delisted delisted_at = checked_at date (the earlier date is kept if already flagged).
 *                 last_verified_at is left alone: history is never rewritten.
 *   inconclusive  no change at all. Reported as "inconclusive: stays due, NOT excluded from
 *                 articles (hold-out is a follow-up)": the product stays on the due list in
 *                 page-recheck-plan.mjs, but nothing stops the generator from using it.
 *
 * This script never sets verification_status (a page check is not a Tier 1 lookup), never adds a
 * product, and never moves an evidence date backwards: a result older than the product's current
 * evidence is skipped as stale. All input is validated before anything is written; one bad entry
 * rejects the whole file. Dry run by default; pass --write to modify the pool file.
 *
 * Usage: node scripts/apply-page-recheck.mjs results.json [--pool file] [--write] [--today YYYY-MM-DD]
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orderKeys } from './build-verified-pool.mjs';
import { dayNumber, utcToday } from './page-recheck-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POOL = path.join(__dirname, '..', 'data', 'verified-products.json');
const OUTCOMES = new Set(['pass', 'fail-delisted', 'inconclusive']);
const MAX_NOTE_CHARS = 300;

function cleanNote(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
}

/**
 * UTC YYYY-MM-DD of an ISO date or datetime, or '' when it is not one. Impossible calendar
 * dates (2026-02-30) are rejected rather than rolled over.
 */
function checkDate(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match || !Number.isFinite(dayNumber(match[1]))) return '';
  const time = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

/** Validate the results file; returns { date, entries } or throws with every problem listed. */
function validateResults(input, knownAsins, today) {
  const problems = [];
  const date = checkDate(input?.checked_at);
  if (!date) problems.push('checked_at must be an ISO date or datetime');
  else if (dayNumber(date) > dayNumber(today)) problems.push(`checked_at ${date} is in the future`);
  if (!Array.isArray(input?.results) || input.results.length === 0) problems.push('results must be a non-empty array');
  const seen = new Set();
  const entries = [];
  for (const [index, result] of (Array.isArray(input?.results) ? input.results : []).entries()) {
    const label = `results[${index}]`;
    const asin = result?.asin;
    if (!/^[A-Z0-9]{10}$/.test(asin || '')) { problems.push(`${label}: invalid ASIN ${JSON.stringify(asin)}`); continue; }
    if (!knownAsins.has(asin)) problems.push(`${label}: ${asin} is not in the pool (this script never adds products)`);
    if (seen.has(asin)) problems.push(`${label}: duplicate ASIN ${asin}`);
    seen.add(asin);
    if (!OUTCOMES.has(result.outcome)) problems.push(`${label}: outcome must be pass, fail-delisted or inconclusive (got ${JSON.stringify(result.outcome)})`);
    const note = cleanNote(result.note);
    if (result.outcome === 'fail-delisted' && note.length < 10) problems.push(`${label}: fail-delisted needs a note saying exactly what the page showed`);
    entries.push({ asin, outcome: result.outcome, note });
  }
  if (problems.length > 0) throw new Error(`Results file rejected, nothing applied:\n- ${problems.join('\n- ')}`);
  return { date, entries };
}

/**
 * Pure: apply validated results to a pool document. Returns { document, changed, report }.
 * The input document is not mutated.
 */
function applyResults({ document, input, today, now = new Date().toISOString() }) {
  const products = Array.isArray(document) ? document : document.products;
  const byAsin = new Map(products.map(product => [product.asin, product]));
  const { date, entries } = validateResults(input, new Set(byAsin.keys()), today);
  const next = new Map(products.map(product => [product.asin, { ...product }]));
  const report = { checked_at: date, passed: [], cleared_delisted: [], delisted: [], inconclusive: [], skipped: [] };
  let changed = false;

  for (const { asin, outcome, note } of entries) {
    const product = next.get(asin);
    const name = product.name;
    const evidence = product.last_verified_at;
    if (outcome === 'inconclusive') {
      report.inconclusive.push({ asin, name, note });
      continue;
    }
    // Never move evidence backwards: an older result cannot override a newer one.
    if (evidence && dayNumber(date) < dayNumber(evidence)) {
      report.skipped.push({ asin, name, reason: `stale: result ${date} is older than current evidence ${evidence}` });
      continue;
    }
    if (outcome === 'pass') {
      if (product.delisted_at && dayNumber(date) < dayNumber(product.delisted_at)) {
        report.skipped.push({ asin, name, reason: `stale: result ${date} is older than the delisted flag ${product.delisted_at}` });
        continue;
      }
      if (product.last_verified_at !== date || product.verification_source !== 'page-recheck') changed = true;
      product.last_verified_at = date;
      product.verification_source = 'page-recheck';
      if (product.delisted_at) {
        delete product.delisted_at;
        changed = true;
        report.cleared_delisted.push({ asin, name });
      }
      report.passed.push({ asin, name });
    } else {
      if (!product.delisted_at || dayNumber(date) < dayNumber(product.delisted_at)) {
        product.delisted_at = date;
        changed = true;
      }
      report.delisted.push({ asin, name, note });
    }
  }

  const nextProducts = products.map(product => orderKeys(next.get(product.asin)));
  const nextDocument = Array.isArray(document) ? nextProducts : { ...document, products: nextProducts };
  if (changed && !Array.isArray(document)) nextDocument.generated_at = now;
  return { document: nextDocument, changed, report };
}

/** Temp file in the same directory, then rename: a crash never leaves a half-written pool. */
function writeAtomically(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function printReport(report, write) {
  const line = (label, items) => console.log(`[page-recheck] ${label}: ${items.length}${items.length ? ` (${items.map(item => item.asin).join(', ')})` : ''}`);
  console.log(`[page-recheck] checked_at ${report.checked_at}${write ? '' : ' (dry run, pass --write to apply)'}`);
  line('pass', report.passed);
  line('delisted flag cleared', report.cleared_delisted);
  line('fail-delisted', report.delisted);
  line('inconclusive: stays due, NOT excluded from articles (hold-out is a follow-up)', report.inconclusive);
  line('skipped', report.skipped);
  for (const item of report.inconclusive) console.log(`  inconclusive ${item.asin} ${item.name}: ${item.note || 'no note'}`);
  for (const item of report.skipped) console.log(`  skipped ${item.asin}: ${item.reason}`);
}

function main(args = process.argv.slice(2)) {
  const valued = new Set(['--pool', '--today']);
  const resultsFile = args.find((arg, index) => !arg.startsWith('--') && !valued.has(args[index - 1]));
  if (!resultsFile) throw new Error('Usage: apply-page-recheck.mjs results.json [--pool file] [--write] [--today YYYY-MM-DD]');
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const poolFile = option('--pool', DEFAULT_POOL);
  const write = args.includes('--write');
  const document = JSON.parse(readFileSync(poolFile, 'utf8'));
  const input = JSON.parse(readFileSync(resultsFile, 'utf8'));
  const today = option('--today', utcToday());
  if (!Number.isFinite(dayNumber(today))) throw new Error(`Invalid --today date: ${today}`);
  const outcome = applyResults({ document, input, today });
  printReport(outcome.report, write);
  if (write && outcome.changed) {
    writeAtomically(poolFile, `${JSON.stringify(outcome.document, null, 2)}\n`);
    console.log(`[page-recheck] Updated ${path.relative(process.cwd(), poolFile)}.`);
  } else if (write) {
    console.log('[page-recheck] No change to the pool file.');
  }
  return outcome;
}

export { applyResults, checkDate, validateResults, writeAtomically };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[page-recheck] ${error.message}`);
    process.exit(1);
  }
}
