#!/usr/bin/env python3
"""
fix_site_polish.py
Fixes all emoji, broken images, broken links, and formatting inconsistencies
across the entire Trail Built Overlanding site.
"""

import re
from pathlib import Path

REPO = Path('/home/ubuntu/trail-built-overland')

# ── SVG icon definitions ──────────────────────────────────────────────────────

INSTAGRAM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>'

YOUTUBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>'

PINTEREST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>'

TWITTER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.261 5.632 5.903-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'

FACEBOOK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>'

COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'

UP_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>'

AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#2a3a2a"/><circle cx="20" cy="15" r="7" fill="#d4751a"/><ellipse cx="20" cy="34" rx="12" ry="8" fill="#d4751a"/></svg>'

# ── Unsplash images for article hero slots ────────────────────────────────────
ARTICLE_IMAGES = {
    'best-overlanding-first-aid-kit-essentials.html': {
        'url': 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=1200&q=80',
        'alt': 'Overlanding first aid kit and medical supplies laid out on a vehicle tailgate',
        'og': 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=1200&auto=format&fit=crop',
    },
    'best-overlanding-water-storage-and-filtration.html': {
        'url': 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=1200&q=80',
        'alt': 'Overlanding vehicle with water storage containers near a mountain stream',
        'og': 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=1200&auto=format&fit=crop',
    },
    'best-vehicle-communication-gear-for-overlanding.html': {
        'url': 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1200&q=80',
        'alt': 'Two-way radio and satellite communication devices for overlanding and off-road travel',
        'og': 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1200&auto=format&fit=crop',
    },
}

# ── Unsplash images for index.html card-img slots ─────────────────────────────
INDEX_CARD_IMAGES = {
    'best-overlanding-first-aid-kit-essentials.html': {
        'url': 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=600&q=80',
        'alt': 'Overlanding first aid kit essentials',
    },
    'best-overlanding-water-storage-and-filtration.html': {
        'url': 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=600&q=80',
        'alt': 'Overlanding water storage and filtration systems',
    },
    'best-vehicle-communication-gear-for-overlanding.html': {
        'url': 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80',
        'alt': 'Vehicle communication gear for overlanding',
    },
}

# ── Quiz vehicle icons (Unsplash-based vehicle images) ────────────────────────
QUIZ_VEHICLE_ICONS = {
    'truck':    ('https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=80&q=80', 'Pickup truck'),
    'suv':      ('https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=80&q=80', 'SUV 4x4'),
    'jeep':     ('https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=80&q=80', 'Jeep Wrangler'),
    'van':      ('https://images.unsplash.com/photo-1504215680853-026ed2a45def?w=80&q=80', 'Camper van'),
}

# ── Experience level icons ────────────────────────────────────────────────────
EXPERIENCE_ICONS = {
    'beginner':     ('https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=80&q=80', 'Mountain trail for beginners'),
    'intermediate': ('https://images.unsplash.com/photo-1501555088652-021faa106b9b?w=80&q=80', 'Overlanding campsite'),
    'experienced':  ('https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=80&q=80', 'Experienced overlander on rocky terrain'),
}

# ── Budget icons ──────────────────────────────────────────────────────────────
BUDGET_ICONS = {
    'budget':   ('https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=80&q=80', 'Budget overlanding gear'),
    'mid':      ('https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=80&q=80', 'Mid-range overlanding gear'),
    'premium':  ('https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=80&q=80', 'Premium overlanding gear'),
}


def fix_social_links_footer(content, is_root=True):
    """Replace emoji social links with SVG icon versions."""
    prefix = '' if is_root else '../'
    
    # Pattern for Instagram with emoji
    content = re.sub(
        r'<a[^>]*aria-label="Instagram"[^>]*>.*?Instagram</a>',
        f'<a href="https://www.instagram.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Instagram">{INSTAGRAM_SVG} Instagram</a>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<a[^>]*hint="Instagram"[^>]*>.*?Instagram</a>',
        f'<a href="https://www.instagram.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Instagram">{INSTAGRAM_SVG} Instagram</a>',
        content, flags=re.DOTALL
    )
    # YouTube
    content = re.sub(
        r'<a[^>]*aria-label="YouTube"[^>]*>.*?YouTube</a>',
        f'<a href="https://www.youtube.com/@trailbuiltoverland" rel="noopener" target="_blank" aria-label="YouTube">{YOUTUBE_SVG} YouTube</a>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<a[^>]*hint="YouTube"[^>]*>.*?YouTube</a>',
        f'<a href="https://www.youtube.com/@trailbuiltoverland" rel="noopener" target="_blank" aria-label="YouTube">{YOUTUBE_SVG} YouTube</a>',
        content, flags=re.DOTALL
    )
    # Pinterest
    content = re.sub(
        r'<a[^>]*aria-label="Pinterest"[^>]*>.*?Pinterest</a>',
        f'<a href="https://www.pinterest.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Pinterest">{PINTEREST_SVG} Pinterest</a>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<a[^>]*hint="Pinterest"[^>]*>.*?Pinterest</a>',
        f'<a href="https://www.pinterest.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Pinterest">{PINTEREST_SVG} Pinterest</a>',
        content, flags=re.DOTALL
    )
    return content


