#!/usr/bin/env node
/**
 * Evidence table for the Tier 3 seed (fallback plan Step 3). Read-only: lists pool ASINs that
 * appear as product boxes, with a local image, in an article added by a
 * "chore: auto-publish" commit within the last N days. It never edits data/verified-products.json.
 *
 *   node scripts/pool-history-evidence.mjs [--days 45] [--asof YYYY-MM-DD] [--out reports/file.md]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const days = Number(arg('days', 45));
const asOf = new Date(`${arg('asof', new Date().toISOString().slice(0, 10))}T23:59:59Z`);
const out = arg('out', '');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

export function boxesIn(html) {
  const boxes = [];
  const re = /<div class="product-box"[^>]*data-asin="([A-Z0-9]{10})"[^>]*>[\s\S]*?<img src="\.\.\/(assets\/product-images\/[^"]+)"/g;
  for (let m; (m = re.exec(html));) boxes.push({ asin: m[1], image: m[2] });
  return boxes;
}

export function collect() {
  const pool = new Set(JSON.parse(readFileSync(path.join(ROOT, 'data', 'verified-products.json'), 'utf8')).products.map(p => p.asin));
  const log = git('log', '--format=%H|%h|%cs|%s', '--grep=^chore: auto-publish', 'HEAD').trim().split('\n').filter(Boolean);
  const evidence = new Map();
  for (const line of log) {
    const [sha, short, date, ...subject] = line.split('|');
    const age = (asOf - new Date(`${date}T00:00:00Z`)) / 86400000;
    if (age < 0 || age > days) continue;
    const added = git('diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', sha).split('\n').filter(f => /^articles\/.+\.html$/.test(f));
    for (const file of added) {
      let html;
      try { html = git('show', `${sha}:${file}`); } catch { continue; }
      for (const { asin, image } of boxesIn(html)) {
        if (!pool.has(asin) || !existsSync(path.join(ROOT, image))) continue;
        const prev = evidence.get(asin);
        if (!prev || date > prev.date) evidence.set(asin, { asin, date, sha: short, file, image, expires: new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10), subject: subject.join('|') });
      }
    }
  }
  return [...evidence.values()].sort((a, b) => b.date.localeCompare(a.date) || a.asin.localeCompare(b.asin));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = collect();
  const md = [`# Tier 3 seed evidence (as of ${asOf.toISOString().slice(0, 10)}, ${days}-day window)`, '',
    'Read-only evidence from git history. Not a verification: public-page corroboration is still required before use.', '',
    '| ASIN | Last published | Commit | Article | Local image | Window ends |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.asin} | ${r.date} | ${r.sha} | ${r.file} | ${r.image} | ${r.expires} |`), '', `${rows.length} ASIN(s).`, ''].join('\n');
  if (out) writeFileSync(path.resolve(ROOT, out), md); else process.stdout.write(md);
}
