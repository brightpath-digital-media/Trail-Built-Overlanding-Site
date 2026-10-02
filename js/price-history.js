/**
 * TrailBuiltOverland.com — Price History & Badge System
 * Modeled on SilkierStrands priceHistory.ts
 *
 * Tracks price history for featured products and renders
 * All-Time Low / Price Drop / Good Deal badges on product cards.
 *
 * Update prices monthly (1st of each month) by editing the
 * `priceHistoryData` object below.
 *
 * Badge logic:
 *   All-Time Low  — currentPrice <= lowestPrice * 1.05
 *   Price Drop    — currentPrice is ≥10% below averagePrice
 *   Good Deal     — currentPrice is 5–10% below averagePrice
 *   (no badge)    — currentPrice is within 5% of averagePrice
 */

const priceHistoryData = {};

// ── Badge logic ───────────────────────────────────────────────────────────────

/**
 * Returns a badge object or null for a given ASIN.
 * @param {string} asin
 * @param {number} [overridePrice] - Optional current price override
 * @returns {{ type: string, label: string, cssClass: string } | null}
 */
function getPriceBadge(asin, overridePrice) {
  const data = priceHistoryData[asin];
  if (!data) return null;

  const current = overridePrice !== undefined ? overridePrice : data.currentPrice;
  const { lowestPrice, averagePrice } = data;

  if (current <= lowestPrice * 1.05) {
    return { type: "atl",  label: "All-Time Low", cssClass: "price-badge price-badge-atl" };
  }
  if (current <= averagePrice * 0.90) {
    return { type: "drop", label: "Price Drop",   cssClass: "price-badge price-badge-drop" };
  }
  if (current <= averagePrice * 0.95) {
    return { type: "deal", label: "Good Deal",    cssClass: "price-badge price-badge-deal" };
  }
  return null;
}

/**
 * Returns the full price history for an ASIN, or null.
 * @param {string} asin
 */
function getPriceHistoryForAsin(asin) {
  return priceHistoryData[asin] || null;
}

/**
 * Returns price trend direction for an ASIN.
 * @param {string} asin
 * @returns {"dropping" | "rising" | "stable" | null}
 */
function getPriceTrend(asin) {
  const data = priceHistoryData[asin];
  if (!data || data.history.length < 2) return null;

  const sorted = [...data.history].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-3);
  if (recent.length < 2) return "stable";

  const first = recent[0].price;
  const last  = recent[recent.length - 1].price;
  const change = (last - first) / first;

  if (change <= -0.05) return "dropping";
  if (change >= 0.05)  return "rising";
  return "stable";
}

// ── Auto-inject badges on page load ──────────────────────────────────────────
/**
 * Scans the page for elements with [data-asin] and injects price badges.
 * Add data-asin="B07SJHVQTJ" to any product card to get automatic badges.
 */
function injectPriceBadges() {
  document.querySelectorAll("[data-asin]").forEach(el => {
    const asin = el.getAttribute("data-asin");
    const badge = getPriceBadge(asin);
    if (!badge) return;

    // Find the price element inside the card (looks for .product-price or .price)
    const priceEl = el.querySelector(".product-price, .price, [class*='price']");
    if (priceEl) {
      const badgeEl = document.createElement("span");
      badgeEl.className = badge.cssClass;
      badgeEl.textContent = badge.label;
      priceEl.appendChild(badgeEl);
    }
  });
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectPriceBadges);
} else {
  injectPriceBadges();
}