def fix_back_to_top(content):
    """Replace emoji/HTML entity back-to-top button content with SVG arrow."""
    content = re.sub(
        r'(<button[^>]*class="back-to-top"[^>]*>).*?(</button>)',
        rf'\1{UP_ARROW_SVG}\2',
        content, flags=re.DOTALL
    )
    return content


def fix_hero_tag_emoji(content):
    """Remove emoji from hero-tag and CTA buttons on homepage."""
    content = content.replace('🌎 Built by Overlanders, for Overlanders', 'Built by Overlanders, for Overlanders')
    content = content.replace('📋 Latest Reviews', 'Latest Reviews')
    content = content.replace('🛠 Build Guides', 'Build Guides')
    content = content.replace('🕐 ', '')
    return content


def fix_avatar_emoji(content):
    """Remove reviewer avatar markup from research-based editorial pages."""
    content = re.sub(
        r'<div class="avatar">[\s\S]*?</div>',
        '',
        content
    )
    return content


def fix_share_bar_emoji(content):
    """Replace emoji in share bar buttons with SVG icons."""
    # Fix Facebook share button emoji (📚 was incorrectly used)
    content = re.sub(
        r'(<a[^>]*class="share-btn share-facebook"[^>]*>).*?(</a>)',
        rf'\1{FACEBOOK_SVG} Facebook\2',
        content, flags=re.DOTALL
    )
    # Fix Pinterest share button emoji
    content = re.sub(
        r'(<a[^>]*class="share-btn share-pinterest"[^>]*>).*?(</a>)',
        rf'\1{PINTEREST_SVG} Pinterest\2',
        content, flags=re.DOTALL
    )
    # Fix copy link button — replace emoji in onclick and button text
    content = re.sub(
        r"(btn\.textContent=')[^']*(')",
        r"\1Link Copied!\2",
        content
    )
    content = re.sub(
        r'(<button[^>]*class="share-btn share-copy"[^>]*>).*?(</button>)',
        rf'\1{COPY_SVG} Copy Link\2',
        content, flags=re.DOTALL
    )
    # Fix old share-btn-twitter/facebook/pinterest pattern (original articles)
    content = re.sub(
        r'<button class="share-btn share-btn-twitter"[^>]*>.*?</button>',
        f'<button class="share-btn share-btn-twitter" onclick="shareArticle(\'twitter\')">{TWITTER_SVG} X / Twitter</button>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<button class="share-btn share-btn-facebook"[^>]*>.*?</button>',
        f'<button class="share-btn share-btn-facebook" onclick="shareArticle(\'facebook\')">{FACEBOOK_SVG} Facebook</button>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<button class="share-btn share-btn-pinterest"[^>]*>.*?</button>',
        f'<button class="share-btn share-btn-pinterest" onclick="shareArticle(\'pinterest\')">{PINTEREST_SVG} Pinterest</button>',
        content, flags=re.DOTALL
    )
    content = re.sub(
        r'<button[^>]*data-share="copy"[^>]*>.*?</button>',
        f'<button class="share-btn" data-share="copy" onclick="shareArticle(\'copy\')">{COPY_SVG} Copy Link</button>',
        content, flags=re.DOTALL
    )
    return content


