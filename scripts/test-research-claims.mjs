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

  fs.writeFileSync(page, '<!doctype html><p>Research-based comparisons organize published specifications and fitment details.</p>\n');
  const clean = spawnSync(process.execPath, [linter, '--root', fixture], { encoding: 'utf8' });
  assert.strictEqual(clean.status, 0, clean.stderr || clean.stdout);
  console.log('Research-claims linter regression test passed.');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
