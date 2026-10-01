#!/usr/bin/env node
/**
 * Trail Built — AI Article Generator
 * Uses Groq (free tier) to write a new overlanding affiliate article,
 * then saves it as a ready-to-publish HTML file.
 *
 * Usage:
 *   node scripts/generate-article.js
 *   node scripts/generate-article.js --topic "best overlanding fridges"
 *
 * Required env var: GROQ_API_KEY
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createAsinVerifier } = require('./asin-verification');

// ── Config ──────────────────────────────────────────────────────────────────
const ASSOCIATE_TAG  = process.env.AMAZON_ASSOCIATE_TAG || 'trailbuiltove-20';
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL     = 'openai/gpt-oss-120b';
// ARTICLES_DIR can be overridden via env (used by tests to point at a temp
// directory); defaults to the repo's articles/ folder so behavior is unchanged.
const ARTICLES_DIR   = process.env.ARTICLES_DIR || path.join(__dirname, '..', 'articles');
const INDEX_FILE     = path.join(__dirname, '..', 'index.html');
const SITE_URL       = 'https://trailbuiltoverland.com';
const PRODUCT_IMAGES_DIR = process.env.PRODUCT_IMAGES_DIR || path.join(__dirname, '..', 'assets', 'product-images');
const PRODUCT_IMAGES_REPO_PREFIX = 'assets/product-images/';
const HERO_IMAGES_FILE = path.join(__dirname, '..', 'data', 'hero-images.json');
const HERO_USED_IMAGES_FILE = path.join(__dirname, '..', 'data', 'used-hero-images.json');
const ARTICLE_FOOTER_FILE = path.join(__dirname, '..', 'templates', 'article-footer.html');
const MIN_PRODUCT_BOXES = 5;

// ── Topic pool — cycles automatically; add more to extend coverage ──────────
const TOPIC_POOL = [
  // Gear Reviews — Year 1
  'best overlanding air compressors',
  'best winches for Toyota 4Runner',
  'overlanding solar power setup guide',
  'best skid plates for off-road trucks',
  'overlanding water storage and filtration',
  'best off-road tires for overlanding',
  'vehicle communication gear for overlanding',
  'best overlanding camp kitchens',
  'how to build a truck bed sleeping platform',
  'best hi-lift jack alternatives',
  'overlanding first aid kit essentials',
  'best roof rack brands for overlanding',
  'best overlanding GPS and navigation devices',
  'diesel vs gasoline for overlanding',
  'best overlanding suspension upgrades',
  'overlanding packing list complete guide',
  'best portable power stations for overlanding',
  'how to choose overlanding recovery boards',
  'best overlanding trailers and teardrops',
  // Gear Reviews — Year 2
  'best overlanding sleeping bags and quilts',
  'best overlanding camp chairs and tables',
  'best overlanding headlamps and lanterns',
  'best overlanding water filters and purifiers',
  'best overlanding fire starters and camp stoves',
  'best overlanding satellite communicators',
  'best overlanding tool kits and recovery bags',
  'best overlanding traction boards comparison',
  'best overlanding snorkels and intake systems',
  'best overlanding dual battery systems',
  'best overlanding cargo management systems',
  'best overlanding shower and hygiene solutions',
  'best overlanding maps and navigation apps',
  'best overlanding dog gear and pet safety',
  'best overlanding tow straps and kinetic ropes',
  'best overlanding CB radios and communication',
  'best overlanding awnings and shade systems',
  'best overlanding ground tents vs rooftop tents',
  'best overlanding solar generators and power banks',
  'best overlanding dash cams and trail cameras',
];

// ── Curated hero library ───────────────────────────────────────────────────
// Hero choices are source-controlled, visually reviewed, and selected by topic.
// The generator never accepts a model-guessed photo ID as an article hero.
function loadHeroLibrary(file = HERO_IMAGES_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const categories = parsed?.categories;
  if (!categories || typeof categories !== 'object') {
    throw new Error(`[hero-images] Missing categories object in ${file}`);
  }
  for (const [name, category] of Object.entries(categories)) {
    if (!Array.isArray(category?.keywords) || category.keywords.length === 0) {
      throw new Error(`[hero-images] ${name} is missing keyword matches`);
    }
    if (!Array.isArray(category?.images) || category.images.length < 3 || category.images.length > 6) {
      throw new Error(`[hero-images] ${name} must provide 3–6 image URLs`);
    }
    for (const image of category.images) {
      if (typeof image !== 'string' || !/^https:\/\/images\.pexels\.com\//.test(image)) {
        throw new Error(`[hero-images] ${name} contains an invalid curated image URL`);
      }
    }
  }
  if (!categories['general-overlanding']) {
    throw new Error('[hero-images] A general-overlanding fallback category is required');
  }
  return categories;
}

function heroImageKey(url) {
  const value = String(url || '');
  const pexels = value.match(/images\.pexels\.com\/photos\/(\d+)/i);
  if (pexels) return `pexels:${pexels[1]}`;
  const unsplash = value.match(/images\.unsplash\.com\/(photo-[^?&#/]+)/i);
  if (unsplash) return `unsplash:${unsplash[1]}`;
  return value.replace(/[?#].*$/, '');
}

function scanCurrentEditorialImageKeys() {
  const keys = new Set();
  const scanFiles = [INDEX_FILE];
  for (const directory of [ARTICLES_DIR, path.join(__dirname, '..', 'categories')]) {
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory)) {
      if (file.endsWith('.html')) scanFiles.push(path.join(directory, file));
    }
  }
  for (const file of scanFiles) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/https:\/\/images\.(?:pexels|unsplash)\.com\/[^\"'<>\s)]+/g)) {
      keys.add(heroImageKey(match[0].replace(/&amp;/g, '&')));
    }
  }
  return keys;
}

function loadUsedHeroImageKeys(file = HERO_USED_IMAGES_FILE) {
  const keys = scanCurrentEditorialImageKeys();
  if (!fs.existsSync(file)) return keys;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const url of Object.values(parsed.assignments || {})) keys.add(heroImageKey(url));
  for (const url of Object.values(parsed.generatedArticleAssignments || {})) keys.add(heroImageKey(url));
  for (const key of parsed.crossSiteEditorialImageKeys || []) keys.add(String(key));
  return keys;
}

function recordUsedHeroImage(slug, url, file = HERO_USED_IMAGES_FILE) {
  const parsed = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { version: 1, assignments: {}, generatedArticleAssignments: {}, crossSiteEditorialImageKeys: [] };
  parsed.generatedArticleAssignments = parsed.generatedArticleAssignments || {};
  parsed.generatedArticleAssignments[`articles/${slug}.html`] = url;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
}

const HERO_LIBRARY = loadHeroLibrary();

function selectHeroImage(topic, library = HERO_LIBRARY, usedImageKeys = loadUsedHeroImageKeys()) {
  const normalizedTopic = String(topic || '').toLowerCase();
  const entries = Object.entries(library);
  const specificMatches = entries
    .filter(([name]) => name !== 'general-overlanding')
    .map(([name, category]) => ({
      name,
      category,
      score: category.keywords.filter(keyword => normalizedTopic.includes(keyword)).length,
    }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = specificMatches[0] || {
    name: 'general-overlanding',
    category: library['general-overlanding'],
  };
  const candidates = selected.category.images
    .filter((url, index, values) => values.indexOf(url) === index && !usedImageKeys.has(heroImageKey(url)));
  if (candidates.length === 0) {
    throw new Error(`[hero-images] No unused reviewed candidate is available for ${selected.name}; curate more unique images before publishing.`);
  }
  const digest = crypto.createHash('sha256').update(`${selected.name}\u0000${normalizedTopic}`).digest();
  const index = digest.readUInt32BE(0) % candidates.length;
  const orderedImages = [candidates[index], ...candidates.filter((_, candidateIndex) => candidateIndex !== index)];
  return { category: selected.name, primary: orderedImages[0], fallbacks: orderedImages.slice(1) };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Validate an external image URL by making an HTTP HEAD request.
 * Returns true if the server responds with HTTP 200.
 * Follows up to one redirect. Times out after 8 seconds.
 */
