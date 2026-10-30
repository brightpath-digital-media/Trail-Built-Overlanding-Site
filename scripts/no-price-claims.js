/**
 * No-price content mode: detector for price, stock, star-rating and review-count claims.
 *
 * Trail Built articles never state a price, availability, discount, star rating or review
 * count. Buttons read "Check current price on Amazon" and the JSON-LD carries no commerce
 * properties. This module finds violations in model output (fragment mode) and in a finished
 * article page (page mode). It is deliberately precise rather than a bare word ban: ordinary
 * technical prose such as "load rating", "rated for 12,000 lb", "the manufacturer offers a
 * warranty", "ground clearance" or "parts availability" is not a claim.
 *
 * Text is normalized before it is scanned, so a claim cannot hide behind encoding: numeric and
 * named HTML entities (&#36; &#x24; &dollar; &euro; &nbsp;), double-encoded entities, fullwidth
 * and other compatibility forms (NFKC), zero-width characters, soft hyphens, unicode dashes.
 * Not handled: look-alike letters from other scripts (confusables).
 *
 * Permitted, and therefore ignored:
 *   - the canonical button text "Check current price on Amazon" (anchor class btn-amazon)
 *   - the hidden guide-product-meta slots while they are EMPTY, and empty data-catalog-*
 *     attributes (they are filled at runtime only from a fresh official catalog response; a
 *     filled slot in generated HTML is a claim and fails)
 */

const NUM = '(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)';
const CURRENCY_WORDS = '(?:dollars?|bucks?|euros?|cents?|quid|pounds? sterling)';
const CODES = '(?:usd|eur|gbp|cad|aud|chf|jpy|inr|mxn|nzd)';

