#!/usr/bin/env node
"use strict";
/**
 * Weekly Editor's Pick rotation for the Trail Built homepage.
 *
 * Picks the homepage "Editor's Pick" from the newest four articles, never the same
 * article as the previous pick and never the top "Latest" card, and rewrites the
 * featured card from the article's own metadata. The pick is stable within a week
 * (week = Monday to Sunday, UTC): a second run in the same week changes nothing.
 * The card uses a local product image from the article; a candidate without one is
 * skipped, so no external or hotlinked image is ever written.
 *
 *   node scripts/rotate-featured.js            rewrite index.html when the pick changes
 *   node scripts/rotate-featured.js --check    report only, write nothing
 *   --date YYYY-MM-DD                          pretend today is this date (tests)
 *   ROTATE_FEATURED_ROOT=<dir>                 operate on another tree (tests)
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.env.ROTATE_FEATURED_ROOT
  ? path.resolve(process.env.ROTATE_FEATURED_ROOT)
  : path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const ARTICLES_DIR = path.join(ROOT, "articles");
const CANDIDATE_WINDOW = 4;
const MARKER = /<!-- editors-pick: week=(\d{4}-\d{2}-\d{2}) slug=([a-z0-9-]+) -->/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function weekStart(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function weekIndex(weekStartIso) {
  return Math.floor((Date.parse(`${weekStartIso}T00:00:00Z`) - Date.UTC(2024, 0, 1)) / (7 * 86400000));
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function humanDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function readArticle(slug) {
  const html = fs.readFileSync(path.join(ARTICLES_DIR, `${slug}.html`), "utf8");
  const date = (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"/) || [])[1];
  const title = ((html.match(/<title>([^<]+)<\/title>/) || [])[1] || "").replace(/\s*\|\s*Trail Built\s*$/i, "").trim();
  const description = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  const header = (html.match(/<div class="article-meta-top">([\s\S]*?)<\/div>/) || [])[1] || "";
  const badges = [...header.matchAll(/<span class="badge[^"]*">([^<]*)<\/span>/g)].map(m => m[1]).slice(0, 2);
  // First product image that is a local repo file (relative "../assets/..." path that exists).
  let image = null;
  for (const m of html.matchAll(/<img src="\.\.\/(assets\/[^"]+)" alt="([^"]*)"/g)) {
    if (fs.existsSync(path.join(ROOT, m[1]))) { image = { src: m[1], alt: m[2] }; break; }
  }
  const words = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return { slug, date, title, description, badges, image, wordCount: words };
}

function listArticles() {
  return fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith(".html"))
    .map(f => f.replace(/\.html$/, ""))
    .map(readArticle)
    .filter(a => a.date)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

function latestCards(html) {
  const start = html.indexOf('<section id="reviews">');
  if (start === -1) throw new Error("Could not locate the homepage latest section");
  const section = html.slice(start);
  return [...section.matchAll(/<div class="card">[\s\S]*?href="articles\/([^"?#]+)\.html"[\s\S]*?<span class="read-time">([^<]*)<\/span>/g)]
    .map(m => ({ slug: m[1], readTime: m[2].trim() }));
}

function featuredBlock(html) {
  const start = html.indexOf('<div class="card card-featured">');
  if (start === -1) throw new Error("Could not locate the Editor's Pick card");
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return { start, end: tag.lastIndex };
  }
  throw new Error("Unbalanced Editor's Pick card markup");
}

function currentPick(html) {
  const block = featuredBlock(html);
  const markerMatch = html.slice(Math.max(0, block.start - 120), block.start).match(MARKER);
  const slug = (html.slice(block.start, block.end).match(/href="articles\/([^"?#]+)\.html"/) || [])[1] || "";
  return { slug, week: markerMatch ? markerMatch[1] : "", hasMarker: Boolean(markerMatch), block };
}

function readTimeFor(article, cards) {
  const card = cards.find(c => c.slug === article.slug);
  const base = card ? card.readTime.replace(/\s*read\s*$/i, "").replace(/\s*min$/i, "") : String(Math.max(1, Math.ceil(article.wordCount / 200)));
  return `${base} min read`;
}

function renderCard(article, cards) {
  const [first, second] = article.badges;
  const badgeHtml = [first && `<span class="badge">${first}</span>`, second && `<span class="badge badge-green">${second}</span>`].filter(Boolean).join("\n");
  const link = `articles/${article.slug}.html`;
  return `<div class="card card-featured">
<div class="card-img"><img alt="${escapeHtml(decodeEntities(article.image.alt))}" decoding="async" loading="lazy" src="${article.image.src}"/></div>
<div class="card-body">
<div class="card-meta">
${badgeHtml}
<span class="card-date">${humanDate(article.date)}</span>
</div>
<h3><a href="${link}">${escapeHtml(decodeEntities(article.title))}</a></h3>
<p>${escapeHtml(decodeEntities(article.description))}</p>
<div class="card-footer">
<a class="read-link" href="${link}">Read Full Guide →</a>
<span class="read-time">${readTimeFor(article, cards)}</span>
</div>
</div>
</div>`;
}

/** Pure selection: returns the slug to feature, or "" when nothing is eligible. */
function chooseSlug({ articles, topLatest, current, week, excludeCurrent }) {
  const newest = articles.slice(0, CANDIDATE_WINDOW);
  const eligible = newest
    .filter(a => a.slug !== topLatest && a.image && a.title && a.description && a.badges.length)
    .filter(a => !excludeCurrent || a.slug !== current)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (!eligible.length) return "";
  return eligible[weekIndex(week) % eligible.length].slug;
}

function rotate({ today, check }) {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const week = weekStart(today);
  const cards = latestCards(html);
  const topLatest = cards.length ? cards[0].slug : "";
  const articles = listArticles();
  const current = currentPick(html);
  const newestSlugs = articles.slice(0, CANDIDATE_WINDOW).map(a => a.slug);

  const stillValid = current.week === week && current.slug !== topLatest && newestSlugs.includes(current.slug);
  if (stillValid) return { changed: false, slug: current.slug, week, reason: "already rotated this week" };

  const slug = chooseSlug({ articles, topLatest, current: current.slug, week, excludeCurrent: true })
    || chooseSlug({ articles, topLatest, current: current.slug, week, excludeCurrent: false });
  if (!slug) return { changed: false, slug: current.slug, week, reason: "no eligible article (needs a local product image)" };

  const article = articles.find(a => a.slug === slug);
  const marker = `<!-- editors-pick: week=${week} slug=${slug} -->\n`;
  const before = html.slice(0, current.block.start).replace(/<!-- editors-pick: [^>]*-->\n?$/, "");
  const next = `${before}${marker}${renderCard(article, cards)}${html.slice(current.block.end)}`;
  if (next === html) return { changed: false, slug, week, reason: "no change" };
  if (!check) fs.writeFileSync(INDEX_PATH, next);
  return { changed: true, slug, previous: current.slug, week, reason: check ? "would rotate" : "rotated" };
}

function main(argv = process.argv.slice(2)) {
  const dateIndex = argv.indexOf("--date");
  const today = dateIndex >= 0 ? argv[dateIndex + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("--date must be YYYY-MM-DD");
  const result = rotate({ today, check: argv.includes("--check") });
  console.log(`[rotate-featured] week of ${result.week}: ${result.reason}; Editor's Pick = ${result.slug}${result.previous ? ` (was ${result.previous})` : ""}`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[rotate-featured] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { chooseSlug, currentPick, listArticles, main, rotate, weekIndex, weekStart };
