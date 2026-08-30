-- Production catalogue integrity and retained shopper journeys.
--
-- 0002 removed the original `demo-*` seed, but an older catalogue generator
-- used realistic-looking ids and *.example.in destinations. Those rows survived
-- because they carried neither marker. Shopper-facing records with reserved or
-- documentation-only hosts are fixtures by definition and must never be live.

DELETE FROM vestiq_alerts
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_saves
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_reports
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_price_history
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_events
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_clicks
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_promotions
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_products_fts
WHERE product_id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_products
WHERE id IN (
  SELECT p.id FROM vestiq_products p JOIN vestiq_brands b ON b.id = p.brand_id
  WHERE lower(COALESCE(b.domain, '')) = 'example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(b.domain, '')) LIKE '%.example'
     OR lower(COALESCE(b.domain, '')) LIKE '%.test'
     OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
     OR lower(p.url) LIKE 'https://%.example.in/%'
     OR lower(p.url) LIKE 'https://%.example/%'
     OR lower(p.url) LIKE 'https://%.test/%'
     OR lower(p.url) LIKE 'https://%.invalid/%'
);

DELETE FROM vestiq_merchants
WHERE brand_id IN (
  SELECT id FROM vestiq_brands
  WHERE lower(COALESCE(domain, '')) = 'example.in'
     OR lower(COALESCE(domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(domain, '')) LIKE '%.example'
     OR lower(COALESCE(domain, '')) LIKE '%.test'
     OR lower(COALESCE(domain, '')) LIKE '%.invalid'
);

DELETE FROM vestiq_feed_runs
WHERE brand_id IN (
  SELECT id FROM vestiq_brands
  WHERE lower(COALESCE(domain, '')) = 'example.in'
     OR lower(COALESCE(domain, '')) LIKE '%.example.in'
     OR lower(COALESCE(domain, '')) LIKE '%.example'
     OR lower(COALESCE(domain, '')) LIKE '%.test'
     OR lower(COALESCE(domain, '')) LIKE '%.invalid'
);

DELETE FROM vestiq_brands
WHERE lower(COALESCE(domain, '')) = 'example.in'
   OR lower(COALESCE(domain, '')) LIKE '%.example.in'
   OR lower(COALESCE(domain, '')) LIKE '%.example'
   OR lower(COALESCE(domain, '')) LIKE '%.test'
   OR lower(COALESCE(domain, '')) LIKE '%.invalid';

UPDATE vestiq_brands
SET product_count = (
  SELECT COUNT(*) FROM vestiq_products p
  WHERE p.brand_id = vestiq_brands.id AND p.status = 'active'
), updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;

-- Anonymous and signed-in shoppers can follow brands without creating a
-- heavyweight social graph. The owner key follows the save/alert convention.
CREATE TABLE IF NOT EXISTS vestiq_brand_follows (
  id         TEXT PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  brand_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_key, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_brand_follows_owner
  ON vestiq_brand_follows(owner_key, created_at DESC);

-- Passwordless shopper accounts. Only token hashes are stored; a token is
-- single-use and expires after 20 minutes.
CREATE TABLE IF NOT EXISTS vestiq_auth_tokens (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_auth_tokens_expiry
  ON vestiq_auth_tokens(expires_at, used_at);

-- Shareable stylist/look-builder output. A share id reveals only the curated
-- product set and prompt, never the creator's session or email.
CREATE TABLE IF NOT EXISTS vestiq_looks (
  id          TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  budget      INTEGER,
  total_price INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_vestiq_looks_owner
  ON vestiq_looks(owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_look_items (
  look_id    TEXT NOT NULL,
  product_id TEXT NOT NULL,
  slot       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (look_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_look_items_look
  ON vestiq_look_items(look_id, position);

-- Rebuild (or deactivate) the KV vector index after the placeholder products
-- have been removed. The id makes this a one-time, idempotent migration job.
INSERT OR IGNORE INTO vestiq_jobs
  (id, type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
VALUES
  ('launch-integrity-reindex', 'embed', '{}', 'queued', 0, 5,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000);
