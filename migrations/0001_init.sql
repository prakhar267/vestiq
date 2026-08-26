-- Vestiq initial schema
-- Conventions (see docs/03-architecture.md §4):
--   * All tables prefixed `vestiq_` (ADR-9: shared D1 database).
--   * All money is INTEGER paise. Never float, never rupees.
--   * All timestamps are INTEGER epoch milliseconds, UTC.

-- Our own migration tracker so we never touch the host project's d1_migrations.
CREATE TABLE IF NOT EXISTS vestiq_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ============================================================ CATALOG

CREATE TABLE IF NOT EXISTS vestiq_brands (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  domain            TEXT,
  logo_url          TEXT,
  description       TEXT,
  city              TEXT,
  country           TEXT NOT NULL DEFAULT 'IN',
  price_tier        TEXT NOT NULL DEFAULT 'mid',      -- value|mid|premium|luxury
  style_tags        TEXT NOT NULL DEFAULT '[]',       -- JSON array
  trust_score       INTEGER NOT NULL DEFAULT 50,      -- 0..100, recomputed nightly
  ship_days         INTEGER,
  return_days       INTEGER,
  has_return_policy INTEGER NOT NULL DEFAULT 0,
  affiliate_network TEXT,
  affiliate_rate_bp INTEGER NOT NULL DEFAULT 0,       -- disabled in free-launch mode
  affiliate_tmpl    TEXT,                             -- retained for schema compatibility
  product_count     INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',   -- active|pending|suspended
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_brands_status ON vestiq_brands(status, trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_brands_created ON vestiq_brands(created_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_products (
  id              TEXT PRIMARY KEY,
  brand_id        TEXT NOT NULL REFERENCES vestiq_brands(id),
  external_id     TEXT,
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,                      -- normalised: dresses, tops, ...
  subcategory     TEXT,
  gender          TEXT NOT NULL DEFAULT 'women',      -- women|men|unisex|kids
  price           INTEGER NOT NULL,                   -- paise
  mrp             INTEGER,                            -- paise
  currency        TEXT NOT NULL DEFAULT 'INR',
  url             TEXT NOT NULL,
  image_url       TEXT,
  images          TEXT NOT NULL DEFAULT '[]',         -- JSON array
  colors          TEXT NOT NULL DEFAULT '[]',         -- JSON array of normalised colours
  sizes           TEXT NOT NULL DEFAULT '[]',         -- JSON array
  materials       TEXT NOT NULL DEFAULT '[]',         -- JSON array
  occasions       TEXT NOT NULL DEFAULT '[]',         -- JSON array
  style_tags      TEXT NOT NULL DEFAULT '[]',         -- JSON array
  attributes      TEXT NOT NULL DEFAULT '{}',         -- JSON object (fit, length, sleeve...)
  availability    TEXT NOT NULL DEFAULT 'in_stock',   -- in_stock|low_stock|out_of_stock
  rating          REAL,
  review_count    INTEGER NOT NULL DEFAULT 0,
  popularity      REAL NOT NULL DEFAULT 0,            -- decayed engagement score
  content_hash    TEXT,                               -- short-circuits unchanged upserts
  embedding       BLOB,                               -- int8 quantised, EMBED_DIM bytes
  embed_version   INTEGER NOT NULL DEFAULT 0,
  last_verified_at INTEGER,
  first_seen_at   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',     -- active|stale|hidden|dead
  UNIQUE (brand_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_live     ON vestiq_products(status, availability, price);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_cat      ON vestiq_products(category, gender, status);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_brand    ON vestiq_products(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_slug     ON vestiq_products(slug);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_new      ON vestiq_products(first_seen_at DESC, status);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_pop      ON vestiq_products(popularity DESC, status);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_embed    ON vestiq_products(embed_version, status);
CREATE INDEX IF NOT EXISTS idx_vestiq_products_verified ON vestiq_products(last_verified_at);

-- Lexical index. Managed manually (delete+insert on upsert) rather than via
-- external-content triggers, so ingestion controls sync explicitly and D1's
-- FTS5 build differences can't silently desync the index.
CREATE VIRTUAL TABLE IF NOT EXISTS vestiq_products_fts USING fts5(
  product_id UNINDEXED,
  title,
  brand_name,
  description,
  tags,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS vestiq_price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   TEXT NOT NULL,
  price        INTEGER NOT NULL,
  availability TEXT NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_ph_product ON vestiq_price_history(product_id, ts DESC);

CREATE TABLE IF NOT EXISTS vestiq_collections (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'auto',        -- auto|curated|editorial
  filters     TEXT NOT NULL DEFAULT '{}',          -- JSON SearchFilters
  product_ids TEXT NOT NULL DEFAULT '[]',          -- JSON array, curated only
  hero_image  TEXT,
  item_count  INTEGER NOT NULL DEFAULT 0,
  indexable   INTEGER NOT NULL DEFAULT 0,          -- 1 only when item_count >= 12
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_collections_live ON vestiq_collections(status, indexable);

-- ============================================================ DEMAND

CREATE TABLE IF NOT EXISTS vestiq_searches (
  id           TEXT PRIMARY KEY,
  query_hash   TEXT NOT NULL,
  query_raw    TEXT NOT NULL,
  parse        TEXT NOT NULL DEFAULT '{}',         -- JSON ParsedQuery
  intent       TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  provider     TEXT,                               -- which AI provider parsed it
  session_id   TEXT,
  user_id      TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_searches_hash ON vestiq_searches(query_hash, ts DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_searches_ts   ON vestiq_searches(ts DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_searches_zero ON vestiq_searches(result_count, ts DESC);

CREATE TABLE IF NOT EXISTS vestiq_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,                        -- impression|click|save|hop_out|bounce_back|...
  session_id TEXT,
  user_id    TEXT,
  product_id TEXT,
  brand_id   TEXT,
  query_hash TEXT,
  position   INTEGER,
  meta       TEXT NOT NULL DEFAULT '{}',
  UNIQUE (ts, type, session_id, product_id, position)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_events_ts   ON vestiq_events(ts DESC, type);
CREATE INDEX IF NOT EXISTS idx_vestiq_events_prod ON vestiq_events(product_id, type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_events_sess ON vestiq_events(session_id, ts DESC);

CREATE TABLE IF NOT EXISTS vestiq_clicks (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  product_id    TEXT NOT NULL,
  brand_id      TEXT NOT NULL,
  session_id    TEXT,
  user_id       TEXT,
  query_hash    TEXT,
  position      INTEGER,
  promoted      INTEGER NOT NULL DEFAULT 0,
  price_at_click INTEGER,
  cpc_paise     INTEGER NOT NULL DEFAULT 0,        -- charged for promoted slots
  returned_at   INTEGER,                           -- bounce-back detection
  converted     INTEGER NOT NULL DEFAULT 0,
  order_value   INTEGER,                           -- paise
  commission    INTEGER,                           -- paise
  settled       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vestiq_clicks_ts    ON vestiq_clicks(ts DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_clicks_brand ON vestiq_clicks(brand_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_vestiq_clicks_conv  ON vestiq_clicks(converted, settled, ts DESC);

CREATE TABLE IF NOT EXISTS vestiq_reports (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  reason     TEXT NOT NULL,                        -- dead_link|wrong_price|out_of_stock|spam|other
  note       TEXT,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vestiq_reports_prod ON vestiq_reports(product_id, resolved);

-- ============================================================ IDENTITY

CREATE TABLE IF NOT EXISTS vestiq_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  name          TEXT,
  taste         TEXT NOT NULL DEFAULT '{}',        -- JSON: {vector:[], tags:{}, budget:{}}
  gender_pref   TEXT,
  budget_min    INTEGER,
  budget_max    INTEGER,
  email_alerts  INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- owner_key = session id (anonymous) or "u:<user_id>" (signed in). Merged on sign-in.
CREATE TABLE IF NOT EXISTS vestiq_saves (
  id         TEXT PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  product_id TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_key, product_id)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_saves_owner ON vestiq_saves(owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_alerts (
  id            TEXT PRIMARY KEY,
  owner_key     TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,                     -- price_drop|back_in_stock
  target_price  INTEGER,                           -- paise; null = any drop
  base_price    INTEGER NOT NULL,
  email         TEXT,
  status        TEXT NOT NULL DEFAULT 'armed',     -- armed|fired|cancelled
  created_at    INTEGER NOT NULL,
  fired_at      INTEGER,
  UNIQUE (owner_key, product_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_alerts_armed ON vestiq_alerts(status, product_id);
CREATE INDEX IF NOT EXISTS idx_vestiq_alerts_owner ON vestiq_alerts(owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_saved_intents (
  id          TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL,
  label       TEXT,
  query_raw   TEXT NOT NULL,
  parse       TEXT NOT NULL DEFAULT '{}',
  email       TEXT,
  last_run_at INTEGER,
  last_count  INTEGER NOT NULL DEFAULT 0,
  seen_ids    TEXT NOT NULL DEFAULT '[]',          -- JSON array, caps at 200
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  UNIQUE (owner_key, query_raw)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_intents_active ON vestiq_saved_intents(status, last_run_at);

-- ============================================================ SUPPLY

CREATE TABLE IF NOT EXISTS vestiq_merchants (
  id           TEXT PRIMARY KEY,
  brand_id     TEXT NOT NULL REFERENCES vestiq_brands(id),
  email        TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  api_key_hash TEXT NOT NULL,                      -- sha256 hex, never the key itself
  api_key_hint TEXT,                               -- last 4 chars, for the UI
  feed_url     TEXT,
  feed_type    TEXT NOT NULL DEFAULT 'shopify',    -- shopify|gmc|csv
  feed_status  TEXT NOT NULL DEFAULT 'pending',    -- pending|healthy|failing|paused
  sync_every_min INTEGER NOT NULL DEFAULT 360,
  last_sync_at INTEGER,
  next_sync_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|suspended
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_merchants_sync ON vestiq_merchants(status, next_sync_at);
CREATE INDEX IF NOT EXISTS idx_vestiq_merchants_key  ON vestiq_merchants(api_key_hash);

CREATE TABLE IF NOT EXISTS vestiq_feed_runs (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT,
  brand_id      TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL DEFAULT 'running',   -- running|ok|partial|failed
  rows_in       INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  reject_reasons TEXT NOT NULL DEFAULT '{}',       -- JSON {reason: count}
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_vestiq_feedruns_brand ON vestiq_feed_runs(brand_id, started_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_promotions (
  id           TEXT PRIMARY KEY,
  brand_id     TEXT NOT NULL,
  product_id   TEXT,                               -- null = whole-brand campaign
  bid_paise    INTEGER NOT NULL,
  budget_paise INTEGER NOT NULL,
  spent_paise  INTEGER NOT NULL DEFAULT 0,
  targeting    TEXT NOT NULL DEFAULT '{}',         -- JSON {categories:[], keywords:[]}
  status       TEXT NOT NULL DEFAULT 'active',     -- active|paused|exhausted
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_promos_live ON vestiq_promotions(status, starts_at, ends_at);

-- ============================================================ PLATFORM

CREATE TABLE IF NOT EXISTS vestiq_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                        -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vestiq_jobs (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,                        -- feed_sync|embed|liveness|alert|...
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued|running|done|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after  INTEGER NOT NULL,
  locked_at  INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vestiq_jobs_due ON vestiq_jobs(status, run_after);

CREATE TABLE IF NOT EXISTS vestiq_audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  meta    TEXT NOT NULL DEFAULT '{}',
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_vestiq_audit_ts ON vestiq_audit_log(ts DESC);
