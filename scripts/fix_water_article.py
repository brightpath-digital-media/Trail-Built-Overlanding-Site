from pathlib import Path
import re

f = Path('/home/ubuntu/trail-built-overland/articles/best-overlanding-water-storage-and-filtration.html')
html = f.read_text()

# Fix the weak title
html = html.replace(
    '<title>Overlanding Water 2026</title>',
    '<title>Best Overlanding Water Storage &amp; Filtration Systems (2026)</title>'
)

# Add og: tags after the robots meta tag
og_block = '''  <meta property="og:title" content="Best Overlanding Water Storage &amp; Filtration Systems (2026)" />
  <meta property="og:description" content="Research-based guidance on water storage and filtration systems, including filters and tanks, for off-grid planning" />
  <meta property="og:image" content="https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=1200&auto=format&fit=crop" />
  <meta property="og:type" content="article" />'''

# Insert after robots meta
html = re.sub(
    r'(<meta name=["\']robots["\'][^>]+>)',
    r'\1\n' + og_block,
    html,
    count=1
)

f.write_text(html)
print("Fixed: title, og:title, og:description, og:image added to water storage article.")
