#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  loadHeroLibrary,
  loadUsedHeroImageKeys,
  heroImageKey,
  selectHeroImage,
} = require('./generate-article');

const library = loadHeroLibrary();
const rawLibrary = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hero-images.json'), 'utf8'));
const used = loadUsedHeroImageKeys();
assert.strictEqual(Object.keys(library).length, 11, 'expected eleven curated hero categories');
const exhaustedCategories = [];
const lowCapacityCategories = [];
for (const [name, category] of Object.entries(library)) {
  assert(category.images.length >= 3 && category.images.length <= 6, `${name} must provide 3–6 reviewed candidates`);
  assert(category.images.every(url => url.startsWith('https://images.pexels.com/')), `${name} contains a non-Pexels URL`);
  const unused = category.images.filter(url => !used.has(heroImageKey(url)));
  if (unused.length === 0) exhaustedCategories.push(name);
  if (unused.length < 2) lowCapacityCategories.push(`${name} (${unused.length})`);
  for (const addition of rawLibrary.categories[name].reviewed_additions || []) {
    assert(category.images.includes(addition.image_url), `${name} provenance image is missing from candidates`);
    assert(/^https:\/\/www\.pexels\.com\/photo\//.test(addition.source_page_url), `${name} provenance source must be a Pexels photo page`);
    assert(typeof addition.photographer === 'string' && addition.photographer.trim(), `${name} provenance photographer is required`);
  }
}

if (lowCapacityCategories.length) {
  console.warn(`WARNING hero library low unused capacity: ${lowCapacityCategories.join(', ')}`);
}
assert.deepStrictEqual(exhaustedCategories, [], `hero library exhausted categories: ${exhaustedCategories.join(', ')}`);
const navigationFirst = selectHeroImage('best overlanding GPS and navigation devices', library, used);
const navigationSecond = selectHeroImage('best overlanding GPS and navigation devices', library, used);
assert.strictEqual(navigationFirst.category, 'navigation');
assert.deepStrictEqual(navigationFirst, navigationSecond, 'same topic must select a deterministic unused hero');
assert(!used.has(heroImageKey(navigationFirst.primary)), 'navigation primary must be unused');
assert(navigationFirst.fallbacks.every(url => !used.has(heroImageKey(url))), 'navigation fallbacks must be unused');
for (const topic of [
  'best overlanding solar power setup guide',
  'best overlanding camp kitchens',
  'best overlanding water filters and purifiers',
  'best overlanding satellite communicators',
  'best off-road tires for overlanding',
  'best overlanding cargo management systems',
  'best overlanding headlamps and lanterns',
  'unclassified expedition philosophy',
]) {
  const selection = selectHeroImage(topic, library, used);
  assert(!used.has(heroImageKey(selection.primary)), `${topic} selected an already-used hero`);
  assert(selection.fallbacks.every(url => !used.has(heroImageKey(url))), `${topic} has a used fallback`);
}
assert.strictEqual(selectHeroImage('best overlanding solar power setup guide', library, used).category, 'power-electrical');
assert.strictEqual(selectHeroImage('best overlanding camp kitchens', library, used).category, 'camp-kitchen');
assert.strictEqual(selectHeroImage('unclassified expedition philosophy', library, used).category, 'general-overlanding');
console.log(`hero library OK: ${Object.keys(library).length} categories; ${used.size} existing editorial identities excluded`);