def fix_article_hero_image(content, filename):
    """Replace emoji placeholder in article-img-hero with real Unsplash image."""
    if filename not in ARTICLE_IMAGES:
        return content
    img_data = ARTICLE_IMAGES[filename]
    img_tag = f'<img src="{img_data["url"]}" alt="{img_data["alt"]}" loading="lazy" decoding="async" width="1200" height="630">'
    # Replace emoji placeholder
    content = re.sub(
        r'<div class="article-img-hero">[^<]*</div>',
        f'<div class="article-img-hero">{img_tag}</div>',
        content
    )
    # Also update og:image if it's a broken URL
    if 'photo-5e3F4oU5HcU' in content or 'og:image' not in content:
        content = re.sub(
            r'<meta[^>]*property="og:image"[^>]*/?>',
            f'<meta property="og:image" content="{img_data["og"]}"/>',
            content
        )
    return content


def fix_index_card_images(content):
    """Replace 🏔 emoji in index.html card-img slots with real images."""
    for article_file, img_data in INDEX_CARD_IMAGES.items():
        # Find the card that links to this article and has an emoji card-img
        pattern = rf'(<div class="card">\s*)<div class="card-img">🏔</div>(\s*<div class="card-body">[\s\S]*?href="articles/{re.escape(article_file)}")'
        replacement = rf'\1<div class="card-img"><img src="{img_data["url"]}" alt="{img_data["alt"]}" loading="lazy" decoding="async"></div>\2'
        content = re.sub(pattern, replacement, content)
    
    # Also fix the comms article card which has a broken Unsplash URL
    content = re.sub(
        r'src="https://images\.unsplash\.com/photo-5e3F4oU5HcU[^"]*"',
        'src="https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=600&q=80"',
        content
    )
    return content


def fix_quiz_vehicle_icons(content):
    """Replace emoji vehicle icons in quiz.html with real image icons."""
    # Replace in the JS questions array
    for vehicle, (img_url, img_alt) in QUIZ_VEHICLE_ICONS.items():
        # Replace emoji icon in JS object
        content = re.sub(
            rf'(value:\s*"{vehicle}"[^}}]*icon:\s*")[^"]*(")',
            rf'\1{img_url}\2',
            content
        )
    
    # Replace experience icons
    for exp, (img_url, img_alt) in EXPERIENCE_ICONS.items():
        content = re.sub(
            rf'(value:\s*"{exp}"[^}}]*icon:\s*")[^"]*(")',
            rf'\1{img_url}\2',
            content
        )
    
    # Replace budget icons
    for budget, (img_url, img_alt) in BUDGET_ICONS.items():
        content = re.sub(
            rf'(value:\s*"{budget}"[^}}]*icon:\s*")[^"]*(")',
            rf'\1{img_url}\2',
            content
        )
    
    # Update the renderQuestion function to use <img> instead of emoji text
    # Replace: <span class="quiz-option-icon">${q.icon}</span>
    # With: <img class="quiz-option-icon" src="${q.icon}" alt="${q.label}" loading="lazy">
    content = content.replace(
        '<span class="quiz-option-icon">${q.icon}</span>',
        '<img class="quiz-option-icon" src="${q.icon}" alt="${q.label}" loading="lazy" width="64" height="64">'
    )
    
    # Also fix any remaining emoji in quiz result header
    content = re.sub(r'🛻\s*', '', content)
    content = re.sub(r'🚙\s*', '', content)
    content = re.sub(r'🚐\s*', '', content)
    content = re.sub(r'🪖\s*', '', content)
    content = re.sub(r'🌱\s*', '', content)
    content = re.sub(r'⛺\s*', '', content)
    content = re.sub(r'🏔\s*', '', content)
    
    return content


def fix_quiz_broken_links(content):
    """Fix empty href="" links in quiz result buttons."""
    # Fix "View Full Build Guide" links that have empty href
    # These should link to the build-guides.html page
    content = re.sub(
        r'href=""\s*(class="[^"]*btn[^"]*"[^>]*>[^<]*Build Guide)',
        r'href="build-guides.html" \1',
        content
    )
    content = re.sub(
        r'(class="[^"]*btn[^"]*")\s*href=""([^>]*>[^<]*Build Guide)',
        r'\1 href="build-guides.html"\2',
        content
    )
    # More general: fix any remaining empty href on buttons
    # Map result types to guide links
    guide_links = {
        'truck': 'articles/toyota-tacoma-overland-build-guide.html',
        'suv': 'articles/4runner-5th-gen-overland-build-guide.html',
        'jeep': 'articles/jeep-wrangler-overland-build-guide.html',
        'van': 'articles/ford-bronco-overland-build-guide.html',
    }
    # Fix the JS resultData guide links
    for vehicle, link in guide_links.items():
        content = re.sub(
            rf'(vehicle:\s*["\']?{vehicle}["\']?[\s\S]*?guideLink:\s*["\'])["\']',
            rf'\1{link}"',
            content
        )
    return content


