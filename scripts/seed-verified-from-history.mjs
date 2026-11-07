#!/usr/bin/env node
/**
 * One-time Tier 3 bootstrap: seed `last_verified_at` in data/verified-products.json from published history.
 *
 * Offline. Reads only `git log` / `git show` / `git cat-file` on the checked-out repository; no network, no
 * credentials, no Creators API. An ASIN is seeded when ALL of these hold:
 *   1. It appears (data-asin on a product box, or a /dp/<ASIN> link carrying the site affiliate tag) in an article
 *      ADDED by a normal `chore: auto-publish <file>.html on <YYYY-MM-DD>` commit (single parent, the added file is
 *      the one the subject names).
 *   2. That commit's author date, as a UTC date, is within --window-days (default 45) of --as-of (default today,
 *      UTC) and not after --as-of.
 *   3. The commit is reachable from the main ref (--main-ref, default origin/main, then main, then HEAD).
 *   4. The article is still present at HEAD and the ASIN is still on that page.
 *   5. The ASIN is already in the pool file. This script never adds a product and never invents an ASIN.
 *   6. The commit is not listed with --exclude-sha.
 *
 * Limitation: whether the run's gates passed (the later `Verify Deploy Live` conclusion) cannot be read offline.
 * Conditions 1, 3 and 4 are the offline stand-in, and they OVER-SEED relative to the plan: a commit whose deploy
 * check failed still looks like a normal auto-publish commit. So a human reads the `Verify Deploy Live` conclusion
 * for each qualifying commit from the GitHub Actions API and passes every failed one with --exclude-sha (reason:
 * deploy gate failed). Those exclusions are hand-added from API evidence, not derived by this script.
 * --deploy-runs <json> lets that API evidence ride along into the evidence table (informational; it never
 * seeds or excludes by itself). Build it with, per commit:
 *   gh api "repos/<owner>/<repo>/actions/workflows/verify-deploy.yml/runs?head_sha=<sha>" \
 *     --jq '.workflow_runs[] | {run_id: .id, conclusion: .conclusion}'
 * File shape: { "<full sha>": { "run_id": "123", "conclusion": "success", "issue": "optional note" } }
 *
 * last_verified_at = the UTC author date of the MOST RECENT qualifying commit. verification_source is set to
 * 'published-history'. verification_status is never read or written. An existing last_verified_at that is the same
 * or newer is left untouched (never lowered), so re-running is a no-op.
 *
 * Usage:
 *   node scripts/seed-verified-from-history.mjs [--as-of YYYY-MM-DD] [--window-days 45] [--write]
 *        [--evidence-out <path>] [--exclude-sha <sha>]... [--deploy-runs <json>]
 *        [--repo <dir>] [--pool <file>] [--main-ref <ref>] [--allow-shallow]
 * --main-ref is required unless origin/main exists; there is no silent fallback to main or HEAD.
 * A shallow clone aborts (history is incomplete) unless --allow-shallow is given.
 * Default is a dry run that prints the evidence table and writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..');
const AFFILIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || 'trailbuiltove-20';
const SEED_SOURCE = 'published-history';
const SUBJECT_RE = /^chore: auto-publish (\S+\.html) on (\d{4}-\d{2}-\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const DAY_MS = 86400000;
// class token exactly `product-box` (not product-box-header and friends).
const BOX_TAG_RE = /<[a-z][^>]*\bclass="(?:[^"]*\s)?product-box(?:\s[^"]*)?"[^>]*>/gi;

function fail(message) {
  console.error(`[seed-history] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    asOf: new Date().toISOString().slice(0, 10),
    windowDays: 45,
    write: false,
    evidenceOut: '',
    repo: DEFAULT_REPO,
    pool: '',
    mainRef: '',
    excludeShas: [],
    deployRuns: '',
    allowShallow: false,
  };
  const takeValue = (index, flag) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`${flag} needs a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--as-of') opts.asOf = takeValue(i++, arg);
    else if (arg === '--window-days') opts.windowDays = Number(takeValue(i++, arg));
    else if (arg === '--evidence-out') opts.evidenceOut = takeValue(i++, arg);
    else if (arg === '--repo') opts.repo = path.resolve(takeValue(i++, arg));
    else if (arg === '--pool') opts.pool = path.resolve(takeValue(i++, arg));
    else if (arg === '--main-ref') opts.mainRef = takeValue(i++, arg);
    else if (arg === '--exclude-sha') opts.excludeShas.push(takeValue(i++, arg).toLowerCase());
    else if (arg === '--deploy-runs') opts.deployRuns = path.resolve(takeValue(i++, arg));
    else if (arg === '--allow-shallow') opts.allowShallow = true;
    else fail(`unknown argument ${arg}`);
  }
  if (!DATE_RE.test(opts.asOf) || Number.isNaN(Date.parse(`${opts.asOf}T00:00:00Z`))) fail('--as-of must be YYYY-MM-DD');
  if (!Number.isInteger(opts.windowDays) || opts.windowDays < 0) fail('--window-days must be a non-negative integer');
  for (const sha of opts.excludeShas) if (!/^[0-9a-f]{7,40}$/.test(sha)) fail(`--exclude-sha needs 7 to 40 hex characters, got "${sha}"`);
  if (!opts.pool) opts.pool = path.join(opts.repo, 'data', 'verified-products.json');
  return opts;
}

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${error.message}`);
  }
}

function resolveMainRef(repo, requested) {
  const ref = requested || 'origin/main';
  if (git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) === null) {
    throw new Error(requested
      ? `main ref "${requested}" does not resolve in ${repo}`
      : `origin/main does not resolve in ${repo}; pass --main-ref <ref> explicitly (no silent fallback to main or HEAD)`);
  }
  return ref;
}

function assertNotShallow(opts) {
  if (git(opts.repo, ['rev-parse', '--is-shallow-repository'], { allowFail: true }).trim() !== 'true') return;
  const message = 'WARNING: this is a SHALLOW clone; auto-publish history older than the clone depth is missing, so the evidence is incomplete.';
  if (!opts.allowShallow) throw new Error(`${message} Fetch full history (git fetch --unshallow) or pass --allow-shallow.`);
  console.warn(`[seed-history] ${message} Continuing because --allow-shallow was given.`);
}

function utcDate(isoTimestamp) {
  return new Date(isoTimestamp).toISOString().slice(0, 10);
}

function dayNumber(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** ASINs on a page: product-box data-asin plus /dp/<ASIN> links that carry the site affiliate tag. */
function extractAsins(html) {
  const found = new Set();
  for (const tag of html.match(BOX_TAG_RE) || []) {
    const attr = tag.match(/\bdata-asin="([A-Z0-9]{10})"/);
    if (attr) found.add(attr[1]);
  }
  const linkRe = /\/dp\/([A-Z0-9]{10})(?:[/?#][^"'\s<>]*)?/g;
  for (const match of html.matchAll(linkRe)) {
    const rest = match[0];
    if (rest.includes(`tag=${AFFILIATE_TAG}`)) found.add(match[1]);
  }
  return found;
}

/** First local product image inside the product box for an ASIN, as a repo-relative path, or ''. */
function boxImagePath(html, asin) {
  const starts = [];
  for (const match of html.matchAll(BOX_TAG_RE)) starts.push({ index: match.index, tag: match[0] });
  for (let i = 0; i < starts.length; i++) {
    if (!starts[i].tag.includes(`data-asin="${asin}"`)) continue;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const img = html.slice(starts[i].index, end).match(/<img\b[^>]*\bsrc="(?:\.\.\/|\/)?(assets\/product-images\/[^"?#]+)"/i);
    if (img) return img[1];
  }
  return '';
}

function listAutoPublishCommits(repo, mainRef) {
  const out = git(repo, ['log', mainRef, '--grep=^chore: auto-publish ', '--format=%H%x1f%P%x1f%aI%x1f%s%x1e']);
  return out.split('\x1e').map(row => row.trim()).filter(Boolean).map(row => {
    const [sha, parents, authorIso, subject] = row.split('\x1f');
    return { sha, parents: parents ? parents.split(' ') : [], authorIso, authorDate: utcDate(authorIso), subject };
  });
}

function loadDeployRuns(file) {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read --deploy-runs ${file}: ${error.message}`);
  }
}

function deployCell(deployRuns, sha) {
  const run = deployRuns[sha];
  if (!run) return 'not recorded';
  return `${run.conclusion || 'unknown'} (run ${run.run_id})${run.issue ? `, ${run.issue}` : ''}`;
}

function collectEvidence(opts, poolAsins) {
  const mainRef = resolveMainRef(opts.repo, opts.mainRef);
  const asOfDay = dayNumber(opts.asOf);
  const considered = [];
  const evidence = new Map();
  let outsideWindow = 0;

  for (const commit of listAutoPublishCommits(opts.repo, mainRef)) {
    const match = SUBJECT_RE.exec(commit.subject);
    if (!match) continue; // legacy "new article" form or anything else is not a normal auto-publish commit
    const age = asOfDay - dayNumber(commit.authorDate);
    if (age < 0 || age > opts.windowDays) { outsideWindow++; continue; }
    const row = { ...commit, file: match[1], decision: '', asins: 0 };
    considered.push(row);
    if (opts.excludeShas.some(prefix => commit.sha.startsWith(prefix))) { row.decision = 'excluded by --exclude-sha (deploy gate failed)'; row.excluded = true; continue; }
    if (commit.parents.length !== 1) { row.decision = 'skipped: not a single-parent commit'; continue; }

    const added = git(opts.repo, ['diff-tree', '-r', '--no-commit-id', '--name-only', '--diff-filter=A', commit.sha])
      .split('\n').filter(name => name.endsWith('.html') && path.posix.basename(name) === match[1]);
    if (added.length !== 1) { row.decision = `skipped: commit does not add ${match[1]} (the article was added by another commit)`; continue; }
    const articlePath = added[0];

    const atCommit = git(opts.repo, ['show', `${commit.sha}:${articlePath}`], { allowFail: true });
    const atHead = git(opts.repo, ['show', `HEAD:${articlePath}`], { allowFail: true });
    if (atCommit === null) { row.decision = 'skipped: article unreadable at the commit'; continue; }
    if (atHead === null) { row.decision = 'skipped: article no longer present at HEAD'; continue; }

    const headAsins = extractAsins(atHead);
    const qualifying = [...extractAsins(atCommit)].filter(asin => headAsins.has(asin) && poolAsins.has(asin));
    row.asins = qualifying.length;
    row.decision = `qualifies: ${qualifying.length} pool ASIN(s) still on the page at HEAD`;
    row.articlePath = articlePath;

    for (const asin of qualifying) {
      const image = boxImagePath(atHead, asin);
      const hasImage = image !== '' && git(opts.repo, ['cat-file', '-e', `HEAD:${image}`], { allowFail: true }) !== null;
      const candidate = { asin, article: articlePath, sha: commit.sha, date: commit.authorDate, authorIso: commit.authorIso, image: hasImage, others: [] };
      const current = evidence.get(asin);
      if (!current) { evidence.set(asin, candidate); continue; }
      const newer = candidate.date > current.date || (candidate.date === current.date && Date.parse(candidate.authorIso) > Date.parse(current.authorIso));
      if (newer) { candidate.others = [...current.others, current.sha]; evidence.set(asin, candidate); }
      else current.others.push(candidate.sha);
    }
  }
  const unmatched = opts.excludeShas.filter(prefix => !considered.some(row => row.sha.startsWith(prefix)));
  return { mainRef, considered, evidence, outsideWindow, unmatched };
}

function renderReport(opts, products, result, deployRuns) {
  const names = new Map(products.map(product => [product.asin, product.name]));
  const rows = [...result.evidence.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || a.article.localeCompare(b.article) || a.asin.localeCompare(b.asin));
  const lines = [
    '# Tier 3 seed evidence',
    '',
    `As-of date: ${opts.asOf}. Window: ${opts.windowDays} days (author date, UTC, inclusive). Main ref: ${result.mainRef}.`,
    `Produced by \`scripts/seed-verified-from-history.mjs\`. Audit any row with \`git show --stat <SHA>\` and \`git log -1 --format=%aI <SHA>\`.`,
    '',
    'Limitation: the later `Verify Deploy Live` conclusion of each run cannot be read offline. Evidence that the run passed',
    'is limited to: a normal `chore: auto-publish` commit that is on main, whose article is still present at HEAD with the ASIN still on the page.',
    '`verification_status` is not changed by this seed; every entry stays `pending-verification`.',
    '',
    'The offline rule over-seeds relative to the plan ("in a run whose gates passed"). The `Verify Deploy Live` column below is copied',
    'from the GitHub Actions API (`--deploy-runs`), not derived offline, and the exclusions were added by hand from that evidence.',
    ...(opts.excludeShas.length
      ? ['', 'Excluded with `--exclude-sha` (reason: deploy gate failed):', ...result.considered.filter(row => row.excluded).map(row => `- ${row.sha} (${row.file}): ${deployCell(deployRuns, row.sha)}`), '']
      : ['']),
    `## Seeded ASINs (${rows.length})`,
    '',
    '| ASIN | Product | Article | Commit SHA | Commit date (UTC) | Verify Deploy Live | Local image | Other qualifying commits |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.asin} | ${String(names.get(row.asin) || '').replace(/\|/g, '/')} | ${row.article} | ${row.sha} | ${row.date} | ${deployCell(deployRuns, row.sha)} | ${row.image ? 'yes' : 'no'} | ${row.others.map(sha => sha.slice(0, 7)).join(', ') || '-'} |`),
    '',
    `## Auto-publish commits inside the window (${result.considered.length}; ${result.outsideWindow} more fall outside it)`,
    '',
    '| Commit SHA | Author date (UTC) | Subject | Verify Deploy Live | Decision |',
    '| --- | --- | --- | --- | --- |',
    ...result.considered.map(row => `| ${row.sha} | ${row.authorDate} | ${row.subject} | ${deployCell(deployRuns, row.sha)} | ${row.decision} |`),
    '',
  ];
  return lines.join('\n');
}

function applySeed(document, evidence) {
  const actions = [];
  for (const product of document.products) {
    const found = evidence.get(product.asin);
    if (!found) continue;
    const existing = product.last_verified_at;
    if (existing !== undefined && !DATE_RE.test(String(existing))) {
      actions.push({ asin: product.asin, action: `left alone: existing last_verified_at "${existing}" is not YYYY-MM-DD` });
      continue;
    }
    if (existing !== undefined && existing >= found.date) {
      actions.push({ asin: product.asin, action: `unchanged: existing ${existing} is not older than ${found.date}` });
      continue;
    }
    product.last_verified_at = found.date;
    product.verification_source = SEED_SOURCE;
    actions.push({ asin: product.asin, action: `set ${found.date}${existing ? ` (was ${existing})` : ''}`, changed: true });
  }
  return actions;
}

/** Re-serialize like the existing file: 2-space JSON, and \\uXXXX escapes when the file already escapes non-ASCII. */
function serializePool(document, rawPool) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (/[^\x00-\x7f]/.test(rawPool)) return text;
  return text.replace(/[\u0080-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let document;
  let rawPool = '';
  try {
    rawPool = readFileSync(opts.pool, 'utf8');
    document = JSON.parse(rawPool);
  } catch (error) {
    fail(`cannot read pool file ${opts.pool}: ${error.message}`);
  }
  if (!document || !Array.isArray(document.products)) fail('pool file has no products array');
  const poolAsins = new Set(document.products.map(product => product.asin).filter(asin => ASIN_RE.test(asin || '')));

  assertNotShallow(opts);
  const deployRuns = loadDeployRuns(opts.deployRuns);
  const result = collectEvidence(opts, poolAsins);
  for (const prefix of result.unmatched) console.warn(`[seed-history] WARNING: --exclude-sha ${prefix} matched no auto-publish commit inside the window.`);
  for (const row of result.considered) {
    const conclusion = deployRuns[row.sha] && deployRuns[row.sha].conclusion;
    if (!row.excluded && row.asins > 0 && conclusion && conclusion !== 'success') {
      console.warn(`[seed-history] WARNING: ${row.sha} has Verify Deploy Live conclusion "${conclusion}" but is not excluded.`);
    }
  }
  const report = renderReport(opts, document.products, result, deployRuns);
  const actions = applySeed(document, result.evidence);
  const changed = actions.filter(action => action.changed).length;

  console.log(report);
  for (const action of actions) console.log(`[seed-history] ${action.asin}: ${action.action}`);
  if (opts.evidenceOut) {
    mkdirSync(path.dirname(path.resolve(opts.evidenceOut)), { recursive: true });
    writeFileSync(opts.evidenceOut, report, 'utf8');
    console.log(`[seed-history] Wrote evidence table to ${opts.evidenceOut}.`);
  }
  if (opts.write) {
    if (changed > 0) writeFileSync(opts.pool, serializePool(document, rawPool), 'utf8');
    console.log(`[seed-history] --write: ${changed} product(s) updated in ${opts.pool}.`);
  } else {
    console.log(`[seed-history] Dry run: ${changed} product(s) would be updated. Pass --write to apply.`);
  }
}

try {
  main();
} catch (error) {
  fail(error.message);
}
