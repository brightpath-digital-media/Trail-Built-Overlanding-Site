/**
 * No-price content mode: detector for price, stock, star-rating and review-count claims.
 *
 * Trail Built articles never state a price, availability, discount, star rating or review
 * count. Buttons read "Check current price on Amazon" and the JSON-LD carries no commerce
 * properties. This module finds violations in model output (fragment mode) and in a finished
 * article page (page mode). It is deliberately precise rather than a bare word ban: ordinary
 * technical prose such as "rated recovery points" or "load rating" is not a claim.
 *
 * Permitted, and therefore ignored:
 *   - the canonical button text "Check current price on Amazon" (anchor class btn-amazon)
 *   - the hidden guide-product-meta spans and data-catalog-* attributes (they stay empty
 *     unless a fresh official catalog response fills them at runtime)
 */

// Text patterns. Each is a claim about money, stock, discounts, star ratings or review counts.
const TEXT_PATTERNS = [
  ['money amount', /(?:[$€£¥]\s?\d|\d\s?[$€£¥]|\b\d[\d,.]*\s?(?:dollars?|usd|bucks|cents)\b|\b(?:usd|msrp)\b)/i],
  ['price wording', /\b(?:prices?|pricing|priced)\b/i],
  ['stock or availability claim', /\b(?:in stock|out of stock|back in stock|limited stock|sold out|availability)\b/i],
  ['discount or sale claim', /\b(?:discount(?:s|ed)?|on sale|for sale|sale price|coupons?)\b/i],
  ['star rating', /(?:\b\d(?:\.\d)?\s*(?:\/\s?5|out of 5|stars?)\b|\b(?:star|customer|user|average|aggregate|amazon)\s+ratings?\b)/i],
  ['review count or customer review', /(?:\b\d[\d,]*\+?\s+(?:ratings|reviews)\b|\b(?:customer|verified|owner|amazon|user)\s+reviews?\b|\breview count\b)/i],
];

// Commerce properties that must never appear as JSON-LD keys.
const FORBIDDEN_SCHEMA_KEYS = new Set([
  'offers', 'offer', 'price', 'pricecurrency', 'pricevaliduntil', 'lowprice', 'highprice',
  'availability', 'aggregaterating', 'review', 'reviewrating', 'ratingvalue', 'ratingcount', 'reviewcount',
]);

function decode(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

function visibleText(html) {
  return decode(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const BUTTON_TEXT = 'Check current price on Amazon';
// Same boundaries the generator uses to find product boxes in model output.
const PRODUCT_BOX_RE = /<div class="product-box"[\s\S]*?(?=<div class="product-box"|<h2 id="faq"|<p>When choosing|<\/article>|$)/g;

/**
 * Remove what is allowed to carry price wording before scanning prose.
 * Page mode: only the exact canonical button and the hidden empty catalog slots.
 * Fragment mode (raw model output): additionally, link text inside product boxes, because
 * the generator replaces every product box with the canonical card after validation.
 */
function stripPermitted(html, mode) {
  let out = String(html);
  if (mode === 'fragment') {
    out = out.replace(PRODUCT_BOX_RE, box => box.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' '));
  }
  return out
    .replace(new RegExp(`<a\\b[^>]*class=(['"])[^'"]*\\bbtn-amazon\\b[^'"]*\\1[^>]*>\\s*${BUTTON_TEXT}\\s*<\\/a>`, 'gi'), ' ')
    .replace(/<div\b[^>]*class=(['"])[^'"]*\bguide-product-meta\b[^'"]*\1[^>]*>[\s\S]*?<\/div>/gi, ' ');
}

function scanText(label, text, hits) {
  const plain = String(text);
  for (const [kind, pattern] of TEXT_PATTERNS) {
    const match = pattern.exec(plain);
    if (match) hits.push({ where: label, kind, match: match[0] });
  }
}

// Identifier-like string values (URLs, SKUs) are not prose; a slug is not a claim.
const IDENTIFIER_KEYS = new Set(['url', '@id', 'item', 'image', 'logo', 'sameas', 'sku', '@context', '@type']);

function walkJson(node, trail, hits, key = '') {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkJson(child, `${trail}[${index}]`, hits, key));
  } else if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      if (FORBIDDEN_SCHEMA_KEYS.has(childKey.toLowerCase())) hits.push({ where: `json-ld ${trail}`, kind: 'commerce schema property', match: childKey });
      walkJson(value, `${trail}.${childKey}`, hits, childKey);
    }
  } else if (typeof node === 'string' && !IDENTIFIER_KEYS.has(key.toLowerCase())) {
    scanText(`json-ld ${trail}`, node, hits);
  }
}

function scanJsonLd(html, hits) {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((block, index) => {
    try {
      walkJson(JSON.parse(block[2]), `#${index + 1}`, hits);
    } catch {
      hits.push({ where: `json-ld #${index + 1}`, kind: 'unparseable JSON-LD', match: block[2].slice(0, 40) });
    }
  });
}

/**
 * Find claims. mode 'fragment' scans model output (the article body); mode 'page' scans a
 * finished page: JSON-LD, title, meta descriptions, h1, intro and the article body.
 * Returns [] when clean, otherwise [{ where, kind, match }].
 */
function findPriceClaims(html, { mode = 'fragment' } = {}) {
  const hits = [];
  const source = String(html);
  if (mode === 'page') {
    scanJsonLd(source, hits);
    scanText('title', visibleText(source.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''), hits);
    for (const meta of source.matchAll(/<meta\b[^>]*(?:name|property)=(['"])(?:description|og:description|og:title|twitter:title|twitter:description)\1[^>]*>/gi)) {
      scanText('meta', decode(meta[0].match(/\bcontent=(['"])([\s\S]*?)\1/i)?.[2] || ''), hits);
    }
    scanText('h1', visibleText(source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''), hits);
    scanText('intro', visibleText(source.match(/<p\b[^>]*class=(['"])article-intro\1[^>]*>([\s\S]*?)<\/p>/i)?.[2] || ''), hits);
    const body = source.match(/<article\b[^>]*class=(['"])article-body\1[^>]*>([\s\S]*?)<\/article>/i)?.[2];
    scanText('article body', visibleText(stripPermitted(body || '', 'page')), hits);
    return hits;
  }
  scanText('body', visibleText(stripPermitted(source, 'fragment')), hits);
  return hits;
}

function describeClaims(hits) {
  return hits.slice(0, 5).map(hit => `${hit.where}: ${hit.kind} (${JSON.stringify(String(hit.match).slice(0, 40))})`).join('; ');
}

function assertNoPriceClaims(html, options) {
  const hits = findPriceClaims(html, options);
  if (hits.length > 0) throw new Error(`[no-price] Blocking publish: generated content contains price, stock, rating or review claims: ${describeClaims(hits)}`);
}

module.exports = { assertNoPriceClaims, describeClaims, findPriceClaims, FORBIDDEN_SCHEMA_KEYS, TEXT_PATTERNS };
