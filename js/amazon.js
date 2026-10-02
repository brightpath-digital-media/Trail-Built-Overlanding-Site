/**
 * Trail Built Overlanding — Amazon Affiliate Link & Image Utilities
 *
 * Mirrors the SilkierStrands amazonLink() / amazonImageUrl() pattern.
 *
 * Amazon Affiliate Tag: trailbuiltove-20
 * All Amazon links use format: https://www.amazon.com/dp/{ASIN}?tag=trailbuiltove-20
 *
 * Image strategy (two-source, same as SilkierStrands):
 *   1. Product card image  → Amazon CDN: https://m.media-amazon.com/images/I/{IMAGE_CODE}._SL500_.jpg
 *   2. Article hero/banner → Unsplash contextual photo (see image-strategy.md)
 */

(function (global) {
  "use strict";

  const AFFILIATE_TAG = "trailbuiltove-20";

  /**
   * Build a tagged Amazon product link.
   * @param {string} asin - 10-character Amazon ASIN
   * @returns {string} Full Amazon URL with affiliate tag
   */
  function amazonLink(asin) {
    if (!asin || typeof asin !== "string") return "#";
    return `https://www.amazon.com/dp/${asin.trim()}?tag=${AFFILIATE_TAG}`;
  }

  /**
   * Build an Amazon product image URL from an image code.
   * The image code is the filename stem from m.media-amazon.com/images/I/
   * e.g. "71abc123XY" → "https://m.media-amazon.com/images/I/71abc123XY._SL500_.jpg"
   *
   * @param {string} imageCode - Amazon image code (no extension)
   * @param {number} [size=500] - Image size (SL dimension). Use 500 for cards, 1500 for hero.
   * @returns {string} Full Amazon image URL
   */
  function amazonImageUrl(imageCode, size) {
    if (!imageCode) return "";
    const sz = size || 500;
    return `https://m.media-amazon.com/images/I/${imageCode.trim()}._SL${sz}_.jpg`;
  }

  /**
   * Build a short affiliate redirect URL using the /go/ shortener.
   * Requires the Netlify redirect rule: /go/:asin → Amazon.
   * @param {string} asin
   * @returns {string} Short URL e.g. https://trailbuiltoverland.com/go/B0F55VMN66
   */
  function shortLink(asin) {
    if (!asin) return "#";
    return `https://trailbuiltoverland.com/go/${asin.trim()}`;
  }

  /**
   * Inject affiliate links into all [data-asin] anchor elements on the page.
   * Usage: add data-asin="B0F55VMN66" to any <a> element.
   * The href will be set to the full tagged Amazon URL.
   * Also sets target="_blank" rel="noopener sponsored".
   */
  function injectAffiliateLinks() {
    const links = document.querySelectorAll("a[data-asin]");
    links.forEach(function (el) {
      const asin = el.getAttribute("data-asin");
      if (asin) {
        el.href = amazonLink(asin);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "sponsored nofollow noopener");
      }
    });
  }

  /**
   * Inject Amazon product images into all [data-amazon-img] img elements.
   * Usage: add data-amazon-img="71abc123XY" to any <img> element.
   * The src will be set to the Amazon CDN URL.
   * Also sets loading="lazy" decoding="async" if not already set.
   */
  function injectAmazonImages() {
    const imgs = document.querySelectorAll("img[data-amazon-img]");
    imgs.forEach(function (el) {
      const code = el.getAttribute("data-amazon-img");
      const size = parseInt(el.getAttribute("data-amazon-img-size") || "500", 10);
      if (code) {
        el.src = amazonImageUrl(code, size);
        if (!el.getAttribute("loading")) el.setAttribute("loading", "lazy");
        if (!el.getAttribute("decoding")) el.setAttribute("decoding", "async");
      }
    });
  }

  /**
   * Auto-run on DOMContentLoaded.
   */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      injectAffiliateLinks();
      injectAmazonImages();
    });
  } else {
    injectAffiliateLinks();
    injectAmazonImages();
  }

  // Expose to global scope for manual use
  global.TrailBuiltAmazon = {
    AFFILIATE_TAG: AFFILIATE_TAG,
    amazonLink: amazonLink,
    amazonImageUrl: amazonImageUrl,
    shortLink: shortLink,
    injectAffiliateLinks: injectAffiliateLinks,
    injectAmazonImages: injectAmazonImages,
  };

})(typeof window !== "undefined" ? window : global);

  /**
   * Returns true if the last price sync is within the 24-hour freshness window.
   * Reads window.TrailBuiltLastSyncedAt written by scripts/fetch-prices.js.
   */
  function isPriceFresh() {
    var ts = window.TrailBuiltLastSyncedAt;
    if (!ts) return false;
    var age = Date.now() - new Date(ts).getTime();
    return age < 24 * 60 * 60 * 1000; // 24 hours in ms
  }

  /**
   * Inject live prices from products-data.js into elements with data-asin.
   * Expects HTML like: <div class="product-price" data-asin="B0F55VMN66"></div>
   * Or for articles: <div class="price" data-asin="B0F55VMN66"></div>
   *
   * Freshness gate: if window.TrailBuiltLastSyncedAt is missing or older than
   * 24 hours, numeric prices are hidden and replaced with a 'Check current price on
   * Amazon' affiliate link (correct tag: trailbuiltove-20) instead.
   */
  function injectLivePrices() {
    if (!window.TrailBuiltProducts) return;

    var fresh = isPriceFresh();

    var priceEls = document.querySelectorAll("[data-asin]");
    priceEls.forEach(function (el) {
      // Only target elements that are meant to hold prices
      if (!el.classList.contains("product-price") && !el.classList.contains("price")) return;

      var asin = el.getAttribute("data-asin");
      if (!asin || !window.TrailBuiltProducts[asin]) return;
      var p = window.TrailBuiltProducts[asin];

      if (!fresh || p.price === 0) {
        // Prices are stale (or this product has no live offer) — show affiliate link
        var link = document.createElement("a");
        link.href = amazonLink(asin);
        link.target = "_blank";
        link.rel = "sponsored nofollow noopener";
        link.textContent = "Check current price on Amazon";
        el.textContent = "";
        el.appendChild(link);
      } else {
        // Prices are fresh — render numeric price
        if (el.classList.contains("price")) {
          el.textContent = p.priceDisplay + " on Amazon";
        } else {
          el.textContent = p.priceDisplay;
        }
      }
    });
  }

  // Hook into DOMContentLoaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectLivePrices);
  } else {
    injectLivePrices();
  }
