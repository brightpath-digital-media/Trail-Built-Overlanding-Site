#!/usr/bin/env node
/**
 * Test: addArticleToIndex() guards in generate-article.js.
 *
 * addArticleToIndex is not exported and INDEX_FILE is hard-wired to
 * <scripts dir>/../index.html, so this test never touches the real homepage.
 * Instead it builds a throw-away site tree in the OS temp dir:
 *
 *   <tmp>/scripts/generate-article.js   copy of the REAL file, with one line
 *                                       appended that exports addArticleToIndex
 *   <tmp>/scripts/asin-verification.js  copy (generate-article.js requires it)
 *   <tmp>/scripts/sync-homepage-latest.js copy (addArticleToIndex runs it)
 *   <tmp>/data/hero-images.json         copy (generate-article.js loads it at require time)
 *   <tmp>/index.html + <tmp>/articles/  small fixtures
 *
 * Because INDEX_FILE and the sync script resolve relative to the copied
 * script's own location, every write lands in the temp tree. The real
 * scripts/generate-article.js is only read, never modified, and the CLI main()
 * is never run (it is guarded by `require.main === module`).
 *
 * Covered:
 *   1. A new slug inserts exactly one card, escaped, inside the reviews grid,
 *      newest-first, without dropping existing cards.
 *   2. A missing reviews grid (or missing reviews section) throws the
 *      "canonical reviews grid not found" error and leaves index.html untouched.
 *   3. A second call with the same slug is idempotent (no duplicate card).
 *   4. A missing index.html is a silent no-op (existing early return).
 *
 * Known gap (documented, deliberately not asserted): the grid lookup is
 * html.indexOf('<div class="grid-3">', reviewsStart) with no upper bound, so if
 * the reviews grid disappears but ANY later <div class="grid-3"> exists, the card
 * is inserted into that other grid and index.html is written before
 * sync-homepage-latest.js then fails. The fixtures below therefore contain no
 * grid-3 after the reviews section in the "missing grid" cases.
 *
 * Not covered: the "String.replace produced no change" guard. After the grid
 * is located the card is always a non-empty insertion, so that branch cannot be
 * reached through the public inputs; it is defensive dead code today.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const REAL_GENERATOR = path.join(SCRIPTS_DIR, 'generate-article.js');
const GRID_MARKER = '<div class="grid-3">';

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed += 1;
  } else {
    console.error(`  ✗  ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function articleFixture(slug, date) {
  return `<!DOCTYPE html><html><head><title>${slug}</title>
<script type="application/ld+json">{"@type":"Article","datePublished":"${date}"}</script>
</head><body><main></main></body></html>\n`;
}

function cardFixture(slug, title, date) {
  return `<div class="card">
<div class="card-img"><img alt="${title}" src="https://example.test/${slug}.jpg?w=600"/></div>
<div class="card-body">
<h3><a href="articles/${slug}.html">${title}</a></h3>
<span class="card-date">${date}</span>
</div>
</div>`;
}

const EXISTING = [
  { slug: 'best-existing-older', date: '2026-01-05', title: 'Older Guide' },
  { slug: 'best-existing-newer', date: '2026-02-09', title: 'Newer Guide' },
];

function indexFixture({ withSection = true, withGrid = true } = {}) {
  const cards = EXISTING.map(e => cardFixture(e.slug, e.title, e.date)).join('\n');
  const inner = withGrid ? `${GRID_MARKER}\n${cards}\n</div>` : `<div class="grid-2">\n${cards}\n</div>`;
  const reviews = withSection
    ? `<section id="reviews">\n<div class="container">\n<h2>Latest</h2>\n${inner}\n</div>\n</section>\n`
    : `<section id="not-reviews">\n<div class="container">\n${inner}\n</div>\n</section>\n`;
  return `<!DOCTYPE html><html><body>
<main>
${reviews}<!-- ===== TOP PRODUCT PICKS ===== -->
<section id="top"><div class="${withGrid ? 'grid-3' : 'grid-2'}"><p>unrelated grid</p></div></section>
</main>
</body></html>
`;
}

// Build an isolated site tree and load addArticleToIndex from the copied generator.
function makeSite(indexHtml, articleSlugs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-add-article-'));
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(path.join(root, 'articles'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.copyFileSync(
    path.join(SCRIPTS_DIR, '..', 'data', 'hero-images.json'),
    path.join(root, 'data', 'hero-images.json')
  );

  const source = fs.readFileSync(REAL_GENERATOR, 'utf8');
  if (!/^function addArticleToIndex\(/m.test(source)) {
    throw new Error('generate-article.js no longer declares a top-level addArticleToIndex(); update this test.');
  }
  fs.writeFileSync(
    path.join(scriptsDir, 'generate-article.js'),
    `${source}\nmodule.exports.addArticleToIndex = addArticleToIndex;\n`
  );
  for (const helper of ['asin-verification.js', 'sync-homepage-latest.js']) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, helper), path.join(scriptsDir, helper));
  }
  if (indexHtml !== null) fs.writeFileSync(path.join(root, 'index.html'), indexHtml);
  for (const [slug, date] of Object.entries(articleSlugs)) {
    fs.writeFileSync(path.join(root, 'articles', `${slug}.html`), articleFixture(slug, date));
  }

  const generator = require(path.join(scriptsDir, 'generate-article.js'));
  return {
    root,
    indexPath: path.join(root, 'index.html'),
    addArticleToIndex: generator.addArticleToIndex,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const NEW_SLUG = 'best-overlanding-test-widgets';
const NEW_TITLE = 'Best "Test" Widgets & Gadgets 2026 - Trail Built';
const NEW_DESC = 'Compare <b>widgets</b> & gadgets.';
const NEW_DATE = 'March 2, 2026';
const NEW_IMAGE = 'https://example.test/hero.jpg?auto=compress&w=1200';
const BASE_ARTICLES = {
  'best-existing-older': '2026-01-05',
  'best-existing-newer': '2026-02-09',
  [NEW_SLUG]: '2026-03-02',
};

const sites = [];
function withSite(indexHtml, articles) {
  const site = makeSite(indexHtml, articles);
  sites.push(site);
  return site;
}

try {
  console.log('\nTest 1: a new slug inserts one escaped card at the top of the reviews grid');
  {
    const site = withSite(indexFixture(), BASE_ARTICLES);
    const before = fs.readFileSync(site.indexPath, 'utf8');
    site.addArticleToIndex(NEW_SLUG, NEW_TITLE, NEW_DESC, NEW_DATE, NEW_IMAGE);
    const after = fs.readFileSync(site.indexPath, 'utf8');

    assert('index.html changed', after !== before);
    assert('card links to the new article (title link + read-more link)',
      count(after, `href="articles/${NEW_SLUG}.html"`) === 2);
    assert('exactly one card was added', count(after, '<div class="card">') === count(before, '<div class="card">') + 1);
    assert('existing cards are preserved',
      EXISTING.every(e => after.includes(`href="articles/${e.slug}.html"`)));

    const reviewsStart = after.indexOf('<section id="reviews">');
    const gridStart = after.indexOf(GRID_MARKER, reviewsStart);
    const firstCardStart = after.indexOf('<div class="card">', gridStart);
    const newCardPos = after.indexOf(`href="articles/${NEW_SLUG}.html"`);
    const olderPos = after.indexOf(`href="articles/${EXISTING[0].slug}.html"`);
    const newerPos = after.indexOf(`href="articles/${EXISTING[1].slug}.html"`);
    assert('new card is inside the reviews grid, before the top-product comment',
      newCardPos > gridStart && newCardPos < after.indexOf('<!-- ===== TOP PRODUCT'));
    assert('new card is first (newest-first by datePublished)',
      firstCardStart !== -1 && firstCardStart < newCardPos && newCardPos < newerPos && newerPos < olderPos);
    assert('unrelated grid-3 after the reviews section is untouched',
      after.includes('<div class="grid-3"><p>unrelated grid</p></div>'));

    assert('title has the " - Trail Built" suffix stripped and is HTML-escaped',
      after.includes('Best &quot;Test&quot; Widgets &amp; Gadgets 2026</a>') && !after.includes('- Trail Built'));
    assert('description is HTML-escaped', after.includes('Compare &lt;b&gt;widgets&lt;/b&gt; &amp; gadgets.'));
    assert('date is rendered', after.includes(`<span class="card-date">${NEW_DATE}</span>`));
    assert('card image is resized to w=600', after.includes('src="https://example.test/hero.jpg?auto=compress&amp;w=600"'));
  }

  console.log('\nTest 2: a missing reviews grid throws and leaves index.html untouched');
  for (const [label, options] of [
    ['no <div class="grid-3"> inside the reviews section', { withGrid: false }],
    ['no <section id="reviews"> at all', { withSection: false }],
  ]) {
    const site = withSite(indexFixture(options), BASE_ARTICLES);
    const before = fs.readFileSync(site.indexPath, 'utf8');
    let error = null;
    try { site.addArticleToIndex(NEW_SLUG, NEW_TITLE, NEW_DESC, NEW_DATE, NEW_IMAGE); }
    catch (err) { error = err; }
    const after = fs.readFileSync(site.indexPath, 'utf8');
    assert(`${label}: throws`, error instanceof Error);
    assert(`${label}: message names the missing canonical grid`,
      !!error && /canonical reviews grid not found/.test(error.message), error && error.message);
    assert(`${label}: message says the homepage was NOT updated`,
      !!error && /homepage was NOT updated/.test(error.message));
    assert(`${label}: index.html is byte-for-byte unchanged`, after === before);
  }

  console.log('\nTest 3: a second call for the same slug does not duplicate the card');
  {
    const site = withSite(indexFixture(), BASE_ARTICLES);
    site.addArticleToIndex(NEW_SLUG, NEW_TITLE, NEW_DESC, NEW_DATE, NEW_IMAGE);
    const afterFirst = fs.readFileSync(site.indexPath, 'utf8');
    let error = null;
    try { site.addArticleToIndex(NEW_SLUG, NEW_TITLE, NEW_DESC, NEW_DATE, NEW_IMAGE); }
    catch (err) { error = err; }
    const afterSecond = fs.readFileSync(site.indexPath, 'utf8');
    assert('second call does not throw', error === null, error && error.message);
    assert('slug is linked exactly twice (still one card)',
      count(afterSecond, `href="articles/${NEW_SLUG}.html"`) === 2);
    assert('card count unchanged by the second call',
      count(afterSecond, '<div class="card">') === count(afterFirst, '<div class="card">'));
    assert('index.html is identical after the second call', afterSecond === afterFirst);
  }

  console.log('\nTest 4: a missing index.html is a silent no-op');
  {
    const site = withSite(null, BASE_ARTICLES);
    let result;
    let error = null;
    try { result = site.addArticleToIndex(NEW_SLUG, NEW_TITLE, NEW_DESC, NEW_DATE, NEW_IMAGE); }
    catch (err) { error = err; }
    assert('does not throw', error === null, error && error.message);
    assert('returns undefined', result === undefined);
    assert('does not create index.html', !fs.existsSync(site.indexPath));
  }
} finally {
  for (const site of sites) site.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
