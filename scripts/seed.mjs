#!/usr/bin/env node
/**
 * Seed a realistic demo catalogue.
 *
 * This exists so the site is inspectable and demo-able the moment it deploys,
 * before any real merchant feed is connected. Everything is generated from a
 * fixed seed, so runs are reproducible.
 *
 * Images point at the Worker's own /ph placeholder renderer rather than
 * hotlinking stock photography we have no licence for. Real catalogues arrive
 * via merchant feeds with real image URLs.
 *
 * Brands here are invented for demo purposes and marked `demo` in style_tags.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const remote = process.argv.includes('--remote');
const DB = 'learnfrench-staging-db';
const flag = remote ? '--remote' : '--local';

// ---------------------------------------------------------------- prng

let seedState = 0x2f6e2b1;
function rnd() {
  seedState ^= seedState << 13;
  seedState ^= seedState >>> 17;
  seedState ^= seedState << 5;
  seedState >>>= 0;
  return seedState / 0xffffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickN = (arr, n) => {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};
const intBetween = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---------------------------------------------------------------- data

const BRANDS = [
  ['Kaanchi', 'Jaipur', 'mid', ['traditional', 'handloom', 'romantic']],
  ['Loom & Lore', 'Bengaluru', 'mid', ['minimal', 'sustainable', 'flowy']],
  ['Neel Studio', 'Mumbai', 'premium', ['quiet-luxury', 'structured', 'minimal']],
  ['Tarkashi', 'Lucknow', 'premium', ['traditional', 'romantic']],
  ['Sadhya', 'Chennai', 'mid', ['handloom', 'traditional', 'sustainable']],
  ['Bhoomi Label', 'Ahmedabad', 'value', ['sustainable', 'minimal']],
  ['Ochre & Oat', 'Bengaluru', 'mid', ['minimal', 'quiet-luxury']],
  ['Marigold Co', 'New Delhi', 'mid', ['romantic', 'boho']],
  ['Saanjh', 'Kolkata', 'mid', ['handloom', 'flowy']],
  ['Rumi Threads', 'Hyderabad', 'value', ['contemporary', 'oversized']],
  ['Indigo Vale', 'Pune', 'mid', ['minimal', 'vintage']],
  ['Pashmi', 'Srinagar', 'luxury', ['traditional', 'quiet-luxury']],
  ['Aarohi', 'Jaipur', 'premium', ['traditional', 'romantic']],
  ['Terra Wear', 'Panaji', 'value', ['boho', 'flowy', 'breathable']],
  ['Nira Basics', 'Bengaluru', 'value', ['minimal', 'fitted']],
  ['The Kora Co', 'Coimbatore', 'mid', ['handloom', 'sustainable', 'breathable']],
  ['Mulberry Lane', 'Mumbai', 'premium', ['romantic', 'coquette']],
  ['Suti Studio', 'Bhopal', 'value', ['breathable', 'minimal']],
  ['Anvi Atelier', 'New Delhi', 'luxury', ['structured', 'quiet-luxury']],
  ['Vann', 'Mumbai', 'mid', ['streetwear', 'oversized', 'edgy']],
  ['Kalaa Kriti', 'Varanasi', 'premium', ['traditional', 'handloom']],
  ['Sole & Sand', 'Panaji', 'mid', ['boho', 'minimal']],
  ['Juttee', 'Amritsar', 'value', ['traditional', 'indo-western']],
  ['Bagh', 'Jaipur', 'mid', ['boho', 'vintage']],
  ['Zariya Jewels', 'Jaipur', 'mid', ['traditional', 'romantic']],
  ['Shorehouse', 'Kochi', 'mid', ['breathable', 'flowy', 'vintage']],
];

/** category → [subcategory descriptors, materials, occasions, price band (rupees)] */
const CATALOG = {
  dresses: [['Midi', 'Maxi', 'Wrap', 'Slip', 'Tiered', 'A-line', 'Shirt'], ['cotton', 'linen', 'rayon', 'satin', 'chiffon', 'georgette'], ['brunch', 'date-night', 'party', 'vacation', 'casual'], [1290, 6900]],
  tops: [['Crop', 'Peplum', 'Wrap', 'Puff-sleeve', 'Halter', 'Corset'], ['cotton', 'linen', 'satin', 'rayon', 'knit'], ['casual', 'work', 'brunch', 'party'], [690, 2900]],
  shirts: [['Oversized', 'Boxy', 'Classic', 'Camp-collar', 'Striped'], ['cotton', 'linen', 'rayon'], ['work', 'casual', 'travel'], [990, 3400]],
  tshirts: [['Relaxed', 'Boxy', 'Graphic', 'Ribbed', 'Oversized'], ['cotton', 'knit'], ['casual', 'college', 'lounge'], [490, 1800]],
  kurtas: [['Chikankari', 'Block-print', 'Straight', 'Anarkali', 'Angrakha'], ['cotton', 'muslin', 'chanderi', 'khadi', 'silk'], ['festive', 'work', 'casual', 'wedding'], [890, 5400]],
  'kurta-sets': [['Chikankari', 'Block-print', 'Anarkali', 'Straight-cut', 'Angrakha'], ['cotton', 'muslin', 'chanderi', 'silk'], ['festive', 'wedding', 'mehendi', 'work'], [1890, 12900]],
  sarees: [['Organza', 'Linen', 'Tussar', 'Banarasi', 'Chanderi', 'Kota'], ['silk', 'linen', 'organza', 'chanderi', 'cotton'], ['wedding', 'festive', 'reception', 'sangeet'], [2490, 34000]],
  lehengas: [['Hand-embroidered', 'Mirror-work', 'Sequin', 'Raw-silk', 'Organza'], ['silk', 'organza', 'velvet', 'tulle'], ['wedding', 'sangeet', 'reception', 'mehendi'], [8900, 74000]],
  'co-ord-sets': [['Linen', 'Cotton', 'Satin', 'Printed', 'Textured'], ['linen', 'cotton', 'satin', 'rayon'], ['vacation', 'brunch', 'travel', 'casual'], [1490, 6400]],
  jumpsuits: [['Wide-leg', 'Utility', 'Halter', 'Belted'], ['cotton', 'linen', 'rayon'], ['brunch', 'party', 'travel'], [1690, 5400]],
  skirts: [['Midi', 'Pleated', 'Wrap', 'Tiered', 'Pencil'], ['cotton', 'linen', 'satin', 'georgette'], ['work', 'brunch', 'party'], [990, 3900]],
  trousers: [['Wide-leg', 'Straight', 'Pleated', 'Palazzo', 'Tapered'], ['cotton', 'linen', 'crepe', 'rayon'], ['work', 'casual', 'travel'], [1190, 4400]],
  jeans: [['Straight', 'Mom', 'Wide-leg', 'High-rise', 'Barrel'], ['denim'], ['casual', 'college'], [1490, 4900]],
  shorts: [['Linen', 'Denim', 'Pleated', 'Bermuda'], ['linen', 'cotton', 'denim'], ['vacation', 'casual', 'lounge'], [690, 2400]],
  blazers: [['Oversized', 'Single-breasted', 'Cropped', 'Linen'], ['linen', 'crepe', 'wool'], ['work', 'party', 'cocktail'], [2490, 9400]],
  jackets: [['Denim', 'Quilted', 'Bomber', 'Overshirt'], ['denim', 'cotton', 'wool'], ['casual', 'winter', 'travel'], [1890, 7400]],
  sweaters: [['Cable-knit', 'Ribbed', 'Cardigan', 'Merino'], ['wool', 'knit', 'cashmere'], ['winter', 'casual', 'work'], [1690, 8900]],
  sweatshirts: [['Oversized', 'Cropped', 'Hoodie', 'Half-zip'], ['cotton', 'knit'], ['casual', 'college', 'lounge'], [990, 3400]],
  loungewear: [['Cotton', 'Muslin', 'Satin', 'Ribbed'], ['cotton', 'muslin', 'satin', 'knit'], ['lounge', 'casual'], [890, 3400]],
  activewear: [['High-rise', 'Seamless', 'Compression', 'Flared'], ['spandex', 'polyester', 'knit'], ['gym', 'casual'], [890, 3200]],
  heels: [['Kitten', 'Block', 'Stiletto', 'Slingback', 'Wedge'], ['leather', 'faux-leather', 'satin'], ['party', 'work', 'wedding', 'cocktail'], [1490, 6900]],
  flats: [['Ballet', 'Loafer', 'Mojari', 'Kolhapuri', 'Mule'], ['leather', 'faux-leather'], ['casual', 'work', 'festive'], [990, 4400]],
  sandals: [['Strappy', 'Slide', 'Braided', 'Platform'], ['leather', 'faux-leather'], ['vacation', 'casual', 'brunch'], [790, 3400]],
  sneakers: [['Canvas', 'Chunky', 'Retro', 'Minimal'], ['leather', 'cotton'], ['casual', 'college', 'travel'], [1490, 5900]],
  bags: [['Tote', 'Sling', 'Crossbody', 'Baguette', 'Bucket'], ['leather', 'faux-leather', 'cotton'], ['work', 'casual', 'travel'], [1190, 8900]],
  clutches: [['Potli', 'Beaded', 'Box', 'Envelope'], ['satin', 'velvet', 'silk'], ['wedding', 'party', 'cocktail', 'reception'], [1290, 6400]],
  jewellery: [['Jhumka', 'Choker', 'Hoop', 'Stud', 'Layered'], ['gold', 'silver'], ['festive', 'wedding', 'party', 'casual'], [590, 5900]],
  scarves: [['Pashmina', 'Cotton', 'Printed', 'Silk'], ['cashmere', 'cotton', 'silk'], ['winter', 'travel', 'festive'], [890, 12900]],
};

