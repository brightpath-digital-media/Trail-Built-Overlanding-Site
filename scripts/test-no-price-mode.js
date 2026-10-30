#!/usr/bin/env node
/**
 * Offline test for the permanent no-price content mode.
 *
 * Builds a full article from a fixture pool (local images only, no network, no model call)
 * and greps the generated HTML and JSON-LD for any price, stock, discount, rating or review
 * claim. The grep here is independent of scripts/no-price-claims.js on purpose: it checks the
 * generator's own templates, while no-price-claims.js polices model prose. The finished page
 * must also pass the unchanged blocking commerce gate, scripts/validate-guide-commerce.py.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  buildHTML, conformProductBoxes, extractProductSchemaRecords, fallbackMeta,
} = require('./generate-article');
const { assertNoPriceClaims, findPriceClaims } = require('./no-price-claims');

const root = path.join(__dirname, '..');
const slug = 'best-__generator-content-mode-stub';
const articlePath = path.join(root, 'articles', `${slug}.html`);
const asins = ['B0NOPRC001', 'B0NOPRC002', 'B0NOPRC003', 'B0NOPRC004', 'B0NOPRC005', 'B0NOPRC006'];

function realImagePath() {
  const dir = path.join(root, 'assets', 'product-images');
  return `assets/product-images/${fs.readdirSync(dir).find(name => /\.(jpe?g|png|webp)$/i.test(name))}`;
}

const pool = new Map(asins.map((asin, index) => [asin, {
  asin,
  name: `Stub Trail Product ${index + 1}`,
  tags: ['stub', 'trail'],
  // A known local file: the card must use it and nothing may be downloaded.
  image_local_path: realImagePath(),
  // Even if a lookup returned a title or CDN URL, nothing price-like may come out.
  amazon_title: `Stub Trail Product ${index + 1}`,
  image_url: `https://example.invalid/${asin}.jpg`,
}]));

// What the model returns: link text such as "Check price" is replaced by the canonical card.
const modelBody = `<p>Choosing recovery and camp gear starts with published specifications and fitment, not with guesswork.</p>
<h2>Top Picks</h2>
${asins.map((asin, index) => `<div class="product-box" data-product="Stub Trail Product ${index + 1}" data-asin="${asin}"><h4>Stub Trail Product ${index + 1}</h4><p>A fixed editorial summary of product ${index + 1}, rated for trail use per its published specifications.</p><ul><li>Published dimensions support packing plans</li><li>Fitment notes are listed by the manufacturer</li></ul><a href="https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20">Check price on Amazon</a></div>`).join('\n')}
<h2 id="faq">FAQ</h2>
<h3>How should I compare these products?</h3><p>Compare published dimensions, fitment, and warranty terms from each manufacturer.</p>
<h3>Where do I confirm current details?</h3><p>Open the Amazon page for the pick you like and confirm fitment for your vehicle.</p>
<h3>Are these ranked?</h3><p>No. They are drawn from the approved pool and presented in a fixed order.</p>`;

function between(html, open, close) {
  const start = html.indexOf(open);
  return start === -1 ? '' : html.slice(start, html.indexOf(close, start));
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

function jsonKeys(node, keys = []) {
  if (Array.isArray(node)) node.forEach(child => jsonKeys(child, keys));
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) { keys.push(key); jsonKeys(value, keys); }
  return keys;
}

async function run() {
  assert.deepStrictEqual(findPriceClaims(modelBody), [], 'the fixture model output must itself be clean');

  const forbidDownload = async () => { throw new Error('no download may happen: local images only'); };
  const conformed = await conformProductBoxes(modelBody, pool, slug, forbidDownload);
  const products = extractProductSchemaRecords(conformed.bodyHTML, pool);
  const html = buildHTML({
    slug,
    title: 'Best Stub Trail Products 2026 — Trail Built',
    description: fallbackMeta('stub trail products').description,
    ogImage: 'https://images.pexels.com/photos/1/stub.jpeg',
    topic: 'stub trail products',
    bodyHTML: conformed.bodyHTML,
    date: '2026-10-30',
    dateHuman: 'October 30, 2026',
    products,
  });

  // 1. Whole page: no dollar sign, no currency words after digits, no offers, stock or discount wording.
  for (const [label, pattern] of [
    ['dollar sign', /\$/],
    ['digits then currency word', /\d\s*(?:dollars?|usd|bucks|cents)\b/i],
    ['offers', /offers/i],
    ['in stock', /in stock/i],
    ['discount', /discount/i],
  ]) {
    assert.ok(!pattern.test(html), `generated page contains ${label}: ${pattern.exec(html)?.[0]}`);
  }

  // 2. Regions that carry the article's own claims: JSON-LD, title/meta, h1, intro, article body.
  //    The permitted button text and the hidden empty catalog slots are removed first.
  const permittedStripped = fragment => fragment
    .replace(/<a class="btn-amazon"[^>]*>Check current price on Amazon<\/a>/g, ' ')
    .replace(/<div class="guide-product-meta">[\s\S]*?<\/div>/g, ' ');
  // The site section called "Reviews" (breadcrumb, nav) is navigation, not a review claim:
  // it is cut out of the breadcrumb block and the header, nothing else.
  const ldBlocks = jsonLdBlocks(html);
  const breadcrumb = ldBlocks.filter(block => /"BreadcrumbList"/.test(block)).join('\n').replace(/"name":\s*"Reviews"[^}]*\}/g, '');
  const regions = {
    'JSON-LD': ldBlocks.filter(block => !/"BreadcrumbList"/.test(block)).join('\n'),
    'breadcrumb JSON-LD': breadcrumb,
    'head meta': between(html, '<title>', '<link rel="icon"'),
    'article header': (html.match(/<h1>[\s\S]*?<\/h1>/) || [''])[0] + (html.match(/<p class="article-intro">[\s\S]*?<\/p>/) || [''])[0],
    'article body': permittedStripped(between(html, '<article class="article-body">', '</article>')),
  };
  for (const [name, text] of Object.entries(regions)) {
    assert.ok(text.length > 100, `region ${name} must not be empty`);
    for (const [label, pattern] of [
      ['price', /price/i],
      ['rating', /rating/i],
      ['reviews', /reviews/i],
      ['stock', /\bstock\b/i],
      ['availability', /availab/i],
      ['sale', /\bsale\b/i],
      ['stars', /\bstars?\b/i],
    ]) {
      assert.ok(!pattern.test(text), `${name} contains ${label}: ${pattern.exec(text)?.[0]}`);
    }
  }

  // 3. JSON-LD structure: an ItemList and an FAQPage, with no commerce properties at any depth.
  const blocks = jsonLdBlocks(html).map(JSON.parse);
  const types = blocks.map(block => block['@type']);
  assert.ok(types.includes('ItemList') && types.includes('FAQPage'));
  const forbiddenKeys = new Set(['offers', 'offer', 'price', 'pricecurrency', 'availability', 'aggregaterating', 'review', 'reviewrating', 'ratingvalue', 'reviewcount']);
  for (const key of blocks.flatMap(block => jsonKeys(block))) {
    assert.ok(!forbiddenKeys.has(key.toLowerCase()), `JSON-LD carries commerce property ${key}`);
  }

  // 4. Product cards: canonical button text, hidden empty slots, tagged direct links, local images only.
  const cards = html.match(/<div class="product-box"[\s\S]*?(?=<div class="product-box"|<h2 id="faq"|<\/article>)/g) || [];
  assert.strictEqual(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /<a class="btn-amazon"[^>]*>Check current price on Amazon<\/a>/);
    assert.match(card, /<span class="price"[^>]*data-catalog-price=""[^>]*hidden=""><\/span>/);
    assert.match(card, /href="https:\/\/www\.amazon\.com\/dp\/B0NOPRC00\d\?tag=trailbuiltove-20"/);
    assert.match(card, /<img alt="[^"]{12,}"[^>]*src="\.\.\/assets\/product-images\/[^"]+"/);
  }
  assert.ok(!/<img[^>]*(?:amazon|example\.invalid)/i.test(html), 'no hotlinked Amazon or CDN image');

  // 5. The unchanged blocking commerce gate accepts the finished page.
  fs.writeFileSync(articlePath, html, 'utf8');
  try {
    const output = execFileSync('python3', ['scripts/validate-guide-commerce.py'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(output.trim());
  } finally {
    fs.rmSync(articlePath, { force: true });
  }

  // 6. The finished-page assertion accepts it, and the detector flags real claims.
  assertNoPriceClaims(html, { mode: 'page' });
  const flagged = [
    '<p>The jack costs $49 today.</p>',
    '<p>It is only 49 dollars.</p>',
    '<p>Currently in stock and ready to ship.</p>',
    '<p>Rated 4.6 stars by buyers.</p>',
    '<p>Over 12,000 reviews agree.</p>',
    '<p>Customer reviews are positive.</p>',
    '<p>A big discount this week.</p>',
    '<p>Pricing varies by size.</p>',
    '<p>Check availability before you go.</p>',
    '<p>It is on sale now.</p>',
    '<div class="product-box" data-asin="B0NOPRC001"><p>Only £30.</p><a href="https://www.amazon.com/dp/B0NOPRC001?tag=t">Go</a></div>',
  ];
  for (const fragment of flagged) assert.ok(findPriceClaims(fragment).length > 0, `should flag: ${fragment}`);
  // Ordinary technical prose is not a claim.
  for (const fragment of [
    '<p>Recovery points rated for 12,000 lb with a published load rating.</p>',
    '<p>The manufacturer offers a five-year warranty and a lower-cost kit.</p>',
  ]) assert.deepStrictEqual(findPriceClaims(fragment), [], `should not flag: ${fragment}`);
  // Link text inside a product box is replaced by the canonical card, so it is not scanned there...
  assert.deepStrictEqual(findPriceClaims('<div class="product-box" data-asin="B0NOPRC001"><p>Fine.</p><a href="https://www.amazon.com/dp/B0NOPRC001?tag=t">Check price</a></div>'), []);
  // ...but price wording in prose links outside a box still is.
  assert.ok(findPriceClaims('<p>See the <a href="https://www.amazon.com/dp/B0NOPRC001?tag=t">current price</a>.</p>').length > 0);
  // Page mode: schema keys and a non-canonical button are caught.
  for (const key of ['offers', 'offer', 'price', 'priceCurrency', 'priceValidUntil', 'lowPrice', 'highPrice', 'availability', 'aggregateRating', 'review', 'reviewRating', 'ratingValue', 'ratingCount', 'reviewCount']) {
    const withKey = html.replace('"numberOfItems"', `"${key}":"x","numberOfItems"`);
    assert.throws(() => assertNoPriceClaims(withKey, { mode: 'page' }), /commerce schema property/, `JSON-LD key ${key} must be rejected`);
  }
  const withFaqClaim = html.replace('"text":"Compare published', '"text":"Rated 4.8 stars. Compare published');
  assert.notStrictEqual(withFaqClaim, html, 'fixture FAQ text must be where the test expects it');
  assert.throws(() => assertNoPriceClaims(withFaqClaim, { mode: 'page' }), /star rating/, 'prose inside JSON-LD is scanned');
  const withPriceSlug = html.replace(/"url":"https:\/\/trailbuiltoverland\.com\/articles\/[^"]+"/, '"url":"https://trailbuiltoverland.com/articles/best-price-checked-gear.html"');
  assertNoPriceClaims(withPriceSlug, { mode: 'page' });
  const withBadButton = html.replace('Check current price on Amazon', 'Check current price on Amazon from 49 dollars');
  assert.throws(() => assertNoPriceClaims(withBadButton, { mode: 'page' }), /money amount|price wording/);
  assert.deepStrictEqual(findPriceClaims(fallbackMeta('stub trail products').title + fallbackMeta('stub trail products').description), []);

  // 7. The wiring stays in place: model output is checked inside the retry loop, the finished
  //    page is checked before it is written, and the prompt forbids the claims.
  const generator = fs.readFileSync(path.join(__dirname, 'generate-article.js'), 'utf8');
  assert.ok(/const priceClaims = findPriceClaims\(bodyHTML\);\s+if \(priceClaims\.length > 0\)/.test(generator), 'model output must be checked in the retry loop');
  assert.ok(generator.indexOf("assertNoPriceClaims(html, { mode: 'page' })") !== -1
    && generator.indexOf("assertNoPriceClaims(html, { mode: 'page' })") < generator.indexOf('fs.writeFileSync(outPath, html)'), 'the finished page must be checked before it is written');
  assert.ok(/attemptCauses\.push\('price-claims'\);\s+lastPriceClaims = priceClaims;/.test(generator), 'a price-claim failure must be recorded as its own cause');
  assert.ok(/throw new Error\(generationFailureMessage\(attemptCauses, MAX_ASIN_RETRIES, lastPriceClaims\)\)/.test(generator), 'the exhausted loop must name its cause');
  assert.ok(/NO-PRICE MODE: never state or imply a price/.test(generator), 'the prompt must forbid price claims');

  console.log('No-price mode test passed: generated HTML and JSON-LD carry no price, stock, discount, rating or review claim.');
}

run().catch(error => {
  fs.rmSync(articlePath, { force: true });
  console.error(error);
  process.exit(1);
});
