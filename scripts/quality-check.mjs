import fs from 'fs';
import path from 'path';

const root = process.cwd();
const LEGACY_MIN_PRODUCT_BOX_ARTICLES = [
  'articles/best-overlanding-first-aid-kit-essentials.html',
  'articles/best-overlanding-water-storage-and-filtration.html',
  'articles/best-vehicle-communication-gear-for-overlanding.html',
];

// Live verified products may be text-first only when an article-title pair is explicitly
// approved for image deferral. All unlisted cards must keep the canonical local-image markup.
const IMAGELESS_PRODUCT_EXCEPTIONS = new Set();

function printUsage() {
  console.log('Usage: node scripts/quality-check.mjs [--scoped-run] [--article <articles/file.html>]... [--report <path>]');
  console.log('Without --scoped-run or --article, all legacy min-product-box targets are validated strictly (local full check).');
  console.log('With --scoped-run and --article paths, only current-run changed article paths block on the five-box minimum; untouched legacy shortfalls are warnings.');
}

const cliArgs = process.argv.slice(2);
const requestedArticles = [];
let reportPath = null;
let scopedRunFlag = false;
for (let i = 0; i < cliArgs.length; i += 1) {
  const arg = cliArgs[i];
  if (arg === '--scoped-run') {
    scopedRunFlag = true;
  } else if (arg === '--article') {
    const value = cliArgs[++i];
    if (!value) {
      console.error('Missing value for --article');
      process.exit(2);
    }
    requestedArticles.push(value);
  } else if (arg === '--report') {
    const value = cliArgs[++i];
    if (!value) {
      console.error('Missing value for --report');
      process.exit(2);
    }
    reportPath = value;
  } else if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }
}

const htmlFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(filePath);
    else if (entry.isFile() && filePath.endsWith('.html')) htmlFiles.push(filePath);
  }
}
walk(root);

function normaliseArticlePath(value) {
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && relative.endsWith('.html')) {
    return relative.split(path.sep).join('/');
  }
  return null;
}

const errors = [];
const warnings = [];
const normalisedRequestedArticles = [...new Set(requestedArticles.map(normaliseArticlePath))];
if (normalisedRequestedArticles.some((article) => article === null)) {
  errors.push('Each --article path must be an HTML file inside this repository');
}
for (const article of normalisedRequestedArticles.filter(Boolean)) {
  if (!fs.existsSync(path.join(root, article))) {
    errors.push(`${article}: requested current-run article does not exist`);
  }
}

for (const file of htmlFiles) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  if (/(#x1D54F;|&#x1D54F;|&#120143;|𝕏 Twitter)/.test(text)) {
    errors.push(`${rel}: malformed X/Twitter share text found`);
  }
  if (/<td\b[^>]*>\s*undefined\s*<\/td>/i.test(text)) {
    errors.push(`${rel}: unresolved comparison-table value 'undefined' found`);
  }
  if (/<th\b[^>]*>\s*Price\s*<\/th>/i.test(text)) {
    errors.push(`${rel}: static comparison Price column found without a current catalog-render payload`);
  }
}

const scopedRun = scopedRunFlag || normalisedRequestedArticles.length > 0;
const strictMinProductBoxArticles = scopedRun
  ? normalisedRequestedArticles.filter(Boolean)
  : LEGACY_MIN_PRODUCT_BOX_ARTICLES;
const productBoxValidationArticles = [...new Set([
  ...strictMinProductBoxArticles,
  ...LEGACY_MIN_PRODUCT_BOX_ARTICLES,
])];
const minProductBoxResults = [];

