-- Isolated Playwright-only catalogue. This file is loaded into
-- .wrangler/playwright-state and is never used by development or production.

INSERT INTO vestiq_brands (
  id, slug, name, domain, description, city, country, price_tier, style_tags,
  trust_score, ship_days, return_days, has_return_policy, affiliate_rate_bp,
  product_count, status, created_at, updated_at
) VALUES
  ('bqa1', 'qa-kora', 'QA Kora', 'qa-kora.example', 'Playwright fixture brand.',
   'Jaipur', 'IN', 'mid', '["minimal"]', 88, 3, 14, 1, 0, 1, 'active',
   (CAST(strftime('%s','now') AS INTEGER) - 864000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('bqa2', 'qa-neel', 'QA Neel', 'qa-neel.example', 'Playwright fixture brand.',
   'Mumbai', 'IN', 'mid', '["classic"]', 82, 4, 14, 1, 0, 1, 'active',
   (CAST(strftime('%s','now') AS INTEGER) - 864000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('bqa3', 'qa-pending', 'QA Pending', 'qa-pending.example', 'Approval fixture.',
   'Delhi', 'IN', 'mid', '[]', 50, 5, 7, 1, 0, 1, 'pending',
   (CAST(strftime('%s','now') AS INTEGER) - 864000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT INTO vestiq_products (
  id, brand_id, external_id, slug, title, description, category, gender, price,
  mrp, currency, url, image_url, images, colors, sizes, materials, occasions,
  style_tags, attributes, availability, rating, review_count, popularity,
  content_hash, embed_version, last_verified_at, first_seen_at, updated_at, status
) VALUES
  ('pqa1', 'bqa1', 'qa-linen-1', 'linen-coast-co-ord-set',
   'Linen Coast Co-ord Set', 'Blue linen co-ord set for a relaxed holiday.',
   'co-ord-sets', 'women', 449900, 549900, 'INR',
   'https://qa-kora.example/products/linen-coast-co-ord-set',
   'https://images.unsplash.com/photo-1529139574466-a303027c1d8b',
   '["https://images.unsplash.com/photo-1529139574466-a303027c1d8b"]',
   '["blue"]', '["s","m","l"]', '["linen"]', '["vacation","casual"]',
   '["minimal"]', '{}', 'in_stock', 4.6, 18, 25, 'qa-hash-1', 0,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   (CAST(strftime('%s','now') AS INTEGER) - 864000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000, 'active'),
  ('pqa2', 'bqa2', 'qa-cotton-1', 'cotton-evening-dress',
   'Cotton Evening Dress', 'Black cotton dress for dinner.',
   'dresses', 'women', 299900, NULL, 'INR',
   'https://qa-neel.example/products/cotton-evening-dress',
   'https://images.unsplash.com/photo-1539109136881-3be0616acf4b',
   '["https://images.unsplash.com/photo-1539109136881-3be0616acf4b"]',
   '["black"]', '["m","l"]', '["cotton"]', '["party"]',
   '["classic"]', '{}', 'in_stock', 4.4, 9, 12, 'qa-hash-2', 0,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   (CAST(strftime('%s','now') AS INTEGER) - 432000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000, 'active'),
  ('pqa3', 'bqa3', 'qa-private-1', 'private-review-kurta',
   'Private Review Kurta', 'This item must never be public.',
   'kurtas', 'women', 199900, NULL, 'INR',
   'https://qa-pending.example/products/private-review-kurta',
   'https://images.unsplash.com/photo-1583391733956-6c78276477e2',
   '["https://images.unsplash.com/photo-1583391733956-6c78276477e2"]',
   '["green"]', '["s","m"]', '["cotton"]', '["festive"]',
   '["traditional"]', '{}', 'in_stock', NULL, 0, 0, 'qa-hash-3', 0,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   (CAST(strftime('%s','now') AS INTEGER) - 432000) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000, 'active');

INSERT INTO vestiq_products_fts (product_id, title, brand_name, description, tags)
VALUES
  ('pqa1', 'Linen Coast Co-ord Set', 'QA Kora',
   'Blue linen co-ord set for a relaxed holiday.',
   'co-ord-sets blue linen vacation casual minimal'),
  ('pqa2', 'Cotton Evening Dress', 'QA Neel',
   'Black cotton dress for dinner.',
   'dresses black cotton party classic'),
  ('pqa3', 'Private Review Kurta', 'QA Pending',
   'This item must never be public.',
   'kurtas green cotton festive traditional');
