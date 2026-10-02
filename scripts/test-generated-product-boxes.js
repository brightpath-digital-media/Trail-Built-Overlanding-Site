#!/usr/bin/env node
/**
 * Credential-free post-generation contract test.
 * It substitutes fixed model output and local SVG placeholder downloads, then runs
 * the repository's unchanged quality gate against the resulting five-card article.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { conformProductBoxes } = require('./generate-article');

const root = path.join(__dirname, '..');
const articlePath = path.join(root, 'articles', '__stub-product-image-quality.html');
const reportPath = path.join(root, 'reports', '__stub-product-image-quality.json');
const seoReportPath = path.join(root, 'seo-audit-report.json');
const originalSeoReport = fs.existsSync(seoReportPath) ? fs.readFileSync(seoReportPath) : null;
const asins = ['B0STUB0001', 'B0STUB0002', 'B0STUB0003', 'B0STUB0004', 'B0STUB0005'];
const placeholderImage = path.join(root, 'assets', 'product-images', 'best-overlanding-first-aid-kit-essentials-adventure-medical-kits-mountain-series-hiker-3403a181.jpg');
const pool = new Map(asins.map((asin, index) => [asin, {
  asin,
  name: `Stub Recovery Product ${index + 1}`,
  tags: ['stub', 'recovery', 'overlanding'],
  image_url: `https://example.invalid/${asin}.jpg`,
}]));

const generatedBody = asins.map((asin, index) => `
<div class="product-box" data-product="Stub Recovery Product ${index + 1}" data-asin="${asin}">
  <h4>Stub Recovery Product ${index + 1}</h4>
  <p>A fixed local test recommendation for recovery and overlanding use.</p>
  <ul><li>Useful for prepared vehicle travel</li><li>Easy to store in a trail kit</li></ul>
  <a href="https://www.amazon.com/dp/${asin}?tag=trailbuiltove-20">Check current price on Amazon</a>
</div>`).join('\n') + '\n<h2 id="faq">FAQ</h2><p>Stub FAQ content.</p>';

async function placeholderDownloader(_url, destination) {
  // Deliberately avoid a network call. A valid existing local JPEG is copied as
  // the test placeholder so the generated local paths are image-audit readable.
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(placeholderImage, destination);
}

async function run() {
  const createdPaths = [];
  try {
    const result = await conformProductBoxes(generatedBody, pool, '__stub-product-image-quality', placeholderDownloader);
    for (const metadata of Object.values(result.imageMetadata)) {
      createdPaths.push(path.join(root, metadata.image_local_path));
    }

    assert.strictEqual((result.bodyHTML.match(/class="product-box"/g) || []).length, 5);
    assert.strictEqual((result.bodyHTML.match(/class="product-box-image"/g) || []).length, 5);
    assert.strictEqual((result.bodyHTML.match(/src="\.\.\/assets\/product-images\//g) || []).length, 5);
    assert.strictEqual((result.bodyHTML.match(/alt="[^"]{12,}"/g) || []).length, 5);

    const title = 'Stub Overlanding Recovery Products 2026';
    const description = 'A credential-free local validation article with five runtime-normalized product cards, descriptive image text, and direct tagged product links.';
    const stubHtml = `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${description}"/><meta name="robots" content="index, follow"/><link rel="canonical" href="https://trailbuiltoverland.com/articles/__stub-product-image-quality.html"/><meta property="og:title" content="${title}"/><meta property="og:description" content="${description}"/><meta property="og:image" content="https://example.invalid/stub.jpg"/><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script></head><body><h1>${title}</h1><article>${result.bodyHTML}</article></body></html>\n`;
    fs.writeFileSync(articlePath, stubHtml);

    const sanitizerOutput = execFileSync(process.execPath, ['scripts/sanitize-articles.mjs', '--file', articlePath], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = execFileSync(process.execPath, [
      'scripts/quality-check.mjs',
      '--scoped-run',
      '--article', 'articles/__stub-product-image-quality.html',
      '--report', 'reports/__stub-product-image-quality.json',
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const seoOutput = execFileSync(process.execPath, [
      'scripts/seo-audit.mjs', '--scoped-run', '--article', 'articles/__stub-product-image-quality.html',
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const seoReport = JSON.parse(fs.readFileSync(seoReportPath, 'utf8'));
    assert.deepStrictEqual(report.errors, []);
    assert.strictEqual(report.min_product_box_results.find(item => item.article.endsWith('__stub-product-image-quality.html')).boxes, 5);
    assert.strictEqual(seoReport.summary.issues, 0, `Stub SEO audit reported issues: ${seoReport.issues.join('; ')}`);
    console.log(sanitizerOutput.trim());
    console.log(output.trim());
    console.log(seoOutput.trim());
    console.log('Generator stub passed: five canonical product boxes include local image wrappers, local sources, descriptive alt text, clean sanitizer output, and a zero-issue SEO audit.');
  } finally {
    fs.rmSync(articlePath, { force: true });
    fs.rmSync(reportPath, { force: true });
    if (originalSeoReport) fs.writeFileSync(seoReportPath, originalSeoReport);
    else fs.rmSync(seoReportPath, { force: true });
    for (const imagePath of createdPaths) fs.rmSync(imagePath, { force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
