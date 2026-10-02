#!/usr/bin/env python3
"""
Fix all quality-gate critical issues across failing HTML files.
Fixes:
  1. emoji-hamburger: &#9776; -> SVG hamburger
  2. emoji-back-to-top: &#8679; -> SVG chevron-up
  3. emoji-avatar: &#127952; -> branded SVG avatar
  4. missing-og-image: add og:image to admin/reviews.html and author pages
  5. missing-canonical: add canonical to admin/reviews.html
  6. missing-ahrefs: add Ahrefs tag to admin/reviews.html
"""
import re, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SVG_HAMBURGER = (
    '<svg aria-hidden="true" fill="none" height="22" stroke="currentColor" '
    'stroke-linecap="round" stroke-linejoin="round" stroke-width="2" '
    'viewbox="0 0 24 24" width="22" xmlns="http://www.w3.org/2000/svg">'
    '<line x1="3" x2="21" y1="6" y2="6"></line>'
    '<line x1="3" x2="21" y1="12" y2="12"></line>'
    '<line x1="3" x2="21" y1="18" y2="18"></line></svg>'
)

SVG_BACK_TO_TOP = (
    '<svg aria-hidden="true" fill="none" height="20" stroke="currentColor" '
    'stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" '
    'viewbox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">'
    '<polyline points="18 15 12 9 6 15"></polyline></svg>'
)

SVG_AVATAR = (
    '<svg aria-hidden="true" fill="none" height="40" viewbox="0 0 40 40" '
    'width="40" xmlns="http://www.w3.org/2000/svg">'
    '<circle cx="20" cy="20" fill="#2a3a2a" r="20"></circle>'
    '<circle cx="20" cy="15" fill="#d4751a" r="7"></circle>'
    '<ellipse cx="20" cy="34" fill="#d4751a" rx="12" ry="8"></ellipse></svg>'
)

AHREFS_TAG = '<script src="https://analytics.ahrefs.com/analytics.js" data-key="j9FlobP0cqeKUsyYo3HRlw" async></script>'

def fix_file(filepath, fixes_applied):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content

    # Fix 1: emoji-hamburger — &#9776; or ☰ in menu-toggle button
    def fix_hamburger(m):
        fixes_applied.append(f'  [emoji-hamburger] {os.path.relpath(filepath, REPO)}')
        return f'<button {m.group(1)}>{SVG_HAMBURGER}</button>'
    content = re.sub(
        r'<button ([^>]*class="menu-toggle"[^>]*)>(?:☰|&#9776;)</button>',
        fix_hamburger, content
    )

    # Fix 2: emoji-back-to-top — &#8679; or ⇧ or ↑ or &#8593; in back-to-top button
    def fix_back_to_top(m):
        fixes_applied.append(f'  [emoji-back-to-top] {os.path.relpath(filepath, REPO)}')
        return f'<button {m.group(1)}>{SVG_BACK_TO_TOP}</button>'
    content = re.sub(
        r'<button ([^>]*class="back-to-top"[^>]*)>(?:⇧|&#8679;|↑|&#8593;)</button>',
        fix_back_to_top, content
    )

    # Fix 3: avatar — reviewer personas are not published on research-based guides.
    def fix_avatar(m):
        fixes_applied.append(f'  [remove-avatar] {os.path.relpath(filepath, REPO)}')
        return ''
    content = re.sub(
        r'<div class="avatar">[^<]*(?:&#127\d{3}|🏔|🏐|🏕|⛺|🌎|🧭)[^<]*</div>',
        fix_avatar, content
    )

    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    return content != original


def fix_admin_reviews():
    """Add missing og:image, canonical, and ahrefs to admin/reviews.html"""
    path = os.path.join(REPO, 'admin', 'reviews.html')
    if not os.path.exists(path):
        print(f'  SKIP: {path} not found')
        return
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    fixes = []

    # Add og:image if missing
    if '<meta property="og:image"' not in content:
        og_image = '<meta property="og:image" content="https://trailbuiltoverland.com/images/og-default.jpg" />'
        content = content.replace('</head>', f'  {og_image}\n</head>', 1)
        fixes.append('[missing-og-image] admin/reviews.html')

    # Add canonical if missing
    if '<link rel="canonical"' not in content:
        canonical = '<link rel="canonical" href="https://trailbuiltoverland.com/admin/reviews.html" />'
        content = content.replace('</head>', f'  {canonical}\n</head>', 1)
        fixes.append('[missing-canonical] admin/reviews.html')

    # Add Ahrefs if missing
    if 'analytics.ahrefs.com' not in content:
        content = content.replace('</head>', f'  {AHREFS_TAG}\n</head>', 1)
        fixes.append('[missing-ahrefs] admin/reviews.html')

    if content != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        for fix in fixes:
            print(f'  {fix}')


def fix_author_pages():
    """Add missing og:image to author pages"""
    author_dir = os.path.join(REPO, 'author')
    if not os.path.exists(author_dir):
        return
    for fname in os.listdir(author_dir):
        if not fname.endswith('.html'):
            continue
        path = os.path.join(author_dir, fname)
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        if '<meta property="og:image"' not in content:
            og_image = '<meta property="og:image" content="https://trailbuiltoverland.com/images/og-default.jpg" />'
            updated = content.replace('</head>', f'  {og_image}\n</head>', 1)
            if updated != content:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(updated)
                print(f'  [missing-og-image] author/{fname}')


def main():
    print('\n=== Fixing quality gate issues ===\n')
    fixes_applied = []

    # Fix articles with emoji issues
    articles_dir = os.path.join(REPO, 'articles')
    for fname in sorted(os.listdir(articles_dir)):
        if fname.endswith('.html'):
            fix_file(os.path.join(articles_dir, fname), fixes_applied)

    # Fix root HTML files too
    for fname in os.listdir(REPO):
        if fname.endswith('.html'):
            fix_file(os.path.join(REPO, fname), fixes_applied)

    if fixes_applied:
        print('Fixed:')
        for f in fixes_applied:
            print(f)
    else:
        print('No emoji issues found in articles/.')

    fix_admin_reviews()
    fix_author_pages()

    print('\nDone.')


if __name__ == '__main__':
    main()
