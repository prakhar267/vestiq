-- Launch in a fully free, real-catalogue-only mode.
--
-- The original seed populated invented brands and products identified by a
-- `demo-*` external id and a `demo` brand tag. Remove every dependent row before
-- deleting those catalogue records so no saved item, alert, report, or search
-- index entry can point at content that no longer exists.

DELETE FROM vestiq_alerts
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_saves
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_reports
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_price_history
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_events
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_clicks
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_promotions
WHERE product_id IN (SELECT id FROM vestiq_products WHERE external_id LIKE 'demo-%')
   OR brand_id IN (
     SELECT id FROM vestiq_brands
     WHERE style_tags LIKE '%"demo"%'
   );

DELETE FROM vestiq_products_fts
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_products
WHERE id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE p.external_id LIKE 'demo-%' OR b.style_tags LIKE '%"demo"%'
);

DELETE FROM vestiq_brands
WHERE style_tags LIKE '%"demo"%';

DELETE FROM vestiq_collections
WHERE slug IN (
  'cotton-kurta-sets-under-2-500',
  'linen-co-ords-for-hot-weather',
  'wedding-guest-not-a-saree',
  'quiet-luxury-under-5-000',
  'handloom-sarees',
  'office-trousers-that-aren-t-black',
  'kitten-heels-under-4-000',
  'goa-packing-list',
  'oversized-shirts',
  'chikankari-done-well',
  'monsoon-proof-everyday',
  'mehendi-outfits-under-6-000',
  'slip-dresses',
  'jhumkas-chokers'
);

DELETE FROM vestiq_searches
WHERE provider = 'seed' OR query_hash LIKE 'demoseed%';

-- Remove every paid-placement and affiliate setting. Product prices remain:
-- they belong to the external brand store, not to Vestiq.
DELETE FROM vestiq_promotions;

UPDATE vestiq_brands
SET affiliate_network = NULL,
    affiliate_rate_bp = 0,
    affiliate_tmpl = NULL;

UPDATE vestiq_clicks
SET promoted = 0,
    price_at_click = NULL,
    cpc_paise = 0,
    converted = 0,
    order_value = NULL,
    commission = NULL,
    settled = 0;

DELETE FROM vestiq_flags
WHERE key IN ('ai_parse_enabled', 'vector_search_enabled', 'stylist_enabled', 'promoted_enabled');
