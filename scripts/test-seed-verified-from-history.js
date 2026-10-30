#!/usr/bin/env node
/**
 * Local tests for scripts/seed-verified-from-history.mjs (Tier 3 bootstrap seed).
 * Builds a throwaway git repository with dated fake commits and a fake pool file, then runs the real CLI
 * against it. No network, no credentials, nothing outside the temp directory is touched.
 * Set SEED_SCRIPT to point at an alternate copy of the script (used for mutation checks).
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = process.env.SEED_SCRIPT || path.join(__dirname, 'seed-verified-from-history.mjs');
const TAG = 'trailbuiltove-20';
const AS_OF = '2026-10-29';

function sh(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function box(asin, name, image) {
  const img = image ? `<div class="product-box-image"><img src="../assets/product-images/${image}" alt="${name}" /></div>` : '';
  return `<div class="product-box" data-asin="${asin}" data-product="${name}"><div class="product-box-header">${img}<h4>${name}</h4></div>`
    + `<a class="btn-amazon" data-asin="${asin}" href="https://www.amazon.com/dp/${asin}?tag=${TAG}">Check current price on Amazon</a></div>`;
}

function article(...parts) {
  return `<!doctype html><html><body><article>${parts.join('\n')}</article></body></html>\n`;
}

function linkOnly(asin, tag = TAG) {
  return `<p><a href="https://www.amazon.com/dp/${asin}?tag=${tag}">link</a></p>`;
}

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-history-test-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message, isoDate) => {
    sh(dir, ['add', '-A']);
    sh(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message], {
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_COMMITTER_DATE: isoDate,
    });
    return sh(dir, ['rev-parse', 'HEAD']).trim();
  };
  const publish = (file, html, isoDate, extraFiles = {}) => {
    write(`articles/${file}`, html);
    for (const [name, text] of Object.entries(extraFiles)) write(name, text);
    return commit(`chore: auto-publish ${file} on ${isoDate.slice(0, 10)}`, isoDate);
  };

  write('README.md', 'fixture\n');
  commit('init', '2026-01-01T00:00:00+00:00');

  const shas = {};
  // Outside the window: 46 days before the as-of date (cutoff is 2026-09-14, inclusive).
  shas.outside = publish('outside.html', article(box('B0OUTSIDE1', 'Outside Product', 'outside.jpg')), '2026-09-13T12:00:00+00:00');
  // Exactly 45 days before: inside (inclusive).
  shas.edge = publish('edge.html', article(box('B0EDGE0001', 'Edge Product', 'edge.jpg')), '2026-09-14T00:00:00+00:00', { 'assets/product-images/edge.jpg': 'x' });
  // Author date is 2026-09-13 local but 2026-09-14 in UTC: must use the UTC date and be inside.
  shas.tzIn = publish('tz-in.html', article(box('B0TZEDGE01', 'Timezone Edge Product', 'tz.jpg')), '2026-09-13T20:00:00-05:00');
  // Author date is 2026-10-10 local but 2026-10-11 in UTC.
  shas.tzDate = publish('tz-date.html', article(box('B0TZDATE01', 'Timezone Date Product', 'tzd.jpg')), '2026-10-10T23:30:00-05:00');
  // A main article with several kinds of ASIN: in pool and boxed, link-only, wrong tag, not in pool, removed later.
  shas.main = publish('main.html', article(
    box('B0INSIDE01', 'Inside Product', 'inside.jpg'),
    box('B0NOPOOL01', 'Not In Pool Product', 'nopool.jpg'),
    box('B0REMOVED1', 'Removed Later Product', 'removed.jpg'),
    box('B0NEWER001', 'Newer Existing Product', 'newer.jpg'),
    box('B0OLDER001', 'Older Existing Product', 'older.jpg'),
    box('B0TWICE001', 'Twice Published Product', 'twice.jpg'),
    linkOnly('B0LINKONLY'),
    linkOnly('B0WRONGTAG', 'someoneelse-20')
  ), '2026-10-05T10:00:00+00:00', { 'assets/product-images/inside.jpg': 'x' });
  // A normal-looking auto-publish subject that adds no article (marker-only commit).
  write('.daily-rebuild-ping', 'ping\n');
  shas.marker = commit('chore: auto-publish marker-only.html on 2026-10-06', '2026-10-06T09:00:00+00:00');
  // The same ASIN published again later: the most recent commit wins.
  shas.twice = publish('twice.html', article(box('B0TWICE001', 'Twice Published Product', 'twice.jpg')), '2026-10-20T08:00:00+00:00');
  // A non auto-publish commit that adds an article: never evidence.
  write('articles/manual.html', article(box('B0MANUAL01', 'Manual Product', 'manual.jpg')));
  shas.manual = commit('content: add manual.html', '2026-10-15T08:00:00+00:00');
  // An auto-publish commit that only MODIFIES an article added by some other commit: the article was not added by it.
  write('articles/manual.html', article(box('B0MANUAL01', 'Manual Product', 'manual.jpg'), box('B0MODIFY01', 'Modified Later Product', 'modify.jpg')));
  shas.modify = commit('chore: auto-publish manual.html on 2026-10-17', '2026-10-17T08:00:00+00:00');
  // Legacy subject form is not a normal auto-publish commit.
  write('articles/legacy.html', article(box('B0LEGACY01', 'Legacy Form Product', 'legacy.jpg')));
  shas.legacy = commit('chore: auto-publish new article 2026-10-16', '2026-10-16T08:00:00+00:00');
  // After the as-of date: not evidence as of 2026-10-29.
  shas.future = publish('future.html', article(box('B0FUTURE01', 'Future Product', 'future.jpg')), '2026-11-02T08:00:00+00:00');
  // An article published inside the window and deleted before HEAD.
  shas.gone = publish('gone.html', article(box('B0GONEART1', 'Deleted Article Product', 'gone.jpg')), '2026-10-12T08:00:00+00:00');
  fs.rmSync(path.join(dir, 'articles', 'gone.html'));
  commit('remove gone.html', '2026-10-13T08:00:00+00:00');
  // B0REMOVED1 leaves main.html after publication.
  write('articles/main.html', fs.readFileSync(path.join(dir, 'articles/main.html'), 'utf8')
    .replace(box('B0REMOVED1', 'Removed Later Product', 'removed.jpg'), ''));
  commit('fix: drop a product', '2026-10-14T08:00:00+00:00');

  const product = (asin, name, extra = {}) => ({
    asin, name, category: 'test', tags: ['test'], affiliate_url: `https://www.amazon.com/dp/${asin}?tag=${TAG}`,
    verification_status: 'pending-verification', sources: ['articles/main.html'], ...extra,
  });
  const pool = {
    schema_version: 1,
    generated_at: '2026-08-20T00:44:45.037Z',
    source: 'test fixture',
    verification_mode: 'pending verification',
    products: [
      product('B0OUTSIDE1', 'Outside Product'),
      product('B0EDGE0001', 'Edge Product'),
      product('B0TZEDGE01', 'Timezone Edge Product'),
      product('B0TZDATE01', 'Timezone Date Product'),
      product('B0INSIDE01', 'Inside Product'),
      product('B0REMOVED1', 'Removed Later Product'),
      product('B0NEWER001', 'Newer Existing Product', { last_verified_at: '2026-10-25', verification_source: 'creators-api' }),
      product('B0OLDER001', 'Older Existing Product', { last_verified_at: '2026-01-01', verification_source: 'creators-api' }),
      product('B0TWICE001', 'Twice Published Product'),
      product('B0LINKONLY', 'Link Only Product'),
      product('B0WRONGTAG', 'Wrong Tag Product'),
      product('B0MANUAL01', 'Manual Product'),
      product('B0MODIFY01', 'Modified Later Product'),
      product('B0LEGACY01', 'Legacy Form Product'),
      product('B0FUTURE01', 'Future Product'),
      product('B0GONEART1', 'Deleted Article Product'),
      product('B0UNUSED01', 'Never Published Product'),
      product('B0VERIFIED', 'Already Verified Product', { verification_status: 'verified' }),
    ],
  };
  write('data/verified-products.json', `${JSON.stringify(pool, null, 2)}\n`);
  commit('data: pool', '2026-10-21T08:00:00+00:00');
  return { dir, shas, pool, poolFile: path.join(dir, 'data', 'verified-products.json') };
}

function run(repo, extraArgs) {
  return execFileSync('node', [SCRIPT, '--repo', repo.dir, '--as-of', AS_OF, ...extraArgs], { encoding: 'utf8' });
}

function readPool(repo) {
  return JSON.parse(fs.readFileSync(repo.poolFile, 'utf8'));
}

function byAsin(document) {
  return new Map(document.products.map(product => [product.asin, product]));
}

function main() {
  const repo = buildRepo();
  try {
    const original = fs.readFileSync(repo.poolFile, 'utf8');

    // Dry run: prints evidence, writes nothing, working tree stays clean.
    const dry = run(repo, []);
    assert.strictEqual(fs.readFileSync(repo.poolFile, 'utf8'), original, 'dry run must not modify the pool file');
    assert.strictEqual(sh(repo.dir, ['status', '--porcelain']).trim(), '', 'dry run must leave the working tree clean');
    assert.ok(/Dry run: \d+ product\(s\) would be updated/.test(dry), 'dry run states it did not write');
    assert.ok(dry.includes(repo.shas.main), 'dry run prints the evidence table with commit SHAs');

    // Real run.
    const evidenceFile = path.join(repo.dir, 'out', 'evidence.md');
    run(repo, ['--write', '--evidence-out', evidenceFile]);
    const after = byAsin(readPool(repo));
    const seeded = (asin) => after.get(asin).last_verified_at;

    // Inside / outside the window (cutoff 2026-09-14 inclusive; UTC author date).
    assert.strictEqual(seeded('B0INSIDE01'), '2026-10-05');
    assert.strictEqual(seeded('B0EDGE0001'), '2026-09-14', 'exactly 45 days back is inside the window');
    assert.strictEqual(seeded('B0TZEDGE01'), '2026-09-14', 'a local 09-13 author date is 09-14 in UTC and inside the window');
    assert.strictEqual(seeded('B0TZDATE01'), '2026-10-11', 'last_verified_at is the UTC date of the author date');
    assert.strictEqual(seeded('B0OUTSIDE1'), undefined, '46 days back is outside the window');
    assert.strictEqual(seeded('B0FUTURE01'), undefined, 'a commit after the as-of date is not evidence');

    // Evidence rules: link with the site tag counts; other tags do not; non-auto-publish and legacy commits do not.
    assert.strictEqual(seeded('B0LINKONLY'), '2026-10-05', 'a /dp/ link with the site tag counts');
    assert.strictEqual(seeded('B0WRONGTAG'), undefined, 'a /dp/ link with another tag does not count');
    assert.strictEqual(seeded('B0MANUAL01'), undefined, 'non auto-publish commits are ignored');
    assert.strictEqual(seeded('B0MODIFY01'), undefined, 'an auto-publish commit that only modifies an article is not evidence');
    assert.strictEqual(seeded('B0LEGACY01'), undefined, 'the legacy "new article" subject is not a normal auto-publish commit');
    assert.strictEqual(seeded('B0REMOVED1'), undefined, 'an ASIN removed from the article by HEAD is not seeded');
    assert.strictEqual(seeded('B0GONEART1'), undefined, 'an article deleted by HEAD is not evidence');
    assert.strictEqual(seeded('B0UNUSED01'), undefined);

    // Most recent qualifying commit wins.
    assert.strictEqual(seeded('B0TWICE001'), '2026-10-20');

    // verification_source / last_verified_at semantics for existing values.
    assert.strictEqual(seeded('B0NEWER001'), '2026-10-25', 'a newer existing last_verified_at is never lowered');
    assert.strictEqual(after.get('B0NEWER001').verification_source, 'creators-api', 'a preserved entry keeps its source');
    assert.strictEqual(seeded('B0OLDER001'), '2026-10-05', 'an older existing last_verified_at is advanced');
    assert.strictEqual(after.get('B0OLDER001').verification_source, 'published-history');
    assert.strictEqual(after.get('B0INSIDE01').verification_source, 'published-history');

    // Never adds products; ASIN not in the pool is ignored everywhere.
    const originalMap = byAsin(JSON.parse(original));
    assert.deepStrictEqual([...after.keys()], [...originalMap.keys()], 'the product list (ASINs and order) is unchanged');
    assert.ok(!after.has('B0NOPOOL01'));
    const report = fs.readFileSync(evidenceFile, 'utf8');
    assert.ok(!report.includes('B0NOPOOL01'), 'an ASIN that is not in the pool is not in the evidence table');

    // verification_status is never touched, and nothing else about an entry changes.
    for (const [asin, product] of after) {
      const before = originalMap.get(asin);
      assert.strictEqual(product.verification_status, before.verification_status, `${asin} verification_status untouched`);
      const strip = ({ last_verified_at, verification_source, ...rest }) => rest;
      assert.deepStrictEqual(strip(product), strip(before), `${asin} has no other change`);
    }
    assert.strictEqual(after.get('B0VERIFIED').verification_status, 'verified');
    assert.strictEqual(after.get('B0INSIDE01').verification_status, 'pending-verification');

    // Evidence table: SHA, date, article, local image flag.
    assert.ok(report.includes(`| B0INSIDE01 | Inside Product | articles/main.html | ${repo.shas.main} | 2026-10-05 | yes |`), 'evidence row with a committed local image');
    assert.ok(report.includes(`| B0LINKONLY | Link Only Product | articles/main.html | ${repo.shas.main} | 2026-10-05 | no |`), 'evidence row without a local image');
    assert.ok(report.includes(`| B0TWICE001 | Twice Published Product | articles/twice.html | ${repo.shas.twice} | 2026-10-20 | no | ${repo.shas.main.slice(0, 7)} |`), 'evidence row lists other qualifying commits');
    assert.ok(report.includes(`${repo.shas.marker} | 2026-10-06 | chore: auto-publish marker-only.html on 2026-10-06 | skipped`), 'the marker-only commit is listed as skipped');

    // Idempotent: a second run changes nothing, byte for byte.
    const once = fs.readFileSync(repo.poolFile, 'utf8');
    const second = run(repo, ['--write']);
    assert.strictEqual(fs.readFileSync(repo.poolFile, 'utf8'), once, 'second run leaves the file byte-identical');
    assert.ok(/--write: 0 product\(s\) updated/.test(second), 'second run reports zero updates');

    // A narrower window drops the older commits and still never lowers anything.
    const narrow = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-history-narrow-'));
    fs.mkdirSync(path.join(narrow, 'data'));
    const narrowPool = path.join(narrow, 'data', 'verified-products.json');
    fs.writeFileSync(narrowPool, original);
    execFileSync('node', [SCRIPT, '--repo', repo.dir, '--pool', narrowPool, '--as-of', AS_OF, '--window-days', '10', '--write'], { encoding: 'utf8' });
    const narrowed = byAsin(JSON.parse(fs.readFileSync(narrowPool, 'utf8')));
    assert.strictEqual(narrowed.get('B0TWICE001').last_verified_at, '2026-10-20');
    assert.strictEqual(narrowed.get('B0INSIDE01').last_verified_at, undefined, '--window-days 10 excludes the 10-05 commit');
    fs.rmSync(narrow, { recursive: true, force: true });

    console.log('seed-verified-from-history tests passed');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
}

main();
