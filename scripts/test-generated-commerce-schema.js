/**
 * Credential-free generator commerce-schema contract test.
 * It renders a fixed five-product buyer guide through buildHTML(), writes it as a
 * temporary best-* article, and runs the repository's blocking commerce gate.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildHTML } = require('./generate-article');

const root = path.join(__dirname, '..');
const filename = 'best-__generator-commerce-schema-stub.html';
const articlePath = path.join(root, 'articles', filename);
const asins = ['B0SCHEMA01', 'B0SCHEMA02', 'B0SCHEMA03', 'B0SCHEMA04', 'B0SCHEMA05'];
const products = asins.map((asin, index) => ({
  asin,
  name: `Stub Navigation Product ${index + 1}`,
  reviewBody: `A credential-free editorial summary for Stub Navigation Product ${index + 1}.`,
}));
const bodyHTML = `
<h2 id="top-picks">Our Top Picks</h2>
${products.map(product => `<div class="product-box" data-asin="${product.asin}" data-product="${product.name}"><div class="product-box-info"><h4>${product.name}</h4><p class="product-summary">${product.reviewBody}</p></div><a class="btn-amazon" data-asin="${product.asin}" href="https://www.amazon.com/dp/${product.asin}?tag=trailbuiltove-20" rel="sponsored nofollow noopener" target="_blank">Check current price on Amazon</a></div>`).join('\n')}
<h2 id="faq">FAQ</h2>
<h3>Does the template emit product schema?</h3><p>Yes. It serializes each runtime-verified product as an ordered Product entry with an editorial Review.</p>
<h3>Are direct product URLs preserved?</h3><p>Yes. The template emits the exact ASIN-based Amazon URL with the required associate tag.</p>
<h3>Does the template emit FAQ schema?</h3><p>Yes. It derives FAQPage entries from the article FAQ questions and answers.</p>`;

try {
  const html = buildHTML({
    slug: filename.slice(0, -5),
    title: 'Best Stub Navigation Products 2026 — Trail Built',
    description: 'A credential-free local commerce-schema contract test with five standardized product records and direct tagged Amazon destinations.',
    ogImage: 'https://images.unsplash.com/photo-1533591380348-14193f1de18f?w=1200&q=80',
    topic: 'stub navigation products',
    bodyHTML,
    date: '2026-08-20',
    dateHuman: 'August 20, 2026',
    products,
  });
  fs.writeFileSync(articlePath, html, 'utf8');
  assert.match(html, /"@type":"ItemList"/);
  assert.match(html, /"numberOfItems":5/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.doesNotMatch(html, /<th>Price<\/th>/);
  assert.match(html, /href="\.\.\/about\.html#privacy"/);
  assert.match(html, /href="\.\.\/about\.html#affiliate"/);
  const output = execFileSync('python3', ['scripts/validate-guide-commerce.py'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(output.trim());
  console.log('Generator commerce-schema stub passed the blocking validator.');
} finally {
  fs.rmSync(articlePath, { force: true });
}