const COLORS = ['black', 'white', 'ivory', 'beige', 'brown', 'tan', 'grey', 'charcoal', 'navy', 'blue', 'teal', 'green', 'olive', 'sage', 'emerald', 'yellow', 'mustard', 'rust', 'peach', 'coral', 'red', 'maroon', 'burgundy', 'pink', 'blush', 'fuchsia', 'purple', 'lavender'];

const PATTERNS = ['Solid', 'Block-printed', 'Floral', 'Striped', 'Checked', 'Embroidered', 'Hand-painted', 'Textured', 'Ikat', 'Bandhani'];

const TIER_MULTIPLIER = { value: 0.72, mid: 1, premium: 1.5, luxury: 2.4 };
const ALPHA_SIZES = ['xs', 's', 'm', 'l', 'xl', 'xxl'];
const SHOE_SIZES = ['36', '37', '38', '39', '40', '41'];
const FOOTWEAR = new Set(['heels', 'flats', 'sandals', 'sneakers']);
const ACCESSORY = new Set(['bags', 'clutches', 'jewellery', 'scarves']);

// ---------------------------------------------------------------- helpers

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const jsonq = (v) => q(JSON.stringify(v));

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

let idCounter = 0;
function makeId(prefix) {
  idCounter++;
  // Deterministic, and short enough for the 24-byte vector index id field.
  return `${prefix}_${idCounter.toString(36).padStart(6, '0')}s${Math.floor(rnd() * 1e6).toString(36)}`;
}

