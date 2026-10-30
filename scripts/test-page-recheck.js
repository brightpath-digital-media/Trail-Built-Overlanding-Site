#!/usr/bin/env node
/**
 * Offline tests for the monthly public-page recheck plumbing:
 * scripts/page-recheck-plan.mjs and scripts/apply-page-recheck.mjs.
 * Fixtures only; nothing here, or in those scripts, contacts amazon.com.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { filterPoolForTopic } = require('./generate-article');

const TODAY = '2026-10-30';
const ROOT = path.join(__dirname, '..');

const product = (asin, extra = {}) => ({
  asin,
  name: `Fixture Product ${asin}`,
  category: 'test',
  tags: ['fixture'],
  affiliate_url: `https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20`,
  verification_status: 'pending-verification',
  sources: ['articles/test.html'],
  ...extra,
});

const poolDocument = () => ({
  schema_version: 1,
  generated_at: '2026-10-20T00:00:00.000Z',
  source: 'fixture',
  verification_mode: 'pending verification; weekly precheck verifies at runtime',
  products: [
    product('B0NEVER001'),
    product('B0OLDONE01', { verification_source: 'creators_api', last_verified_at: '2026-09-01', amazon_title: 'Old Title' }),
    product('B0EDGE3001', { verification_source: 'creators_api', last_verified_at: '2026-09-30' }), // age 30: not due
    product('B0EDGE3101', { verification_source: 'creators_api', last_verified_at: '2026-09-29' }), // age 31: due
    product('B0FRESH001', { verification_source: 'page-recheck', last_verified_at: '2026-10-25' }),
    product('B0FUTURE01', { verification_source: 'creators_api', last_verified_at: '2026-12-01' }),
    product('B0FLAGGED1', { verification_source: 'creators_api', last_verified_at: '2026-08-01', delisted_at: '2026-08-15' }),
  ],
});

function testPlan(plan) {
  const { buildPlan, significantWords, PASS_CRITERIA } = plan;
  const result = buildPlan({ products: [...poolDocument().products, { asin: 'bad', name: 'x' }], today: TODAY });
  const asins = result.items.map(item => item.asin);
  // Oldest evidence first; missing or future-dated evidence counts as oldest; ties by ASIN.
  assert.deepStrictEqual(asins, ['B0FUTURE01', 'B0NEVER001', 'B0FLAGGED1', 'B0OLDONE01', 'B0EDGE3101']);
  assert.ok(!asins.includes('B0EDGE3001'), 'exactly 30 days old is not yet due');
  assert.ok(!asins.includes('B0FRESH001'));
  assert.strictEqual(result.due_total, 5);
  assert.strictEqual(buildPlan({ products: poolDocument().products, today: TODAY, limit: 2 }).count, 2);
  assert.strictEqual(buildPlan({ products: poolDocument().products, today: TODAY, limit: 2 }).due_total, 5);

  const flagged = result.items.find(item => item.asin === 'B0FLAGGED1');
  assert.strictEqual(flagged.currently_flagged_delisted, true);
  assert.strictEqual(flagged.days_since_evidence, 90);
  for (const item of result.items) {
    // Plain public page: no affiliate tag, so a check never earns or costs a click.
    assert.strictEqual(item.url, `https://www.amazon.com/dp/${item.asin}`);
    assert.ok(!/tag=|trailbuiltove/.test(item.url));
    assert.strictEqual(item.min_words_to_match, Math.ceil(0.35 * item.name_words.length));
  }
  assert.deepStrictEqual(significantWords('The Hi-Lift Jack 48 HL-484 for the trail'), ['hi', 'lift', 'jack', '48', 'hl', '484', 'trail']);

  // The exact pass criteria are part of the checklist.
  assert.strictEqual(result.pass_criteria, PASS_CRITERIA);
  for (const phrase of ['at least 35 percent', 'buying-options area', 'CAPTCHA', 'INCONCLUSIVE', 'FAIL-DELISTED', 'Never guess']) {
    assert.ok(PASS_CRITERIA.includes(phrase), `criteria must mention ${phrase}`);
  }
  assert.ok(/Never run this check from CI/.test(result.do_not_automate));
  assert.throws(() => buildPlan({ products: [], today: 'nope' }), /Invalid --today/);

  // The planner must not be able to reach the network.
  const source = fs.readFileSync(path.join(__dirname, 'page-recheck-plan.mjs'), 'utf8');
  assert.ok(!/\b(?:fetch\(|node:https?|require\('https?'\)|XMLHttpRequest)/.test(source), 'planner must not make network calls');
}

function testApply(apply, build) {
  const { applyResults } = apply;
  const input = results => ({ checked_at: '2026-10-30', results });
  const base = poolDocument();
  const frozen = JSON.stringify(base);
  const find = (document, asin) => document.products.find(item => item.asin === asin);

  // pass: date and source set, status untouched, never verified.
  const passed = applyResults({ document: base, input: input([{ asin: 'B0OLDONE01', outcome: 'pass', note: 'title match, Add to Cart shown' }]), today: TODAY, now: '2026-10-30T12:00:00.000Z' });
  assert.strictEqual(JSON.stringify(base), frozen, 'the input document must not be mutated');
  assert.strictEqual(find(passed.document, 'B0OLDONE01').last_verified_at, TODAY);
  assert.strictEqual(find(passed.document, 'B0OLDONE01').verification_source, 'page-recheck');
  assert.strictEqual(find(passed.document, 'B0OLDONE01').amazon_title, 'Old Title', 'other evidence is kept');
  assert.strictEqual(find(passed.document, 'B0OLDONE01').verification_status, 'pending-verification');
  assert.strictEqual(passed.document.generated_at, '2026-10-30T12:00:00.000Z');
  assert.ok(passed.document.products.every(item => item.verification_status !== 'verified'));
  // Even a product that is `verified` in a run-local file keeps its status: this script never sets or changes it.
  const runLocal = poolDocument();
  find(runLocal, 'B0OLDONE01').verification_status = 'verified';
  assert.strictEqual(find(applyResults({ document: runLocal, input: input([{ asin: 'B0OLDONE01', outcome: 'pass' }]), today: TODAY }).document, 'B0OLDONE01').verification_status, 'verified');

  // fail-delisted: flag set, evidence date and source untouched.
  const gone = applyResults({ document: base, input: input([{ asin: 'B0OLDONE01', outcome: 'fail-delisted', note: 'Amazon page-not-found page shown' }]), today: TODAY });
  assert.strictEqual(find(gone.document, 'B0OLDONE01').delisted_at, TODAY);
  assert.strictEqual(find(gone.document, 'B0OLDONE01').last_verified_at, '2026-09-01');
  assert.strictEqual(find(gone.document, 'B0OLDONE01').verification_source, 'creators_api');
  assert.strictEqual(gone.report.delisted[0].asin, 'B0OLDONE01');
  // An existing earlier flag date is kept.
  const reflag = applyResults({ document: base, input: input([{ asin: 'B0FLAGGED1', outcome: 'fail-delisted', note: 'Still unavailable, no buying options' }]), today: TODAY });
  assert.strictEqual(find(reflag.document, 'B0FLAGGED1').delisted_at, '2026-08-15');

  // inconclusive: nothing changes, the product is reported as held out.
  const held = applyResults({ document: base, input: input([{ asin: 'B0OLDONE01', outcome: 'inconclusive', note: 'CAPTCHA shown' }, { asin: 'B0NEVER001', outcome: 'inconclusive', note: 'HTTP 503' }]), today: TODAY });
  assert.strictEqual(held.changed, false);
  assert.strictEqual(JSON.stringify(held.document), frozen, 'inconclusive must not change a byte of the pool');
  assert.deepStrictEqual(held.report.held_out.map(item => item.asin), ['B0OLDONE01', 'B0NEVER001']);
  assert.strictEqual(held.document.generated_at, base.generated_at, 'generated_at moves only when content changes');

  // A later pass clears a delisted flag; an older pass cannot.
  const back = applyResults({ document: base, input: input([{ asin: 'B0FLAGGED1', outcome: 'pass' }]), today: TODAY });
  assert.strictEqual(find(back.document, 'B0FLAGGED1').delisted_at, undefined);
  assert.strictEqual(find(back.document, 'B0FLAGGED1').last_verified_at, TODAY);
  assert.deepStrictEqual(back.report.cleared_delisted.map(item => item.asin), ['B0FLAGGED1']);
  const flaggedLater = poolDocument();
  find(flaggedLater, 'B0FLAGGED1').delisted_at = '2026-10-29';
  find(flaggedLater, 'B0FLAGGED1').last_verified_at = '2026-08-01';
  const olderPass = applyResults({ document: flaggedLater, input: { checked_at: '2026-10-20', results: [{ asin: 'B0FLAGGED1', outcome: 'pass' }] }, today: TODAY });
  assert.strictEqual(olderPass.changed, false);
  assert.match(olderPass.report.skipped[0].reason, /older than the delisted flag/);

  // Stale results never move evidence backwards.
  const stale = applyResults({ document: base, input: { checked_at: '2026-10-01', results: [{ asin: 'B0FRESH001', outcome: 'fail-delisted', note: 'page not found, older check' }] }, today: TODAY });
  assert.strictEqual(stale.changed, false);
  assert.match(stale.report.skipped[0].reason, /stale/);
  assert.strictEqual(find(stale.document, 'B0FRESH001').delisted_at, undefined);
  const stalePass = applyResults({ document: base, input: { checked_at: '2026-08-20', results: [{ asin: 'B0OLDONE01', outcome: 'pass' }] }, today: TODAY });
  assert.strictEqual(stalePass.changed, false);
  assert.strictEqual(find(stalePass.document, 'B0OLDONE01').last_verified_at, '2026-09-01');

  // Idempotent: applying the same file twice changes nothing the second time.
  const twice = applyResults({ document: passed.document, input: input([{ asin: 'B0OLDONE01', outcome: 'pass' }]), today: TODAY, now: '2026-10-31T00:00:00.000Z' });
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.document.generated_at, passed.document.generated_at);

  // Datetime with an offset is converted to its UTC date.
  const offset = applyResults({ document: base, input: { checked_at: '2026-10-30T20:00:00-07:00', results: [{ asin: 'B0OLDONE01', outcome: 'pass' }] }, today: '2026-10-31' });
  assert.strictEqual(find(offset.document, 'B0OLDONE01').last_verified_at, '2026-10-31');

  // Notes are sanitized in the report and never stored in the pool.
  const noted = applyResults({ document: base, input: input([{ asin: 'B0OLDONE01', outcome: 'fail-delisted', note: `Page said\u0007 gone\n${'x'.repeat(500)}` }]), today: TODAY });
  assert.ok(noted.report.delisted[0].note.length <= 300 && !/[\u0000-\u001f]/.test(noted.report.delisted[0].note));
  assert.ok(!JSON.stringify(noted.document).includes('Page said'));

  // Validation rejects the whole file, naming every problem.
  const reject = (results, checkedAt = '2026-10-30') => assert.throws(
    () => applyResults({ document: base, input: { checked_at: checkedAt, results }, today: TODAY }), /Results file rejected, nothing applied/);
  reject([{ asin: 'B0UNKNOWN1', outcome: 'pass' }]); // never adds a product
  reject([{ asin: 'B0OLDONE01', outcome: 'pass' }, { asin: 'B0OLDONE01', outcome: 'pass' }]);
  reject([{ asin: 'B0OLDONE01', outcome: 'verified' }]);
  reject([{ asin: 'B0OLDONE01', outcome: 'fail-delisted' }]); // no note
  reject([{ asin: 'B0OLDONE01', outcome: 'fail-delisted', note: 'short' }]);
  reject([{ asin: 'nope', outcome: 'pass' }]);
  reject([]);
  reject([{ asin: 'B0OLDONE01', outcome: 'pass' }], '2026-11-02'); // future
  reject([{ asin: 'B0OLDONE01', outcome: 'pass' }], 'yesterday');
  assert.throws(() => applyResults({ document: base, input: { checked_at: TODAY, results: [{ asin: 'B0OLDONE01', outcome: 'pass' }, { asin: 'B0UNKNOWN1', outcome: 'pass' }] }, today: TODAY }), /B0UNKNOWN1 is not in the pool/);

  // Evidence written here survives the next pool build (merge from the committed file).
  const { mergeProducts } = build;
  const afterBuild = mergeProducts({
    seedProducts: base.products.map(item => product(item.asin)),
    priorProducts: applyResults({ document: base, input: input([{ asin: 'B0OLDONE01', outcome: 'pass' }, { asin: 'B0EDGE3101', outcome: 'fail-delisted', note: 'page not found shown' }]), today: TODAY }).document.products,
    results: null,
    today: TODAY,
  });
  assert.strictEqual(afterBuild.find(item => item.asin === 'B0OLDONE01').verification_source, 'page-recheck');
  assert.strictEqual(afterBuild.find(item => item.asin === 'B0OLDONE01').last_verified_at, TODAY);
  assert.strictEqual(afterBuild.find(item => item.asin === 'B0EDGE3101').delisted_at, TODAY);
}

function testCli(dir) {
  const poolFile = path.join(dir, 'pool.json');
  const resultsFile = path.join(dir, 'results.json');
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(poolFile, `${JSON.stringify(poolDocument(), null, 2)}\n`);
  fs.writeFileSync(resultsFile, JSON.stringify({ checked_at: TODAY, results: [{ asin: 'B0OLDONE01', outcome: 'pass' }, { asin: 'B0EDGE3101', outcome: 'inconclusive', note: 'CAPTCHA' }] }));
  fs.writeFileSync(badFile, JSON.stringify({ checked_at: TODAY, results: [{ asin: 'B0OLDONE01', outcome: 'pass' }, { asin: 'B0MISSING1', outcome: 'pass' }] }));
  const original = fs.readFileSync(poolFile, 'utf8');
  const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, 'apply-page-recheck.mjs'), ...args, '--pool', poolFile, '--today', TODAY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // Dry run by default.
  const dry = run(resultsFile);
  assert.match(dry, /dry run/);
  assert.match(dry, /HELD OUT of new articles until a clear pass: 1 \(B0EDGE3101\)/);
  assert.strictEqual(fs.readFileSync(poolFile, 'utf8'), original);

  // A rejected file exits non-zero and writes nothing, even with --write.
  assert.throws(() => run(badFile, '--write'), error => /nothing applied/.test(String(error.stderr)));
  assert.strictEqual(fs.readFileSync(poolFile, 'utf8'), original);

  // --write applies: only the passed product changes, formatting is kept.
  run(resultsFile, '--write');
  const written = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  assert.strictEqual(written.products.find(item => item.asin === 'B0OLDONE01').last_verified_at, TODAY);
  assert.strictEqual(written.products.find(item => item.asin === 'B0EDGE3101').last_verified_at, '2026-09-29');
  assert.ok(fs.readFileSync(poolFile, 'utf8').endsWith('}\n'));
  assert.deepStrictEqual(written.products.map(item => item.asin), poolDocument().products.map(item => item.asin), 'product order is preserved');
  // Re-applying is a no-op on disk.
  const afterFirst = fs.readFileSync(poolFile, 'utf8');
  assert.match(run(resultsFile, '--write'), /No change to the pool file/);
  assert.strictEqual(fs.readFileSync(poolFile, 'utf8'), afterFirst);

  // The plan CLI reads the same file and reflects the pass.
  const planOut = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'page-recheck-plan.mjs'), '--pool', poolFile, '--today', TODAY], { encoding: 'utf8' }));
  assert.ok(!planOut.items.some(item => item.asin === 'B0OLDONE01'), 'a passed product leaves the due list');
  assert.ok(planOut.items.some(item => item.asin === 'B0EDGE3101'), 'an inconclusive product stays due');
}

function testGeneratorFilter() {
  const pool = new Map([
    ['B0TRAILA01', product('B0TRAILA01', { name: 'Trail Jack', tags: ['jack'] })],
    ['B0TRAILA02', product('B0TRAILA02', { name: 'Trail Jack Gone', tags: ['jack'], delisted_at: '2026-10-01' })],
  ]);
  assert.deepStrictEqual(filterPoolForTopic(pool, 'best jack').map(item => item.asin), ['B0TRAILA01']);
}

async function run() {
  const apply = await import('./apply-page-recheck.mjs');
  const plan = await import('./page-recheck-plan.mjs');
  const build = await import('./build-verified-pool.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-recheck-'));
  try {
    testPlan(plan);
    testApply(apply, build);
    testCli(dir);
    testGeneratorFilter();
    // The runbook exists and carries the warnings a cold reader needs.
    const runbook = fs.readFileSync(path.join(ROOT, 'docs', 'PAGE_RECHECK.md'), 'utf8');
    for (const phrase of ['## Do not automate this from CI', 'Do not automate this check from GitHub Actions', 'CAPTCHA', 'node scripts/page-recheck-plan.mjs', 'node scripts/apply-page-recheck.mjs', '35 percent', 'inconclusive']) {
      assert.ok(runbook.includes(phrase), `runbook must mention ${phrase}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('Page-recheck tests passed: due list, pass/fail/inconclusive handling, stale and invalid input, CLI dry run and write, delisted filter.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
