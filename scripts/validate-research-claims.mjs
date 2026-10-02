#!/usr/bin/env node
/**
 * Block first-hand testing, ownership, mileage, and reviewer-persona claims from
 * published Trail Built copy and the sources that generate it.
 *
 * Usage:
 *   node scripts/validate-research-claims.mjs
 *   node scripts/validate-research-claims.mjs --root /path/to/copy-fixture
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex === -1 ? DEFAULT_ROOT : path.resolve(process.argv[rootIndex + 1] || DEFAULT_ROOT);

const RULES = [
  ['reviewer-persona', /\b(?:Dylan\s+Frost|Marcus\s+Reed|Trail\s+Built\s+Staff)\b/gi, 'reviewer name or persona'],
  ['hands-on-claim', /\bhands[-\s]?on\b/gi, 'hands-on claim'],
  ['field-or-trail-tested', /\b(?:field|trail)[-\s]?tested\b/gi, 'field/trail testing claim'],
  ['real-world-test-claim', /\breal[-\s]?world\s+test\b/gi, 'unsupported real-world test claim'],
  ['first-hand-claim', /\bfirst[-\s]?hand\b/gi, 'first-hand claim'],
  ['testing-claim', /\b(?:testing|tested)\s+(?:methodology|criteria|conditions|results|gear|products?|units?)\b/gi, 'testing claim'],
  ['tested-language', /\b(?:tested|testing)\b/gi, 'unsupported testing language'],
  ['last-tested-label', /\b(?:last|independently)\s+tested\b/gi, 'tested-status label'],
  ['first-person-physical-use', /\b(?:we|we['’]ve|our\s+team)\b\s+(?:test(?:ed|ing)?|run|ran|drive|drove|own(?:ed)?|use(?:d)?|buy|bought|log(?:ged)?)\b/gi, 'first-person physical-use claim'],
  ['first-person-mileage', /\b(?:we|we['’]ve|our\s+team)\b[^.!?\n]{0,60}\b(?:mile|miles|mileage)\b/gi, 'first-person mileage claim'],
  ['own-rig-claim', /\b(?:our|my|their)\s+(?:own\s+)?rigs?\b/gi, 'ownership claim'],
  ['numeric-mileage', /\b\d{1,3}(?:,\d{3})*(?:\+)?\s+miles?\b/gi, 'unsupported mileage claim'],
  ['measured-claim', /\bmeasured\b/gi, 'unsupported measurement claim'],
  ['evaluation-claim', /\b(?:our|the)\s+evaluation\b/gi, 'unsupported evaluation claim'],
  ['real-world-use-claim', /\breal[-\s]?world\s+(?:testing|use|results)\b/gi, 'unsupported real-world use claim'],
  ['on-trail-physical-use', /\b(?:drove|drive|ran|run|mounted|mount|installed|install|used|use|observed|observe)\b[^.!?\n]{0,80}\bon\s+the\s+trail\b|\bon\s+the\s+trail\b[^.!?\n]{0,80}\b(?:drove|drive|ran|run|mounted|mount|installed|install|used|use|observed|observe)\b/gi, 'unsupported on-trail physical-use claim'],
  ['test-mule-claim', /\btest\s+mule\b/gi, 'unsupported test-mule claim'],
  ['we-found-claim', /\bwe\s+found\b/gi, 'unsupported first-person finding'],
  ['after-testing-claim', /\bafter\s+(?:rigorous\s+)?testing\b/gi, 'unsupported post-testing claim'],
  ['static-product-price', /(?:\bpriceDisplay\s*:\s*["'](?:~|≈)?\s*\$|\bprice\s*:\s*(?!0(?:\.0+)?\b)\d+(?:\.\d+)?|\$\s*(?:\d{2,}\b|\d+\.\d{2}\b))/gi, 'static product price or stale price payload'],
  ['unverified-manufacturer-number', /\bmanufacturer[-\s](?:listed|rated|specified)\b(?:(?![.!?]).){0,160}\d/gi, 'manufacturer-qualified numeric specification without a source record'],
];

function existing(relative) {
  const full = path.join(ROOT, relative);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? [full] : [];
}

function filesWithExtensions(relative, extensions) {
  const directory = path.join(ROOT, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true })
    .map(entry => path.join(directory, entry))
    .filter(file => fs.existsSync(file) && fs.statSync(file).isFile() && extensions.some(extension => file.endsWith(extension)));
}

function copySources() {
  return [
    ...existing('index.html'), ...existing('about.html'), ...existing('reviews.html'),
    ...existing('build-guides.html'), ...existing('quiz.html'),
    ...filesWithExtensions('articles', ['.html']), ...filesWithExtensions('categories', ['.html']),
    ...filesWithExtensions('templates', ['.html']), ...filesWithExtensions('email-templates', ['.html']),
    ...filesWithExtensions('newsletters', ['.html', '.json']),
    ...filesWithExtensions('data', ['.json']),
    ...existing('js/main.js'), ...existing('js/products-data.js'), ...existing('js/price-history.js'),
    ...existing('scripts/generate-article.js'),
    ...existing('scripts/sanitize-articles.mjs'),
    ...existing('scripts/standardize-guide-commerce.py'),
    ...existing('scripts/fix_water_article.py'),
  ].sort();
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

const issues = [];
for (const file of copySources()) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [id, pattern, description] of RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      issues.push({
        file: path.relative(ROOT, file),
        line: lineAt(text, match.index),
        id,
        description,
        snippet: match[0].replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
}

if (issues.length) {
  console.error('Research-based claims gate failed:');
  for (const issue of issues) {
    console.error(`  - ${issue.file}:${issue.line} [${issue.id}] ${issue.description}: ${JSON.stringify(issue.snippet)}`);
  }
  process.exit(1);
}

console.log(`Research-based claims gate passed: ${copySources().length} copy-emitting source file(s) scanned.`);