const now = Date.now();
const DAY = 86_400_000;

// ---------------------------------------------------------------- generate

const statements = [];
const products = [];

for (const [name, city, tier, styleTags] of BRANDS) {
  const brandId = makeId('b');
  const slug = slugify(name);
  const domain = `${slug.replace(/-/g, '')}.example.in`;
  const createdAt = now - intBetween(40, 900) * DAY;

  // Footwear/accessory houses only carry their own categories.
  let categories;
  if (name === 'Sole & Sand' || name === 'Juttee') categories = ['heels', 'flats', 'sandals', 'sneakers'];
  else if (name === 'Bagh') categories = ['bags', 'clutches'];
  else if (name === 'Zariya Jewels') categories = ['jewellery'];
  else if (name === 'Pashmi') categories = ['scarves', 'sweaters', 'kurtas'];
  else categories = pickN(Object.keys(CATALOG).filter((c) => !FOOTWEAR.has(c) && !ACCESSORY.has(c)), intBetween(4, 7));

  statements.push(
    `INSERT OR IGNORE INTO vestiq_brands (id, slug, name, domain, description, city, country, price_tier, style_tags, trust_score, ship_days, return_days, has_return_policy, affiliate_rate_bp, product_count, status, created_at, updated_at) VALUES (${[
      q(brandId),
      q(slug),
      q(name),
      q(domain),
      q(`${name} is an independent label from ${city} making ${styleTags.slice(0, 2).join(', ')} pieces in small batches.`),
      q(city),
      q('IN'),
      q(tier),
      jsonq([...styleTags, 'demo']),
      intBetween(52, 92),
      intBetween(2, 9),
      intBetween(7, 30),
      rnd() > 0.15 ? 1 : 0,
      intBetween(700, 1500),
      0,
      q('active'),
      createdAt,
      now,
    ].join(',')});`,
  );

  const productCount = intBetween(28, 62);
  for (let i = 0; i < productCount; i++) {
    const category = pick(categories);
    const [descriptors, materials, occasions, [lo, hi]] = CATALOG[category];

    const descriptor = pick(descriptors);
    const pattern = pick(PATTERNS);
    const color = pick(COLORS);
    const material = pick(materials);
    const extraMaterials = rnd() > 0.7 ? [pick(materials)] : [];

    const catWord = category
      .replace(/-/g, ' ')
      .replace(/s$/, '')
      .replace(/\b\w/g, (m) => m.toUpperCase());

    const title = `${pattern === 'Solid' ? '' : pattern + ' '}${descriptor} ${catWord}`.trim();
    const fullTitle = `${title} in ${color.replace(/\b\w/g, (m) => m.toUpperCase())}`;

    const mult = TIER_MULTIPLIER[tier];
    const basePrice = Math.round((lo + rnd() * (hi - lo)) * mult);
    const price = Math.round(basePrice / 10) * 10;
    const hasDiscount = rnd() > 0.55;
    const mrp = hasDiscount ? Math.round((price * (1.15 + rnd() * 0.55)) / 10) * 10 : null;

    const sizes = FOOTWEAR.has(category)
      ? pickN(SHOE_SIZES, intBetween(3, 6))
      : ACCESSORY.has(category)
        ? ['free']
        : pickN(ALPHA_SIZES, intBetween(3, 6));

    const productId = makeId('p');
    const productSlug = slugify(fullTitle);
    const firstSeen = now - intBetween(0, 120) * DAY;
    const availability = rnd() > 0.9 ? (rnd() > 0.5 ? 'low_stock' : 'out_of_stock') : 'in_stock';
    const itemOccasions = pickN(occasions, intBetween(1, 3));
    const itemStyles = pickN([...styleTags, pattern === 'Solid' ? 'minimal' : 'contemporary'], intBetween(1, 3));
    const colors = [color, ...(rnd() > 0.8 ? [pick(COLORS)] : [])];
    const image = `/ph?s=${productSlug}&w=480`;
    const rating = rnd() > 0.35 ? (3.6 + rnd() * 1.4).toFixed(1) : null;

    const description = `${fullTitle} by ${name}. ${material.replace(/\b\w/g, (m) => m.toUpperCase())} construction, ${itemStyles[0].replace(/-/g, ' ')} silhouette. Made in small batches in ${city}. Good for ${itemOccasions.join(', ')}.`;

    products.push({ id: productId, title: fullTitle, brandName: name, category, colors, materials: [material, ...extraMaterials], occasions: itemOccasions, styles: itemStyles, description });

    statements.push(
      `INSERT OR IGNORE INTO vestiq_products (id, brand_id, external_id, slug, title, description, category, subcategory, gender, price, mrp, currency, url, image_url, images, colors, sizes, materials, occasions, style_tags, attributes, availability, rating, review_count, popularity, content_hash, embed_version, last_verified_at, first_seen_at, updated_at, status) VALUES (${[
        q(productId),
        q(brandId),
        q(`demo-${productId}`),
        q(productSlug),
        q(fullTitle),
        q(description),
        q(category),
        q(descriptor.toLowerCase()),
        q(ACCESSORY.has(category) ? 'unisex' : 'women'),
        price * 100,
        mrp === null ? 'NULL' : mrp * 100,
        q('INR'),
        q(`https://${domain}/products/${productSlug}`),
        q(image),
        jsonq([image, `/ph?s=${productSlug}-2&w=480`]),
        jsonq(colors),
        jsonq(sizes),
        jsonq([material, ...extraMaterials]),
        jsonq(itemOccasions),
        jsonq(itemStyles),
        jsonq({ fit: pick(['Regular', 'Relaxed', 'Slim', 'Oversized']), care: pick(['Machine wash cold', 'Dry clean only', 'Hand wash']) }),
        q(availability),
        rating === null ? 'NULL' : rating,
        rating === null ? 0 : intBetween(3, 240),
        (rnd() * 12).toFixed(2),
        q(makeId('h').slice(2, 18)),
        0,
        now - intBetween(0, 3) * DAY,
        firstSeen,
        now,
        q('active'),
      ].join(',')});`,
    );

    statements.push(
      `INSERT INTO vestiq_price_history (product_id, price, availability, ts) VALUES (${q(productId)}, ${price * 100}, ${q(availability)}, ${firstSeen});`,
    );
    // A few products get a genuine price move so the sparkline has something real.
    if (hasDiscount && rnd() > 0.5) {
      statements.push(
        `INSERT INTO vestiq_price_history (product_id, price, availability, ts) VALUES (${q(productId)}, ${Math.round(price * 1.12) * 100}, ${q(availability)}, ${firstSeen + 10 * DAY});`,
      );
      statements.push(
        `INSERT INTO vestiq_price_history (product_id, price, availability, ts) VALUES (${q(productId)}, ${price * 100}, ${q(availability)}, ${now - 3 * DAY});`,
      );
    }
  }
}

// FTS index rows — without these the lexical arm of search returns nothing.
for (const p of products) {
  const tags = [
    p.category.replace(/-/g, ' '),
    ...p.colors,
    ...p.materials,
    ...p.occasions,
    ...p.styles.map((s) => s.replace(/-/g, ' ')),
  ].join(' ');
  statements.push(
    `INSERT INTO vestiq_products_fts (product_id, title, brand_name, description, tags) VALUES (${q(p.id)}, ${q(p.title)}, ${q(p.brandName)}, ${q(p.description)}, ${q(tags)});`,
  );
}

// Brand product counts.
statements.push(
  `UPDATE vestiq_brands SET product_count = (SELECT COUNT(*) FROM vestiq_products WHERE brand_id = vestiq_brands.id AND status = 'active');`,
);

// ---------------------------------------------------------------- collections

const COLLECTIONS = [
  ['Cotton kurta sets under ₹2,500', 'Everyday ethnic', { categories: ['kurta-sets', 'kurtas'], materials: ['cotton'], price_max: 250000 }],
  ['Linen co-ords for hot weather', 'Breathe easy', { categories: ['co-ord-sets'], materials: ['linen'] }],
  ['Wedding guest, not a saree', 'For the invite that says cocktail', { categories: ['lehengas', 'kurta-sets', 'dresses'], occasions: ['wedding', 'reception'] }],
  ['Quiet luxury under ₹5,000', 'Expensive-looking, actually not', { style_tags: ['quiet-luxury', 'minimal'], price_max: 500000 }],
  ['Handloom sarees', 'Woven, not printed', { categories: ['sarees'], materials: ['cotton', 'silk', 'linen'] }],
  ['Office trousers that aren’t black', 'Workwear, reconsidered', { categories: ['trousers'], occasions: ['work'] }],
  ['Kitten heels under ₹4,000', 'Walkable heels', { categories: ['heels'], price_max: 400000 }],
  ['Goa packing list', 'Sun, salt, no ironing', { occasions: ['vacation'], materials: ['linen', 'cotton'] }],
  ['Oversized shirts', 'Borrowed-from-him energy', { categories: ['shirts'], style_tags: ['oversized'] }],
  ['Chikankari, done well', 'Lucknow craft', { categories: ['kurtas', 'kurta-sets'], materials: ['muslin', 'cotton'] }],
  ['Monsoon-proof everyday', 'Dries fast, no fuss', { occasions: ['monsoon', 'casual'] }],
  ['Mehendi outfits under ₹6,000', 'Bright, and you can dance in it', { occasions: ['mehendi', 'sangeet'], price_max: 600000 }],
  ['Slip dresses', 'One piece, done', { categories: ['dresses'], materials: ['satin'] }],
  ['Jhumkas & chokers', 'Finishing touches', { categories: ['jewellery'], occasions: ['festive', 'wedding'] }],
];

for (const [title, subtitle, filters] of COLLECTIONS) {
  const id = makeId('col');
  statements.push(
    `INSERT OR IGNORE INTO vestiq_collections (id, slug, title, subtitle, description, kind, filters, product_ids, item_count, indexable, status, created_at, updated_at) VALUES (${[
      q(id),
      q(slugify(title)),
      q(title),
      q(subtitle),
      q(`A rotating edit of ${title.toLowerCase()} from independent Indian labels, refreshed as new pieces land.`),
      q('auto'),
      jsonq(filters),
      jsonq([]),
      0,
      0,
      q('active'),
      now,
      now,
    ].join(',')});`,
  );
}

// Seed a couple of representative searches so trending/suggest aren't empty.
const DEMO_QUERIES = [
  'matching co-ord set for a Goa vacation',
  'cotton kurta set under 2500',
  'kitten heels under 4000',
  'linen shirt for summer',
  'wedding guest outfit not a saree',
  'oversized shirt',
  'quiet luxury under 5000',
  'handloom saree',
];
for (const [i, query] of DEMO_QUERIES.entries()) {
  statements.push(
    `INSERT OR IGNORE INTO vestiq_searches (id, query_hash, query_raw, parse, intent, result_count, latency_ms, provider, ts) VALUES (${[
      q(makeId('s')),
      q(`demoseed${i}`),
      q(query),
      q('{}'),
      q('mood'),
      intBetween(18, 240),
      intBetween(60, 400),
      q('seed'),
      now - intBetween(1, 6) * DAY,
    ].join(',')});`,
  );
}

// ---------------------------------------------------------------- execute

console.log(
  `Generated ${BRANDS.length} brands, ${products.length} products, ${COLLECTIONS.length} collections (${statements.length} statements).`,
);

const dir = mkdtempSync(join(tmpdir(), 'vestiq-seed-'));
const CHUNK = 400; // keep each --file well inside D1's request size limit
const chunks = [];
for (let i = 0; i < statements.length; i += CHUNK) {
  chunks.push(statements.slice(i, i + CHUNK));
}

console.log(`Applying in ${chunks.length} batches to ${DB} (${remote ? 'remote' : 'local'})…`);

for (const [i, chunkStatements] of chunks.entries()) {
  const file = join(dir, `seed-${i}.sql`);
  writeFileSync(file, chunkStatements.join('\n'));
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB, flag, '--file', file, '-y'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '41ed7bc118fad2779267d4e61988f423',
      },
    });
    process.stdout.write(`\r  batch ${i + 1}/${chunks.length}`);
  } catch (err) {
    console.error(`\n✗ batch ${i + 1} failed:\n${(err.stderr ?? String(err)).slice(0, 1500)}`);
    process.exit(1);
  }
}

console.log(`\n✓ Seed complete. Next: npm run embed (builds the semantic index).`);
