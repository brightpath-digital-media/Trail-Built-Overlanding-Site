#!/usr/bin/env node
/**
 * Table-driven tests for scripts/no-price-claims.js: claim phrasings in fragment and page
 * mode, each also hidden behind encodings; legitimate prose that must stay clean; prose
 * attributes; JSON-LD identifier exemptions; fail-closed page containers; the canonical-card
 * fallback text; and an end-to-end hostile model body that must not reach a published page.
 * Offline; no model call.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assertNoPriceClaims, findPriceClaims, normalizeText } = require('./no-price-claims');
const {
  buildHTML, canonicalProductBox, conformProductBoxes, extractProductSchemaRecords, fallbackMeta, generationFailureMessage,
} = require('./generate-article');

const ROOT = path.join(__dirname, '..');

// Every phrase here is a price, stock, shipping, discount, rating, review-count or social-proof claim.
const CLAIMS = {
  money: [
    'Costs $49 today', 'only $49.99', 'about $ 49', '$1,299 for the kit', 'for 49 dollars', 'USD 49', 'USD49', '49 USD', '€49', '£30 shipped',
    '¥5000', '49 euros', '49 EUR', '49 GBP', '49 CAD', '49 CHF', 'fifty dollars', 'a hundred bucks', 'forty-nine dollars', 'two hundred fifty dollars',
    '99 cents', 'MSRP is higher', 'about 40 bucks', 'thousands of dollars', 'it is a few bucks', 'priced at 20 dollars', '₹4000', '$.99',
  ],
  price: [
    'The price is fair', 'prices vary', 'check the pricing', 'it is priced well', 'a pricey option', 'a cheap option', 'the cheapest choice', 'cheaper than a winch',
    'an inexpensive kit', 'a real bargain', 'the lowest cost option', 'the best price around', 'a low price',
  ],
  discount: [
    '20% off', '20 % off', '20 percent off', 'twenty percent off', 'save 20%', 'save $10', 'save up to 30 percent', 'half off', 'half-off today',
    'a markdown this week', 'marked down', 'a big discount', 'discounted gear', 'on sale now', 'for sale on Amazon', 'the sale price', 'use a coupon',
    'a good deal', 'the best deal', 'a great deal', 'an amazing deal', 'deal of the day', 'it is a steal', '20% discount', '30% savings', 'save big',
  ],
  stars: [
    '4.5 stars', '4.5-star', '5 star', 'five-star pick', 'five star pick', 'a four-star option', 'star-rated', '★★★★☆', '★ 4.5', '⭐⭐⭐⭐', '4.5/5',
    '4 out of 5', '9/10', 'rated 4.5', 'rated 4.6 by buyers', 'rated 4.5 out of 5', 'a 4.5 rating', 'rating of 4.5', 'rating: 4.5', 'a top-rated pick',
    'highly rated by owners', 'best-rated option', 'well-rated overall', 'poorly rated', 'a review score of 9', 'the rating score', 'customer rating', 'star rating',
    'average rating', 'Amazon rating', 'owner ratings', 'rated 5.',
  ],
  reviews: [
    '12,000 reviews', '12k reviews', '12K ratings', '3,400 customer reviews', '1.2k verified reviews', 'thousands of reviews', 'hundreds of ratings',
    'countless reviewers', 'customer reviews', 'verified reviews', 'owner reviews', 'Amazon reviews', 'the review count', 'positive reviews', 'glowing reviews',
    'customers love it', 'reviewers say it works', 'owners report no issues', 'buyers praise it', 'users complain about noise', 'shoppers rave about it',
    'according to reviewers', 'according to customers', 'two thousand reviews', 'ten reviews', 'thousands of customers',
  ],
  seller: [
    'a bestseller', 'a best seller', 'a best-seller', '#1 Best Seller', '# 1 best pick', '#1 pick', "Amazon's Choice", 'Amazon’s Choice', 'Amazon Choice',
    'ships with Prime', 'a Prime pick', 'Prime eligible', 'Prime-eligible', 'Amazon Prime', 'free shipping', 'free delivery', 'free returns', 'fast shipping',
    'a limited time offer', 'a limited-time run', 'while supplies last', 'ships in 2 days', 'ships within 3 days', 'ships today', 'ships tomorrow', 'a top seller',
  ],
  stock: [
    'in stock', 'in-stock now', 'out of stock', 'out-of-stock', 'sold out', 'sold-out', 'it is backordered', 'back-ordered', 'on backorder', 'available now',
    'currently available', 'currently unavailable', 'available on Amazon', 'available at Amazon', 'only 3 left', 'only 3 left in stock', '3 left in stock',
    'limited stock', 'check availability', 'current availability', 'Amazon availability', 'product availability', 'availability varies', 'subject to availability',
  ],
  hostile: [
    'Costs &#36;49 today, a five-star pick with free shipping, 20% off, a bestseller with Prime',
    'Only &#x24;49', 'Only &dollar;49', 'Only &euro;49', 'Only &pound;30', 'Only &yen;500', 'Only $​49', 'Only $­49', 'Only ＄49', 'Only &amp;#36;49',
    'Only &#36;&#52;&#57;', 'Only &nbsp;$49', 'Only $<b>49</b>', 'Only $<!-- x -->49', 'the pri<b>ce</b>', 'the pri&shy;ce', 'the p​rice', 'the ｐｒｉｃｅ', 'in stock',
    'in&nbsp;stock', 'five&#8209;star', '4.5&#8211;star', 'free&nbsp;shipping', '4&#46;5 stars', 'twenty&nbsp;percent&nbsp;off',
  ],
};

// Legitimate prose that must NOT be flagged.
const CLEAN = [
  'Recovery points rated for 12,000 lb', 'rated at 9,500 lb with the stock hardware', 'a published load rating of 5,000 lb', 'WLL-rated 3/4" D-rings', 'rated 10,000 lb',
  'the manufacturer offers a five-year warranty', 'Hi-Lift offers a 48 inch jack', 'good ground clearance', 'better approach angles and clearance', 'parts availability in remote areas',
  'fuel availability limits range', 'water availability at camp', 'a prime mover for heavy loads', 'a prime campsite near the creek', 'lower cost of ownership than a winch',
  'the total cost of a build', 'plan a budget build', 'the lowest rated limit in the system', 'an IP67 rating', 'the rating plate on the hitch', 'a five-year warranty',
  'a 35-inch tire on a 17-inch wheel', 'a 12 volt system with a 30 amp breaker', 'weights from 143 lb to 294 lb', 'a 10,000 lb winch', 'save weight where you can',
  'saves 5 lb of weight', 'save space in the cargo area', 'deal with dust at every stop', 'the review process for specifications', 'compare published specifications',
  'owner-reported fitment notes from the manufacturer', 'a one-person tent for solo trips', 'the Big Agnes listing does not state a setup time', 'rated capacity is printed on the tag',
  'hauling gear on a 4x4 rig', 'a 2.5 inch lift', 'the 9,500 lb class', 'a rating of 12 amps on the fuse', 'rating of 5,000 lb at the hitch', 'a 30 amp rating',
];

const page = (body, extra = '') => `<!doctype html><html lang="en"><head><title>Best Stub Gear 2026 — Trail Built</title><meta name="description" content="Research-based gear guide for stub gear." /><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Best Stub Gear","url":"https://trailbuiltoverland.com/articles/best-stub-gear.html"}</script>${extra}</head><body><h1>Best Stub Gear</h1><p class="article-intro">An introduction to stub gear.</p><article class="article-body">${body}</article></body></html>`;

// Forms in which a phrase can arrive: plain, then hidden behind encodings.
const entityEncode = text => [...text].map(char => (/[A-Za-z0-9]/.test(char) ? `&#${char.codePointAt(0)};` : char)).join('');
const FORMS = {
  plain: text => text,
  zeroWidth: text => text.replace(/([A-Za-z0-9])/g, '$1​'),
  softHyphen: text => text.replace(/([A-Za-z])([A-Za-z])/g, '$1­$2'),
  fullwidth: text => text.replace(/[A-Za-z0-9$%#]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)),
  numericEntities: entityEncode,
  doubleEncoded: text => entityEncode(text).replace(/&#/g, '&amp;#'),
  tripleEncoded: text => entityEncode(text).replace(/&#/g, '&amp;amp;#'),
};

function testTables() {
  let cases = 0;
  for (const [group, phrases] of Object.entries(CLAIMS)) {
    for (const phrase of phrases) {
      const forms = group === 'hostile' ? { plain: FORMS.plain } : FORMS;
      for (const [formName, transform] of Object.entries(forms)) {
        const text = transform(phrase);
        // Fullwidth forms of $ and % only exist for the ASCII symbols; # and the rest are covered by NFKC too.
        assert.ok(findPriceClaims(`<p>${text}</p>`).length > 0, `fragment mode must flag [${group}/${formName}] ${JSON.stringify(text)}`);
        assert.throws(() => assertNoPriceClaims(page(`<p>${text}</p>`), { mode: 'page' }), /Blocking publish/, `page mode must flag [${group}/${formName}] ${JSON.stringify(text)}`);
        cases += 2;
      }
    }
  }
  assert.ok(cases >= 1000, `table should be large (got ${cases})`);
  for (const phrase of CLEAN) {
    assert.deepStrictEqual(findPriceClaims(`<p>${phrase}</p>`), [], `fragment mode must not flag ${JSON.stringify(phrase)}`);
    assert.doesNotThrow(() => assertNoPriceClaims(page(`<p>${phrase}</p>`), { mode: 'page' }), `page mode must not flag ${JSON.stringify(phrase)}`);
  }
  assert.deepStrictEqual(findPriceClaims(page('<p>Plain editorial text about fitment.</p>'), { mode: 'page' }), []);
  assert.strictEqual(normalizeText('&#36;&#x34;9​ ＄'), '$49 $');
  return cases;
}

function testAttributes() {
  const attributes = [
    'alt="Only $49"', 'title="Now 20% off"', 'aria-label="five-star pick"', 'data-note="in stock"', 'data-catalog-price="$39.99"',
    'data-catalog-availability="In stock"', 'data-catalog-badge="Best Seller"', "data-x='free shipping'", 'data-y=pricing', 'alt="&#36;49"',
  ];
  for (const attribute of attributes) {
    const body = `<p>Clean prose.</p><div class="product-box" data-asin="B0TESTAAAA"><img ${attribute} src="../assets/product-images/x.jpg"/></div>`;
    assert.ok(findPriceClaims(body).length > 0, `fragment mode must flag attribute ${attribute}`);
    assert.throws(() => assertNoPriceClaims(page(body), { mode: 'page' }), /Blocking publish/, `page mode must flag attribute ${attribute}`);
    // The same attribute on a catalog slot inside the permitted meta div.
    const slot = `<div class="guide-product-meta"><span class="price" ${attribute.replace(/^[a-z-]+=/, 'data-catalog-price=')} hidden></span></div>`;
    assert.throws(() => assertNoPriceClaims(page(slot), { mode: 'page' }), /Blocking publish/, `filled slot ${attribute}`);
  }
  // A filled slot's text is a claim; an empty slot is permitted.
  const empty = '<div class="guide-product-meta"><span class="price" data-asin="B0TESTAAAA" data-catalog-price="" hidden></span><span class="guide-availability" data-asin="B0TESTAAAA" data-catalog-availability="" hidden></span><span class="guide-catalog-badge" data-asin="B0TESTAAAA" data-catalog-badge="" hidden></span></div>';
  assert.doesNotThrow(() => assertNoPriceClaims(page(empty), { mode: 'page' }));
  assert.throws(() => assertNoPriceClaims(page(empty.replace('hidden></span><span class="guide-availability"', 'hidden>$39.99</span><span class="guide-availability"')), { mode: 'page' }), /money amount/);
  assert.throws(() => assertNoPriceClaims(page(empty.replace('data-catalog-availability="" hidden></span>', 'data-catalog-availability="" hidden>In stock</span>')), { mode: 'page' }), /stock/);
  // The permitted button is exactly the canonical text on a btn-amazon anchor, nothing else.
  const button = text => `<a class="btn-amazon" data-asin="B0TESTAAAA" href="https://www.amazon.com/dp/B0TESTAAAA?tag=trailbuiltove-20" rel="sponsored nofollow noopener" target="_blank">${text}</a>`;
  assert.doesNotThrow(() => assertNoPriceClaims(page(button('Check current price on Amazon')), { mode: 'page' }));
  assert.throws(() => assertNoPriceClaims(page(button('Check current price on Amazon from 49 dollars')), { mode: 'page' }), /Blocking publish/);
  assert.throws(() => assertNoPriceClaims(page(button('Buy now for less')), { mode: 'page' }) || assertNoPriceClaims(page(button('See the price')), { mode: 'page' }), /Blocking publish/);
  assert.throws(() => assertNoPriceClaims(page('<a class="other" href="https://www.amazon.com/dp/B0TESTAAAA">Check current price on Amazon</a>'), { mode: 'page' }), /price wording/, 'the exemption is for the canonical button class only');
  // Non-prose attributes are not scanned: class, href, src, data-asin, on* handlers.
  assert.deepStrictEqual(findPriceClaims(page('<a class="price-tag" href="https://www.amazon.com/dp/B0TESTAAAA?tag=x&ref=deal" data-asin="B0TESTAAAA" id="sale">Read more</a><img src="../assets/product-images/free-shipping.jpg" alt="Trail Jack overlanding gear"/>'), { mode: 'page' }), []);
  // A bad meta description is caught from the head, and og:title too.
  assert.throws(() => assertNoPriceClaims(page('<p>ok</p>').replace('Research-based gear guide', 'Gear at 20% off'), { mode: 'page' }), /Blocking publish/);
  assert.throws(() => assertNoPriceClaims(page('<p>ok</p>', '<meta property="og:title" content="Only $49" />'), { mode: 'page' }), /Blocking publish/);
}

function testJsonLdIdentifiers() {
  const ld = json => page('<p>ok</p>').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(json)}</script>`);
  const clean = { '@context': 'https://schema.org', '@type': 'ItemList', url: 'https://trailbuiltoverland.com/articles/best-price-checked-gear.html', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'Product', name: 'Stub Jack', sku: 'B0TESTAAAA', url: 'https://www.amazon.com/dp/B0TESTAAAA?tag=trailbuiltove-20' } }] };
  assert.doesNotThrow(() => assertNoPriceClaims(ld(clean), { mode: 'page' }), 'real URLs, SKUs and type tokens stay exempt');
  const hostile = {
    'url with prose': { url: 'https://trailbuiltoverland.com/ costs $49' },
    'item as prose': { item: 'pricing' },
    'sku as prose': { sku: 'Costs $49 today' },
    'type with prose': { '@type': 'Product $49' },
    'image as prose': { image: 'five-star pick' },
    'context as prose': { '@context': 'on sale now' },
    '@id as prose': { '@id': '20% off' },
    'logo as prose': { logo: 'free shipping' },
    'sameAs as prose': { sameAs: 'in stock' },
  };
  for (const [name, fields] of Object.entries(hostile)) {
    assert.throws(() => assertNoPriceClaims(ld({ '@context': 'https://schema.org', '@type': 'Thing', ...fields }), { mode: 'page' }), /Blocking publish/, name);
  }
}

function testFailClosed() {
  const good = page('<p>ok</p>');
  assert.deepStrictEqual(findPriceClaims(good, { mode: 'page' }), []);
  const broken = {
    'article-body': good.replace('class="article-body"', 'class="article-text"'),
    'article-intro': good.replace('class="article-intro"', 'class="intro"'),
    h1: good.replace(/<h1>[\s\S]*?<\/h1>/, ''),
    title: good.replace(/<title>[\s\S]*?<\/title>/, ''),
    'application/ld+json': good.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''),
  };
  for (const [container, html] of Object.entries(broken)) {
    assert.throws(() => assertNoPriceClaims(html, { mode: 'page' }), error => /expected container missing/.test(error.message) && error.message.includes(container), `missing ${container} must fail closed by name`);
  }
}

function testCanonicalFallbackText() {
  // A box with no <p> and no <li> takes the canonical fallback reasons.
  const bare = '<div class="product-box" data-asin="B0TESTAAAA" data-product="Stub Jack"><h4>Stub Jack</h4></div>';
  const card = canonicalProductBox(bare, { asin: 'B0TESTAAAA', name: 'Stub Jack' }, 'assets/product-images/x.jpg');
  assert.ok(card.includes('is drawn from the approved Trail Built product pool'));
  assert.ok(!/runtime-verified/.test(card));
  assert.deepStrictEqual(findPriceClaims(card), [], 'the fallback card text is claim-free');
  assert.doesNotThrow(() => assertNoPriceClaims(page(card), { mode: 'page' }));
  for (const forbidden of [/\$/, /price(?! on Amazon)/i, /\bstock\b/i, /rating/i, /reviews/i, /offer/i, /discount/i, /availab/i]) {
    assert.ok(!forbidden.test(card.replace(/<div class="guide-product-meta">[\s\S]*?<\/div>/, '').replace(/>Check current price on Amazon</, '><')), `fallback card contains ${forbidden}`);
  }
  // fallbackMeta: no double "best", no claims.
  const meta = fallbackMeta('best overlanding fridges');
  assert.strictEqual(meta.title, 'Best overlanding fridges 2026 — Trail Built');
  assert.ok(!/best best/i.test(`${meta.title} ${meta.description}`));
  assert.strictEqual(fallbackMeta('overlanding fridges').title, 'Best overlanding fridges 2026 — Trail Built');
  assert.deepStrictEqual(findPriceClaims(`${meta.title} ${meta.description}`), []);
}

function testFailureMessages() {
  const old = n => `[asin-precheck] Blocking publish: no generated draft passed ASIN and local-product-image validation after ${n} attempts.`;
  const claims = [{ where: 'body', kind: 'money amount', match: '$49' }];
  assert.strictEqual(generationFailureMessage(['asin-or-image', 'asin-or-image', 'asin-or-image'], 3), old(3), 'the old cause keeps the old message exactly');
  const priceOnly = generationFailureMessage(['price-claims', 'price-claims', 'price-claims'], 3, claims);
  assert.match(priceOnly, /^\[no-price\] Blocking publish: 3 of 3 generated draft\(s\) contained price, stock, rating or review claims/);
  assert.ok(!priceOnly.includes('local-product-image validation'), 'a price-claim failure must not blame ASINs or images');
  const mixed = generationFailureMessage(['price-claims', 'asin-or-image', 'asin-or-image'], 3, claims);
  assert.ok(mixed.startsWith('[no-price]') && mixed.endsWith(old(3)));
}

async function testHostileEndToEnd() {
  const asins = ['B0HOSTILE1', 'B0HOSTILE2', 'B0HOSTILE3', 'B0HOSTILE4', 'B0HOSTILE5'];
  const imagePath = `assets/product-images/${fs.readdirSync(path.join(ROOT, 'assets', 'product-images')).find(name => /\.(jpe?g|png|webp)$/i.test(name))}`;
  const pool = new Map(asins.map((asin, index) => [asin, { asin, name: `Hostile Product ${index + 1}`, tags: ['x'], image_local_path: imagePath }]));
  const hostile = 'Costs &#36;49 today, a five-star pick with free shipping, 20% off, a bestseller with Prime';
  const body = `<p>Intro text.</p><h2>Top Picks</h2>${asins.map((asin, index) => `<div class="product-box" data-product="Hostile Product ${index + 1}" data-asin="${asin}"><h4>Hostile Product ${index + 1}</h4><p>${index === 0 ? hostile : 'A clean editorial summary.'}</p><ul><li>${index === 1 ? hostile : 'Published dimensions'}</li><li>Fitment notes</li></ul><a href="https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20">Check price</a></div>`).join('')}<h2 id="faq">FAQ</h2><h3>Is it good?</h3><p>${hostile}</p><h3>Q2?</h3><p>Answer two.</p><h3>Q3?</h3><p>Answer three.</p>`;

  // The retry-loop check catches the raw model output...
  assert.ok(findPriceClaims(body).length > 0);
  // ...and, if it were bypassed, the page assertion still refuses the finished page.
  const conformed = await conformProductBoxes(body, pool, 'best-hostile-stub', async () => { throw new Error('no download'); });
  const html = buildHTML({
    slug: 'best-hostile-stub', title: 'Best Hostile Stub Products 2026 — Trail Built', description: fallbackMeta('hostile stub products').description,
    ogImage: 'https://images.pexels.com/photos/1/stub.jpeg', topic: 'hostile stub products', bodyHTML: conformed.bodyHTML, date: '2026-10-30', dateHuman: 'October 30, 2026',
    products: extractProductSchemaRecords(conformed.bodyHTML, pool),
  });
  assert.throws(() => assertNoPriceClaims(html, { mode: 'page' }), /Blocking publish/, 'a page built from a hostile model body must fail the page assertion');
  // The claims reach the card text, the JSON-LD description and the FAQ JSON-LD: all three are caught.
  const where = findPriceClaims(html, { mode: 'page' }).map(hit => hit.where).join(' ');
  assert.ok(/article body/.test(where) && /json-ld/.test(where), `expected body and JSON-LD hits, got: ${where}`);
  // The same pipeline with clean prose publishes.
  const cleanBody = body.split(hostile).join('A clean editorial summary.');
  const cleanConformed = await conformProductBoxes(cleanBody, pool, 'best-hostile-stub', async () => { throw new Error('no download'); });
  const cleanHtml = buildHTML({
    slug: 'best-hostile-stub', title: 'Best Hostile Stub Products 2026 — Trail Built', description: fallbackMeta('hostile stub products').description,
    ogImage: 'https://images.pexels.com/photos/1/stub.jpeg', topic: 'hostile stub products', bodyHTML: cleanConformed.bodyHTML, date: '2026-10-30', dateHuman: 'October 30, 2026',
    products: extractProductSchemaRecords(cleanConformed.bodyHTML, pool),
  });
  assert.doesNotThrow(() => assertNoPriceClaims(cleanHtml, { mode: 'page' }));
}

async function run() {
  const cases = testTables();
  testAttributes();
  testJsonLdIdentifiers();
  testFailClosed();
  testCanonicalFallbackText();
  testFailureMessages();
  await testHostileEndToEnd();
  console.log(`No-price detector tests passed: ${cases} table cases (fragment and page, plain and encoded), clean prose, attributes, JSON-LD identifiers, fail-closed containers, hostile end-to-end.`);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
