#!/usr/bin/env node
/**
 * image-coverage — the one image gate for every Brightpath site (canonical copy: factory-ops/gates/).
 *
 * Why it exists (2026-09-17): TrailBuilt shipped nine product cards with no picture at all. Every gate we had
 * checked that *referenced* images existed; none checked that the places that must carry an image carried one.
 * This gate checks the rendered output — the HTML people and crawlers receive — so it is the same rule whether
 * the site is a static folder, a prerendered React build or a tenant the engine emitted, and whether it runs in
 * the build (directory mode) or against a live site (URL mode, used by the daily monitor).
 *
 * Rules, in order of severity
 *   FAIL card       an affiliate link's card (nearest card-like ancestor) has no <img>/<picture> and no data-image-free
 *   FAIL missing    an <img>/srcset/CSS url() points at a local file that does not exist (directory mode)
 *   FAIL corrupt    a local image file is empty or its bytes are not an image (the 2026-09-17 case: JPEGs written through a
 *                   UTF-8 text decode — every high byte became EF BF BD; the file existed, the server said image/jpeg,
 *                   and no browser could draw it)
 *   FAIL broken     an image URL answers non-2xx, a non-image content type, or bytes that are not an image (URL mode;
 *                   directory mode with --remote block)
 *   FAIL page       a page carries affiliate links but no product-looking image at all (--page-level block, the default)
 *   WARN hero       the hero block has no image, no background-image and no data-image-free
 *
 * A card may opt out with data-image-free="<reason>" on the card or any ancestor — the reason is required and is
 * reported, so an opt-out is a decision, never a silence.
 *
 * Usage
 *   node image-coverage.mjs --dir dist/public [--remote warn|block|off] [--page-level warn|block] [--hero warn|off]
 *   node image-coverage.mjs --url https://example.com [--max 40]
 *   node image-coverage.mjs --sites sites.json --out results.json [--shard 1/4] [--concurrency 6]
 *   Any mode: --json <file> writes the full report; exit code 1 on any FAIL.
 */
import { access, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ───────────────────────── options ─────────────────────────
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? true) : fallback; };
const has = (name) => argv.includes(`--${name}`);
const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined; // engine validators pass the publish dir bare
const OPTS = {
  dir: opt("dir", positional), url: opt("url"), sites: opt("sites"), out: opt("out"), json: opt("json"),
  max: Number(opt("max", 40)), shard: opt("shard", "1/1"), concurrency: Number(opt("concurrency", 6)),
  remote: opt("remote", process.env.IMAGE_GATE_REMOTE || "warn"),
  pageLevel: opt("page-level", process.env.IMAGE_GATE_PAGE || "block"),
  hero: opt("hero", process.env.IMAGE_GATE_HERO || "warn"),
  exclude: String(opt("exclude", "")).split(",").filter(Boolean),
  quiet: has("quiet"),
};
const DEFAULT_EXCLUDE = new Set([".git", "node_modules", "templates", "admin", "docs", "reports", "downloads", "__manus__", "fixtures", "newsletters", "email-templates", ...OPTS.exclude]);
const UA = "site-bindery-image-gate/1.0 (+https://sitebindery.com)";

