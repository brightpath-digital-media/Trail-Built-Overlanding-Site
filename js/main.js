// Trail Built — main.js

// ── Mobile menu toggle ────────────────────────────────────────────────────────
const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('header nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('header')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// ── Active nav link ───────────────────────────────────────────────────────────
const navLinks = document.querySelectorAll('nav a:not(.header-cta)');
navLinks.forEach(link => {
  const linkPath = link.getAttribute('href');
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  if (linkPath === currentPath || (currentPath === '' && linkPath === 'index.html')) {
    link.classList.add('active');
  }
});

// ── Site search ───────────────────────────────────────────────────────────────
const SEARCH_INDEX = [
  { title: "Best Overlanding Recovery Gear: 2026 Buyer's Guide", url: 'articles/best-overlanding-recovery-gear.html', tags: 'recovery kinetic rope shackle maxtrax tred winch' },
  { title: 'Best Off-Road Light Bars 2026: From Budget to Pro', url: 'articles/best-off-road-light-bars.html', tags: 'lighting led light bar spotlight off-road' },
  { title: 'Rooftop Tent Buying Guide: Every Type, Ranked', url: 'articles/rooftop-tent-buying-guide.html', tags: 'rooftop tent rtt hard shell soft shell sleeping' },
  { title: 'Best Overlanding Winches 2026: Research-Based Rankings', url: 'articles/best-overlanding-winches.html', tags: 'winch warn synthetic rope recovery' },
  { title: 'Best Overlanding Fridges and Coolers 2026', url: 'articles/best-overlanding-fridges.html', tags: 'fridge cooler dometic arb camp kitchen' },
  { title: 'Best Overlanding Solar and Power Systems 2026', url: 'articles/best-overlanding-solar-and-power.html', tags: 'solar power station battery dual battery' },
  { title: '4Runner 5th Gen Overlanding Build Guide', url: 'articles/4runner-5th-gen-overland-build-guide.html', tags: '4runner toyota build guide mods' },
  { title: 'Ford Bronco Overland Build Guide', url: 'articles/ford-bronco-overland-build-guide.html', tags: 'bronco ford build guide mods' },
  { title: 'Toyota Tacoma Overlanding Build Guide', url: 'articles/toyota-tacoma-overland-build-guide.html', tags: 'tacoma toyota build guide mods' },
  { title: 'Jeep Wrangler Overlanding Build Guide', url: 'articles/jeep-wrangler-overland-build-guide.html', tags: 'jeep wrangler jl jk build guide mods' },
  { title: 'Recovery Gear Category', url: 'categories/recovery-gear.html', tags: 'recovery gear category' },
  { title: 'Sleeping and Camp Category', url: 'categories/sleeping-camp.html', tags: 'sleeping camp tent category' },
  { title: 'Lighting Category', url: 'categories/lighting.html', tags: 'lighting led category' },
  { title: 'Water and Power Category', url: 'categories/water-power.html', tags: 'water power solar fridge category' },
  { title: 'Navigation Category', url: 'categories/navigation.html', tags: 'navigation gps sat comm category' },
  { title: 'All Gear Reviews', url: 'reviews.html', tags: 'reviews all gear' },
  { title: 'All Build Guides', url: 'build-guides.html', tags: 'build guides all vehicles' },
];

function resolveUrl(relativeUrl) {
  const depth = window.location.pathname.split('/').length - 2;
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return prefix + relativeUrl;
}

const searchInput = document.getElementById('site-search');
const searchResults = document.getElementById('search-results');

if (searchInput && searchResults) {
  searchInput.addEventListener('input', function () {
    const q = this.value.trim().toLowerCase();
    searchResults.innerHTML = '';
    if (q.length < 2) { searchResults.classList.remove('open'); return; }

    const matches = SEARCH_INDEX.filter(item =>
      item.title.toLowerCase().includes(q) || item.tags.includes(q)
    ).slice(0, 6);

    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
    } else {
      matches.forEach(item => {
        const a = document.createElement('a');
        a.href = resolveUrl(item.url);
        a.className = 'search-result-item';
        a.textContent = item.title;
        searchResults.appendChild(a);
      });
    }
    searchResults.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.header-search')) {
      searchResults.classList.remove('open');
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchResults.classList.remove('open');
      searchInput.blur();
    }
  });
}