function validateImageUrl(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : require('http');
      const req = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD', timeout: 8000 },
        (res) => {
          // Follow one redirect
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            validateImageUrl(res.headers.location).then(resolve);
          } else {
            resolve(res.statusCode === 200);
          }
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

/**
 * Validate a selected curated image URL; on failure, retry deterministically
 * through other images from the same curated topic category and then the general
 * overlanding library. Throws if no curated image URL is live.
 */
async function resolveValidImageUrl(candidateUrl, fallbackUrls = []) {
  const candidates = [candidateUrl, ...fallbackUrls].filter((url, index, values) => values.indexOf(url) === index);
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const ok = await validateImageUrl(url);
    if (ok) {
      if (i > 0) console.log(`[image-validate] Curated fallback accepted: ${url}`);
      return url;
    }
    console.warn(`[image-validate] Curated URL unavailable: ${url}`);
  }
  throw new Error('[image-validate] No curated hero image URL passed liveness validation. Update data/hero-images.json.');
}

function cardImageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('w', '600');
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&])w=\d+/, '$1w=600');
  }
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}
/**
 * Single source of truth for topic → slug conversion.
 * Extracted to avoid the two-path divergence that caused the PR #1 bug.
 */
function topicToSlug(topic) {
  return slugify('best-' + topic).replace(/^best-best-/, 'best-');
}
function todayISO()   { return new Date().toISOString().split('T')[0]; }
function todayHuman() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function pickTopic() {
  // CLI override — honour --topic as before
  const idx = process.argv.indexOf('--topic');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];

  // Build a Set of already-published slugs by stripping only the .html extension;
  // no hyphen-to-space mangling so the comparison is exact.
  const publishedSlugs = new Set(
    fs.readdirSync(ARTICLES_DIR)
      .filter(f => f.endsWith('.html'))
      .map(f => f.slice(0, -5))          // strip ".html", keep hyphens intact
  );

  // Derive the slug for each pool entry via the shared topicToSlug helper.
  const eligible = TOPIC_POOL.filter(t => !publishedSlugs.has(topicToSlug(t)));

  if (eligible.length === 0) {
    console.error('TOPIC_POOL exhausted, add new topics');
    process.exit(1);
  }

  return eligible[Math.floor(Math.random() * eligible.length)];
}

// ── ASIN pre-validation ─────────────────────────────────────────────────────
const VERIFIED_POOL_FILE = path.join(__dirname, '..', 'data', 'verified-products.json');
const MIN_RELEVANT_POOL_PRODUCTS = MIN_PRODUCT_BOXES;
const MAX_POOL_PROMPT_PRODUCTS = 12;
const POOL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'best', 'for', 'guide', 'how', 'in', 'of', 'or', 'overlanding',
  'the', 'to', 'vs', 'with', 'your', 'setup', 'comparison', 'complete', 'gear',
]);

function loadVerifiedPool(poolFile = VERIFIED_POOL_FILE, requireVerifiedStatus = process.env.REQUIRE_POOL_VERIFICATION === 'true') {
  const parsed = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  const products = Array.isArray(parsed) ? parsed : parsed.products;
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error(`[asin-precheck] Verified product pool is empty: ${poolFile}`);
  }
  const pool = new Map();
  for (const product of products) {
    if (requireVerifiedStatus && product.verification_status !== 'verified') continue;
    if (!/^[A-Z0-9]{10}$/.test(product.asin || '')) {
      throw new Error(`[asin-precheck] Invalid pool ASIN: ${product.asin || '(missing)'}`);
    }
    if (!product.name || !Array.isArray(product.tags)) {
      throw new Error(`[asin-precheck] Pool entry ${product.asin} is missing a name or tags array`);
    }
    if (pool.has(product.asin)) {
      throw new Error(`[asin-precheck] Duplicate pool ASIN: ${product.asin}`);
    }
    pool.set(product.asin, product);
  }
  if (pool.size === 0) {
    const state = requireVerifiedStatus ? 'runtime-verified' : 'seed';
    throw new Error(`[asin-precheck] No ${state} product entries are available in ${poolFile}`);
  }
  return pool;
}

function topicWords(topic) {
  return new Set(String(topic).toLowerCase().match(/[a-z0-9]+/g)?.filter(word => !POOL_STOP_WORDS.has(word)) || []);
}