// ───────────────────────── tiny tolerant HTML parser ─────────────────────────
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "noscript", "template", "svg"]);

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([^\s=\/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/** Returns a flat node list; each node: {tag, attrs, parent, imgs:[src...], hasBg, imageFree} with imgs aggregated over descendants. */
function parse(html) {
  const nodes = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    const tag = m[1].toLowerCase();
    if (m[0][1] === "/") {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const attrs = parseAttrs(m[2]);
    const node = { tag, attrs, parent: stack[stack.length - 1] || null, imgs: [], hasBg: false, imageFree: null, anchors: [] };
    if (attrs.style && /background(-image)?\s*:[^;]*url\(/i.test(attrs.style)) node.hasBg = true;
    if ("data-image-free" in attrs) node.imageFree = attrs["data-image-free"] || "(no reason given)";
    nodes.push(node);
    if (RAW.has(tag) && !m[2].endsWith("/")) {
      const close = html.indexOf(`</${tag}`, re.lastIndex);
      if (close > 0) re.lastIndex = close;
      continue;
    }
    if (VOID.has(tag) || m[2].trim().endsWith("/")) {
      if (tag === "img" || tag === "source") {
        const src = attrs.src || (attrs.srcset || "").split(",")[0].trim().split(/\s+/)[0] || attrs["data-src"];
        if (src) for (let p = node.parent; p; p = p.parent) p.imgs.push(src);
        if (tag === "img" && src) node.imgs.push(src);
      }
      continue;
    }
    stack.push(node);
  }
  return nodes;
}

function matchesSimpleCssSelector(node, selector) {
  const value = selector.trim().replace(/::?[\w-]+(?:\([^)]*\))?/g, "");
  if (!value || /[\s>+~\[\]*]/.test(value)) return false;
  const tag = value.match(/^[a-z][\w-]*/i)?.[0]?.toLowerCase();
  if (tag && tag !== node.tag) return false;
  const id = value.match(/#([\w-]+)/)?.[1];
  if (id && id !== node.attrs.id) return false;
  const classes = [...value.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const nodeClasses = new Set((node.attrs.class || "").split(/\s+/).filter(Boolean));
  return classes.every((className) => nodeClasses.has(className));
}

function applyStylesheetBackgrounds(nodes, stylesheets) {
  for (const stylesheet of stylesheets) {
    const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(",");
      const declarations = rule[2];
      if (!/background(?:-image)?\s*:[^;}]*url\(/i.test(declarations)) continue;
      for (const node of nodes) {
        if (selectors.some((selector) => matchesSimpleCssSelector(node, selector))) node.hasBg = true;
      }
    }
  }
}

async function localStylesheetTexts(html, htmlFile, root) {
  const texts = [];
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1]);
    if (!/(^|\s)stylesheet(\s|$)/i.test(attrs.rel || "") || !attrs.href) continue;
    if (/^(?:https?:)?\/\//i.test(attrs.href)) continue;
    const file = path.resolve(path.dirname(htmlFile), attrs.href.split(/[?#]/, 1)[0]);
    if (!file.startsWith(root + path.sep) || !(await exists(file))) continue;
    texts.push(await readFile(file, "utf8"));
  }
  return texts;
}

// ───────────────────────── rules ─────────────────────────
const AFFILIATE = /amazon\.[a-z.]+\/|amzn\.to|amzn\.com|\/go\/|\/out\/|\/recommends?\/|shareasale|awin1|impact\.com|clickbank|cj\.com|rstyle|shopstyle|geni\.us/i;
const CARD_TOKENS = /(^|[\s_-])(card|product|box|pick|item|tile|listing|offer|deal|feature|spotlight|verdict|buy|recommend)([\s_-]|$)/i;
const PROSE = new Set(["p", "span", "em", "strong", "b", "i", "td", "th", "small", "sup", "sub", "cite", "blockquote", "figcaption", "dd", "dt"]);
const NOT_PRODUCT_IMG = /logo|favicon|icon|wordmark|avatar|badge|sprite|pixel|spacer|tracking|\.svg(\?|$)|^data:image\/svg/i;

function isAffiliate(a) {
  const rel = (a.attrs.rel || "").toLowerCase();
  return rel.includes("sponsored") || AFFILIATE.test(a.attrs.href || "");
}

function cardOf(a) {
  if (a.parent && PROSE.has(a.parent.tag)) return null; // a link inside running text is not a card
  for (let p = a.parent; p && p.tag !== "body" && p.tag !== "main" && p.tag !== "html"; p = p.parent) {
    if (CARD_TOKENS.test(p.attrs.class || "") || CARD_TOKENS.test(p.attrs.id || "") || "data-product" in p.attrs || "data-asin" in p.attrs) return p;
    if (p.tag === "article" && CARD_TOKENS.test(p.attrs.class || "")) return p;
    if (p.tag === "li" && CARD_TOKENS.test((p.parent && p.parent.attrs.class) || "")) return p;
  }
  return null;
}

function freeReason(n) { for (let p = n; p; p = p.parent) if (p.imageFree) return p.imageFree; return null; }
function label(n) { const c = (n.attrs.class || "").split(/\s+/).filter(Boolean).slice(0, 3).join("."); return `<${n.tag}${n.attrs.id ? "#" + n.attrs.id : ""}${c ? "." + c : ""}>`; }

function checkPage(html, page, stylesheets = []) {
  const nodes = parse(html);
  applyStylesheetBackgrounds(nodes, stylesheets);
  const findings = [];
  const cards = new Set();
  let affiliateLinks = 0;
  for (const a of nodes) {
    if (a.tag !== "a" || !isAffiliate(a)) continue;
    affiliateLinks += 1;
    const card = cardOf(a);
    if (!card || cards.has(card)) continue;
    cards.add(card);
    if (card.imgs.length || card.hasBg) continue;
    const reason = freeReason(card);
    if (reason) findings.push({ level: "info", rule: "card-opt-out", page, detail: `${label(card)} image-free: ${reason}` });
    else findings.push({ level: "fail", rule: "card", page, detail: `${label(card)} links to ${(a.attrs.href || "").slice(0, 80)} but shows no image` });
  }
  const root = nodes.find((n) => n.tag === "body") || nodes[0];
  const productImgs = root ? root.imgs.filter((s) => !NOT_PRODUCT_IMG.test(s)) : [];
  if (affiliateLinks && !productImgs.length && !(root && freeReason(root)) && OPTS.pageLevel !== "off") {
    findings.push({ level: OPTS.pageLevel === "block" ? "fail" : "warn", rule: "page", page, detail: `${affiliateLinks} affiliate link(s) but no product image on the page` });
  }
  if (OPTS.hero !== "off") {
    const heroClass = (n) => (n.attrs.class || "").split(/\s+/).some((t) => /^hero(-?(section|block|banner|wrap|wrapper|area|header))?$/i.test(t));
    const hero = nodes.find((n) => ["section", "header", "div"].includes(n.tag) && (heroClass(n) || n.attrs.id === "hero" || /^hero$/i.test(n.attrs["data-section"] || "")));
    if (hero && !hero.imgs.length && !hero.hasBg && !freeReason(hero)) findings.push({ level: OPTS.hero === "block" ? "fail" : "warn", rule: "hero", page, detail: `${label(hero)} has no image or background image` });
  }
  const refs = new Set();
  for (const n of nodes) if (n.tag === "img") for (const s of n.imgs) refs.add(s);
  for (const n of nodes) if (n.tag === "img" && n.attrs.srcset) for (const part of n.attrs.srcset.split(",")) { const u = part.trim().split(/\s+/)[0]; if (u) refs.add(u); }
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) for (const u of m[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) refs.add(u[1]);
  return { findings, refs: [...refs].map((s) => s.replace(/&amp;/g, "&").trim()).filter((s) => s && !s.startsWith("data:")), cards: cards.size, affiliateLinks };
}

// ───────────────────────── reference checks ─────────────────────────
async function exists(f) { return access(f).then(() => true).catch(() => false); }
const remoteCache = new Map();
async function fetchImageStatus(url) {
  if (remoteCache.has(url)) return remoteCache.get(url);
  const p = (async () => {
    for (const method of ["HEAD", "GET"]) {
      try {
        const r = await fetch(url, { method, redirect: "follow", headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.5" }, signal: AbortSignal.timeout(20000) });
        const type = r.headers.get("content-type") || "";
        if (r.status === 405 || (r.status === 403 && method === "HEAD")) continue;
        if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, unverifiable: r.status === 403 || r.status === 429 };
        if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) {
          if (method === "HEAD") continue; // some CDNs answer HEAD with text/html; let GET decide
          return { ok: false, why: `content-type ${type.split(";")[0]}` };
        }
        if (method === "HEAD") continue; // a content-type is not a picture: read the first bytes
        const reader = r.body && r.body.getReader ? r.body.getReader() : null;
        if (!reader) return { ok: true };
        const chunks = []; let got = 0;
        while (got < 512) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
        try { await reader.cancel(); } catch {}
        const why = sniff(Buffer.concat(chunks.map((c) => Buffer.from(c))));
        return why ? { ok: false, why } : { ok: true };
      } catch (err) { if (method === "GET") return { ok: false, why: String(err.message || err).slice(0, 60), unverifiable: true }; }
    }
    return { ok: false, why: "HEAD and GET both refused", unverifiable: true };
  })();
  remoteCache.set(url, p);
  return p;
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** Image magic bytes. Returns null when the bytes look like an image, else a short reason. */
function sniff(buf) {
  if (!buf || buf.length === 0) return "empty file";
  const b = buf.subarray(0, 16);
  const ascii = buf.subarray(0, 512).toString("latin1");
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return null;                     // JPEG
  if (b[0] === 0x89 && ascii.startsWith("\x89PNG")) return null;                       // PNG
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return null;            // GIF
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return null;          // WEBP
  if (ascii.slice(4, 8) === "ftyp") return null;                                      // AVIF / HEIF
  if (ascii.startsWith("BM")) return null;                                            // BMP
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return null; // ICO / CUR
  if (/^\s*(<\?xml|<!doctype svg|<svg)/i.test(ascii)) return null;                     // SVG
  if (ascii.startsWith("\ufffd") || (b[0] === 0xef && b[1] === 0xbf && b[2] === 0xbd)) return "UTF-8-mangled binary (EF BF BD)";
  if (/^\s*<(!doctype|html)/i.test(ascii)) return "HTML, not an image";
  return "not an image (unknown bytes)";
}

// ───────────────────────── directory mode ─────────────────────────
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (DEFAULT_EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full))); else if (e.name.endsWith(".html")) out.push(full);
  }
  return out;
}

async function runDir(dir) {
  const root = path.resolve(dir);
  const files = await walk(root);
  const findings = [];
  const remote = new Map();
  const sniffed = new Map();
  let pages = 0, cards = 0;
  for (const file of files) {
    const html = await readFile(file, "utf8");
    const page = path.relative(root, file);
    const r = checkPage(html, page, await localStylesheetTexts(html, file, root));
    pages += 1; cards += r.cards;
    findings.push(...r.findings);
    for (let ref of r.refs) {
      if (/^(https?:)?\/\//i.test(ref)) { if (!remote.has(ref)) remote.set(ref, page); continue; }
      if (ref.startsWith("/.netlify/images")) { // host image CDN: in a build the source file is what must exist
        const m = ref.match(/[?&]url=([^&]+)/); if (!m) continue;
        ref = decodeURIComponent(m[1]); if (/^(https?:)?\/\//i.test(ref)) { if (!remote.has(ref)) remote.set(ref, page); continue; }
      }
      const clean = decodeURIComponent(ref.split(/[?#]/, 1)[0]);
      const target = clean.startsWith("/") ? path.join(root, clean.slice(1)) : path.resolve(path.dirname(file), clean);
      if (!(await exists(target))) { findings.push({ level: "fail", rule: "missing", page, detail: `${ref} not found in publish directory` }); continue; }
      if (!sniffed.has(target)) {
        let why = null;
        try { const fh = await open(target, "r"); const buf = Buffer.alloc(512); const { bytesRead } = await fh.read(buf, 0, 512, 0); await fh.close(); why = sniff(buf.subarray(0, bytesRead)); } catch (err) { why = String(err.message || err).slice(0, 60); }
        sniffed.set(target, why);
      }
      if (sniffed.get(target)) findings.push({ level: "fail", rule: "corrupt", page, detail: `${ref} — ${sniffed.get(target)}` });
    }
  }
  if (OPTS.remote !== "off" && remote.size) {
    await mapLimit([...remote.entries()], OPTS.concurrency, async ([url, page]) => {
      const s = await fetchImageStatus(url.startsWith("//") ? "https:" + url : url);
      if (!s.ok) findings.push({ level: OPTS.remote === "block" && !s.unverifiable ? "fail" : "warn", rule: "broken", page, detail: `${url.slice(0, 100)} → ${s.why}` });
    });
  }
  return { target: root, pages, cards, findings };
}

// ───────────────────────── URL mode ─────────────────────────
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  return { status: r.status, url: r.url, text: r.ok ? await r.text() : "" };
}

async function pagesFor(site) {
  const base = site.replace(/\/$/, "");
  const urls = new Set([base + "/"]);
  for (const sm of [base + "/sitemap.xml", base + "/sitemap_index.xml"]) {
    try {
      const { text } = await getText(sm);
      const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      const nested = locs.filter((l) => /sitemap[^/]*\.xml$/i.test(l));
      for (const n of nested.slice(0, 5)) { try { const { text: t } = await getText(n); for (const m of t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) locs.push(m[1]); } catch {} }
      // a preview host's sitemap lists canonical-domain URLs; check them on the host we were asked about
      const onBase = (l) => { try { const u = new URL(l); return base + u.pathname + u.search; } catch { return null; } };
      for (const l of locs) if (!nested.includes(l)) { const u = onBase(l); if (u) urls.add(u); }
      if (urls.size > 1) break;
    } catch {}
  }
  // money pages first: reviews, comparisons, picks, products, guides; then everything else, deterministic order
  const money = (u) => /review|comparison|compare|best|-vs-|product|pick|guide|gear|deal/i.test(u);
  const all = [...urls].sort((a, b) => a.localeCompare(b));
  const half = Math.ceil(OPTS.max / 2);
  const chosen = [base + "/", ...all.filter(money).slice(0, half)];
  for (const u of all) { if (chosen.length >= OPTS.max) break; if (!chosen.includes(u)) chosen.push(u); }
  return chosen;
}

async function runUrl(site) {
  const findings = [];
  let pages = 0, cards = 0;
  const remote = new Map();
  let list;
  try { list = await pagesFor(site); } catch (err) { return { target: site, pages: 0, cards: 0, findings: [{ level: "fail", rule: "unreachable", page: "/", detail: String(err.message || err).slice(0, 80) }] }; }
  await mapLimit(list, 4, async (u) => {
    let res;
    try { res = await getText(u); } catch (first) {
      try { res = await getText(u); } catch (err) { // one retry; a lone timeout is a warning, a hard refusal is a failure
        const timeout = /abort|timeout/i.test(String(err.message || err));
        findings.push({ level: timeout ? "warn" : "fail", rule: "unreachable", page: u, detail: String(err.message || err).slice(0, 80) }); return;
      }
    }
    if (!res.text) { findings.push({ level: "fail", rule: "unreachable", page: u, detail: `HTTP ${res.status}` }); return; }
    const r = checkPage(res.text, u);
    pages += 1; cards += r.cards;
    findings.push(...r.findings);
    for (const ref of r.refs) { try { const abs = new URL(ref, res.url).toString(); if (!remote.has(abs)) remote.set(abs, u); } catch {} }
  });
  await mapLimit([...remote.entries()], OPTS.concurrency, async ([url, page]) => {
    const s = await fetchImageStatus(url);
    if (!s.ok) findings.push({ level: s.unverifiable ? "warn" : "fail", rule: "broken", page, detail: `${url.slice(0, 100)} → ${s.why}` });
  });
  return { target: site, pages, cards, findings };
}

// ───────────────────────── reporting ─────────────────────────
function summarize(report) {
  const fails = report.findings.filter((f) => f.level === "fail");
  const warns = report.findings.filter((f) => f.level === "warn");
  const infos = report.findings.filter((f) => f.level === "info");
  return { ...report, fails: fails.length, warns: warns.length, optOuts: infos.length, status: fails.length ? "fail" : warns.length ? "warn" : "pass" };
}

function print(report) {
  const s = summarize(report);
  if (!OPTS.quiet) for (const f of s.findings) if (f.level !== "info") console.log(`${f.level.toUpperCase().padEnd(4)} ${f.rule.padEnd(8)} ${f.page} — ${f.detail}`);
  console.log(`image-coverage ${s.status.toUpperCase()}: ${s.target} — ${s.pages} page(s), ${s.cards} product card(s), ${s.fails} fail, ${s.warns} warn, ${s.optOuts} opt-out`);
  return s;
}

const shardOf = (list) => { const [i, n] = OPTS.shard.split("/").map(Number); return list.filter((_, k) => k % n === i - 1); };

let exit = 0;
if (OPTS.sites) {
  const all = JSON.parse(await readFile(OPTS.sites, "utf8"));
  const sites = shardOf(Array.isArray(all) ? all : all.sites);
  const results = await mapLimit(sites, Math.max(1, Math.floor(OPTS.concurrency / 2)), async (site) => {
    const url = typeof site === "string" ? site : site.url;
    const r = summarize(await runUrl(url));
    console.log(`${r.status.toUpperCase().padEnd(4)} ${url} — ${r.pages} pages, ${r.cards} cards, ${r.fails} fail, ${r.warns} warn`);
    return { ...(typeof site === "string" ? { url } : site), ...r };
  });
  if (OPTS.out) await writeFile(OPTS.out, JSON.stringify({ generated: new Date().toISOString(), shard: OPTS.shard, results }, null, 2));
  exit = results.some((r) => r.status === "fail") ? 1 : 0;
} else if (OPTS.url) {
  const s = print(await runUrl(OPTS.url));
  if (OPTS.json) await writeFile(OPTS.json, JSON.stringify(s, null, 2));
  exit = s.status === "fail" ? 1 : 0;
} else if (OPTS.dir) {
  const s = print(await runDir(OPTS.dir));
  if (OPTS.json) await writeFile(OPTS.json, JSON.stringify(s, null, 2));
  exit = s.status === "fail" ? 1 : 0;
} else {
  console.error("usage: image-coverage.mjs --dir <publish dir> | --url <site> | --sites <sites.json> [--out results.json]");
  exit = 2;
}
process.exit(exit);
