#!/usr/bin/env node
/**
 * Offline tests for evidence persistence in scripts/build-verified-pool.mjs.
 * A mocked verifier stands in for the Creators API; no network or credentials are used.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TODAY = '2026-10-30';
const A = 'B0AAAAAAA1'; // prior Tier 1 evidence, lookup inconclusive now
const B = 'B0AAAAAAA2'; // prior seed evidence, becomes LIVE now, delisted flag set
const C = 'B0AAAAAAA3'; // no prior evidence, inconclusive
const D = 'B0AAAAAAA4'; // prior entry no longer referenced on the site
const E = 'B0AAAAAAA5'; // new on the site, LIVE

const seed = asin => ({
  asin,
  name: `Product ${asin}`,
  category: 'test category',
  tags: ['test'],
  affiliate_url: `https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20`,
  verification_status: 'pending-verification',
  sources: ['articles/test.html'],
});

const prior = [
  { ...seed(A), verification_source: 'creators_api', last_verified_at: '2026-10-17', amazon_title: 'Prior Title A', image_local_path: 'assets/product-images/a.jpg' },
  { ...seed(B), verification_source: 'published-history', last_verified_at: '2026-10-19', amazon_title: 'Prior Title B', delisted_at: '2026-10-25' },
  { ...seed(D), verification_source: 'creators_api', last_verified_at: '2026-10-17', amazon_title: 'Gone Product' },
];

const results = new Map([
  [A, { status: 'INCONCLUSIVE', source: 'creators_api', reason: 'No items returned' }],
  [B, { status: 'LIVE', source: 'creators_api', title: 'Fresh Title B', image_url: 'https://example.invalid/b.jpg' }],
  [C, { status: 'INCONCLUSIVE', source: 'creators_api', reason: 'HTTP 403 AssociateNotEligible' }],
  [E, { status: 'LIVE', source: 'creators_api', title: 'Fresh Title E', image_url: 'https://example.invalid/e.jpg' }],
]);

async function run() {
  const mod = await import('./build-verified-pool.mjs');
  const { mergeProducts, verifyProducts, buildPersistedDocument, persistWorkingFile, chooseGeneratedAt, persistedProducts } = mod;

  // Seed comes in unsorted on purpose.
  const seedProducts = [E, C, B, A].map(seed);
  const merged = mergeProducts({ seedProducts, priorProducts: prior, results, today: TODAY });
  const byAsin = Object.fromEntries(merged.map(product => [product.asin, product]));

  // Entries for ASINs no longer referenced on the site are dropped; output is sorted by ASIN.
  assert.deepStrictEqual(merged.map(product => product.asin), [A, B, C, E]);
  assert.strictEqual(byAsin[D], undefined, 'unreferenced ASIN must be dropped');

  // INCONCLUSIVE keeps old evidence untouched: never erased, never extended.
  assert.strictEqual(byAsin[A].verification_status, 'pending-verification');
  assert.strictEqual(byAsin[A].last_verified_at, '2026-10-17');
  assert.strictEqual(byAsin[A].verification_source, 'creators_api');
  assert.strictEqual(byAsin[A].amazon_title, 'Prior Title A');
  assert.strictEqual(byAsin[A].image_local_path, 'assets/product-images/a.jpg');
  assert.strictEqual(byAsin[A].verification_note, 'No items returned');

  // Inconclusive with no prior evidence invents none (no source label, no date).
  assert.strictEqual(byAsin[C].last_verified_at, undefined);
  assert.strictEqual(byAsin[C].verification_source, undefined);
  assert.strictEqual(byAsin[C].amazon_title, undefined);

  // LIVE sets today's UTC date and the creators_api source, refreshes title and image.
  assert.strictEqual(byAsin[B].verification_status, 'verified');
  assert.strictEqual(byAsin[B].last_verified_at, TODAY);
  assert.strictEqual(byAsin[B].verification_source, 'creators_api');
  assert.strictEqual(byAsin[B].amazon_title, 'Fresh Title B');
  assert.strictEqual(byAsin[B].image_url, 'https://example.invalid/b.jpg');
  // A LIVE result never erases a delisted flag; only the page recheck owns it.
  assert.strictEqual(byAsin[B].delisted_at, '2026-10-25');
  assert.strictEqual(byAsin[E].last_verified_at, TODAY);

  // Evidence copied from the committed file is validated: bad dates, unknown sources, paths and
  // titles are dropped rather than believed; a date without a known source loses both.
  const corrupt = [
    { ...seed(A), verification_source: 'creators_api', last_verified_at: '2026-02-30', amazon_title: 'ok', delisted_at: '2026-13-01', image_local_path: '../../etc/passwd' },
    { ...seed(B), verification_source: 'manual', last_verified_at: '2026-10-17', amazon_title: 42, image_local_path: 'https://m.media-amazon.com/x.jpg' },
    { ...seed(C), verification_source: 'creators_api', last_verified_at: 'yesterday', delisted_at: 'soon' },
    { ...seed(E), verification_source: 'page-recheck', last_verified_at: '2026-10-20', delisted_at: '2026-10-21', amazon_title: 'Good', image_local_path: 'assets/product-images/e.jpg' },
  ];
  const cleaned = mergeProducts({ seedProducts: [A, B, C, E].map(seed), priorProducts: corrupt, results: null, today: TODAY });
  const clean = asin => cleaned.find(product => product.asin === asin);
  for (const field of ['last_verified_at', 'verification_source', 'delisted_at', 'image_local_path']) assert.strictEqual(clean(A)[field], undefined, `A ${field}`);
  assert.strictEqual(clean(A).amazon_title, 'ok');
  for (const field of ['last_verified_at', 'verification_source', 'amazon_title', 'image_local_path']) assert.strictEqual(clean(B)[field], undefined, `B ${field}`);
  for (const field of ['last_verified_at', 'verification_source', 'delisted_at']) assert.strictEqual(clean(C)[field], undefined, `C ${field}`);
  assert.deepStrictEqual(
    { source: clean(E).verification_source, date: clean(E).last_verified_at, flag: clean(E).delisted_at, title: clean(E).amazon_title, image: clean(E).image_local_path },
    { source: 'page-recheck', date: '2026-10-20', flag: '2026-10-21', title: 'Good', image: 'assets/product-images/e.jpg' }
  );
  assert.strictEqual(mod.isCalendarDate('2026-02-28'), true);
  assert.strictEqual(mod.isCalendarDate('2026-02-29'), false);
  assert.strictEqual(mod.isCalendarDate('2024-02-29'), true);

  // Without any lookup (static mode) evidence is carried and nothing becomes verified.
  const staticMerge = mergeProducts({ seedProducts, priorProducts: prior, results: null, today: TODAY });
  assert.ok(staticMerge.every(product => product.verification_status === 'pending-verification'));
  assert.strictEqual(staticMerge.find(product => product.asin === B).last_verified_at, '2026-10-19');
  assert.strictEqual(staticMerge.find(product => product.asin === B).verification_source, 'published-history');

  // Deterministic: input order does not change the output bytes.
  const again = mergeProducts({ seedProducts: [A, B, C, E].map(seed), priorProducts: [...prior].reverse(), results, today: TODAY });
  assert.strictEqual(JSON.stringify(again), JSON.stringify(merged));
  assert.deepStrictEqual(Object.keys(byAsin[B]).slice(0, 7), ['asin', 'name', 'category', 'tags', 'affiliate_url', 'verification_status', 'sources']);

  // The mocked verifier path: verifyProducts returns a result per product and mutates nothing.
  const calls = [];
  const mocked = await verifyProducts(seedProducts, {
    verifyAsin: async asin => { calls.push(asin); return results.get(asin); },
  }, () => {});
  assert.deepStrictEqual(calls, [E, C, B, A]);
  assert.strictEqual(mocked.size, 4);
  assert.ok(seedProducts.every(product => product.verification_status === 'pending-verification'));

  // Persist: zero LIVE results leaves the file byte-for-byte untouched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-persist-'));
  try {
    const file = path.join(dir, 'verified-products.json');
    const noLiveRun = mergeProducts({
      seedProducts: [A, C].map(seed),
      priorProducts: prior,
      results: new Map([[A, results.get(A)], [C, results.get(C)]]),
      today: TODAY,
    });
    const runDoc = products => ({ schema_version: 1, generated_at: '2026-10-30T10:00:00.000Z', source: 's', verification_mode: 'Creators API verification requested', products });
    fs.writeFileSync(file, `${JSON.stringify(runDoc(noLiveRun), null, 2)}\n`);
    const before = fs.readFileSync(file, 'utf8');
    assert.strictEqual(persistWorkingFile(file, null, 'NOW'), false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'file must not be touched when nothing was LIVE');
    assert.strictEqual(buildPersistedDocument(runDoc(noLiveRun)), null);

    // Persist with a LIVE result: committable form has pending status, no run-local fields,
    // and the evidence for every ASIN, including the inconclusive ones.
    fs.writeFileSync(file, `${JSON.stringify(runDoc(merged), null, 2)}\n`);
    assert.strictEqual(persistWorkingFile(file, null, '2026-10-30T11:00:00.000Z'), true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(persisted.generated_at, '2026-10-30T11:00:00.000Z');
    assert.ok(persisted.products.every(product => product.verification_status === 'pending-verification'));
    assert.ok(persisted.products.every(product => !('image_url' in product) && !('verification_note' in product)));
    assert.strictEqual(persisted.products.find(product => product.asin === A).last_verified_at, '2026-10-17');
    assert.strictEqual(persisted.products.find(product => product.asin === B).last_verified_at, TODAY);
    assert.strictEqual(persisted.verification_mode, 'pending verification; weekly precheck verifies at runtime');

    // Idempotent rewrite: a second run that proves the same things on the same day yields
    // the same committable bytes, including generated_at, so git sees no diff.
    const committed = { document: persisted, products: persisted.products };
    const committedBytes = fs.readFileSync(file, 'utf8');
    const rerun = mergeProducts({ seedProducts: [A, B, C, E].map(seed), priorProducts: committed.products, results, today: TODAY });
    const rerunGeneratedAt = chooseGeneratedAt({ priorDocument: committed.document, priorProducts: committed.products, nextProducts: rerun, now: '2026-10-30T23:00:00.000Z' });
    assert.strictEqual(rerunGeneratedAt, '2026-10-30T11:00:00.000Z', 'generated_at must not move when content did not change');
    fs.writeFileSync(file, `${JSON.stringify({ ...runDoc(rerun), generated_at: rerunGeneratedAt }, null, 2)}\n`);
    assert.strictEqual(persistWorkingFile(file, committed, '2026-10-30T23:30:00.000Z'), true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), committedBytes, 'rewrite with nothing new must produce no diff');

    // A later day with new evidence changes content, so generated_at moves.
    const nextDay = mergeProducts({ seedProducts: [A, B, C, E].map(seed), priorProducts: committed.products, results, today: '2026-10-31' });
    fs.writeFileSync(file, `${JSON.stringify(runDoc(nextDay), null, 2)}\n`);
    persistWorkingFile(file, committed, '2026-10-31T10:00:00.000Z');
    const moved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(moved.generated_at, '2026-10-31T10:00:00.000Z');
    assert.strictEqual(moved.products.find(product => product.asin === B).last_verified_at, '2026-10-31');
    assert.strictEqual(moved.products.find(product => product.asin === A).last_verified_at, '2026-10-17', 'inconclusive evidence is never extended');

    // A hand-marked verified status without Tier 1 evidence cannot reach a commit.
    const forged = persistedProducts([{ ...seed(A), verification_status: 'verified' }]);
    assert.strictEqual(forged[0].verification_status, 'pending-verification');
    assert.strictEqual(buildPersistedDocument(runDoc([{ ...seed(A), verification_status: 'verified' }])), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('Verified-pool persistence tests passed: preserve on inconclusive, set on LIVE, dropped ASINs, ordering, idempotent rewrite, zero-LIVE no-op.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
