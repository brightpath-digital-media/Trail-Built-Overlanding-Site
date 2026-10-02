#!/usr/bin/env node
/**
 * Smoke tests for remote fallback URLs and stylesheet-background validation.
 * Usage: node scripts/_test_image_validate.js
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const UNSPLASH_FALLBACKS = [
  'https://images.unsplash.com/photo-1533591380348-14193f1de18f?w=1200&q=80',
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1200&q=80',
  'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=1200&q=80',
  'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=1200&q=80',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80',
  'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=1200&q=80',
  'https://images.unsplash.com/photo-1518611012118-696072aa579a?w=1200&q=80',
  'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=1200&q=80',
];

const DEAD_URL = 'https://images.unsplash.com/photo-1534536297917?w=1200&q=80';

function validateImageUrl(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : require('http');
      const req = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD', timeout: 8000 },
        (res) => {
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

function runImageCoverage(dir) {
  return execFileSync(process.execPath, [path.join(__dirname, 'validate-image-coverage.mjs'), '--dir', dir, '--remote', 'off', '--hero', 'warn', '--page-level', 'block'], {
    encoding: 'utf8',
  });
}

function writeFixture(root, background) {
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><section class="hero">Hero</section></body></html>');
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background: url('${background}') center / cover no-repeat; }`);
}

function testStylesheetBackgroundValidation() {
  console.log('\n=== Testing stylesheet hero background validation ===');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-image-coverage-'));
  try {
    writeFixture(root, '../images/missing.jpg');
    const missing = runImageCoverage(root);
    assert.match(missing, /WARN hero\s+index\.html/, 'missing local stylesheet image must not satisfy the hero rule');

    fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background-image: url('https://images.example.invalid/hero.jpg'); }`);
    const remote = runImageCoverage(root);
    assert.match(remote, /WARN hero\s+index\.html/, 'remote stylesheet image must not satisfy the hero rule');

    fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background-image: url('data:image/png;base64,AA=='); }`);
    const data = runImageCoverage(root);
    assert.match(data, /WARN hero\s+index\.html/, 'data URI stylesheet image must not satisfy the hero rule');

    fs.mkdirSync(path.join(root, 'images'));
    fs.writeFileSync(path.join(root, 'images', 'hero.jpg'), 'non-empty local image fixture');
    fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background-image: url('../images/hero.jpg'); }`);
    const local = runImageCoverage(root);
    assert.doesNotMatch(local, /WARN hero/, 'existing non-empty local stylesheet image must satisfy the hero rule');

    fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background: url('../images/hero.jpg'), url('../images/missing.jpg'); }`);
    const mixed = runImageCoverage(root);
    assert.match(mixed, /WARN hero\s+index\.html/, 'a rule with any missing stylesheet image must not satisfy the hero rule');

    fs.writeFileSync(path.join(root, 'css', 'site.css'), `.hero { background-image: url('../images/hero.jpg'); }`);
    const homepage = runImageCoverage(path.join(__dirname, '..'));
    assert.doesNotMatch(homepage, /WARN hero\s+index\.html/, 'homepage local stylesheet hero must satisfy the hero rule');
    console.log('PASS: missing, remote, and data stylesheet backgrounds warn; local fixture and homepage backgrounds pass.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  console.log('\n=== Testing dead URL rejection ===');
  const deadOk = await validateImageUrl(DEAD_URL);
  if (deadOk) {
    console.error(`FAIL: Dead URL returned 200 — it may have been restored: ${DEAD_URL}`);
  } else {
    console.log(`PASS: Dead URL correctly rejected (non-200): ${DEAD_URL}`);
  }

  console.log('\n=== Testing fallback pool ===');
  let allOk = true;
  for (const url of UNSPLASH_FALLBACKS) {
    const ok = await validateImageUrl(url);
    const status = ok ? 'OK' : 'DEAD';
    console.log(`  ${status}  ${url}`);
    if (!ok) allOk = false;
  }

  testStylesheetBackgroundValidation();

  console.log('\n=== Summary ===');
  if (!deadOk && allOk) {
    console.log('All checks passed. Dead URL rejected; all fallbacks and stylesheet-background checks passed.');
    process.exit(0);
  } else {
    if (deadOk) console.error('WARNING: Dead URL is now returning 200 — update the test.');
    if (!allOk) console.error('ERROR: One or more fallback URLs are dead — update UNSPLASH_FALLBACKS.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