// ── Newsletter fallback form ──────────────────────────────────────────────────
async function handleNewsletterSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');
  const emailInput = form.querySelector('input[type="email"]');
  const email = (emailInput?.value || '').trim();
  const originalLabel = btn?.dataset.originalLabel || btn?.textContent || 'Subscribe Free →';

  let status = form.querySelector('[data-newsletter-status]');
  if (!status) {
    status = document.createElement('p');
    status.setAttribute('data-newsletter-status', 'true');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'font-size:0.72rem;margin:8px 0 0;color:rgba(240,236,228,0.75);';
    form.appendChild(status);
  }

  if (!email) {
    status.textContent = 'Please enter a valid email address.';
    status.style.color = '#ff9b8a';
    emailInput?.focus();
    return;
  }

  if (!btn || !window.TBOEmailCapture?.submitEmailSignup) {
    status.textContent = 'Subscription is temporarily unavailable. Please try again shortly.';
    status.style.color = '#ff9b8a';
    return;
  }

  btn.dataset.originalLabel = originalLabel;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.textContent = '';

  // Use persisted rig style from quiz if available, otherwise generic.
  const style = window.TBOEmailCapture.getPersistedRigStyle?.() || 'suv';

  try {
    const result = await window.TBOEmailCapture.submitEmailSignup(email, style, 'homepage');
    if (!result?.ok) {
      throw new Error(result?.error || 'Subscription failed. Please try again.');
    }

    btn.textContent = 'You’re subscribed';
    btn.style.background = 'var(--green)';
    status.textContent = 'Thanks — you’re on the TrailBuilt Weekly.';
    status.style.color = 'var(--green)';
  } catch (error) {
    btn.disabled = false;
    btn.textContent = originalLabel;
    status.textContent = error?.message || 'Subscription failed. Please try again.';
    status.style.color = '#ff9b8a';
  }
}

// ── Social sharing ────────────────────────────────────────────────────────────
function shareArticle(platform) {
  const url = encodeURIComponent(window.location.href);
  const title = encodeURIComponent(document.title);
  const urls = {
    twitter: 'https://twitter.com/intent/tweet?url=' + url + '&text=' + title,
    facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + url,
    pinterest: 'https://pinterest.com/pin/create/button/?url=' + url + '&description=' + title,
  };
  if (platform === 'copy') {
    navigator.clipboard.writeText(window.location.href).then(() => {
      const btn = document.querySelector('[data-share="copy"]');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    });
    return;
  }
  if (urls[platform]) {
    window.open(urls[platform], '_blank', 'width=600,height=400,noopener');
  }
}

// ── Back to top ───────────────────────────────────────────────────────────────
const backToTop = document.getElementById('back-to-top');
if (backToTop) {
  window.addEventListener('scroll', () => {
    backToTop.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ── Affiliate click tracking (GA4 affiliate_click event) ─────────────────────
// Fires on every outbound Amazon / buy link.
// GA4 Measurement ID is configured in the gtag snippet in each page <head>.
document.querySelectorAll('a[href*="amazon"], a.btn-amazon, a[data-affiliate]').forEach(link => {
  link.addEventListener('click', () => {
    // Resolve product name: prefer data-product on parent box, then link text
    const productBox = link.closest('[data-product]');
    const productName = productBox?.dataset.product
      || link.dataset.product
      || link.textContent.trim().replace(/[\u2197\u2192\u00bb]+/g, '').trim()
      || 'unknown';

    const destination = link.href || '';

    // GA4 custom event
    if (typeof gtag === 'function') {
      gtag('event', 'affiliate_click', {
        product:     productName,
        destination: destination,
        page:        window.location.pathname,
      });
    }
  });
});
