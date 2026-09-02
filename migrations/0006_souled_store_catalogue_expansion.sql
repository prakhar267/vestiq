-- Replace the single-fandom collection with a bounded, category-diverse
-- storefront snapshot. The adapter treats this source as partial, so products
-- that move out of the popularity window are never falsely marked sold out.

UPDATE vestiq_brands
SET description = 'Current fashion, footwear and accessories from The Souled Store.',
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE id = 'brand_souled_store';

UPDATE vestiq_merchants
SET feed_url = 'https://www.thesouledstore.com/',
    feed_status = 'pending',
    next_sync_at = 0
WHERE id = 'merchant_souled_store_hp';

INSERT INTO vestiq_audit_log (ts, actor, action, target, meta)
VALUES (
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  'migration:0006',
  'authorized_feed_expanded',
  'brand_souled_store',
  '{"scope":"popular-men-and-women","snapshot_pages_per_gender":6}'
);
