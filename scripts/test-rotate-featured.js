#!/usr/bin/env node
"use strict";
/**
 * Fixture tests for scripts/rotate-featured.js: weekly rotation from the newest four
 * articles, never the previous pick, never the top Latest card, stable within a week,
 * local images only. Runs on throw-away trees; the real index.html is never written.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT = path.join(__dirname, "rotate-featured.js");
const REAL_ROOT = path.resolve(__dirname, "..");

function article({ slug, date, title, badges = ["Gear", "Guide"], image = true, desc = "A guide & more." }) {
  const img = image ? `<img src="../assets/product-images/${slug}.jpg" alt="Photo of ${title} &amp; kit" />` : "";
  return `<!doctype html><html><head><title>${title} | Trail Built</title><meta name="description" content="${desc}" />
<script type="application/ld+json">{"datePublished":"${date}"}</script></head><body>
<div class="article-meta-top">${badges.map((b, i) => `<span class="badge${i ? " badge-green" : ""}">${b}</span>`).join("")}<span class="card-date">x</span></div>
<div class="product-box">${img}</div></body></html>`;
}

function homepage({ latest, pick, pickWeek }) {
  const cards = latest.map(slug => `<div class="card">
<div class="card-img"><img alt="x" src="https://example.invalid/${slug}.jpg"/></div>
<div class="card-body"><h3><a href="articles/${slug}.html">${slug}</a></h3>
<div class="card-footer"><a class="read-link" href="articles/${slug}.html">Read More →</a><span class="read-time">9 min</span></div></div>
</div>`).join("\n");
  const marker = pickWeek ? `<!-- editors-pick: week=${pickWeek} slug=${pick} -->\n` : "";
  return `<html><body><section><div class="container">
${marker}<div class="card card-featured">
<div class="card-img"><img alt="old" src="https://example.invalid/old.jpg"/></div>
<div class="card-body"><h3><a href="articles/${pick}.html">old title</a></h3>
<div class="card-footer"><a class="read-link" href="articles/${pick}.html">Read Full Guide →</a><span class="read-time">1 min read</span></div></div>
</div></div></section>
<section id="reviews"><div class="grid-3">
${cards}
</div></section><!-- ===== TOP PRODUCT --></body></html>`;
}

function tree(articles, pageOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-"));
  fs.mkdirSync(path.join(dir, "articles"));
  fs.mkdirSync(path.join(dir, "assets", "product-images"), { recursive: true });
  for (const a of articles) {
    fs.writeFileSync(path.join(dir, "articles", `${a.slug}.html`), article(a));
    if (a.image !== false) fs.writeFileSync(path.join(dir, "assets", "product-images", `${a.slug}.jpg`), "x");
  }
  fs.writeFileSync(path.join(dir, "index.html"), homepage(pageOpts));
  return dir;
}

function run(dir, date, extra = []) {
  const out = execFileSync("node", [SCRIPT, "--date", date, ...extra], { env: { ...process.env, ROTATE_FEATURED_ROOT: dir }, encoding: "utf8" });
  return out;
}

const pickOf = dir => (fs.readFileSync(path.join(dir, "index.html"), "utf8").match(/<!-- editors-pick: week=\S+ slug=(\S+) -->/) || [])[1];

// 1. Fixture: five articles, newest four are eligible, top Latest excluded, no-image article skipped.
const articles = [
  { slug: "a-newest", date: "2026-10-19", title: "Newest" },
  { slug: "b-second", date: "2026-10-18", title: "Second &amp; Co" },
  { slug: "c-third", date: "2026-09-28", title: "Third" },
  { slug: "d-fourth-noimg", date: "2026-09-21", title: "Fourth", image: false },
  { slug: "e-old", date: "2026-09-14", title: "Old" },
];
const dir = tree(articles, { latest: ["a-newest", "b-second", "c-third", "d-fourth-noimg", "e-old"], pick: "b-second" });

run(dir, "2026-10-26");
assert.strictEqual(pickOf(dir), "c-third", "only b-second (current, excluded), c-third are eligible besides the top card and the image-less article");
let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
assert.ok(html.includes('src="assets/product-images/c-third.jpg"'), "card uses the local product image");
assert.ok(!/<div class="card card-featured">[\s\S]*?https?:\/\//.test(html.split("<section id=\"reviews\">")[0]), "no external URL in the card");
assert.ok(html.includes('<span class="badge">Gear</span>') && html.includes('<span class="badge badge-green">Guide</span>'));
assert.ok(html.includes("September 28, 2026") && html.includes('<h3><a href="articles/c-third.html">Third</a></h3>'));
assert.ok(html.includes("<p>A guide &amp; more.</p>"), "description escaped");
assert.ok(html.includes("Photo of Third &amp; kit"), "alt text kept escaped");
assert.ok((html.match(/editors-pick:/g) || []).length === 1, "exactly one marker");

// 2. Idempotent within the same week (Monday to Sunday), even on a later day.
const snapshot = html;
const second = run(dir, "2026-10-30");
assert.strictEqual(fs.readFileSync(path.join(dir, "index.html"), "utf8"), snapshot, "same week: byte-identical");
assert.ok(/already rotated this week/.test(second));
assert.ok(/would rotate|already rotated/.test(run(dir, "2026-11-01", ["--check"])), "Sunday is still the same week");

// 3. Next week: a different article than last week's pick.
run(dir, "2026-11-02");
assert.notStrictEqual(pickOf(dir), "c-third", "never the same pick two weeks running");
assert.strictEqual(pickOf(dir), "b-second", "with a single other eligible article the pick alternates");

// 3b. When the weekly formula would land on the current pick, the pick moves on instead.
const trio = [
  { slug: "a-top", date: "2026-10-19", title: "Top" },
  { slug: "b-one", date: "2026-10-18", title: "One" },
  { slug: "c-two", date: "2026-09-28", title: "Two" },
  { slug: "d-three", date: "2026-09-21", title: "Three" },
];
const { weekIndex, weekStart } = require("./rotate-featured");
for (const date of ["2026-10-26", "2026-11-02", "2026-11-09"]) {
  const collides = ["b-one", "c-two", "d-three"][weekIndex(weekStart(date)) % 3];
  const t = tree(trio, { latest: trio.map(a => a.slug), pick: collides, pickWeek: "2026-01-05" });
  run(t, date);
  assert.notStrictEqual(pickOf(t), collides, `${date}: the formula's own choice is skipped when it is the current pick`);
  fs.rmSync(t, { recursive: true, force: true });
}

// 4. A pick that has become the top Latest card is replaced even within its week.
const dir2 = tree(
  [{ slug: "n-new", date: "2026-11-03", title: "New" }, ...articles],
  { latest: ["n-new", "a-newest", "b-second", "c-third", "d-fourth-noimg", "e-old"], pick: "n-new", pickWeek: "2026-11-02" }
);
run(dir2, "2026-11-04");
assert.notStrictEqual(pickOf(dir2), "n-new", "pick equal to the top Latest card is replaced");

// 5. --check never writes.
const dir3 = tree(articles, { latest: ["a-newest", "b-second", "c-third", "d-fourth-noimg", "e-old"], pick: "b-second" });
const before = fs.readFileSync(path.join(dir3, "index.html"), "utf8");
assert.ok(/would rotate/.test(run(dir3, "2026-10-26", ["--check"])));
assert.strictEqual(fs.readFileSync(path.join(dir3, "index.html"), "utf8"), before);

// 6. Nothing eligible (no local images) leaves the page untouched.
const dir4 = tree(articles.map(a => ({ ...a, image: false })), { latest: ["a-newest", "b-second"], pick: "b-second" });
const before4 = fs.readFileSync(path.join(dir4, "index.html"), "utf8");
assert.ok(/no eligible article/.test(run(dir4, "2026-10-26")));
assert.strictEqual(fs.readFileSync(path.join(dir4, "index.html"), "utf8"), before4);

// 7. The real site: copy index.html and articles/assets, rotate eight consecutive weeks.
const real = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-real-"));
fs.copyFileSync(path.join(REAL_ROOT, "index.html"), path.join(real, "index.html"));
fs.cpSync(path.join(REAL_ROOT, "articles"), path.join(real, "articles"), { recursive: true });
fs.cpSync(path.join(REAL_ROOT, "assets", "product-images"), path.join(real, "assets", "product-images"), { recursive: true });
const topLatest = (fs.readFileSync(path.join(real, "index.html"), "utf8").match(/<section id="reviews">[\s\S]*?href="articles\/([^"]+)\.html"/) || [])[1];
let previous = "";
for (let week = 0; week < 8; week++) {
  const date = new Date(Date.UTC(2026, 9, 26 + week * 7)).toISOString().slice(0, 10);
  run(real, date);
  const picked = pickOf(real);
  assert.ok(picked, `week ${week}: a pick exists`);
  assert.notStrictEqual(picked, topLatest, `week ${week}: not the top Latest card`);
  if (previous) assert.notStrictEqual(picked, previous, `week ${week}: not last week's pick`);
  previous = picked;
}
const realHtml = fs.readFileSync(path.join(real, "index.html"), "utf8").split('<section id="reviews">')[0];
assert.ok(!/src="https?:\/\//.test(realHtml.slice(realHtml.indexOf("card-featured"))), "real card image is local");

for (const d of [dir, dir2, dir3, dir4, real]) fs.rmSync(d, { recursive: true, force: true });
console.log("Rotate-featured tests passed: eligibility, local image, same-week idempotence, weekly change, top-card replacement, no-write check, real-site 8-week run.");
