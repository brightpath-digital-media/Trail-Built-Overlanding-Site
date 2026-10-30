#!/usr/bin/env node
/**
 * Build Trail Built's controlled product pool from every current direct-ASIN site reference.
 *
 * Default mode performs static extraction only and marks entries pending-verification.
 * Add --verify in an environment with Creators API credentials to confirm each ASIN via
 * the official catalog, with the same paced and retrying lookup client used by generation.
 * Inconclusive API evidence remains pending; it is never labelled dead by this builder.
 *
 * The pool is merged with the committed data/verified-products.json instead of being rebuilt
 * from nothing, so evidence from earlier real checks survives a lookup outage:
 *   - LIVE:         last_verified_at = today (UTC), verification_source = 'creators_api',
 *                   amazon_title refreshed (image_url too, run-local only).
 *   - INCONCLUSIVE: prior last_verified_at / verification_source / amazon_title untouched;
 *                   never erased and never extended.
 *   - delisted_at is carried forward as is (only the page recheck sets or clears it).
 *   - Carried evidence is validated first (real calendar date, known source, local image path);
 *     an invalid field is dropped, never believed.
 *   - ASINs no longer referenced on the site are dropped.
 * verification_status keeps its meaning: 'verified' only for a LIVE result in this run.
 *
 * --persist (separate step, after generation) rewrites the working-tree file into its
 * committable form, but only when this run produced at least one LIVE result: every
 * status goes back to pending-verification and run-local fields (image_url,
 * verification_note) are removed, so a committed file never claims a status no run proved.
 * It prints persist=1 or persist=0 as its last line for the workflow to act on.
 *
 * --run-report <file> (with --verify) writes counts of LIVE and failed lookups by failure
 * kind (see scripts/lookup-outage.js). The generator classifies the run from it.
 *
 * generated_at changes only when the committable content changes, so a rewrite with
 * nothing new produces a byte-identical file.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAsinVerifier, getCreatorsCredentials } = require('./asin-verification.js');
const { buildRunReport, writeRunReport } = require('./lookup-outage.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXTRACTOR = path.join(REPO_ROOT, 'tools', 'validate_asins.py');
const OUTPUT_FILE = path.join(REPO_ROOT, 'data', 'verified-products.json');
const AFFILIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || 'trailbuiltove-20';
const VERIFY = process.argv.includes('--verify');
const PERSIST = process.argv.includes('--persist');
// --run-report <file>: write the credential-free lookup summary the evidence-tier loader reads.
const RUN_REPORT_FLAG = process.argv.indexOf('--run-report');
const RUN_REPORT_FILE = RUN_REPORT_FLAG !== -1 ? process.argv[RUN_REPORT_FLAG + 1] : '';
const STATIC_VERIFICATION_MODE = 'pending verification; weekly precheck verifies at runtime';
// Evidence from earlier real checks, carried across rebuilds. Order is the output order.
const EVIDENCE_FIELDS = ['verification_source', 'last_verified_at', 'amazon_title', 'delisted_at', 'image_local_path'];
// Fields that exist only inside one run and are never committed.
const RUN_LOCAL_FIELDS = ['image_url', 'verification_note'];
const STOP_WORDS = new Set([
  'a', 'all', 'and', 'best', 'built', 'check', 'for', 'from', 'gear', 'guide', 'in',
  'kit', 'of', 'on', 'overlanding', 'price', 'review', 'the', 'to', 'trail', 'with',
]);

function slugWords(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function cleanTags(...values) {
  return [...new Set(values.flatMap(slugWords).filter(word => word.length > 1 && !STOP_WORDS.has(word)))].slice(0, 10);
}

function categoryFor(record) {
  const file = record.file || '';
  if (file.startsWith('categories/')) {
    return path.basename(file, '.html').replace(/-/g, ' ');
  }
  if (file.startsWith('articles/')) {
    return path.basename(file, '.html').replace(/-/g, ' ');
  }
  return 'overlanding gear';
}

function chooseName(records) {
  return [...records]
    .map(record => record.product.trim())
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

function runStaticExtractor() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trail-built-pool-'));
  const reportFile = path.join(tempDir, 'asin-static-report.json');
  try {
    execFileSync(process.env.PYTHON || 'python3', [EXTRACTOR, '--static-only', '--output', reportFile], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    return JSON.parse(readFileSync(reportFile, 'utf8'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildSeedProducts(records) {
  const grouped = new Map();
  for (const record of records) {
    if (record.destination_type !== 'asin' || !/^[A-Z0-9]{10}$/.test(record.asin || '')) continue;
    if (!grouped.has(record.asin)) grouped.set(record.asin, []);
    grouped.get(record.asin).push(record);
  }

  return [...grouped.entries()]
    .map(([asin, sources]) => {
      const name = chooseName(sources);
      const categories = [...new Set(sources.map(categoryFor))].sort();
      return {
        asin,
        name,
        category: categories[0] || 'overlanding gear',
        tags: cleanTags(name, ...categories),
        affiliate_url: `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`,
        verification_status: 'pending-verification',
        sources: [...new Set(sources.map(source => source.file))].sort(),
      };
    })
    .sort((a, b) => a.asin.localeCompare(b.asin));
}

function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function readPool(file) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const products = Array.isArray(parsed) ? parsed : parsed.products;
  if (!Array.isArray(products)) throw new Error(`Pool file has no products array: ${file}`);
  return { document: Array.isArray(parsed) ? {} : parsed, products };
}

/** Verify every product with the injected verifier; returns Map<asin, result>. Never mutates products. */
async function verifyProducts(products, verifier, log = console.log) {
  const results = new Map();
  for (let index = 0; index < products.length; index++) {
    const product = products[index];
    const result = await verifier.verifyAsin(product.asin);
    results.set(product.asin, result);
    log(`[verified-pool] ${index + 1}/${products.length} ${product.asin}: ${result.status === 'LIVE' ? 'verified' : 'pending-verification'}`);
  }
  return results;
}