function filterPoolForTopic(pool, topic) {
  const words = topicWords(topic);
  const scored = [...pool.values()].map(product => {
    const searchable = `${product.name} ${(product.tags || []).join(' ')}`.toLowerCase();
    const score = [...words].reduce((total, word) => total + (searchable.includes(word) ? 1 : 0), 0);
    return { product, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  return scored.slice(0, MAX_POOL_PROMPT_PRODUCTS).map(({ product }) => product);
}

function formatPoolForPrompt(products) {
  return products.map(product => `- ${product.name} | ASIN: ${product.asin} | tags: ${product.tags.join(', ')}`).join('\n');
}

/**
 * Extract all ASINs from generated HTML body. Returns unique ASIN strings.
 */
function extractAsins(html) {
  const dataAsins = [...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map(m => m[1]);
  const directLinkAsins = [...html.matchAll(/amazon\.com\/dp\/([A-Z0-9]{10})(?:[?/#]|\"|')/g)].map(m => m[1]);
  return [...new Set([...dataAsins, ...directLinkAsins])];
}

/**
 * Enforce direct links, verified-pool membership, and live Creators API evidence.
 * INCONCLUSIVE API evidence remains blocking, preserving the publish gate.
 */
async function validateBodyAsins(bodyHTML, pool, verifier = createAsinVerifier()) {
  if (/amazon\.com\/s\?/i.test(bodyHTML)) {
    return { ok: [], failed: ['Amazon search URLs are prohibited'] };
  }
  const asins = extractAsins(bodyHTML);
  console.log(`[asin-precheck] Found ${asins.length} ASIN(s): ${asins.join(', ')}`);
  if (asins.length === 0) return { ok: [], failed: ['No direct Amazon ASINs were supplied'] };

  const ok = [];
  const failed = [];
  for (const asin of asins) {
    if (!pool.has(asin)) {
      failed.push(`${asin}: not in verified product pool`);
      console.log(`[asin-precheck] ${asin}: NOT_IN_POOL`);
      continue;
    }
    const result = await verifier.verifyAsin(asin);
    console.log(`[asin-precheck] ${asin}: ${result.status} via ${result.source}${result.reason ? ` (${result.reason})` : ''}`);
    const product = pool.get(asin);
    const hasExistingLocalImage = Boolean(product && findExistingLocalProductImage(product));
    if (result.status === 'LIVE' && (result.image_url || hasExistingLocalImage)) {
      // Reuse the image URL returned by the same runtime Creators API lookup;
      // no second catalog lookup is made solely for image acquisition. A known
      // local asset for the same ASIN is also valid and avoids a redundant download.
      if (result.image_url) product.image_url = result.image_url;
      ok.push(asin);
    } else if (result.status === 'LIVE') {
      failed.push(`${asin}: LIVE listing returned without a primary product image or reusable local asset`);
    } else {
      failed.push(`${asin}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
  }
  return { ok, failed };
}

// ── Product-card image conformance ───────────────────────────────────────────
const PRODUCT_BOX_RE = /<div class="product-box"[\s\S]*?(?=<div class="product-box"|<h2 id="faq"|<p>We ran|<p>When choosing|<\/article>|$)/g;

function imageExtension(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return ['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'].includes(extension) ? extension : '.jpg';
  } catch {
    return '.jpg';
  }
}

function productImageFilename(slug, product, extension = '.jpg') {
  const prefix = slugify(`${slug}-${product.name}`).slice(0, 104) || product.asin.toLowerCase();
  const fingerprint = crypto.createHash('sha256').update(product.asin).digest('hex').slice(0, 8);
  return `${prefix}-${fingerprint}${extension}`;
}

function repoImagePathFromMetadata(localPath) {
  if (typeof localPath !== 'string' || !localPath.startsWith(PRODUCT_IMAGES_REPO_PREFIX)) return null;
  const resolved = path.resolve(__dirname, '..', localPath);
  const allowedRoot = path.resolve(PRODUCT_IMAGES_DIR) + path.sep;
  return resolved.startsWith(allowedRoot) ? resolved : null;
}

function findExistingLocalProductImage(asin) {
  const metadataPath = repoImagePathFromMetadata(asin.image_local_path);
  if (metadataPath && fs.existsSync(metadataPath)) {
    return { filePath: metadataPath, localPath: asin.image_local_path };
  }

  // Earlier articles did not record image metadata in the pool. Reuse their local
  // assets when the same ASIN already appears in a product card.
  const articlesDir = path.join(__dirname, '..', 'articles');
  for (const file of fs.readdirSync(articlesDir).filter(name => name.endsWith('.html'))) {
    const article = fs.readFileSync(path.join(articlesDir, file), 'utf8');
    const card = article.match(new RegExp(`<div class="product-box"[^>]*data-asin="${asin.asin}"[\\s\\S]*?(?=<div class="product-box"|<h2 id="faq"|<\\/article>)`));
    const source = card && card[0].match(/<img [^>]*src="(\.\.\/assets\/product-images\/[^\"]+)"/);
    if (!source) continue;
    const localPath = source[1].replace(/^\.\.\//, '');
    const filePath = repoImagePathFromMetadata(localPath);
    if (filePath && fs.existsSync(filePath)) return { filePath, localPath };
  }
  return null;
}

function downloadProductImage(imageUrl, destination) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      reject(new Error('Creators API returned an invalid product image URL'));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('Creators API product image URL must use HTTPS'));
      return;
    }
    const request = https.get(parsed, { timeout: 15000, headers: { 'User-Agent': 'TrailBuiltProductImageSync/1.0' } }, response => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadProductImage(new URL(response.headers.location, imageUrl).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Product image download returned HTTP ${response.statusCode}`));
        return;
      }
      if (!String(response.headers['content-type'] || '').startsWith('image/')) {
        response.resume();
        reject(new Error('Product image download did not return an image content type'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > 8 * 1024 * 1024) {
          response.destroy(new Error('Product image exceeds the 8 MiB download limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (total < 128) {
          reject(new Error('Product image download was unexpectedly small'));
          return;
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, Buffer.concat(chunks));
        resolve();
      });
    });
    request.on('timeout', () => request.destroy(new Error('Product image download timed out')));
    request.on('error', reject);
  });
}

async function ensureProductImage(slug, product, downloader = downloadProductImage) {
  try {
    const existing = findExistingLocalProductImage(product);
    if (existing) return { ...existing, created: false };
    if (!product.image_url) throw new Error('Creators API did not return a primary product image URL');

    const filename = productImageFilename(slug, product, imageExtension(product.image_url));
    const filePath = path.join(PRODUCT_IMAGES_DIR, filename);
    const localPath = `${PRODUCT_IMAGES_REPO_PREFIX}${filename}`;
    if (fs.existsSync(filePath)) return { filePath, localPath, created: false };
    await downloader(product.image_url, filePath);
    return { filePath, localPath, created: true };
  } catch (cause) {
    const error = new Error(`[product-images] ${product.asin}: ${cause.message}`);
    error.asin = product.asin;
    throw error;
  }
}

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalProductBox(box, product, imageLocalPath) {
  const heading = product.name;
  const description = plainText(box.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]) || `${product.name} is a practical overlanding gear option.`;
  const listItems = [...box.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(match => plainText(match[1]))
    .filter(Boolean)
    .slice(0, 3);
  const reasons = listItems.length >= 2
    ? listItems
    : [`${product.name} is selected from the runtime-verified product pool.`, 'Its practical format suits vehicle-based travel and camp use.'];
  const asin = product.asin;
  const alt = `${product.name} overlanding gear`;
  const amazonUrl = `https://www.amazon.com/dp/${asin}?tag=${ASSOCIATE_TAG}`;

  return `<div class="product-box" data-asin="${asin}" data-product="${escapeHtml(product.name)}"><div class="product-box-header"><div class="product-box-image"><img alt="${escapeHtml(alt)}" decoding="async" height="140" loading="lazy" src="../${imageLocalPath}" width="180"/></div><div class="product-box-info"><h4>${escapeHtml(heading)}</h4><p class="product-summary">${escapeHtml(description)}</p></div></div><div class="guide-product-meta"><span class="price" data-asin="${asin}" data-catalog-price="" hidden=""></span><span class="guide-availability" data-asin="${asin}" data-catalog-availability="" hidden=""></span><span class="guide-catalog-badge" data-asin="${asin}" data-catalog-badge="" hidden=""></span></div><div class="product-box-pros"><h5>Why We Like It</h5><ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div><a class="btn-amazon" data-asin="${asin}" href="${amazonUrl}" rel="sponsored nofollow noopener" target="_blank">Check Price on Amazon</a></div>`;
}

async function conformProductBoxes(bodyHTML, pool, slug, downloader = downloadProductImage) {
  const boxes = [...bodyHTML.matchAll(PRODUCT_BOX_RE)];
  if (boxes.length < MIN_PRODUCT_BOXES) {
    throw new Error(`[product-images] Blocking publish: generated article has ${boxes.length} product boxes; the quality gate requires at least ${MIN_PRODUCT_BOXES}.`);
  }

  const usedAsins = extractAsins(bodyHTML);
  const images = new Map();
  const createdPaths = [];
  try {
    for (const asin of usedAsins) {
      const product = pool.get(asin);
      if (!product) throw new Error(`${asin}: product is not in the verified pool`);
      const image = await ensureProductImage(slug, product, downloader);
      if (image.created) createdPaths.push(image.filePath);
      images.set(asin, image.localPath);
    }

    const conforming = bodyHTML.replace(PRODUCT_BOX_RE, box => {
      const asin = box.match(/data-asin="([A-Z0-9]{10})"/i)?.[1] || extractAsins(box)[0];
      const product = asin && pool.get(asin);
      const imageLocalPath = asin && images.get(asin);
      if (!product || !imageLocalPath) throw new Error(`[product-images] ${asin || 'unknown ASIN'} has no verified local product image`);
      return canonicalProductBox(box, product, imageLocalPath);
    });

    return { bodyHTML: conforming, imageMetadata: Object.fromEntries([...images].map(([asin, localPath]) => [asin, { image_local_path: localPath }])) };
  } catch (error) {
    for (const createdPath of createdPaths) fs.rmSync(createdPath, { force: true });
    throw error;
  }
}

function extractProductSchemaRecords(bodyHTML, pool) {
  const boxes = [...bodyHTML.matchAll(PRODUCT_BOX_RE)];
  const seenAsins = new Set();
  return boxes.map((match, index) => {
    const box = match[0];
    const asin = box.match(/data-asin="([A-Z0-9]{10})"/i)?.[1];
    const product = asin && pool.get(asin);
    if (!asin || !product) {
      throw new Error(`[commerce-schema] Product box ${index + 1} does not resolve to a verified pool product.`);
    }
    if (seenAsins.has(asin)) {
      throw new Error(`[commerce-schema] Duplicate product ASIN in generated article: ${asin}`);
    }
    seenAsins.add(asin);
    const reviewBody = plainText(box.match(/<p\b[^>]*class=(['"])\s*product-summary\s*\1[^>]*>([\s\S]*?)<\/p>/i)?.[2]);
    if (!reviewBody) {
      throw new Error(`[commerce-schema] Product ${asin} is missing a canonical product summary for its editorial Review schema.`);
    }
    return { asin, name: product.name, reviewBody };
  });
}

function extractFaqSchemaPairs(bodyHTML) {
  const faqStart = bodyHTML.search(/<h2\b[^>]*\bid=(['"])faq\1[^>]*>/i);
  if (faqStart === -1) return [];
  const followingMarkup = bodyHTML.slice(faqStart).replace(/^[\s\S]*?<\/h2>/i, '');
  const faqMarkup = followingMarkup.split(/<h2\b/i)[0];
  return [...faqMarkup.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, question, answer]) => ({ question: plainText(question), answer: plainText(answer) }))
    .filter(({ question, answer }) => question && answer);
}

function buildCommerceSchemas({ title, articleUrl, bodyHTML, products }) {
  if (products.length < MIN_PRODUCT_BOXES) {
    throw new Error(`[commerce-schema] Generated article has ${products.length} schema product(s); ${MIN_PRODUCT_BOXES} are required.`);
  }
  const faqPairs = extractFaqSchemaPairs(bodyHTML);
  if (faqPairs.length === 0) {
    throw new Error('[commerce-schema] Generated article is missing FAQ question-and-answer pairs for FAQPage JSON-LD.');
  }
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Top Picks — ${title}`,
    url: articleUrl,
    numberOfItems: products.length,
    itemListElement: products.map((product, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Product',
        name: product.name,
        sku: product.asin,
        url: `https://www.amazon.com/dp/${product.asin}?tag=${ASSOCIATE_TAG}`,
        review: {
          '@type': 'Review',
          name: 'Trail Built editorial review',
          author: { '@type': 'Person', name: 'Trail Built Staff' },
          reviewBody: product.reviewBody,
        },
      },
    })),
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqPairs.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
  return [itemList, faq];
}

function buildComparisonTable(products) {
  return `<section class="guide-comparison" data-guide-generated="true"><div class="guide-comparison-header"><h2>Compare the Top Picks</h2><p class="guide-comparison-note">Review each product section for current Amazon availability and offer details.</p></div><div class="guide-table-wrap"><table class="guide-comparison-table"><thead><tr><th>Product</th><th>Key spec(s)</th><th>Review</th></tr></thead><tbody>${products.map(product => `<tr><td>${escapeHtml(product.name)}</td><td>${escapeHtml(product.reviewBody)}</td><td><a href="#top-picks">See pick</a></td></tr>`).join('')}</tbody></table></div></section>`;
}

function loadArticleFooter() {
  const template = fs.readFileSync(ARTICLE_FOOTER_FILE, 'utf8');
  if (!template.includes('{{CURRENT_YEAR}}')) {
    throw new Error(`Article footer template is missing the CURRENT_YEAR placeholder: ${ARTICLE_FOOTER_FILE}`);
  }
  return template.replace('{{CURRENT_YEAR}}', String(new Date().getFullYear())).trim();
}

function buildMobileStickyCta() {
  return '<div class="guide-mobile-sticky" data-guide-sticky="true"><a class="btn btn-primary" href="#top-picks">View top picks</a></div>';
}

function updatePoolImageMetadata(poolFile, imageMetadata) {
  const document = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  const products = Array.isArray(document) ? document : document.products;
  let changed = false;
  for (const product of products) {
    const metadata = imageMetadata[product.asin];
    if (!metadata) continue;
    if (product.image_local_path !== metadata.image_local_path) {
      product.image_local_path = metadata.image_local_path;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(poolFile, `${JSON.stringify(document, null, 2)}\n`);
}

// ── Groq API ─────────────────────────────────────────────────────────────────
// Keep the primary model unchanged. The fallback is used only after the primary
// model has exhausted its 429 retries.
const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b';
const GROQ_MAX_429_ATTEMPTS = 5;
const GROQ_MAX_TOKENS = 4096;
const GROQ_TOKEN_WINDOW_MS = 60 * 1000;
const GROQ_TOKEN_WINDOW_BUDGET = 7000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createGroqHttpError(statusCode, message, headers = {}) {
  const error = new Error(message || `Groq request failed with HTTP ${statusCode}`);
  error.statusCode = statusCode;
  error.headers = headers;
  return error;
}

function isRateLimitError(error) {
  return error && error.statusCode === 429;
}

function retryDelayMs(error, attempt) {
  const retryAfter = error.headers && (error.headers['retry-after'] || error.headers['Retry-After']);
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000) + 2000;

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.max(0, retryDate - Date.now()) + 2000;
  }

  const messageMatch = String(error.message || '').match(/try again in\s+([\d.]+)\s*s/i);
  if (messageMatch) return Math.round(Number(messageMatch[1]) * 1000) + 2000;

  // Groq did not provide a wait hint: use 15s, 30s, 60s, 120s exponential backoff.
  return 15000 * (2 ** (attempt - 1));
}

function estimateMessageTokens(messages) {
  const characters = messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
    return total + content.length;
  }, 0);
  return Math.max(1, Math.ceil(characters / 4));
}

function usageTokens(usage, messages, content) {
  if (usage && Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
    return usage.prompt_tokens + usage.completion_tokens;
  }
  return estimateMessageTokens(messages) + Math.max(1, Math.ceil(String(content || '').length / 4));
}

/**
 * Creates a serialized Groq requester. Serialization prevents the article and
 * metadata calls from racing each other inside Groq's 60-second TPM window.
 * Optional dependencies make the retry and pacing behavior locally testable
 * without network access or real delays.
 */
function createGroqClient({
  apiKey = GROQ_API_KEY,
  request: requestOverride,
  sleepFn = sleep,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let tokenWindowStartedAt = now();
  let tokenWindowUsed = 0;
  let requestChain = Promise.resolve();

  function resetTokenWindowIfNeeded() {
    const elapsed = now() - tokenWindowStartedAt;
    if (elapsed >= GROQ_TOKEN_WINDOW_MS) {
      tokenWindowStartedAt = now();
      tokenWindowUsed = 0;
    }
  }

  async function paceForTokenWindow(messages, model) {
    resetTokenWindowIfNeeded();
    // Forecast the configured completion cap before the request; on success,
    // actual Groq usage is recorded for the current 60-second window.
    const estimatedRequestTokens = estimateMessageTokens(messages) + GROQ_MAX_TOKENS;
    if (tokenWindowUsed + estimatedRequestTokens <= GROQ_TOKEN_WINDOW_BUDGET) return;

    const waitMs = Math.max(0, GROQ_TOKEN_WINDOW_MS - (now() - tokenWindowStartedAt));
    logger.log(`[groq-pace] Waiting ${Math.ceil(waitMs / 1000)}s before ${model} to stay below ~${GROQ_TOKEN_WINDOW_BUDGET} TPM.`);
    if (waitMs > 0) await sleepFn(waitMs);
    tokenWindowStartedAt = now();
    tokenWindowUsed = 0;
  }

  function sendRequest(messages, model) {
    if (requestOverride) {
      return requestOverride({ model, messages, temperature: 0.7, maxTokens: GROQ_MAX_TOKENS });
    }

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: GROQ_MAX_TOKENS,
      });
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400 || json.error) {
              return reject(createGroqHttpError(res.statusCode, json.error && json.error.message, res.headers));
            }
            resolve({ content: json.choices[0].message.content, usage: json.usage });
          } catch {
            reject(new Error('Failed to parse Groq response: ' + data.slice(0, 200)));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function requestWith429Retries(messages, model) {
    for (let attempt = 1; attempt <= GROQ_MAX_429_ATTEMPTS; attempt++) {
      await paceForTokenWindow(messages, model);
      try {
        const response = await sendRequest(messages, model);
        tokenWindowUsed += usageTokens(response.usage, messages, response.content);
        return response.content;
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        if (attempt === GROQ_MAX_429_ATTEMPTS) {
          error.groqRateLimitExhausted = true;
          throw error;
        }

        const waitMs = retryDelayMs(error, attempt);
        logger.warn(`[groq-429] ${model} attempt ${attempt}/${GROQ_MAX_429_ATTEMPTS} rate-limited; waiting ${Math.ceil(waitMs / 1000)}s before retrying the same request.`);
        await sleepFn(waitMs);
      }
    }
  }

  async function requestWithFallback(messages) {
    try {
      return await requestWith429Retries(messages, GROQ_MODEL);
    } catch (error) {
      if (!error.groqRateLimitExhausted) throw error;

      logger.error(`[groq-fallback] ${GROQ_MODEL} exhausted ${GROQ_MAX_429_ATTEMPTS} consecutive 429 retries; retrying this request once with ${GROQ_FALLBACK_MODEL}.`);
      return requestWith429Retries(messages, GROQ_FALLBACK_MODEL);
    }
  }

  function groqRequest(messages) {
    const scheduledRequest = requestChain.then(() => requestWithFallback(messages));
    // Keep the queue alive after a failed request so later generation attempts
    // preserve the same serialized, paced behavior.
    requestChain = scheduledRequest.catch(() => {});
    return scheduledRequest;
  }

  return { groqRequest };
}

const groqClient = createGroqClient();
function groqRequest(messages) {
  return groqClient.groqRequest(messages);
}

// ── Article generation ───────────────────────────────────────────────────────
async function generateArticleContent(topic, pool = loadVerifiedPool(), excludedAsins = new Set()) {
  console.log(`Generating article for: "${topic}"`);
  const relevantProducts = filterPoolForTopic(pool, topic).filter(product => !excludedAsins.has(product.asin));
  if (relevantProducts.length < MIN_RELEVANT_POOL_PRODUCTS) {
    throw new Error(`[asin-precheck] Blocking publish: topic has only ${relevantProducts.length} eligible product(s); the quality gate requires ${MIN_PRODUCT_BOXES}.`);
  }
  const productPool = formatPoolForPrompt(relevantProducts);
  const productCountInstruction = relevantProducts.length >= MIN_RELEVANT_POOL_PRODUCTS
    ? `Use at least ${MIN_PRODUCT_BOXES} and up to ${relevantProducts.length} relevant product recommendations from the approved pool.`
    : `The approved pool has only ${relevantProducts.length} relevant product(s), so do not generate this article: its topic does not have the ${MIN_PRODUCT_BOXES} qualified products required by the publish quality gate.`;

  const systemPrompt = `You are an expert overlanding writer for TrailBuiltOverland.com, an affiliate review site.
Write in a confident, practical, first-person-plural voice ("we tested", "we ran it for 3 months").
Every article must include:
- A compelling intro paragraph
- ${productCountInstruction}
- Amazon affiliate links formatted only as: https://www.amazon.com/dp/ASIN?tag=${ASSOCIATE_TAG}
- Product recommendations ONLY when their exact name and ASIN appear in the approved product pool below. Never guess, transform, or introduce any ASIN. Do not use an Amazon search URL, shortened URL, product family URL, or placeholder. Each product MUST have a UNIQUE ASIN.
- Pros/cons or "why we like it" for each included product
- At least one FAQ section with 3 questions
- An affiliate disclosure reminder in the footer note
Write clean HTML fragments only (no <html>/<head>/<body> tags).
Use <h2>, <h3>, <p>, <ul>, <li>, <strong> tags only outside of product boxes.
For each included product recommendation, wrap in a <div class="product-box" data-product="PRODUCT NAME" data-asin="ASIN"> containing an <h4>, one descriptive <p>, a <ul> with 2–3 <li> points, and the direct tagged Amazon product link. Do NOT emit <img>, prices, image wrappers, product metadata spans, emoji, or any other product-card presentation markup: the generator supplies the site-standard local-image product card after validation.`;

  const userPrompt = `Write a comprehensive buyer's guide article titled "Best ${topic.charAt(0).toUpperCase() + topic.slice(1)} 2026".
${productCountInstruction}
Make it around 1,200-1,500 words. Be specific with product names, prices, and real-world testing details.
Each product MUST use the exact corresponding name and ASIN from the approved pool. Use the concrete https://www.amazon.com/dp/{exact approved ASIN}?tag=${ASSOCIATE_TAG} destination. Do NOT create Amazon search links, reuse ASINs, leave placeholders, recommend a product outside the pool, or include a product when no relevant approved entry exists. Do not add any product image or price markup; the generator will inject the canonical local-image card layout after validation.

Approved topic-relevant product pool (the complete allowed list for this article):
${productPool || '(No relevant pool products are available. Write the guide without product boxes or Amazon links.)'}

End with a 3-question FAQ section using <h2 id="faq">FAQ</h2> and <h3> for each question.`;

  return groqRequest([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

async function generateMeta(topic) {
  const prompt = `For an overlanding affiliate article about "${topic}", write:
1. A title tag (max 65 chars, include "2026")
2. A meta description (min 100 chars, max 155 chars, mention testing, year 2026, and specific product types)

Do not provide image URLs; article heroes are selected deterministically from the curated local hero library.
Return as JSON: {"title": "...", "description": "..."}`;

  const raw = await groqRequest([
    { role: 'system', content: 'Return only valid JSON, no markdown.' },
    { role: 'user', content: prompt },
  ]);
  try {
    const parsed = JSON.parse(raw.trim());
    // Enforce minimum description length
    if (parsed.description && parsed.description.length < 100) {
      parsed.description = parsed.description + ` Our team tested the top-rated options in the field to find the best picks for every budget and overlanding build style in 2026.`;
      if (parsed.description.length > 155) parsed.description = parsed.description.substring(0, 152) + '...';
    }
    return parsed;
  } catch {
    return {
      title: `Best ${topic} 2026 — Trail Built`,
      description: `Expert overlanding gear reviews for ${topic} in 2026. Our team tested the top-rated options in the field to find the best picks for every budget and build.`,
    };
  }
}

// ── HTML template ─────────────────────────────────────────────────────────────
function buildHTML({ slug, title, description, ogImage, topic, bodyHTML, date, dateHuman, products }) {
  const articleUrl = `${SITE_URL}/articles/${slug}.html`;
  const cleanTitle = title.replace(' - Trail Built', '').replace(' — Trail Built', '');
  const commerceSchemas = buildCommerceSchemas({ title, articleUrl, bodyHTML, products });
  const articleFooter = loadArticleFooter();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="google-site-verification" content="-SPOBgw4SJuET6ls2todjugd59xdelE3YnaputXr6ps" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-GX99D9KWL0"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-GX99D9KWL0');
  </script>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${articleUrl}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${articleUrl}" />
  <meta property="og:type" content="article" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <link rel="icon" type="image/svg+xml" href="../images/favicon.svg" />
  <link rel="preconnect" href="https://images.pexels.com" crossorigin />
  <link rel="preconnect" href="https://m.media-amazon.com" crossorigin />
  <link rel="stylesheet" href="../css/style.css" />
  <script src="https://analytics.ahrefs.com/analytics.js" data-key="j9FlobP0cqeKUsyYo3HRlw" async></script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${escapeHtml(title)}",
    "description": "${escapeHtml(description)}",
    "image": "${escapeHtml(ogImage)}",
    "datePublished": "${date}",
    "dateModified": "${date}",
    "url": "${articleUrl}",
    "mainEntityOfPage": { "@type": "WebPage", "@id": "${articleUrl}" },
    "author": { "@type": "Person", "name": "Trail Built Staff" },
    "publisher": {
      "@type": "Organization",
      "name": "Trail Built",
      "url": "${SITE_URL}",
      "logo": { "@type": "ImageObject", "url": "${SITE_URL}/images/favicon.svg" }
    }
  }
  <\/script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE_URL}/" },
      { "@type": "ListItem", "position": 2, "name": "Reviews", "item": "${SITE_URL}/reviews.html" },
      { "@type": "ListItem", "position": 3, "name": "${escapeHtml(cleanTitle)}", "item": "${articleUrl}" }
    ]
  }
  <\/script>
  ${commerceSchemas.map(schema => `<script data-guide-commerce-schema="true" type="application/ld+json">${JSON.stringify(schema)}</script>`).join('\n  ')}
</head>
<body>

<header>
  <div class="container header-inner">
    <a href="../index.html" class="logo">Trail<span>Built</span></a>
    <nav>
      <a href="../index.html">Home</a>
      <a href="../reviews.html" class="active">Reviews</a>
      <a href="../build-guides.html">Build Guides</a>
      <a href="../quiz.html">Rig Quiz</a>
      <a href="../index.html#gear">Top Gear</a>
      <a href="../categories/recovery-gear.html" class="header-cta btn">Best Picks</a>
    </nav>
    <button class="menu-toggle" aria-label="Toggle menu" aria-expanded="false">&#9776;</button>
  </div>
</header>

<main id="main-content">
<div class="article-header">
  <div class="container">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="../index.html">Home</a> &rsaquo;
      <a href="../reviews.html">Reviews</a> &rsaquo;
      <span>${escapeHtml(cleanTitle)}</span>
    </nav>
    <div class="article-hero">
      <div>
        <div class="article-meta-top">
          <span class="badge">Gear Guide</span>
          <span class="badge badge-green">2026</span>
          <span class="card-date">${dateHuman}</span>
        </div>
        <h1>${escapeHtml(cleanTitle)}</h1>
        <p class="article-intro">${escapeHtml(description)}</p>
        <div class="article-byline">
          <div class="avatar">&#127952;</div>
          <div class="byline-info">
            <strong>Trail Built Staff</strong>
            <span>Published ${dateHuman}</span>
          </div>
        </div>
      </div>
      <div class="article-img-hero">
        <img src="${escapeHtml(ogImage)}" alt="${escapeHtml(cleanTitle)}" width="600" height="400" loading="lazy" decoding="async" />
      </div>
    </div>
  </div>
</div>

<div class="container">
  <div class="article-layout">
    <article class="article-body">
      <div class="share-bar" data-url="${articleUrl}" data-title="${escapeHtml(title)}">
        <span class="share-label">Share:</span>
        <a class="share-btn share-twitter" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(articleUrl)}&text=${encodeURIComponent(title)}" rel="noopener" target="_blank" aria-label="Share on X (Twitter)"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
        <a class="share-btn share-facebook" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(articleUrl)}" rel="noopener" target="_blank" aria-label="Share on Facebook">&#128218;</a>
        <a class="share-btn share-pinterest" href="https://pinterest.com/pin/create/button/?url=${encodeURIComponent(articleUrl)}&description=${encodeURIComponent(title)}" rel="noopener" target="_blank" aria-label="Share on Pinterest">&#128204;</a>
        <button class="share-btn share-copy" onclick="navigator.clipboard.writeText('${articleUrl}').then(function(){this.textContent='Copied!';var btn=this;setTimeout(function(){btn.textContent='&#128279;'},2000)}.bind(this))" aria-label="Copy link">&#128279;</button>
      </div>

      ${buildComparisonTable(products)}
      ${bodyHTML.replace(/<h2(\b[^>]*)>\s*Our Top Picks\s*<\/h2>/i, '<h2$1 id="top-picks">Our Top Picks</h2>')}
    </article>

    <aside class="article-sidebar">
      <div class="sidebar-widget">
        <h4>More Guides</h4>
        <div class="sidebar-product">
          <div class="icon">&#9981;</div>
          <div><h5><a href="best-overlanding-recovery-gear.html">Best Recovery Gear 2026</a></h5><span>18 min read</span></div>
        </div>
        <div class="sidebar-product">
          <div class="icon">&#128269;</div>
          <div><h5><a href="best-off-road-light-bars.html">Best Light Bars 2026</a></h5><span>14 min read</span></div>
        </div>
        <div class="sidebar-product">
          <div class="icon">&#127988;</div>
          <div><h5><a href="rooftop-tent-buying-guide.html">Rooftop Tent Guide 2026</a></h5><span>22 min read</span></div>
        </div>
        <div class="sidebar-product">
          <div class="icon">&#9889;</div>
          <div><h5><a href="best-overlanding-solar-and-power.html">Solar &amp; Power 2026</a></h5><span>16 min read</span></div>
        </div>
      </div>
      <div class="sidebar-widget" style="margin-top:1.5rem">
        <h4>Find Your Rig Profile</h4>
        <p style="font-size:0.9rem;color:var(--muted);margin-bottom:1rem">Take our 5-question quiz to get personalized gear picks for your vehicle.</p>
        <a href="../quiz.html" class="btn btn-primary" style="width:100%;text-align:center;display:block">Take the Quiz &rarr;</a>
      </div>
    </aside>
  </div>
</div>
</main>

<button class="back-to-top" aria-label="Back to top" title="Back to top">&#8679;</button>

${articleFooter}

<script src="../js/main.js"><\/script>
<script src="../js/amazon.js"><\/script>
<script src="../js/price-history.js"><\/script>
<script src="../js/guide-commerce.js"><\/script>
${buildMobileStickyCta()}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Index updater ─────────────────────────────────────────────────────────────
function synchronizeHomepageLatest() {
  execFileSync(process.execPath, [path.join(__dirname, 'sync-homepage-latest.js')], { stdio: 'inherit' });
}

// ANCHOR: we locate the insertion point by finding the stable
// '<!-- ===== TOP PRODUCT' comment and inserting the new card immediately
// before the </section> that precedes it.  This is whitespace-insensitive
// and survives any future HTML reformatting of that section.
function addArticleToIndex(slug, title, description, date, ogImage) {
  if (!fs.existsSync(INDEX_FILE)) return;
  let html = fs.readFileSync(INDEX_FILE, 'utf8');

  // ── Duplicate guard ──────────────────────────────────────────────────────
  if (html.includes(`articles/${slug}.html`)) {
    console.log(`Index already contains a link to ${slug} — synchronizing existing cards.`);
    synchronizeHomepageLatest();
    return;
  }

  const cleanTitle = title.replace(' - Trail Built', '').replace(' — Trail Built', '');
  // Canonical three-across review-card markup: local structural classes and
  // 600px source sizing are intentionally stable for all future insertions.
  const card =
`<div class="card">
<div class="card-img"><img alt="${escapeHtml(cleanTitle)}" decoding="async" loading="lazy" src="${escapeHtml(cardImageUrl(ogImage))}"/></div>
<div class="card-body">
<div class="card-meta">
<span class="badge">Gear Guide</span>
<span class="card-date">${escapeHtml(date)}</span>
</div>
<h3><a href="articles/${slug}.html">${escapeHtml(cleanTitle)}</a></h3>
<p>${escapeHtml(description)}</p>
<div class="card-footer">
<a class="read-link" href="articles/${slug}.html">Read More &rarr;</a>
<span class="read-time">12 min</span>
</div>
</div>
</div>`;

  // Insert immediately inside the canonical reviews grid, so a new article is
  // at the top of the homepage and remains a child of the three-across layout.
  const reviewsStart = html.indexOf('<section id="reviews">');
  const gridMarker = '<div class="grid-3">';
  const gridStart = reviewsStart === -1 ? -1 : html.indexOf(gridMarker, reviewsStart);
  if (gridStart === -1) {
    throw new Error(
      'addArticleToIndex: canonical reviews grid not found in index.html. ' +
      'The homepage was NOT updated. Fix the reviews grid before generating articles.'
    );
  }
  const insertionPoint = gridStart + gridMarker.length;
  const updated = html.slice(0, insertionPoint) + `\n${card}` + html.slice(insertionPoint);

  // ── No-change guard ───────────────────────────────────────────────────────
  if (updated === html) {
    throw new Error(
      'addArticleToIndex: String.replace produced no change — ' +
      'the anchor regex matched but the substitution was a no-op. ' +
      'The homepage was NOT updated.'
    );
  }

  fs.writeFileSync(INDEX_FILE, updated);
  synchronizeHomepageLatest();
  console.log(`Index updated and synchronized newest-first for "${slug}".`);
}

// ── Sitemap updater ───────────────────────────────────────────────────────────
function updateSitemap(slug, date) {
  const sitemapPath = path.join(__dirname, '..', 'sitemap.xml');
  let sitemap = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
  const entry = `  <url>
    <loc>${SITE_URL}/articles/${slug}.html</loc>
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
  if (sitemap.includes(`/${slug}.html`)) return;
  sitemap = sitemap.replace('</urlset>', entry + '\n</urlset>');
  fs.writeFileSync(sitemapPath, sitemap);
  console.log('Sitemap updated.');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GROQ_API_KEY) {
    console.error('ERROR: GROQ_API_KEY environment variable is not set.');
    console.error('Get a free key at: https://console.groq.com');
    process.exit(1);
  }

  const topic     = pickTopic();
  const slug      = topicToSlug(topic);
  const date      = todayISO();
  const dateHuman = todayHuman();
  const usedHeroImageKeys = loadUsedHeroImageKeys();
  const heroSelection = selectHeroImage(topic, HERO_LIBRARY, usedHeroImageKeys);

  console.log(`Topic: ${topic}`);
  console.log(`Slug:  ${slug}`);
  console.log(`[hero-select] ${heroSelection.category}: ${heroSelection.primary}`);

  // Overwrite guard: refuse to clobber an existing article unless --force was
  // explicitly passed. Checked here — immediately after slug is known — so that
  // no paid Groq calls are made for a topic that would be rejected anyway.
  const outPath   = path.join(ARTICLES_DIR, `${slug}.html`);
  const forceFlag = process.argv.includes('--force');
  if (fs.existsSync(outPath) && !forceFlag) {
    throw new Error(
      `OVERWRITE GUARD: ${outPath} already exists. ` +
      'Pass --force to overwrite an existing article.'
    );
  }

    // Generate article with ASIN pre-validation and retry (up to 3 attempts).
  // The pool must load before any paid generation request so a malformed seed fails safely.
  const verifiedPool = loadVerifiedPool();
  const MAX_ASIN_RETRIES = 3;
  const excludedImageAsins = new Set();
  let bodyHTML, meta, productCards;
  let generationPassed = false;
  for (let attempt = 1; attempt <= MAX_ASIN_RETRIES; attempt++) {
    console.log(`\n[asin-precheck] Generation attempt ${attempt}/${MAX_ASIN_RETRIES}`);
    [bodyHTML, meta] = await Promise.all([
      generateArticleContent(topic, verifiedPool, excludedImageAsins),
      attempt === 1 ? generateMeta(topic) : Promise.resolve(meta), // reuse meta on retries
    ]);
    meta.ogImage = heroSelection.primary;
    const { ok, failed } = await validateBodyAsins(bodyHTML, verifiedPool);
    if (failed.length > 0) {
      console.warn(`[asin-precheck] ⚠️  Attempt ${attempt}: ${failed.join('; ')}`);
      continue;
    }

    try {
      productCards = await conformProductBoxes(bodyHTML, verifiedPool, slug);
      bodyHTML = productCards.bodyHTML;
      console.log(`[asin-precheck] ✅ All ${ok.length} direct ASIN(s) verified live with local product images.`);
      generationPassed = true;
      break;
    } catch (error) {
      if (error.asin) excludedImageAsins.add(error.asin);
      console.warn(`[product-images] ⚠️  Attempt ${attempt}: ${error.message}`);
      if (!error.asin) break;
      console.log(`[product-images] Retrying generation with ${error.asin} excluded so another verified pool product can be selected.`);
    }
  }
  if (!generationPassed) {
    throw new Error(`[asin-precheck] Blocking publish: no generated draft passed ASIN and local-product-image validation after ${MAX_ASIN_RETRIES} attempts.`);
  }
  updatePoolImageMetadata(VERIFIED_POOL_FILE, productCards.imageMetadata);

  // Validate hero image URL — reject dead URLs before writing the article file.
  // This prevents the link-check gate from failing in CI.
  console.log(`[image-validate] Checking hero image: ${meta.ogImage}`);
  meta.ogImage = await resolveValidImageUrl(meta.ogImage, heroSelection.fallbacks);
  console.log(`[image-validate] Hero image OK: ${meta.ogImage}`);
  const products = extractProductSchemaRecords(bodyHTML, verifiedPool);
  const html = buildHTML({
    slug,
    title: meta.title,
    description: meta.description,
    ogImage: meta.ogImage,
    topic,
    bodyHTML,
    date,
    dateHuman,
    products,
  });

  fs.writeFileSync(outPath, html);
  recordUsedHeroImage(slug, meta.ogImage);
  console.log(`Article written: ${outPath}`);

  addArticleToIndex(slug, meta.title, meta.description, dateHuman, meta.ogImage);
  updateSitemap(slug, date);
  console.log('Done.');
}

// Export helpers for unit testing; only run main() when invoked directly.
if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  topicToSlug,
  createGroqClient,
  createGroqHttpError,
  extractAsins,
  loadVerifiedPool,
  filterPoolForTopic,
  validateBodyAsins,
  conformProductBoxes,
  productImageFilename,
  canonicalProductBox,
  extractProductSchemaRecords,
  extractFaqSchemaPairs,
  buildCommerceSchemas,
  buildHTML,
  loadHeroLibrary,
  heroImageKey,
  scanCurrentEditorialImageKeys,
  loadUsedHeroImageKeys,
  recordUsedHeroImage,
  selectHeroImage,
  resolveValidImageUrl,
  cardImageUrl,
};
