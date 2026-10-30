#!/usr/bin/env node
/**
 * Offline tests for the lookup-outage classifier, the evidence-tier pool loader and the
 * outage issue sync. Fixtures and mocks only: no network, no credentials.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRunReport, classifyCounts, classifyRunReport, failureKind, otherFailuresAccounted, readRunReport,
} = require('./lookup-outage');
const { loadVerifiedPool, validateBodyAsins, tierCommitBody, publishTierOutputs } = require('./generate-article');
const outageIssue = require('./sync-outage-issue');

const ROOT = path.join(__dirname, '..');
const TODAY = '2026-10-30';
const OLD_MESSAGE = file => `[asin-precheck] No runtime-verified product entries are available in ${file}`;
const OUTAGE = 'LOOKUP_OUTAGE';
const PRODUCT = 'PRODUCT_FAILURE';

const empty = () => ({ status: 'INCONCLUSIVE', source: 'creators_api', http_status: 200, reason: 'No items returned' });
const authFail = () => ({ status: 'INCONCLUSIVE', source: 'creators_api', stage: 'auth', http_status: 403, error_code: 'AssociateNotEligible', reason: 'HTTP 403 AssociateNotEligible' });
const throttled = () => ({ status: 'INCONCLUSIVE', source: 'creators_api', http_status: 429, error_code: 'TooManyRequests', reason: 'Creators API throttled the lookup' });
const transport = () => ({ status: 'INCONCLUSIVE', source: 'creators_api', http_status: 0, reason: 'Creators API request failed: socket hang up' });
const other = () => ({ status: 'INCONCLUSIVE', source: 'creators_api', http_status: 404, error_code: 'ItemNotFound', reason: 'HTTP 404 ItemNotFound' });
const live = () => ({ status: 'LIVE', source: 'creators_api', title: 'T', image_url: '', reason: '' });
const repeat = (factory, count) => Array.from({ length: count }, factory);

function product(asin, extra = {}) {
  assert.ok(/^[A-Z0-9]{10}$/.test(asin), `fixture ASIN ${asin} must be 10 characters`);
  return {
    asin,
    name: `Product ${asin}`,
    category: 'test',
    tags: ['test'],
    affiliate_url: `https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20`,
    verification_status: 'pending-verification',
    sources: ['articles/test.html'],
    ...extra,
  };
}

function withCapturedLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = original;
  }
}

function classifyResults(results) {
  return classifyRunReport(buildRunReport(results));
}

function testClassifier() {
  // All-empty lookup (the 10/26 failure) is an outage.
  assert.strictEqual(classifyResults(repeat(empty, 126)), OUTAGE);
  // 90 percent systemic failures is an outage; 89 percent is not.
  assert.strictEqual(classifyResults([...repeat(live, 10), ...repeat(transport, 90)]), OUTAGE);
  assert.strictEqual(classifyResults([...repeat(live, 11), ...repeat(transport, 89)]), PRODUCT);
  // A minority failing while the rest are LIVE is a product failure.
  assert.strictEqual(classifyResults([...repeat(live, 106), ...repeat(empty, 20)]), PRODUCT);
  // A healthy run is not an outage.
  assert.strictEqual(classifyResults(repeat(live, 126)), PRODUCT);
  // Each systemic kind counts on its own.
  assert.strictEqual(classifyResults(repeat(authFail, 126)), OUTAGE);
  assert.strictEqual(classifyResults(repeat(throttled, 126)), OUTAGE);
  assert.strictEqual(classifyResults(repeat(transport, 126)), OUTAGE);
  // Product-specific errors (404 ItemNotFound) are not systemic, even when nothing is LIVE.
  assert.strictEqual(classifyResults(repeat(other, 126)), PRODUCT);
  // Zero LIVE across at least 20 ASINs needs a majority of systemic failures; fewer than 20 needs 90 percent.
  assert.strictEqual(classifyResults([...repeat(empty, 12), ...repeat(other, 8)]), OUTAGE);
  assert.strictEqual(classifyResults([...repeat(empty, 9), ...repeat(other, 11)]), PRODUCT);
  assert.strictEqual(classifyResults([...repeat(empty, 8), ...repeat(other, 7)]), PRODUCT);
  assert.strictEqual(classifyCounts({ total: 0, live: 0, failures: {} }), PRODUCT);
  // The verdict is recomputed from counts: a forged classification field changes nothing.
  assert.strictEqual(classifyRunReport({ total: 100, live: 100, failures: {}, classification: OUTAGE }), PRODUCT);
  assert.strictEqual(classifyRunReport(null), null);
  // Kinds.
  assert.deepStrictEqual([empty(), authFail(), throttled(), transport(), other(), live()].map(failureKind), ['empty', 'auth', 'throttle', 'transport', 'other', null]);
  assert.strictEqual(failureKind({ status: 'INCONCLUSIVE', source: 'creators_api', stage: 'auth', error_code: 'MissingCredentials', reason: 'Creators API credentials are unavailable' }), 'auth');
  assert.strictEqual(failureKind({ status: 'INCONCLUSIVE', http_status: 503, reason: 'HTTP 503' }), 'transport');

  // The report carries counts and a masked sample, never a credential.
  const secret = 'sk-live-0123456789abcdefghijklmnop';
  const report = buildRunReport([{ ...transport(), reason: `Creators API request failed: ${secret} fake-secret-value Bearer abc.def.ghi` }], { credentials: { clientId: secret, clientSecret: 'fake-secret-value', partnerTag: 'trailbuiltove-20' } });
  assert.strictEqual(report.sample.kind, 'transport', 'the sample under test must exist');
  assert.ok(!JSON.stringify(report).includes(secret), 'secret must be masked');
  assert.ok(!JSON.stringify(report).includes('fake-secret-value'), 'configured secret must be masked');
  assert.ok(!/Bearer abc/.test(JSON.stringify(report)));
  const codeReport = buildRunReport([{ ...transport(), error_code: secret }], { credentials: { clientId: secret, clientSecret: 'fake-secret-value', partnerTag: 'trailbuiltove-20' } });
  assert.strictEqual(codeReport.sample.error_code, '', 'a credential-shaped error code is dropped');
  assert.ok(!JSON.stringify(codeReport).includes(secret));
}

function testLoader(dir) {
  const file = path.join(dir, 'pool.json');
  const write = products => fs.writeFileSync(file, JSON.stringify({ schema_version: 1, products }));
  const evidence = (date, extra = {}) => ({ verification_source: 'creators_api', last_verified_at: date, ...extra });
  const outageReport = buildRunReport(repeat(empty, 126));
  const minorityReport = buildRunReport([...repeat(live, 106), ...repeat(empty, 20)]);
  const noImage = new Set(['B0NOIMAGE1']);
  const base = { today: TODAY, hasLocalImage: item => !noImage.has(item.asin) };

  const fixtures = [
    product('B0FRESH001', evidence('2026-10-17')),
    product('B0LIMIT045', evidence('2026-09-15')), // exactly 45 days old: still inside
    product('B0EXPIRED6', evidence('2026-09-14')), // 46 days old
    product('B0NOIMAGE1', evidence('2026-10-17')),
    product('B0DELISTED', evidence('2026-10-17', { delisted_at: '2026-10-25' })),
    product('B0NOEVID01'),
    product('B0BADSRC01', { verification_source: 'manual', last_verified_at: '2026-10-17' }),
    product('B0FUTURE01', evidence('2026-11-30')),
    product('B0SEEDED01', { verification_source: 'published-history', last_verified_at: '2026-10-19' }),
    product('B0RECHECK1', { verification_source: 'page-recheck', last_verified_at: '2026-10-25' }), // exclusion mechanism only
    product('B0SEEDLATE', { verification_source: 'published-history', last_verified_at: '2026-10-29' }), // last day the one-time seed can carry
    product('B0SEEDREFR', { verification_source: 'published-history', last_verified_at: '2026-10-30' }), // a refreshed "seed" is not the seed
    product('B0BADDATE1', evidence('2026-09-31')), // impossible calendar date
    product('B0OWNFAIL1', evidence('2026-10-17')), // its own lookup failed with a product-specific error
  ];
  write(fixtures);

  // Outage + flag on: only entries inside the window, with a local image, not delisted.
  const outageWithOwnFailure = buildRunReport([
    ...repeat(empty, 125),
    { ...other(), asin: 'B0OWNFAIL1' },
  ].map((result, index) => (result.asin ? result : { ...result, asin: `B0FILL${String(index).padStart(5, '0')}` })));
  assert.strictEqual(outageWithOwnFailure.classification, OUTAGE);
  assert.strictEqual(outageWithOwnFailure.failed_kinds.B0OWNFAIL1, 'other');
  assert.ok(Object.values(outageWithOwnFailure.failed_kinds).every(kind => typeof kind === 'string' && kind.length < 12), 'kinds only, no messages');
  const { value: carried, lines } = withCapturedLog(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: outageWithOwnFailure }));
  assert.deepStrictEqual([...carried.keys()].sort(), ['B0FRESH001', 'B0LIMIT045', 'B0SEEDED01', 'B0SEEDLATE']);
  assert.strictEqual(carried.get('B0FRESH001').verification_status, 'pending-verification', 'carry-forward never relabels status');
  assert.strictEqual(carried.evidence.tier, 'carry-forward');
  assert.strictEqual(carried.evidence.classification, OUTAGE);
  assert.deepStrictEqual(carried.evidence.excluded, { expired: 1, 'no-local-image': 1, 'no-evidence': 6, 'own-lookup-failed': 1 });
  assert.ok(!carried.has('B0DELISTED'));
  assert.strictEqual(lines.filter(line => line === '[asin-precheck] LOOKUP_OUTAGE: using carry-forward pool (tier 2/3)').length, 1);
  assert.deepStrictEqual([...carried.evidence.carriedAsins].sort(), ['B0FRESH001', 'B0LIMIT045', 'B0SEEDED01', 'B0SEEDLATE']);
  // Without per-ASIN kinds (an old-style report) the same entry is not excluded; with them it is.
  const withoutKinds = withCapturedLog(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: outageReport })).value;
  assert.ok(withoutKinds.has('B0OWNFAIL1'));

  // Minority failing is a product failure: fail closed, no carry-forward, even with the flag on.
  assert.throws(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: minorityReport }), error => error.message === OLD_MESSAGE(file));
  // Flag off (the default): fail closed with the old message, even in an outage.
  assert.throws(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: false, runReport: outageReport }), error => error.message === OLD_MESSAGE(file));
  // No usable report: no classification, fail closed.
  assert.throws(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: null }), error => error.message === OLD_MESSAGE(file));

  // Default entry point reads the real environment: unset flag (or anything but "true") fails closed.
  const reportFile = path.join(dir, 'pool-run-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(outageReport));
  assert.strictEqual(readRunReport(reportFile).total, 126);
  assert.strictEqual(readRunReport(path.join(dir, 'missing.json')), null);
  fs.writeFileSync(path.join(dir, 'garbage.json'), '{"total":"x"}');
  assert.strictEqual(readRunReport(path.join(dir, 'garbage.json')), null);
  const savedEnv = { ...process.env };
  try {
    process.env.POOL_RUN_REPORT = reportFile;
    delete process.env.ALLOW_CARRY_FORWARD;
    assert.throws(() => loadVerifiedPool(file, true), error => error.message === OLD_MESSAGE(file));
    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      process.env.ALLOW_CARRY_FORWARD = value;
      assert.throws(() => loadVerifiedPool(file, true), error => error.message === OLD_MESSAGE(file), `ALLOW_CARRY_FORWARD=${value} must not enable carry-forward`);
    }
    process.env.ALLOW_CARRY_FORWARD = 'true';
    const viaEnv = withCapturedLog(() => loadVerifiedPool(file, true, { today: TODAY, hasLocalImage: () => true })).value;
    assert.strictEqual(viaEnv.evidence.tier, 'carry-forward', 'exact "true" plus an outage report enables it');
  } finally {
    for (const key of ['POOL_RUN_REPORT', 'ALLOW_CARRY_FORWARD']) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }

  // Outage + flag but nothing qualifies: still fails closed, message keeps the old prefix.
  write([product('B0EXPIRED6', evidence('2026-09-14')), product('B0NOEVID01')]);
  assert.throws(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: outageReport }), error => error.message.startsWith(OLD_MESSAGE(file)) && /LOOKUP_OUTAGE/.test(error.message));

  // Healthy Tier 1 run: identical to today. Only verified entries; evidence entries are ignored.
  write([
    product('B0VERIFIE1', { verification_status: 'verified', ...evidence(TODAY) }),
    product('B0VERIFIE2', { verification_status: 'verified', ...evidence(TODAY) }),
    product('B0FRESH001', evidence('2026-10-17')),
  ]);
  const healthyReport = buildRunReport([...repeat(live, 2), empty()]);
  const healthyOn = withCapturedLog(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: healthyReport }));
  const healthyOff = loadVerifiedPool(file, true, { ...base, allowCarryForward: false });
  const healthyDefault = loadVerifiedPool(file, true);
  assert.deepStrictEqual([...healthyOn.value.keys()], ['B0VERIFIE1', 'B0VERIFIE2']);
  assert.deepStrictEqual([...healthyOff.keys()], [...healthyOn.value.keys()]);
  assert.deepStrictEqual([...healthyDefault.keys()], [...healthyOn.value.keys()]);
  assert.strictEqual(healthyOn.value.evidence.tier, 'tier-1');
  assert.ok(!healthyOn.lines.some(line => /LOOKUP_OUTAGE/.test(line)), 'healthy run must not log an outage');

  // Mixed outage (95 percent failing, a few LIVE): Tier 1 entries plus eligible carry-forward.
  const mixedReport = buildRunReport([...repeat(live, 5), ...repeat(empty, 95)]);
  const mixed = withCapturedLog(() => loadVerifiedPool(file, true, { ...base, allowCarryForward: true, runReport: mixedReport })).value;
  assert.deepStrictEqual([...mixed.keys()].sort(), ['B0FRESH001', 'B0VERIFIE1', 'B0VERIFIE2']);
  assert.strictEqual(mixed.evidence.tier1, 2);
  assert.strictEqual(mixed.evidence.carried, 1);

  // Seed mode (verification not required) keeps loading everything except delisted entries.
  write([product('B0SEEDMODE', {}), product('B0DELISTED', evidence('2026-10-17', { delisted_at: '2026-10-25' }))]);
  assert.deepStrictEqual([...loadVerifiedPool(file, false).keys()], ['B0SEEDMODE']);
  // A verified-but-delisted entry is never used either.
  write([product('B0VERIFIE1', { verification_status: 'verified', delisted_at: '2026-10-25' })]);
  assert.throws(() => loadVerifiedPool(file, true), error => error.message === OLD_MESSAGE(file));

  // Unverified malformed/duplicate entries are skipped, not fatal, when verification is required (as before).
  write([
    product('B0VERIFIE1', { verification_status: 'verified' }),
    { asin: 'bad', name: 'x', tags: [] },
    product('B0VERIFIE1'),
  ]);
  assert.deepStrictEqual([...loadVerifiedPool(file, true).keys()], ['B0VERIFIE1']);
  assert.throws(() => loadVerifiedPool(file, false), /Invalid pool ASIN|Duplicate pool ASIN/);
}

function realImagePath() {
  const dirPath = path.join(ROOT, 'assets', 'product-images');
  const name = fs.readdirSync(dirPath).find(entry => /\.(jpe?g|png|webp)$/i.test(entry));
  return `assets/product-images/${name}`;
}

// N14: a report that counts product-specific failures but cannot say which ASINs they were is
// not trusted for carry-forward at all (old-style or tampered report).
function testUnaccountedFailuresFailClosed(dir) {
  const file = path.join(dir, 'unaccounted-pool.json');
  fs.writeFileSync(file, JSON.stringify({ products: [
    product('B0OWNFAIL1', { verification_source: 'creators_api', last_verified_at: '2026-10-17' }),
    product('B0FRESH001', { verification_source: 'creators_api', last_verified_at: '2026-10-17' }),
  ] }));
  const load = report => loadVerifiedPool(file, true, { allowCarryForward: true, today: TODAY, hasLocalImage: () => true, runReport: report });
  const results = [...repeat(empty, 125), { ...other(), asin: 'B0OWNFAIL1' }].map((result, index) => (result.asin ? result : { ...result, asin: `B0FILL${String(index).padStart(5, '0')}` }));
  const good = buildRunReport(results);
  assert.strictEqual(good.failures.other, 1);
  assert.strictEqual(classifyRunReport(good), OUTAGE);

  // Intact report: carry-forward runs and the entry with its own failed lookup is excluded.
  const ok = withCapturedLog(() => load(good)).value;
  assert.deepStrictEqual([...ok.keys()], ['B0FRESH001']);
  assert.strictEqual(ok.evidence.carryForwardSkippedReason, '');

  const damaged = {
    'failed_kinds absent (old-style report)': (() => { const report = { ...good }; delete report.failed_kinds; return report; })(),
    'failed_kinds null': { ...good, failed_kinds: null },
    'failed_kinds array': { ...good, failed_kinds: ['B0OWNFAIL1'] },
    'failed_kinds string': { ...good, failed_kinds: 'B0OWNFAIL1' },
    'failed_kinds array of other': { ...good, failed_kinds: ['other'] },
    'failed_kinds number': { ...good, failed_kinds: 7 },
    'failed_kinds empty object': { ...good, failed_kinds: {} },
    'failed_kinds names no other': { ...good, failed_kinds: { B0OWNFAIL1: 'empty' } },
    'failures.other undercounted by kinds': { ...good, failures: { ...good.failures, other: 3 }, failed_kinds: { B0OWNFAIL1: 'other' } },
  };
  for (const [name, report] of Object.entries(damaged)) {
    const { lines } = withCapturedLog(() => {
      assert.throws(() => load(report), error => error.message.startsWith(OLD_MESSAGE(file)) && /carry-forward skipped/.test(error.message), name);
    });
    assert.ok(lines.some(line => /carry-forward skipped, the run report counts/.test(line)), `${name}: the reason must be logged by name`);
    assert.ok(!lines.some(line => /using carry-forward pool/.test(line)), `${name}: nothing may be carried`);
    assert.strictEqual(otherFailuresAccounted(report).ok, false, name);
  }
  // Nothing product-specific to account for: an old-style report without kinds is still usable.
  const noOther = buildRunReport(repeat(empty, 126));
  delete noOther.failed_kinds;
  assert.strictEqual(otherFailuresAccounted(noOther).ok, true);
  assert.strictEqual(withCapturedLog(() => load(noOther)).value.size, 2);
  // Extra kinds are fine; the exclusion still applies.
  assert.strictEqual(otherFailuresAccounted({ ...good, failed_kinds: { ...good.failed_kinds, B0FRESH001: 'other' } }).ok, true);
  // A tampered report can still not lower the count it must account for.
  assert.strictEqual(otherFailuresAccounted({ failures: { other: 2 }, failed_kinds: { A: 'other', B: 'empty' } }).ok, false);
}

// R8: the production wiring in build-verified-pool.mjs attaches each ASIN to its verifier result
// (the verifier's results do not carry one). Exercised from a Map exactly as main() builds it.
async function testRunReportWiring(dir) {
  const { reportFromResults, verifyProducts } = await import('./build-verified-pool.mjs');
  const asins = Array.from({ length: 10 }, (_, index) => `B0WIRE000${index}`);
  const scripted = new Map(asins.map((asin, index) => [asin, index === 3 ? other() : empty()]));
  const verified = await verifyProducts(asins.map(asin => ({ asin })), { verifyAsin: async asin => scripted.get(asin) }, () => {});
  assert.ok([...verified.values()].every(result => result.asin === undefined), 'verifier results carry no ASIN of their own');
  const report = reportFromResults(verified);
  assert.strictEqual(report.failed_kinds.B0WIRE0003, 'other');
  assert.strictEqual(Object.keys(report.failed_kinds).length, 10);
  assert.strictEqual(report.failures.other, 1);
  assert.strictEqual(classifyRunReport(report), OUTAGE);
  // End to end: the loader excludes exactly that ASIN.
  const file = path.join(dir, 'wiring-pool.json');
  fs.writeFileSync(file, JSON.stringify({ products: asins.map(asin => product(asin, { verification_source: 'creators_api', last_verified_at: '2026-10-17' })) }));
  const pool = withCapturedLog(() => loadVerifiedPool(file, true, { allowCarryForward: true, today: TODAY, hasLocalImage: () => true, runReport: report })).value;
  assert.ok(!pool.has('B0WIRE0003') && pool.size === 9);
  assert.strictEqual(pool.evidence.excluded['own-lookup-failed'], 1);
  // The production main() must route through the same function.
  assert.ok(/const report = reportFromResults\(results, credentials\);/.test(fs.readFileSync(path.join(__dirname, 'build-verified-pool.mjs'), 'utf8')), 'main() must build the report with reportFromResults');
  // Credentials are masked on this path too.
  const secret = 'sk-live-0123456789abcdefghijklmnop';
  const leaky = reportFromResults(new Map([['B0WIRE0001', { ...transport(), reason: `failed ${secret}` }]]), { clientId: secret, clientSecret: 'fake-secret-value', partnerTag: 'trailbuiltove-20' });
  assert.ok(!JSON.stringify(leaky).includes(secret));
}

async function testCarryForwardGate() {
  // The default local-image check: a real file under assets/product-images/ qualifies, a missing one does not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outage-gate-'));
  try {
    const file = path.join(dir, 'pool.json');
    fs.writeFileSync(file, JSON.stringify({ products: [
      product('B0REALIMG1', { verification_source: 'creators_api', last_verified_at: '2026-10-17', image_local_path: realImagePath() }),
      product('B0MISSING1', { verification_source: 'creators_api', last_verified_at: '2026-10-17', image_local_path: 'assets/product-images/does-not-exist.jpg' }),
      product('B0OUTSIDE1', { verification_source: 'creators_api', last_verified_at: '2026-10-17', image_local_path: 'package.json' }),
    ] }));
    const pool = withCapturedLog(() => loadVerifiedPool(file, true, { allowCarryForward: true, today: TODAY, runReport: buildRunReport(repeat(empty, 50)) })).value;
    assert.deepStrictEqual([...pool.keys()], ['B0REALIMG1']);

    // validateBodyAsins: carry-forward ASINs skip the live lookup, still need a local image;
    // Tier 1 ASINs still go to the verifier exactly as before.
    const looked = [];
    const verifier = { verifyAsin: async asin => { looked.push(asin); return { status: 'LIVE', source: 'creators_api', image_url: 'https://example.invalid/x.jpg', reason: '' }; } };
    const box = asin => `<div class="product-box" data-asin="${asin}"><a href="https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20">x</a></div>`;
    const gatePool = new Map([
      ['B0REALIMG1', pool.get('B0REALIMG1')],
      ['B0MISSING1', product('B0MISSING1', { image_local_path: 'assets/product-images/does-not-exist.jpg' })],
      ['B0TIERONE1', product('B0TIERONE1', { verification_status: 'verified' })],
    ]);
    const carryForwardAsins = new Set(['B0REALIMG1', 'B0MISSING1']);
    const gate = await (async () => {
      const original = console.log;
      console.log = () => {};
      try {
        return await validateBodyAsins(box('B0REALIMG1') + box('B0MISSING1') + box('B0TIERONE1'), gatePool, verifier, { carryForwardAsins });
      } finally {
        console.log = original;
      }
    })();
    assert.deepStrictEqual(looked, ['B0TIERONE1'], 'live lookup only for the Tier 1 ASIN');
    assert.deepStrictEqual(gate.ok, ['B0REALIMG1', 'B0TIERONE1']);
    assert.deepStrictEqual(gate.failed, ['B0MISSING1: carry-forward product has no local product image']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Tier outputs: Tier 1 writes only the tier; carry-forward adds the commit body with the evidence.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'outage-out-'));
  try {
    const out = path.join(dir2, 'github-output');
    const tierOne = new Map([['B0TIERONE1', product('B0TIERONE1')]]);
    Object.defineProperty(tierOne, 'evidence', { value: { tier: 'tier-1', carriedAsins: new Set() } });
    withCapturedLog(() => publishTierOutputs(tierOne, ['B0TIERONE1'], out));
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'evidence_tier=tier-1\n');
    assert.strictEqual(tierCommitBody(tierOne, ['B0TIERONE1']), '');

    fs.rmSync(out);
    const carry = new Map([['B0CARRIED1', product('B0CARRIED1', { verification_source: 'published-history', last_verified_at: '2026-10-19' })]]);
    Object.defineProperty(carry, 'evidence', { value: { tier: 'carry-forward', carriedAsins: new Set(['B0CARRIED1']) } });
    withCapturedLog(() => publishTierOutputs(carry, ['B0CARRIED1'], out));
    const written = fs.readFileSync(out, 'utf8');
    assert.ok(written.startsWith('evidence_tier=carry-forward\ncommit_body<<TIER_BODY_EOF\n'));
    assert.ok(written.includes('B0CARRIED1 last_verified_at=2026-10-19 source=published-history'));
    assert.ok(!/chore: auto-publish/.test(written), 'the body must not carry the commit-subject prefix');

    // N12: a carry-forward pool whose article used only Tier 1 ASINs is not labelled carry-forward.
    fs.rmSync(out);
    const mixedPool = new Map([...carry, ['B0TIERONE1', product('B0TIERONE1')]]);
    Object.defineProperty(mixedPool, 'evidence', { value: { tier: 'carry-forward', carriedAsins: new Set(['B0CARRIED1']) } });
    assert.strictEqual(tierCommitBody(mixedPool, ['B0TIERONE1']), '');
    withCapturedLog(() => publishTierOutputs(mixedPool, ['B0TIERONE1'], out));
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'evidence_tier=tier-1\n');
    assert.ok(tierCommitBody(mixedPool, ['B0TIERONE1', 'B0CARRIED1']).startsWith('evidence-tier: carry-forward'));
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
}

async function testIssueSync() {
  const secret = 'fake-client-secret-0123456789abcdefghijklmnop';
  const credentials = { clientId: 'fake-client-id-value', clientSecret: secret, partnerTag: 'fake-tag-20' };
  const outage = buildRunReport(repeat(empty, 126), { credentials, checkedAt: '2026-10-30T10:00:00.000Z' });
  outage.sample.message = `HTTP 403: rejected ${secret} for fake-client-id-value Bearer abc.def.ghi user@example.com`;
  const healthy = buildRunReport(repeat(live, 126), { credentials, checkedAt: '2026-10-31T10:00:00.000Z' });

  const body = outageIssue.renderBody(outage, { credentials, runUrl: 'https://github.com/o/r/actions/runs/1', carryForwardEnabled: false });
  for (const forbidden of [secret, 'fake-client-id-value', 'fake-tag-20', 'Bearer abc', 'user@example.com']) {
    assert.ok(!body.includes(forbidden), `issue body must not contain ${forbidden}`);
  }
  assert.ok(body.includes('| Carry-forward enabled (ALLOW_CARRY_FORWARD) | no |'));
  assert.ok(body.includes('| Failed: empty | 126 |'));

  const originalFetch = global.fetch;
  const calls = [];
  let issues = [];
  global.fetch = async (url, options) => {
    const route = String(url).replace('https://api.github.com/repos/o/r', '');
    const method = options.method;
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, route: route.split('?')[0], payload });
    const respond = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (method === 'GET') return respond(issues);
    if (method === 'POST' && route === '/issues') { issues = [{ number: 9, title: payload.title, state: 'open', body: payload.body }]; return respond({ number: 9 }); }
    return respond({});
  };
  const ctx = { token: 'fake-token', repo: 'o/r' };
  const writes = () => calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.route}`);
  try {
    // Healthy run, no issue: nothing is written, nothing is created.
    assert.deepStrictEqual(await outageIssue.sync(healthy, ctx, { credentials }), { action: 'none', verdict: PRODUCT });
    assert.deepStrictEqual(writes(), []);

    // Outage creates the issue (title, label), with a clean body.
    calls.length = 0;
    const created = await outageIssue.sync(outage, ctx, { credentials });
    assert.deepStrictEqual(created, { action: 'created', number: 9, verdict: OUTAGE });
    const create = calls.find(call => call.route === '/issues' && call.method === 'POST');
    assert.strictEqual(create.payload.title, 'Amazon lookup outage');
    assert.deepStrictEqual(create.payload.labels, ['lookup-outage']);
    assert.ok(!JSON.stringify(calls).includes(secret));

    // A second outage run updates the body in place, no comment.
    calls.length = 0;
    issues[0].title = 'Amazon lookup outage';
    assert.strictEqual((await outageIssue.sync(outage, ctx, { credentials })).action, 'updated');
    assert.deepStrictEqual(writes(), ['PATCH /issues/9']);

    // Recovery: a comment, then close.
    calls.length = 0;
    assert.strictEqual((await outageIssue.sync(healthy, ctx, { credentials })).action, 'closed');
    assert.deepStrictEqual(writes(), ['POST /issues/9/comments', 'PATCH /issues/9']);
    assert.strictEqual(calls.find(call => call.method === 'PATCH').payload.state, 'closed');

    // A new outage reopens a closed issue, with a comment first.
    calls.length = 0;
    issues[0].state = 'closed';
    assert.strictEqual((await outageIssue.sync(outage, ctx, { credentials })).action, 'reopened');
    assert.deepStrictEqual(writes(), ['POST /issues/9/comments', 'PATCH /issues/9']);

    // Hysteresis: a mostly-failing lookup with a few LIVE hits is not recovered. Not an outage
    // (84 percent systemic), 20 of 126 LIVE (16 percent): the open issue stays open.
    calls.length = 0;
    issues[0].state = 'open';
    const limping = buildRunReport([...repeat(live, 20), ...repeat(empty, 106)]);
    assert.strictEqual(classifyRunReport(limping), PRODUCT);
    assert.strictEqual((await outageIssue.sync(limping, ctx, { credentials })).action, 'none');
    assert.deepStrictEqual(writes(), []);
    // At 50 percent LIVE it closes.
    assert.strictEqual((await outageIssue.sync(buildRunReport([...repeat(live, 63), ...repeat(other, 63)]), ctx, { credentials })).action, 'closed');
    issues[0].state = 'open';

    // No LIVE evidence (e.g. a product failure with zero LIVE) never closes an open issue.
    calls.length = 0;
    issues[0].state = 'open';
    const noEvidence = buildRunReport(repeat(other, 5));
    assert.strictEqual((await outageIssue.sync(noEvidence, ctx, { credentials })).action, 'none');
    assert.deepStrictEqual(writes(), []);

    // The eligibility issue shares the label but not the title: it is never touched.
    calls.length = 0;
    issues = [{ number: 3, title: 'Amazon API eligibility', state: 'open', body: 'x' }];
    assert.strictEqual((await outageIssue.sync(outage, ctx, { credentials })).action, 'created');

    // Dry run prints and writes nothing.
    calls.length = 0;
    const dry = await (async () => {
      const original = console.log;
      console.log = () => {};
      try { return await outageIssue.sync(outage, ctx, { credentials, dryRun: true }); } finally { console.log = original; }
    })();
    assert.strictEqual(dry.action, 'dry-run');
    assert.deepStrictEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
  }
}

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
    entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
}

function testWorkflowSwitches() {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'weekly-content.yml'), 'utf8');
  // The carry-forward switch must not appear anywhere under .github in any form: not as env:,
  // not echoed into GITHUB_ENV, not in a comment, in any case.
  const githubFiles = walkFiles(path.join(ROOT, '.github'));
  assert.ok(githubFiles.length > 3);
  for (const file of githubFiles) {
    assert.ok(!/allow[_\s-]*carry[_\s-]*forward/i.test(fs.readFileSync(file, 'utf8')), `${path.relative(ROOT, file)} must not mention the carry-forward switch`);
  }
  assert.ok(/REQUIRE_POOL_VERIFICATION: 'true'/.test(workflow), 'REQUIRE_POOL_VERIFICATION must stay true');
  assert.ok(/--run-report "\$RUNNER_TEMP\/pool-run-report\.json"/.test(workflow));
  // Both commit branches keep the exact subject; only the carry-forward one adds a body.
  const commits = workflow.split('\n').filter(line => /\bgit commit\b/.test(line)).map(line => line.trim());
  assert.deepStrictEqual(commits, [
    'git commit -m "chore: auto-publish ${ARTICLE} on $(date +%Y-%m-%d)" -m "$TIER_BODY"',
    'git commit -m "chore: auto-publish ${ARTICLE} on $(date +%Y-%m-%d)"',
  ]);
  assert.ok(/if \[ -n "\$TIER_BODY" \]; then\s+#[^\n]*\n\s+git commit -m "chore: auto-publish[^\n]*-m "\$TIER_BODY"\s+else\s+git commit/.test(workflow), 'the body branch is guarded by TIER_BODY');
  assert.ok(workflow.indexOf('Build runtime-verified product pool') < workflow.indexOf('Generate new article'), 'pool build runs before generation');
  const netlify = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.ok(/ASIN_VALIDATE\s*=\s*"warn"/.test(netlify), 'ASIN_VALIDATE must stay warn');
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outage-tiers-'));
  try {
    testClassifier();
    testLoader(dir);
    testUnaccountedFailuresFailClosed(dir);
    await testRunReportWiring(dir);
    await testCarryForwardGate();
    await testIssueSync();
    testWorkflowSwitches();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('Outage-tier tests passed: classifier, tier selection, fail-closed defaults, carry-forward gate, issue sync, workflow switches.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