def fix_menu_toggle_emoji(content):
    """Replace ☰ hamburger emoji with proper SVG hamburger icon."""
    hamburger_svg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>'
    content = content.replace('>☰<', f'>{hamburger_svg}<')
    return content


def add_social_column_if_missing(content, is_root=True):
    """Add social links column to footers that don't have one (category pages)."""
    if 'footer-social' in content:
        return content  # Already has social column
    
    social_col = f'''
      <div class="footer-social">
        <h4>Follow Us</h4>
        <div class="social-links">
          <a href="https://www.instagram.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Instagram">{INSTAGRAM_SVG} Instagram</a>
          <a href="https://www.youtube.com/@trailbuiltoverland" rel="noopener" target="_blank" aria-label="YouTube">{YOUTUBE_SVG} YouTube</a>
          <a href="https://www.pinterest.com/trailbuiltoverland" rel="noopener" target="_blank" aria-label="Pinterest">{PINTEREST_SVG} Pinterest</a>
        </div>
      </div>'''
    
    # Insert before </div> that closes footer-grid
    content = content.replace(
        '<div class="footer-bottom">',
        f'{social_col}\n    </div>\n    <div class="footer-bottom">'
    )
    # Remove the extra </div> that was already there before footer-bottom
    content = re.sub(r'</div>\s*\n\s*</div>\s*\n\s*<div class="footer-bottom">', 
                     '\n    <div class="footer-bottom">', content, count=1)
    return content


def fix_article_titles(content, filename):
    """Fix generic auto-generated article titles in index.html cards."""
    title_fixes = {
        'best-overlanding-first-aid-kit-essentials.html': (
            'Overlanding First Aid 2026',
            'Best Overlanding First Aid Kits (2026)'
        ),
        'best-overlanding-water-storage-and-filtration.html': (
            'Overlanding Water 2026',
            'Best Overlanding Water Storage &amp; Filtration (2026)'
        ),
        'best-vehicle-communication-gear-for-overlanding.html': (
            'Overlanding Comms 2026',
            'Best Overlanding Communication Gear (2026)'
        ),
    }
    for article, (old_title, new_title) in title_fixes.items():
        if article in content:
            content = content.replace(
                f'>{old_title}</a></h3>',
                f'>{new_title}</a></h3>'
            )
    return content


def process_file(filepath):
    """Apply all fixes to a single HTML file."""
    content = filepath.read_text(encoding='utf-8')
    original = content
    filename = filepath.name
    
    # Determine if this is a root-level file or in a subdirectory
    is_root = filepath.parent == REPO
    
    # Apply all fixes
    content = fix_social_links_footer(content, is_root)
    content = fix_back_to_top(content)
    content = fix_avatar_emoji(content)
    content = fix_share_bar_emoji(content)
    content = fix_menu_toggle_emoji(content)
    
    # File-specific fixes
    if filename == 'index.html':
        content = fix_hero_tag_emoji(content)
        content = fix_index_card_images(content)
        content = fix_article_titles(content, filename)
    
    if filename == 'quiz.html':
        content = fix_quiz_vehicle_icons(content)
        content = fix_quiz_broken_links(content)
    
    if filename in ARTICLE_IMAGES:
        content = fix_article_hero_image(content, filename)
    
    # Add social column to category pages that don't have it
    if filepath.parent.name == 'categories':
        content = add_social_column_if_missing(content, is_root=False)
    
    if content != original:
        filepath.write_text(content, encoding='utf-8')
        return True
    return False


def main():
    html_files = [f for f in REPO.glob('**/*.html') 
                  if '.git' not in str(f) and 'email-templates' not in str(f)]
    
    changed = []
    unchanged = []
    
    for f in sorted(html_files):
        if process_file(f):
            changed.append(f.relative_to(REPO))
        else:
            unchanged.append(f.relative_to(REPO))
    
    print(f"\n✅ Fixed {len(changed)} files:")
    for f in changed:
        print(f"   {f}")
    
    print(f"\n⏭  Unchanged {len(unchanged)} files:")
    for f in unchanged:
        print(f"   {f}")


if __name__ == '__main__':
    main()