for (const article of productBoxValidationArticles) {
  const file = path.join(root, article);
  if (!fs.existsSync(file)) {
    errors.push(`${article}: expected article file is missing`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const boxes = [...text.matchAll(/<div class="product-box"[\s\S]*?(?=<div class="product-box"|<h2 id="faq"|<p>When choosing|<\/article>)/g)];
  const isStrictTarget = strictMinProductBoxArticles.includes(article);
  const result = {
    article,
    boxes: boxes.length,
    enforcement: isStrictTarget ? 'blocking' : 'report-only',
  };
  minProductBoxResults.push(result);

  if (boxes.length < 5) {
    const message = `${article}: expected at least 5 product boxes, found ${boxes.length}`;
    if (isStrictTarget) errors.push(message);
    else warnings.push(`Legacy product-box shortfall (report-only): ${message}`);
  }

  // Validate the standard product-card contract for the articles under the
  // current run plus known legacy targets. A legacy count shortfall is warning
  // only when it was not modified by this run; malformed individual cards still
  // remain a content defect worth surfacing.
  for (const [i, match] of boxes.entries()) {
    const box = match[0];
    const title = box.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '';
    const isApprovedTextFirst = IMAGELESS_PRODUCT_EXCEPTIONS.has(`${article}::${title}`);
    if (!isApprovedTextFirst && !/class="product-box-image"/.test(box)) errors.push(`${article}: product box ${i + 1} missing product image wrapper`);
    if (!isApprovedTextFirst && !/<img [^>]*src="\.\.\/assets\/product-images\//.test(box)) errors.push(`${article}: product box ${i + 1} missing local product image src`);
    if (!isApprovedTextFirst && !/<img [^>]*alt="[^"]{12,}"/.test(box)) errors.push(`${article}: product box ${i + 1} missing descriptive image alt text`);
    if (isApprovedTextFirst && /<img\b/i.test(box)) errors.push(`${article}: deferred product box ${i + 1} must remain image-free`);
    if (!/href="https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}\?tag=trailbuiltove-20"/.test(box)) errors.push(`${article}: product box ${i + 1} missing direct tagged Amazon dp link`);
    if (/amazon\.com\/s\?k=/.test(box)) errors.push(`${article}: product box ${i + 1} still uses generic Amazon search link`);
  }
}

// Local article image paths must exist before a current-run article can publish.
// Legacy pages are still scanned and reported, but only explicitly scoped current
// articles block the run. This mirrors the established product-box scoping rule.
const localImageResults = [];
const allArticleFiles = htmlFiles.filter(file =>
  path.relative(root, file).split(path.sep).join('/').startsWith('articles/'),
);
for (const articleFile of allArticleFiles) {
  const article = path.relative(root, articleFile).split(path.sep).join('/');
  const text = fs.readFileSync(articleFile, 'utf8');
  const localSources = [...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(match => match[1].trim())
    .filter(src => src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(src));
  const missing = [];
  for (const src of localSources) {
    const assetPath = src.split(/[?#]/, 1)[0];
    const resolvedAsset = path.resolve(path.dirname(articleFile), assetPath);
    const insideRepository = resolvedAsset === root || resolvedAsset.startsWith(`${root}${path.sep}`);
    if (!insideRepository || !fs.existsSync(resolvedAsset)) missing.push(src);
  }
  const isStrictTarget = strictMinProductBoxArticles.includes(article);
  const result = {
    article,
    local_image_count: localSources.length,
    missing_local_images: missing,
    enforcement: isStrictTarget ? 'blocking' : 'report-only',
  };
  localImageResults.push(result);
  if (missing.length > 0) {
    const message = `${article}: ${missing.length} local image src reference(s) do not resolve to repository files (${missing.join(', ')})`;
    if (isStrictTarget) errors.push(message);
    else warnings.push(`Legacy local-image defect (report-only): ${message}`);
  }
}

const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
for (const selector of ['.grid-3 > .card', '.card-footer', '.review-card', '.comparison-card', '.guide-card', '.product-box-image']) {
  if (!css.includes(selector)) errors.push(`css/style.css: missing ${selector} quality-layout rule`);
}
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const reviewsSection = index.match(/<section id="reviews"[\s\S]*?<\/section>/)?.[0] || '';
const homepageCards = [...reviewsSection.matchAll(/class="card"/g)].length;
if (homepageCards < 6) errors.push(`index.html: expected at least 6 homepage gear-review cards, found ${homepageCards}`);
if (/<a[^>]*class="review-card"[\s\S]*<a[^>]*class="review-card"/.test(index)) {
  errors.push('index.html: detected nested review-card anchors');
}
if (homepageCards > 20) {
  errors.push(`index.html: possible nested or duplicated homepage cards detected (${homepageCards} card markers)`);
}

const report = {
  scoped_run: scopedRun,
  strict_min_product_box_articles: strictMinProductBoxArticles,
  min_product_box_results: minProductBoxResults,
  local_image_results: localImageResults,
  errors,
  warnings,
};
if (reportPath) {
  const resolvedReportPath = path.resolve(root, reportPath);
  fs.mkdirSync(path.dirname(resolvedReportPath), { recursive: true });
  fs.writeFileSync(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Quality-check report written: ${resolvedReportPath}`);
}

if (warnings.length) {
  console.warn('Quality check warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}
if (errors.length) {
  console.error('Quality check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const scopeLabel = scopedRun
  ? `${strictMinProductBoxArticles.length} current-run article(s) enforced; untouched legacy shortfalls report-only`
  : 'local full check; all legacy min-product-box targets enforced';
console.log(`Quality check passed: ${htmlFiles.length} HTML files scanned; ${scopeLabel}.`);
for (const result of minProductBoxResults) {
  console.log(`- ${result.article}: ${result.boxes} product boxes (${result.enforcement})`);
}
for (const result of localImageResults) {
  console.log(`- ${result.article}: ${result.local_image_count} local image reference(s), ${result.missing_local_images.length} missing (${result.enforcement})`);
}
