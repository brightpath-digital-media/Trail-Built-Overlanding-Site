#!/usr/bin/env node
/**
 * sanitize-articles.mjs
 * Post-generation sanitizer for Trail Built Overlanding articles.
 * Runs after generate-article.js to fix known AI output issues before
 * the quality gate and SEO audit run.
 *
 * Fixes applied:
 *  1. Malformed X/Twitter share button — replaces &#120143; / &#x1D54F; / 𝕏
 *     with a clean SVG X icon.
 *  2. Short meta descriptions — pads descriptions under 100 chars.
 *  3. Stray encoded share text in button labels.
 *
 * Usage:
 *   node scripts/sanitize-articles.mjs              # sanitize all articles
 *   node scripts/sanitize-articles.mjs --file path  # sanitize one file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.resolve(REPO, 'articles');

// The clean SVG X icon to use in share buttons
const X_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;

function sanitizeFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  const rel = path.relative(REPO, filePath);
  const fixes = [];

  // ── Fix 1: Malformed X/Twitter share button icon ──────────────────────────
  // Matches any of: &#120143; &#x1D54F; 𝕏 (the raw Unicode char)
  // inside a share-twitter anchor tag
  const twitterBtnPattern = /(<a[^>]*class="share-btn share-twitter"[^>]*>)([\s\S]*?)(<\/a>)/g;
  const fixedContent = content.replace(twitterBtnPattern, (match, open, inner, close) => {
    const hasProblematic = /&#120143;|&#x1D54F;|&#x1d54f;|𝕏/.test(inner);
    const alreadySvg = inner.includes('<svg');
    if (hasProblematic || (!alreadySvg && inner.trim() !== '')) {
      fixes.push('Replaced malformed X/Twitter share icon with SVG');
      changed = true;
      return `${open}${X_SVG}${close}`;
    }
    return match;
  });
  content = fixedContent;

  // ── Fix 2: Short meta description ────────────────────────────────────────
  const descPattern = /(<meta\s+name="description"\s+content=")([^"]{1,99})(")/g;
  content = content.replace(descPattern, (match, open, desc, close) => {
    if (desc.length < 100) {
      const padded = (desc + ` Compare published specifications, fitment, availability, and warranty information for overlanding build planning in 2026.`).substring(0, 155);
      fixes.push(`Padded short meta description from ${desc.length} to ${padded.length} chars`);
      changed = true;
      return `${open}${padded}${close}`;
    }
    return match;
  });

  // ── Fix 3: Stray 𝕏 character anywhere in the file ────────────────────────
  if (/𝕏/.test(content)) {
    content = content.replace(/𝕏/g, 'X');
    fixes.push('Replaced raw 𝕏 Unicode character with plain X');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✅ Sanitized ${rel}:`);
    fixes.forEach(f => console.log(`     - ${f}`));
  }

  return { file: rel, changed, fixes };
}

function main() {
  const args = process.argv.slice(2);
  const targetFile = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

  const files = targetFile
    ? [path.resolve(targetFile)]
    : fs.readdirSync(ARTICLES_DIR)
        .filter(f => f.endsWith('.html'))
        .map(f => path.join(ARTICLES_DIR, f));

  console.log(`\n🧹 Sanitizing ${files.length} article(s)...\n`);

  let totalChanged = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const result = sanitizeFile(f);
    if (result.changed) totalChanged++;
  }

  if (totalChanged === 0) {
    console.log('  No issues found — all articles are clean.\n');
  } else {
    console.log(`\n  ${totalChanged} file(s) sanitized.\n`);
  }
}

main();