// Text patterns. Each is a claim about money, stock, shipping, discounts, star ratings,
// review counts or social proof. Matched case-insensitively on normalized text.
const TEXT_PATTERNS = [
  ['money amount', new RegExp(
    `(?:[$€£¥₹₩₽₺¢]\\s?\\.?\\d|\\d\\s?[$€£¥₹₩₽¢]|\\b${CODES}\\s?[\\d$]|\\b\\d[\\d,.]*\\s?(?:${CODES}|${CURRENCY_WORDS})\\b|\\b(?:usd|msrp)\\b|\\b${NUM}(?:[ -]${NUM})*\\s+${CURRENCY_WORDS}\\b|\\b(?:dollars|bucks)\\b)`, 'i')],
  ['price wording', /\b(?:prices?|pricing|priced|pricey|cheap(?:er|est|ly)?|inexpensive|bargains?|lowest cost|best price|low price)\b/i],
  ['stock or availability claim', new RegExp(
    '\\b(?:in[ -]stock|out[ -]of[ -]stock|limited stock|sold[ -]out|back-?order(?:ed|s)?|available now|currently (?:available|unavailable)|available (?:on|at|from|through|via) amazon|only \\d+ (?:left|remaining)|\\d+ (?:left|remaining) in stock|ships? (?:in|within) \\d|ships? (?:today|tomorrow|same[ -]day|next[ -]day)|(?:check|confirm|current|stock|product|item|amazon|live|real-time) availability|availability (?:varies|may vary|changes|status|is limited)|subject to availability)\\b', 'i')],
  ['shipping or seller claim', /\b(?:free (?:shipping|delivery|returns?)|fast (?:shipping|delivery)|limited[ -]time|while (?:supplies|stocks?) last|amazon prime|with prime|prime[ -](?:eligible|shipping|delivery|day|members?(?:hip)?)|best[ -]?sellers?|top[ -]sellers?|amazon'?s choice|amazon choice)\b|#\s?1\s+(?:best|top|seller|rated|pick|choice|new release)|\bnumber[ -]one (?:best|seller|rated)/i],
  ['discount or sale claim', /\b(?:discount(?:s|ed)?|on sale|for sale|sale price|coupons?|markdowns?|marked[ -]down|half[ -]off|percent[ -]off|\d+(?:\.\d+)?\s?percent (?:off|discount|savings?)|(?:good|great|best|hot|amazing|incredible|solid|real|excellent) deals?|deal of the day|a steal)\b|%\s?off\b|\d\s?%\s*(?:discount|savings?|cheaper)|\bsave\s+(?:up to |over )?(?:\$\s?\d|\d[\d,.]*\s?(?:%|(?:percent|dollars?|bucks|usd)\b))|\bsave big\b/i],
  // Capitalized only: "Prime" the Amazon program, not "prime mover" or "a prime campsite".
  ['Prime program', /\bPrime\b/],
  ['star rating', /(?:\b\d(?:\.\d)?[ -]?(?:\/\s?5\b|out of 5\b|stars?\b)|\b(?:one|two|three|four|five)(?:[ -]and[ -]a[ -]half)?[ -]stars?\b|\bstar[ -]rated\b|[★☆⭐✩✪✫✬✭✮✯✰]|\b\d(?:\.\d)?\s?\/\s?10\b|\brated\s+(?:at\s+)?\d(?:\.\d)?(?=\s*(?:\/\s?(?:5|10)\b|out of|stars?\b|%|[.,;:)!?](?!\d)|$)|\s+(?:by|on|across|among|highly|well|as|from)\b)|\b\d(?:\.\d)?\s+rating\b|\brating\s?(?:of|:)\s?\d(?:\.\d)?(?![\d,]|\s?(?:lbs?|kg|amps?|volts?|watts?|psi|mph|inch(?:es)?|ft|feet|mm|cm|kn|hp|cfm|gpm|oz|ah|lbf|pounds|degrees|°)\b)|\brating scores?\b|\b(?:top|best|highest|highly|well|poorly|negatively|positively)[ -]rated\b|\b(?:review|rating) scores?\b|\b(?:star|customer|user|average|aggregate|amazon|online|buyer|owner|consumer|overall|public)\s+ratings?\b)/i],
  ['review count or social proof', new RegExp(
    `(?:\\b\\d[\\d,.]*\\s?[km]?\\+?\\s+(?:[a-z]+\\s+)?(?:ratings|reviews|reviewers)\\b|\\b(?:countless|numerous) (?:[a-z]+ )?(?:reviews?|reviewers|ratings|customers|buyers)\\b|\\b(?:thousands|hundreds|millions|dozens|tens of thousands|hundreds of thousands) of (?:[a-z]+ )?(?:reviews|ratings|reviewers|customers|buyers|owners)\\b|\\b${NUM}(?:[ -]${NUM})* (?:reviews|ratings)\\b|\\b(?:customer|verified|owner|amazon|user|buyer|consumer|online)\\s+reviews?\\b|\\breview count\\b|\\b(?:positive|negative|mixed|glowing|rave|recent|top) reviews?\\b|\\b(?:customers|reviewers|buyers|shoppers|users|owners)\\s+(?:love|say|report|praise|complain|rave|swear|give|gave|rate|rated|call)\\b|\\baccording to (?:reviewers|customers|buyers|owners|amazon reviews)\\b)`, 'i')],
];

// Commerce properties that must never appear as JSON-LD keys.
const FORBIDDEN_SCHEMA_KEYS = new Set([
  'offers', 'offer', 'price', 'pricecurrency', 'pricevaliduntil', 'lowprice', 'highprice',
  'availability', 'aggregaterating', 'review', 'reviewrating', 'ratingvalue', 'ratingcount', 'reviewcount',
]);

const ENTITY_NAMES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', numsp: ' ',
  dollar: '$', euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', percnt: '%', num: '#', excl: '!', period: '.', comma: ',',
  colon: ':', semi: ';', sol: '/', bsol: '\\', lowbar: '_', lpar: '(', rpar: ')', plus: '+', equals: '=', commat: '@',
  hyphen: '-', dash: '-', ndash: '-', mdash: '-', minus: '-', shy: '', zwj: '', zwnj: '',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', star: '☆', starf: '★', bigstar: '★', frac12: '1/2',
};

