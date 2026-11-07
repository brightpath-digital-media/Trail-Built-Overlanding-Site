#!/usr/bin/env node

/**
 * Stages a ready-to-paste weekly newsletter for human review. A human creates the
 * campaign in Klaviyo and sends it; this script never calls any email API.
 *
 * NEWSLETTER-0918: SS and P&F went two weeks without a newsletter because their
 * scan missed a whole record type and the skip was silent. Trail Built scans every
 * page in articles/ so it has no equivalent blind spot, but it shared the silent
 * skip; a corpus that has stopped moving now fails loudly here too.
 * This script intentionally makes no network requests and never creates or sends campaigns.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = {
  siteName: "Trail Built",
  tagline: "Built for the road beyond the pavement.",
  domain: "trailbuiltoverland.com",
  fromName: "Trail Built",
  fromAddress: "hello@trailbuiltoverland.com",
  listName: "Trail Built newsletter list",
  palette: {
    page: "#1a1a1a",
    card: "#242424",
    header: "#121212",
    accent: "#d4751a",
    heading: "#f0ece4",
    body: "#d0cbc3",
    muted: "#a0998e",
    footer: "#121212",
  },
};

// NEWSLETTER-0918: content ships weekly and the Tuesday run normally sees a
// 1-day-old article. 8 days (the freshness window below) means one cycle slipped —
// tolerable and already quiet. More than 14 days means two consecutive cycles
// produced nothing, which is broken authoring rather than a quiet week, so the
// run must fail loudly instead of looking identical to "already sent that one".
const STALL_AFTER_DAYS = 14;

// Archive issue (continuity plan, Step 6). OFF unless ALLOW_ARCHIVE_ISSUE is exactly
// "true"; with it unset every code path below is byte-for-byte the pre-existing
// behavior. When on and the newest article is stale, the current homepage Editor's
// Pick is staged as `<date>-archive-<slug>` instead of failing/no-op'ing, subject to
// the guards in chooseArchiveIssue(). Content is the article's existing card and
// meta description only: no prices, no product claims, no retailer links.
const ARCHIVE_MIN_GAP_DAYS = 14;
const ARCHIVE_MAX_SENTENCE = 300;
const ARCHIVE_SUBJECT_PREFIX = "From the archive:";
// Anything that would be a new commerce claim. Applied to the final rendered HTML.
const ARCHIVE_FORBIDDEN = /\$|price|offers|amazon\.com|amzn\.to|media-amazon|in stock/i;
// Wider list, applied only to the text we copy in (title, sentence, alt text, URLs);
// the HTML shell legitimately contains "100%" and similar.
const ARCHIVE_FORBIDDEN_CONTENT = /%|\b(?:rated|stars?|deals?|coupons?|discount(?:s|ed)?|cheap(?:er|est)?|lowest|sales?|usd)\b|tag=|utm_/i;
// A pick's editors-pick marker week must be this close to the staging date.
const ARCHIVE_MARKER_MAX_DAYS = 7;

function fail(step, message) {
  throw new Error(`${step}: ${message}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripHtml(value) {
  return decodeHtml(String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function metaContent(html, expectedAttribute, expectedValue) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, expectedAttribute).toLowerCase() === expectedValue.toLowerCase()) {
      return attr(tag, "content");
    }
  }
  return "";
}

// Archive path only. attr() stops at the first quote of either kind, so a double-quoted
// value containing an apostrophe is cut short. These helpers honor the opening delimiter.
// The normal path keeps using attr()/metaContent() so its output stays byte-identical.
function quotedAttr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeHtml(match[1] ?? match[2]) : "";
}

function quotedMetaContent(html, expectedAttribute, expectedValue) {
  for (const match of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (quotedAttr(match[0], expectedAttribute).toLowerCase() === expectedValue.toLowerCase()) {
      return quotedAttr(match[0], "content");
    }
  }
  return "";
}

function canonicalUrl(html) {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, "rel").toLowerCase() === "canonical") return attr(tag, "href");
  }
  return "";
}

function firstJsonLdObject(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const objects = Array.isArray(parsed) ? parsed : [parsed];
      const candidate = objects.find((item) => item?.datePublished || item?.headline || item?.name);
      if (candidate) return candidate;
    } catch {
      // Ignore unrelated or invalid JSON-LD blocks and continue searching.
    }
  }
  return {};
}

function sentencesFrom(...sources) {
  const sentences = [];
  for (const source of sources) {
    const text = stripHtml(source);
    for (const sentence of text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []) {
      const normalized = sentence.replace(/\s+/g, " ").trim();
      if (normalized.length >= 35 && !sentences.includes(normalized)) sentences.push(normalized);
      if (sentences.length >= 3) return sentences.join(" ");
    }
  }
  return sentences.join(" ");
}

function excerptParagraphs(html) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((paragraph) => paragraph.length >= 70)
    .filter((paragraph) => !/unsubscribe|cookie|affiliate disclosure|table of contents/i.test(paragraph))
    .slice(0, 4);
}

function newsletterDate() {
  const candidate = process.env.NEWSLETTER_NOW ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) fail("DATE", "NEWSLETTER_NOW must use YYYY-MM-DD.");
  return candidate;
}

function ageInDays(publishedDate, today) {
  const published = Date.parse(`${publishedDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((current - published) / 86_400_000);
}

function testMode() {
  return process.env.NEWSLETTER_TEST_MODE === "true" && process.env.GITHUB_ACTIONS !== "true";
}

async function writeResult(result) {
  const destination = process.env.NEWSLETTER_RESULT_FILE;
  if (destination) await fs.writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function renderHtml(article, options = {}) {
  const eyebrow = options.eyebrow ?? "New from Trail Built";
  const imageBlock = options.imageUrl
    ? `<img src="${escapeHtml(options.imageUrl)}" alt="${escapeHtml(options.imageAlt ?? "")}" width="532" style="display:block;width:100%;max-width:532px;height:auto;margin:0 0 18px;border-radius:6px;">\n          `
    : "";
  const { palette } = config;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(article.title)} | ${escapeHtml(config.siteName)}</title>
</head>
<body style="margin:0;padding:0;background:${palette.page};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${palette.page};margin:0;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:${palette.card};border-radius:8px;overflow:hidden;">
        <tr><td align="center" style="background:${palette.header};border-bottom:3px solid ${palette.accent};padding:32px 28px;">
          <div style="margin:0;color:${palette.heading};font-size:27px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Trail <span style="color:${palette.accent};">Built</span></div>
          <div style="margin-top:7px;color:${palette.muted};font-size:13px;letter-spacing:.5px;">${escapeHtml(config.tagline)}</div>
        </td></tr>
        <tr><td align="center" style="background:${palette.card};border-bottom:1px solid ${palette.accent};padding:18px 28px;">
          <div style="color:${palette.accent};font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">Trail Built Dispatch</div>
          <div style="margin-top:6px;color:${palette.muted};font-size:13px;line-height:1.5;">Practical guides for the road beyond the pavement.</div>
        </td></tr>
        <tr><td style="padding:32px 34px 18px;color:${palette.body};font-size:16px;line-height:1.7;">
          <div style="color:${palette.accent};font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;margin:0 0 12px;">${escapeHtml(eyebrow)}</div>
          ${imageBlock}<h1 style="margin:0 0 18px;color:${palette.heading};font-size:27px;line-height:1.25;">${escapeHtml(article.title)}</h1>
          <p style="margin:0;color:${palette.body};">${escapeHtml(article.excerpt)}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 10px;"><tr><td style="border-radius:6px;background:${palette.accent};">
            <a href="${escapeHtml(article.url)}" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.2px;">Read the full guide</a>
          </td></tr></table>
        </td></tr>
        <tr><td align="center" style="background:${palette.footer};padding:24px 28px;color:${palette.muted};font-size:12px;line-height:1.55;">
          <p style="margin:0 0 8px;">{{SenderInfo}}</p>
          <p style="margin:0;"><a href="{{UnsubscribeURL}}" style="color:${palette.accent};text-decoration:none;">Unsubscribe</a> &nbsp;·&nbsp; <a href="https://trailbuiltoverland.com/about.html" style="color:${palette.accent};text-decoration:none;">About Trail Built</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;
}

function articlesDirectoryPath() {
  return path.resolve(root, process.env.NEWSLETTER_ARTICLES_DIR ?? "articles");
}

// One article page -> candidate record, or null when it has no dated publish stamp.
// Shared by the newest-article scan and the archive Editor's Pick lookup.
async function parseArticleFile(articlesDirectory, fileName) {
  const filePath = path.join(articlesDirectory, fileName);
  const html = await fs.readFile(filePath, "utf8");
  const jsonLd = firstJsonLdObject(html);
  const publishedDate = jsonLd.datePublished || (html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) return null;

  const title = jsonLd.headline || jsonLd.name || metaContent(html, "property", "og:title") || "";
  const description = metaContent(html, "name", "description") || jsonLd.description || "";
  const articleUrl = canonicalUrl(html) || `https://${config.domain}/articles/${fileName}`;
  const heroImage = metaContent(html, "property", "og:image") || jsonLd.image?.url || jsonLd.image || "";
  const excerpt = sentencesFrom(description, ...excerptParagraphs(html));
  if (!title || !articleUrl || !heroImage || !excerpt) {
    fail("ARTICLE_PARSE", `Required title, URL, image, or excerpt metadata is missing from articles/${fileName}.`);
  }
  return {
    title: stripHtml(title),
    excerpt,
    url: articleUrl,
    heroImage,
    publishedDate,
    slug: fileName.replace(/\.html$/i, ""),
    source: `articles/${fileName}`,
  };
}

async function findNewestArticle() {
  const articlesDirectory = articlesDirectoryPath();
  const entries = await fs.readdir(articlesDirectory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const candidate = await parseArticleFile(articlesDirectory, entry.name);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0) fail("ARTICLE_DETECTION", `No dated static article pages were found in ${path.relative(root, articlesDirectory)}/.`);
  candidates.sort((left, right) => right.publishedDate.localeCompare(left.publishedDate) || left.slug.localeCompare(right.slug));
  return candidates[0];
}

// NEWSLETTER-0918: "the newest stem is one we already sent" and "authoring has
// produced nothing for two weeks" used to look identical and both exit 0.
function archiveStallSummary(article, age, stem) {
  return `${config.siteName}: the newest article is "${article.title}" (${article.source}), published ${article.publishedDate} — ${age} days old against a ${STALL_AFTER_DAYS}-day threshold. Nothing newer exists in the article corpus, so at least two weekly authoring cycles produced nothing. Archive issue staged instead (${stem}); weekly authoring is still broken.`.replace(/\s+/g, " ");
}

async function reportStall(article, age, archiveBlock = null) {
  const summary = `${config.siteName}: the newest article is "${article.title}" (${article.source}), published ${article.publishedDate} — ${age} days old against a ${STALL_AFTER_DAYS}-day threshold. Nothing newer exists in the article corpus, so at least two weekly authoring cycles produced nothing. This is an authoring/content-pipeline failure, not a week with nothing new to send; no newsletter was staged.${archiveBlock ? ` Archive issue not staged (ARCHIVE_BLOCKED:${archiveBlock.reason}): ${archiveBlock.detail}` : ""}`.replace(/\s+/g, " ");
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `newsletter_stalled=true\nnewsletter_stall_summary=${summary}\n`, "utf8");
  }
  await writeResult({ status: "failed", reason: "content-stalled", ageDays: age, thresholdDays: STALL_AFTER_DAYS, article, ...(archiveBlock ? { archiveBlocked: archiveBlock.reason } : {}) });
  return summary;
}

async function commitAndPush(htmlPath, metaPath, article, commitMessage = `chore: stage weekly newsletter ${article.slug} ${article.publishedDate}`) {
  if (process.env.NEWSLETTER_COMMIT !== "true") return "";
  const relativeHtml = path.relative(root, htmlPath);
  const relativeMeta = path.relative(root, metaPath);
  try {
    await execFile("git", ["config", "user.name", "Trail Built Newsletter Bot"], { cwd: root });
    await execFile("git", ["config", "user.email", "bot@trailbuiltoverland.com"], { cwd: root });
    await execFile("git", ["add", "--", relativeHtml, relativeMeta], { cwd: root });
    await execFile("git", ["commit", "-m", commitMessage], { cwd: root });
  } catch (error) {
    fail("GIT_COMMIT", error.stderr?.trim() || error.message);
  }
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    await execFile("git", ["push", "origin", "HEAD:main"], { cwd: root });
    return stdout.trim();
  } catch (error) {
    fail("GIT_PUSH", error.stderr?.trim() || error.message);
  }
}

// ---------------------------------------------------------------------------
// Archive issue (ALLOW_ARCHIVE_ISSUE=true only)
// ---------------------------------------------------------------------------

function archiveEnabled() {
  return process.env.ALLOW_ARCHIVE_ISSUE === "true";
}

const EDITORS_PICK_MARKER = /<!-- editors-pick: week=(\d{4}-\d{2}-\d{2}) slug=([a-z0-9-]+) -->/g;
const ARTICLE_LINK = /href=["'](?:https?:\/\/(?:www\.)?trailbuiltoverland\.com\/|\/)?articles\/([a-z0-9][a-z0-9-]*)\.html["']/i;

// The current Editor's Pick on the homepage: the card-featured block, plus the
// rotation marker comment directly above it when present.
function readEditorsPick(indexHtml) {
  const start = indexHtml.search(/<div\b[^>]*class=["'][^"']*\bcard-featured\b[^"']*["'][^>]*>/i);
  if (start < 0) return null;
  const rest = indexHtml.slice(start);
  const end = rest.search(/<\/section>|<!-- =====/i);
  const block = end < 0 ? rest.slice(0, 6000) : rest.slice(0, end);
  const markers = [...indexHtml.slice(Math.max(0, start - 200), start).matchAll(EDITORS_PICK_MARKER)];
  const marker = markers.length ? markers[markers.length - 1] : null;
  const linkSlug = block.match(ARTICLE_LINK)?.[1] ?? "";
  const img = block.match(/<img\b[^>]*>/i)?.[0] ?? "";
  return {
    markerSlug: marker ? marker[2] : "",
    markerWeek: marker ? marker[1] : "",
    linkSlug,
    imageSrc: img ? quotedAttr(img, "src") : "",
    imageAlt: img ? quotedAttr(img, "alt") : "",
  };
}

// Staged/sent record = the stems already in the output directory, the same place
// the ALREADY_STAGED check looks. `<date>-<slug>` is a normal issue and
// `<date>-archive-<slug>` an archive issue.
async function readStagedRecord(outputDirectory) {
  let names = [];
  try {
    names = await fs.readdir(outputDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stems = new Set();
  for (const name of names) {
    const match = name.match(/^(.+?)\.(?:html|meta\.json)$/);
    if (match) stems.add(match[1]);
  }
  const records = [];
  for (const stem of stems) {
    const match = stem.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (!match) continue;
    // `<date>-archive-foo` is an archive stem for `foo`, but it is also exactly what a
    // normal stem for an article whose slug is `archive-foo` looks like. Treat it as an
    // archive stem for the 14-day/consecutive-week guards (conservative) and let both
    // readings count for the duplicate and last-sent checks.
    const archive = match[2].startsWith("archive-");
    records.push({ stem, date: match[1], archive, slugs: archive ? [match[2].slice("archive-".length), match[2]] : [match[2]] });
  }
  return records;
}

// Monday-start UTC week number (1970-01-01 was a Thursday).
function weekIndex(date) {
  return Math.floor((Date.parse(`${date}T00:00:00Z`) / 86_400_000 + 3) / 7);
}

function archiveBlocked(reason, detail) {
  return { ok: false, reason, detail };
}

// Returns { alreadyStaged, stem } | { ok: true, issue } | { ok: false, reason, detail }.
async function chooseArchiveIssue({ today, outputDirectory }) {
  const records = await readStagedRecord(outputDirectory);
  const archives = records.filter((record) => record.archive);

  // Idempotent re-run on the same day stays quiet, like ALREADY_STAGED does today.
  const todays = archives.find((record) => record.date === today);
  if (todays) return { alreadyStaged: true, stem: todays.stem };

  // Guard: never on consecutive weeks (this or the previous Monday-start week).
  const recentWeek = archives.find((record) => weekIndex(today) - weekIndex(record.date) <= 1);
  if (recentWeek) {
    return archiveBlocked("archive-consecutive-week", `an archive issue (${recentWeek.stem}) was already staged in this or the previous week.`);
  }
  // Guard: at most one archive issue per 14 days.
  const recentGap = archives.find((record) => ageInDays(record.date, today) < ARCHIVE_MIN_GAP_DAYS);
  if (recentGap) {
    return archiveBlocked("archive-14-day-limit", `the last archive issue (${recentGap.stem}) is less than ${ARCHIVE_MIN_GAP_DAYS} days old.`);
  }

  const indexFile = path.resolve(root, process.env.NEWSLETTER_INDEX_FILE ?? "index.html");
  let indexHtml;
  try {
    indexHtml = await fs.readFile(indexFile, "utf8");
  } catch {
    return archiveBlocked("editors-pick-unreadable", `${path.relative(root, indexFile)} could not be read.`);
  }
  const pick = readEditorsPick(indexHtml);
  const slug = pick ? pick.markerSlug || pick.linkSlug : "";
  if (!pick || !slug) {
    return archiveBlocked("editors-pick-not-found", "no card-featured block with an article link was found on the homepage.");
  }
  if (pick.markerSlug && pick.linkSlug && pick.markerSlug !== pick.linkSlug) {
    return archiveBlocked("editors-pick-inconsistent", `the editors-pick marker names ${pick.markerSlug} but the featured card links ${pick.linkSlug}.`);
  }

  // Guard: a marker older (or newer) than a week means the rotation did not run for this
  // week, so the pick is not this week's. No marker at all cannot be checked and is allowed.
  if (pick.markerWeek && Math.abs(ageInDays(pick.markerWeek, today)) > ARCHIVE_MARKER_MAX_DAYS) {
    return archiveBlocked("editors-pick-stale-marker", `the editors-pick marker week ${pick.markerWeek} is more than ${ARCHIVE_MARKER_MAX_DAYS} days from ${today}.`);
  }

  // Guard: the pick must not be the article of the most recent staged/sent stem.
  const newestDate = records.map((record) => record.date).sort().pop();
  const latest = records.find((record) => record.date === newestDate && record.slugs.includes(slug));
  if (latest) {
    return archiveBlocked("editors-pick-is-last-sent", `the Editor's Pick ${slug} is the article of the most recent staged stem ${latest.stem}.`);
  }
  // Guard: never when any stem (archive or normal) for that article already exists.
  const existing = records.find((record) => record.slugs.includes(slug));
  if (existing) {
    return archiveBlocked("editors-pick-already-issued", `a stem for ${slug} already exists (${existing.stem}).`);
  }

  const articlesDirectory = articlesDirectoryPath();
  let article;
  try {
    article = await parseArticleFile(articlesDirectory, `${slug}.html`);
  } catch (error) {
    if (error.code === "ENOENT") return archiveBlocked("editors-pick-article-missing", `articles/${slug}.html does not exist.`);
    return archiveBlocked("editors-pick-article-unusable", String(error.message));
  }
  if (!article) return archiveBlocked("editors-pick-article-unusable", `articles/${slug}.html has no publish date.`);

  const src = pick.imageSrc;
  const imageFile = path.resolve(path.dirname(indexFile), src);
  const localImage = /^assets\/[A-Za-z0-9._\/-]+$/.test(src) && !src.includes("..") && !/amazon/i.test(src);
  if (!localImage || !(await fs.access(imageFile).then(() => true).catch(() => false))) {
    return archiveBlocked("editors-pick-no-local-image", `the featured card image "${src}" is not an existing local assets/ file.`);
  }

  const articleHtml = await fs.readFile(path.join(articlesDirectory, `${slug}.html`), "utf8");
  // Quote-aware re-read of the title and description: parseArticleFile() uses attr(),
  // which cuts a double-quoted value at its first apostrophe.
  const jsonLd = firstJsonLdObject(articleHtml);
  const title = stripHtml(jsonLd.headline || jsonLd.name || quotedMetaContent(articleHtml, "property", "og:title"));
  const description = stripHtml(quotedMetaContent(articleHtml, "name", "description"));
  // One sentence: up to the first period or exclamation mark (a leading question stays
  // attached to its answer), not the whole paragraph.
  const sentence = (description.match(/^.*?[.!](?=\s|$)/)?.[0] ?? description).trim();
  if (sentence.length < 35 || sentence.length > ARCHIVE_MAX_SENTENCE) {
    return archiveBlocked("editors-pick-no-description", `articles/${slug}.html has no usable meta description sentence.`);
  }

  const issue = {
    article: { ...article, title: title || article.title, excerpt: sentence },
    stem: `${today}-archive-${slug}`,
    imageUrl: `https://${config.domain}/${src}`,
    imageAlt: pick.imageAlt,
    week: pick.markerWeek,
  };
  issue.subject = `${ARCHIVE_SUBJECT_PREFIX} ${issue.article.title}`;
  issue.html = renderHtml(issue.article, { eyebrow: "From the archive", imageUrl: issue.imageUrl, imageAlt: issue.imageAlt });
  // The subject is only the fixed prefix plus the title, which is in the rendered HTML.
  const copied = [issue.article.title, sentence, issue.imageAlt, issue.article.url, issue.imageUrl].join("\n");
  if (ARCHIVE_FORBIDDEN.test(issue.html) || ARCHIVE_FORBIDDEN_CONTENT.test(copied)) {
    return archiveBlocked("editors-pick-unsafe-content", `the rendered archive issue for ${slug} contains a price, offer, deal, rating, stock, tracking or retailer-link term.`);
  }
  return { ok: true, issue };
}

// Shared by the normal and archive paths: write, optionally commit, report.
async function writeStagedIssue({ outputDirectory, htmlPath, metaPath, html, metadata, article, commitMessage, resultExtra = {} }) {
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(htmlPath, html, "utf8");
  await fs.writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const commitSha = await commitAndPush(htmlPath, metaPath, article, commitMessage);
  console.log(`NEWSLETTER_PREPARED: ${path.relative(root, htmlPath)}`);
  console.log(`SUBJECT: ${metadata.suggestedSubject}`);
  console.log(`CTA_URL: ${article.url}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `newsletter_prepared=true\nnewsletter_html_path=${path.relative(root, htmlPath)}\nnewsletter_meta_path=${path.relative(root, metaPath)}\nnewsletter_commit_sha=${commitSha}\n`,
      "utf8",
    );
  }
  await writeResult({
    status: "prepared",
    article,
    htmlPath: path.relative(root, htmlPath),
    metaPath: path.relative(root, metaPath),
    ...metadata,
    ...resultExtra,
  });
}

async function main() {
  const article = await findNewestArticle();
  const today = newsletterDate();
  const age = ageInDays(article.publishedDate, today);
  const outputDirectory = path.resolve(root, process.env.NEWSLETTER_OUTPUT_DIR ?? "newsletters");
  const stem = `${article.publishedDate}-${article.slug}`;
  const htmlPath = path.join(outputDirectory, `${stem}.html`);
  const metaPath = path.join(outputDirectory, `${stem}.meta.json`);

  // Stale (no new article this week) with the archive flag on: stage an archive issue
  // if every guard passes; otherwise fall through to exactly the pre-existing outcome
  // with the named block reason added.
  let archiveBlock = null;
  if (archiveEnabled() && age > 8 && !testMode()) {
    const outcome = await chooseArchiveIssue({ today, outputDirectory });
    if (outcome.alreadyStaged) {
      console.log(`ALREADY_STAGED: ${outcome.stem} archive issue already exists; no duplicate newsletter staged.`);
      await writeResult({ status: "no-op", reason: "already-staged", article, archiveStem: outcome.stem });
      return;
    }
    if (outcome.ok) {
      const { issue } = outcome;
      const archiveHtmlPath = path.join(outputDirectory, `${issue.stem}.html`);
      const archiveMetaPath = path.join(outputDirectory, `${issue.stem}.meta.json`);
      console.log(`ARCHIVE_ISSUE: newest article ${article.slug} is ${age} days old; staging the Editor's Pick ${issue.article.slug} as an archive issue.`);
      // The corpus being stalled must stay visible even though the job now succeeds, so a
      // later workflow step can alert on it. Only when the stall threshold is exceeded.
      const stalled = age > STALL_AFTER_DAYS;
      const stallSummary = stalled ? archiveStallSummary(article, age, issue.stem) : "";
      if (process.env.GITHUB_OUTPUT) {
        await fs.appendFile(
          process.env.GITHUB_OUTPUT,
          `newsletter_archive=true\n${stalled ? `newsletter_stalled=true\nnewsletter_stall_summary=${stallSummary}\n` : ""}`,
          "utf8",
        );
      }
      await writeStagedIssue({
        outputDirectory,
        htmlPath: archiveHtmlPath,
        metaPath: archiveMetaPath,
        html: issue.html,
        article: issue.article,
        commitMessage: `chore: stage archive newsletter ${issue.article.slug} ${today}`,
        resultExtra: stalled ? { stalled: true, ageDays: age, thresholdDays: STALL_AFTER_DAYS, stallSummary, newestArticle: article } : {},
        metadata: {
          suggestedSubject: issue.subject,
          previewText: issue.article.excerpt.slice(0, 160),
          fromName: config.fromName,
          fromAddress: config.fromAddress,
          listName: config.listName,
          articleUrl: issue.article.url,
          publishedDate: issue.article.publishedDate,
          articleTitle: issue.article.title,
          articleSource: issue.article.source,
          issueType: "archive",
          issueStem: issue.stem,
          editorsPickWeek: issue.week,
          stagedAt: new Date().toISOString(),
          note: "Create and send this campaign manually in Klaviyo. This workflow never calls any email API.",
        },
      });
      return;
    }
    archiveBlock = outcome;
    console.log(`ARCHIVE_BLOCKED: ${outcome.reason}: ${outcome.detail}`);
  }

  if (age > STALL_AFTER_DAYS && !testMode()) {
    fail("CONTENT_STALLED", await reportStall(article, age, archiveBlock));
  }
  if ((age < 0 || age > 8) && !testMode()) {
    console.log(`NO_NEW_ARTICLE: newest article ${article.slug} was published ${article.publishedDate} (${age} days old); no newsletter staged.`);
    await writeResult({ status: "no-op", reason: "stale", article, ...(archiveBlock ? { archiveBlocked: archiveBlock.reason } : {}) });
    return;
  }
  if ((age < 0 || age > 8) && testMode()) {
    console.log(`TEST_MODE: bypassing freshness only for local validation; newest article is ${age} days old.`);
  }
  if (await fs.access(htmlPath).then(() => true).catch(() => false)) {
    console.log(`ALREADY_STAGED: ${path.relative(root, htmlPath)} already exists; no duplicate newsletter staged.`);
    await writeResult({ status: "no-op", reason: "already-staged", article, htmlPath: path.relative(root, htmlPath) });
    return;
  }

  const metadata = {
    suggestedSubject: `New this week: ${article.title}`,
    previewText: article.excerpt.slice(0, 160),
    fromName: config.fromName,
    fromAddress: config.fromAddress,
    listName: config.listName,
    articleUrl: article.url,
    publishedDate: article.publishedDate,
    articleTitle: article.title,
    articleSource: article.source,
    stagedAt: new Date().toISOString(),
    note: "Create and send this campaign manually in Klaviyo. This workflow never calls any email API.",
  };

  await writeStagedIssue({
    outputDirectory,
    htmlPath,
    metaPath,
    html: renderHtml(article),
    metadata,
    article,
  });
}

main().catch((error) => {
  console.error(`NEWSLETTER_PREP_FAILED: ${error.message}`);
  process.exitCode = 1;
});
