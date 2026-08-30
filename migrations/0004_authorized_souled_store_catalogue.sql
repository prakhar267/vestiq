INSERT OR IGNORE INTO vestiq_brands (
  id, slug, name, domain, description, country, price_tier, style_tags,
  trust_score, product_count, status, created_at, updated_at
) VALUES (
  'brand_souled_store',
  'the-souled-store',
  'The Souled Store',
  'thesouledstore.com',
  'Official Harry Potter fashion and accessories from The Souled Store.',
  'IN',
  'mid',
  '["streetwear","casual"]',
  50,
  0,
  'pending',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);

-- Authorized production source: the operator confirmed listing authorization
-- before this source was added. It remains private until a successful feed sync
-- is reviewed.
-- This is a non-login service identity. The random one-way hash has no retained
-- API-key preimage; catalogue operations remain under the audited admin path.
INSERT OR IGNORE INTO vestiq_merchants (
  id, brand_id, email, contact_name, api_key_hash, api_key_hint, feed_url,
  feed_type, feed_status, sync_every_min, next_sync_at, status, created_at
) VALUES (
  'merchant_souled_store_hp',
  'brand_souled_store',
  'catalogue-import+souled-store@vestiq.invalid',
  'Vestiq managed authorized import',
  '98c02f113461cf75331bace3d363a5d41b835dee3ae0f143d0758375c4702c5d',
  'sync',
  'https://www.thesouledstore.com/artists/harry-potter-official-merchandise',
  'souled_store',
  'pending',
  360,
  (CAST(strftime('%s','now') AS INTEGER) + 60) * 1000,
  'pending',
  CAST(strftime('%s','now') AS INTEGER) * 1000
);

INSERT INTO vestiq_audit_log (ts, actor, action, target, meta)
VALUES (
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  'migration:0004',
  'authorized_feed_registered',
  'brand_souled_store',
  '{"collection":"harry-potter-official-merchandise","visibility":"pending"}'
);