function decodeEntities(text) {
  let current = String(text);
  // Repeat: a model or template can double-encode (&amp;#36;).
  for (let pass = 0; pass < 3; pass++) {
    const next = current.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return Object.prototype.hasOwnProperty.call(ENTITY_NAMES, body) ? ENTITY_NAMES[body] : (ENTITY_NAMES[body.toLowerCase()] ?? whole);
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

// Soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Mongolian
// variation selectors, zero-width and bidi controls, word joiner and invisible operators,
// line/paragraph separators, variation selectors, byte order mark.
const INVISIBLES = new RegExp('[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff]', 'g');

/** Decode, strip invisibles, apply NFKC, unify dashes and quotes, collapse whitespace. */
function normalizeText(value) {
  return decodeEntities(value)
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const INLINE_TAGS = 'a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr|font';

function visibleText(html) {
  return normalizeText(String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    // Inline tags join their neighbours (pri<b>ce</b>); block tags separate them.
    .replace(new RegExp(`</?(?:${INLINE_TAGS})\\b[^>]*>`, 'gi'), '')
    .replace(/<[^>]+>/g, ' '));
}

const BUTTON_TEXT = 'Check current price on Amazon';
// Same boundaries the generator uses to find product boxes in model output.
const PRODUCT_BOX_RE = /<div class="product-box"[\s\S]*?(?=<div class="product-box"|<h2 id="faq"|<p>When choosing|<\/article>|$)/g;

/**
 * Remove what is allowed to carry price wording before scanning prose.
 * Page mode: only the exact canonical button and hidden catalog slots that are EMPTY.
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
    // A catalog slot is permitted only while it is empty; a filled one stays and is scanned.
    .replace(/<div\b[^>]*class=(['"])[^'"]*\bguide-product-meta\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/gi, (whole, _quote, inner) => (visibleText(inner) === '' ? ' ' : whole));
}

function scanText(label, text, hits) {
  const plain = normalizeText(text);
  if (!plain) return;
  for (const [kind, pattern] of TEXT_PATTERNS) {
    const match = pattern.exec(plain);
    if (match) hits.push({ where: label, kind, match: match[0] });
  }
}

// Identifier-like string values (URLs, SKUs, type tokens) are not prose; a slug is not a claim.
// An exemption applies only when the value actually looks like the identifier its key names.
const URL_LIKE = /^(?:https?:\/\/|\/|#)\S+$/;
const ASIN_LIKE = /^[A-Z0-9]{10}$/;
const TOKEN_LIKE = /^[@\w:.#-]{1,64}$/;
const IDENTIFIER_KEYS = {
  url: [URL_LIKE], '@id': [URL_LIKE], item: [URL_LIKE], image: [URL_LIKE], logo: [URL_LIKE], sameas: [URL_LIKE],
  sku: [ASIN_LIKE, TOKEN_LIKE], '@context': [URL_LIKE], '@type': [TOKEN_LIKE],
};

function isIdentifier(key, value) {
  const rules = IDENTIFIER_KEYS[String(key).toLowerCase()];
  return Boolean(rules) && rules.some(rule => rule.test(value));
}

function walkJson(node, trail, hits, key = '') {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkJson(child, `${trail}[${index}]`, hits, key));
  } else if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      if (FORBIDDEN_SCHEMA_KEYS.has(childKey.toLowerCase())) hits.push({ where: `json-ld ${trail}`, kind: 'commerce schema property', match: childKey });
      walkJson(value, `${trail}.${childKey}`, hits, childKey);
    }
  } else if (typeof node === 'string' && !isIdentifier(key, node)) {
    scanText(`json-ld ${trail}`, node, hits);
  }
}

function scanJsonLd(html, hits) {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)];
  if (blocks.length === 0) hits.push({ where: 'page', kind: 'expected container missing', match: 'application/ld+json' });
  blocks.forEach((block, index) => {
    try {
      walkJson(JSON.parse(block[2]), `#${index + 1}`, hits);
    } catch {
      hits.push({ where: `json-ld #${index + 1}`, kind: 'unparseable JSON-LD', match: block[2].slice(0, 40) });
    }
  });
}

// Attributes that carry prose or data a reader or crawler can see. href, src, class, id, rel,
// style and event handlers are not prose.
const PROSE_ATTRIBUTES = new Set(['alt', 'title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'label', 'summary', 'value', 'content']);

function attributeValues(html) {
  const source = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const found = [];
  for (const tag of source.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    const tagName = tag[1].toLowerCase();
    for (const attribute of tag[2].matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      const isProse = PROSE_ATTRIBUTES.has(name) || (name.startsWith('data-') && name !== 'data-asin');
      if (!isProse || !value.trim()) continue;
      // <meta content> matters only for the description/social fields; viewport and charset are not prose.
      if (name === 'content' && tagName === 'meta' && !/\b(?:name|property)=["'](?:description|og:|twitter:)/i.test(tag[2])) continue;
      if (URL_LIKE.test(value.trim()) || ASIN_LIKE.test(value.trim())) continue;
      found.push({ tag: tagName, name, value });
    }
  }
  return found;
}

function scanAttributes(html, hits) {
  for (const { tag, name, value } of attributeValues(html)) scanText(`attribute <${tag} ${name}>`, value, hits);
}

function expect(hits, label, value) {
  if (value === null || value === undefined) hits.push({ where: 'page', kind: 'expected container missing', match: label });
  return value ?? '';
}

/**
 * Find claims. mode 'fragment' scans model output (the article body and its prose attributes:
 * alt, title, aria-label, data-*); mode 'page' scans a finished page: JSON-LD, title, meta
 * descriptions, h1, intro, the article body, and prose attributes. Page mode fails CLOSED: a
 * missing expected container is itself a finding. Returns [] when clean, otherwise
 * [{ where, kind, match }].
 */
function findPriceClaims(html, { mode = 'fragment' } = {}) {
  const hits = [];
  const source = String(html);
  if (mode === 'page') {
    scanJsonLd(source, hits);
    scanText('title', visibleText(expect(hits, 'title', source.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? null)), hits);
    for (const meta of source.matchAll(/<meta\b[^>]*(?:name|property)=(['"])(?:description|og:description|og:title|twitter:title|twitter:description)\1[^>]*>/gi)) {
      scanText('meta', meta[0].match(/\bcontent=(['"])([\s\S]*?)\1/i)?.[2] || '', hits);
    }
    scanText('h1', visibleText(expect(hits, 'h1', source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? null)), hits);
    scanText('intro', visibleText(expect(hits, 'article-intro', source.match(/<p\b[^>]*class=(['"])article-intro\1[^>]*>([\s\S]*?)<\/p>/i)?.[2] ?? null)), hits);
    const body = expect(hits, 'article-body', source.match(/<article\b[^>]*class=(['"])article-body\1[^>]*>([\s\S]*?)<\/article>/i)?.[2] ?? null);
    scanText('article body', visibleText(stripPermitted(body, 'page')), hits);
    scanAttributes(source, hits);
    return hits;
  }
  scanText('body', visibleText(stripPermitted(source, 'fragment')), hits);
  scanAttributes(source, hits);
  return hits;
}

function describeClaims(hits) {
  return hits.slice(0, 5).map(hit => `${hit.where}: ${hit.kind} (${JSON.stringify(String(hit.match).slice(0, 40))})`).join('; ');
}

function assertNoPriceClaims(html, options) {
  const hits = findPriceClaims(html, options);
  if (hits.length > 0) throw new Error(`[no-price] Blocking publish: generated content contains price, stock, rating or review claims: ${describeClaims(hits)}`);
}

module.exports = { assertNoPriceClaims, describeClaims, findPriceClaims, normalizeText, FORBIDDEN_SCHEMA_KEYS, TEXT_PATTERNS };