const KNOWN_SOURCES = new Set(['creators_api', 'published-history', 'page-recheck']);

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is rejected). */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The evidence fields of a committed entry that are safe to carry forward. Evidence is
 * all-or-nothing: a date needs a known source and a source needs a real date, so a
 * hand-edited or corrupted entry loses its evidence instead of being believed.
 * delisted_at, amazon_title and image_local_path are checked on their own.
 */
function validEvidence(before) {
  const out = {};
  if (isCalendarDate(before.last_verified_at) && KNOWN_SOURCES.has(before.verification_source)) {
    out.verification_source = before.verification_source;
    out.last_verified_at = before.last_verified_at;
  }
  if (typeof before.amazon_title === 'string' && before.amazon_title.trim() && before.amazon_title.length <= 500) {
    out.amazon_title = before.amazon_title;
  }
  if (isCalendarDate(before.delisted_at)) out.delisted_at = before.delisted_at;
  const image = before.image_local_path;
  if (typeof image === 'string' && image.startsWith('assets/product-images/') && !image.includes('..') && !/[\s\\]/.test(image)) {
    out.image_local_path = image;
  }
  return out;
}

/**
 * Merge the freshly extracted seed with prior committed evidence and (optionally) this run's
 * lookup results. Pure: no I/O. Output is sorted by ASIN with a fixed key order.
 */
function mergeProducts({ seedProducts, priorProducts = [], results = null, today }) {
  const prior = new Map(priorProducts.map(product => [product.asin, product]));
  return [...seedProducts]
    .sort((a, b) => a.asin.localeCompare(b.asin))
    .map(seed => {
      const before = prior.get(seed.asin) || {};
      const merged = {
        asin: seed.asin,
        name: seed.name,
        category: seed.category,
        tags: seed.tags,
        affiliate_url: seed.affiliate_url,
        verification_status: 'pending-verification',
        sources: seed.sources,
      };
      Object.assign(merged, validEvidence(before));
      const result = results && results.get(seed.asin);
      if (result && result.status === 'LIVE') {
        merged.verification_status = 'verified';
        merged.verification_source = 'creators_api';
        merged.last_verified_at = today;
        if (result.title) merged.amazon_title = result.title;
        if (result.image_url) merged.image_url = result.image_url;
      } else if (result) {
        merged.verification_note = result.reason || 'Creators API result was inconclusive';
      }
      return orderKeys(merged);
    });
}

function orderKeys(product) {
  const order = ['asin', 'name', 'category', 'tags', 'affiliate_url', 'verification_status', 'sources', ...EVIDENCE_FIELDS, ...RUN_LOCAL_FIELDS];
  const out = {};
  for (const key of order) if (product[key] !== undefined) out[key] = product[key];
  for (const key of Object.keys(product)) if (!(key in out)) out[key] = product[key];
  return out;
}

/** The committable form of one product: pending status, no run-local fields. */
function persistedProduct(product) {
  const out = { ...product, verification_status: 'pending-verification' };
  for (const field of RUN_LOCAL_FIELDS) delete out[field];
  return orderKeys(out);
}

function persistedProducts(products) {
  return products.map(persistedProduct).sort((a, b) => a.asin.localeCompare(b.asin));
}

