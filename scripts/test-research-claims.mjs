#!/usr/bin/env node
/** Regression test for the blocking research-based claims linter. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const linter = path.join(__dirname, 'validate-research-claims.mjs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-built-research-claims-'));
const page = path.join(fixture, 'index.html');

try {
  fs.writeFileSync(page, '<!doctype html><p>We tested our own rigs across 2,000 miles.</p>\n');
  const violation = spawnSync(process.execPath, [linter, '--root', fixture], { encoding: 'utf8' });
  assert.notStrictEqual(violation.status, 0, 'seeded first-person testing claim must block');
  assert.match(violation.stderr, /(?:tested-language|first-person-physical-use)/, 'failure must name a blocking research-claims rule');

  const seededViolations = [
    ['numeric-mileage', 'The route covered 3,200+ miles of desert travel.'],
    ['measured-claim', 'We measured current draw during a weekend trip.'],
    ['evaluation-claim', 'The evaluation averaged 2.8 amps.'],
    ['real-world-use-claim', 'Real-world testing showed stable output.'],
    ['on-trail-physical-use', 'We installed the kit on the trail.'],
    ['test-mule-claim', 'The Tacoma served as a test mule.'],
    ['we-found-claim', 'We found that the product ran quietly.'],
    ['after-testing-claim', 'After rigorous testing, this is the winner.'],
    ['static-product-price', 'Current offer: $499 beside the Amazon link.'],
    ['unverified-manufacturer-number', 'Manufacturer-listed capacity is 1,002 Wh.'],
  ];
  for (const [rule, text] of seededViolations) {
    fs.writeFileSync(page, `<!doctype html><p>${text}</p>\n`);
    const seeded = spawnSync(process.execPath, [linter, '--root', fixture], { encoding: 'utf8' });
    assert.notStrictEqual(seeded.status, 0, `${rule} must block`);
    assert.match(seeded.stderr, new RegExp(`\\[${rule}\\]`), `${rule} must identify itself`);
  }

  fs.writeFileSync(page, '<!doctype html><p>Consult the linked manufacturer or seller listing for current specifications and fitment before purchase.</p>\n');
  const clean = spawnSync(process.execPath, [linter, '--root', fixture], { encoding: 'utf8' });
  assert.strictEqual(clean.status, 0, `research-based listing guidance must pass: ${clean.stderr || clean.stdout}`);
  console.log('Research-claims linter regression test passed.');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