/** Keep the previous generated_at unless the committable content changed. */
function chooseGeneratedAt({ priorDocument, priorProducts, nextProducts, now }) {
  const unchanged = priorDocument && priorDocument.generated_at
    && JSON.stringify(persistedProducts(priorProducts || [])) === JSON.stringify(persistedProducts(nextProducts));
  return unchanged ? priorDocument.generated_at : now;
}

function countLive(products) {
  return products.filter(product => (
    product.verification_status === 'verified'
    && product.verification_source === 'creators_api'
    && /^\d{4}-\d{2}-\d{2}$/.test(product.last_verified_at || '')
  )).length;
}

/**
 * Convert the working-tree (run) document to its committable form; null when nothing was LIVE.
 * generated_at follows the committed file unless the committable content differs from it.
 */
function buildPersistedDocument(runDocument, committed = null, now = new Date().toISOString()) {
  if (countLive(runDocument.products) === 0) return null;
  const products = persistedProducts(runDocument.products);
  return {
    schema_version: runDocument.schema_version,
    generated_at: chooseGeneratedAt({
      priorDocument: committed?.document,
      priorProducts: committed?.products,
      nextProducts: products,
      now,
    }),
    source: runDocument.source,
    verification_mode: STATIC_VERIFICATION_MODE,
    products,
  };
}

/** The pool as committed at HEAD (null outside a git checkout or when absent). */
function readCommittedPool(file = OUTPUT_FILE) {
  try {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const text = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(text);
    return { document: parsed, products: parsed.products };
  } catch {
    return null;
  }
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function persistWorkingFile(file = OUTPUT_FILE, committed = readCommittedPool(file), now = new Date().toISOString()) {
  const working = readPool(file);
  if (!working) throw new Error(`--persist: ${file} does not exist.`);
  const persisted = buildPersistedDocument({ ...working.document, products: working.products }, committed, now);
  if (!persisted) {
    console.log('[verified-pool] --persist: no LIVE result in this run; data file left untouched.');
    return false;
  }
  writeFileSync(file, serialize(persisted), 'utf8');
  console.log(`[verified-pool] --persist: wrote ${persisted.products.length} product(s) in committable form (${countLive(working.products)} LIVE this run).`);
  return true;
}

async function main() {
  if (PERSIST) {
    console.log(`persist=${persistWorkingFile() ? 1 : 0}`);
    return;
  }
  if (!existsSync(EXTRACTOR)) throw new Error(`Site extractor not found: ${EXTRACTOR}`);
  const report = runStaticExtractor();
  const seedProducts = buildSeedProducts(report.products || []);
  if (seedProducts.length === 0) throw new Error('No direct ASINs were found in current site references.');

  let results = null;
  if (VERIFY) {
    const credentials = getCreatorsCredentials();
    if (!credentials.clientId || !credentials.clientSecret || !credentials.partnerTag) {
      throw new Error('--verify requires Creators API credentials in environment variables.');
    }
    results = await verifyProducts(seedProducts, createAsinVerifier({ credentials }));
    if (RUN_REPORT_FILE) {
      const report = buildRunReport([...results.values()], { credentials });
      writeRunReport(RUN_REPORT_FILE, report);
      console.log(`[verified-pool] Lookup run: ${report.live} LIVE of ${report.total}; failures ${JSON.stringify(report.failures)}; ${report.classification}.`);
    }
  }

  const prior = readPool(OUTPUT_FILE);
  const products = mergeProducts({ seedProducts, priorProducts: prior?.products, results, today: utcDate() });
  const live = results ? [...results.values()].filter(result => result.status === 'LIVE').length : 0;

  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const payload = {
    schema_version: 1,
    generated_at: chooseGeneratedAt({
      priorDocument: prior?.document,
      priorProducts: prior?.products,
      nextProducts: products,
      now: new Date().toISOString(),
    }),
    source: 'tools/validate_asins.py --static-only site-wide direct-ASIN extraction',
    verification_mode: VERIFY ? 'Creators API verification requested' : STATIC_VERIFICATION_MODE,
    products,
  };
  writeFileSync(OUTPUT_FILE, serialize(payload), 'utf8');
  console.log(`[verified-pool] Wrote ${products.length} product(s) to ${path.relative(REPO_ROOT, OUTPUT_FILE)}.`);
  if (results) console.log(`[verified-pool] Tier 1 summary: ${live} LIVE, ${results.size - live} inconclusive of ${results.size}.`);
}

export {
  KNOWN_SOURCES,
  buildPersistedDocument,
  isCalendarDate,
  validEvidence,
  chooseGeneratedAt,
  countLive,
  mergeProducts,
  persistWorkingFile,
  persistedProducts,
  verifyProducts,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[verified-pool] ${error.message}`);
    process.exit(1);
  });
}
