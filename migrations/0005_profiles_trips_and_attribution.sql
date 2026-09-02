-- Shopper fit intelligence, multi-day wardrobe planning, and transparent
-- affiliate attribution. All additions are backwards-compatible and keep the
-- existing organic ranking path untouched.

CREATE TABLE IF NOT EXISTS vestiq_profiles (
  owner_key  TEXT PRIMARY KEY,
  profile    TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vestiq_trips (
  id          TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL,
  title       TEXT NOT NULL,
  destination TEXT NOT NULL,
  days        INTEGER NOT NULL,
  occasions   TEXT NOT NULL DEFAULT '[]',
  budget      INTEGER NOT NULL,
  total_price INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_vestiq_trips_owner
  ON vestiq_trips(owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS vestiq_trip_looks (
  trip_id  TEXT NOT NULL,
  look_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  label    TEXT NOT NULL,
  PRIMARY KEY (trip_id, day)
);
CREATE INDEX IF NOT EXISTS idx_vestiq_trip_looks_trip
  ON vestiq_trip_looks(trip_id, day);

ALTER TABLE vestiq_clicks ADD COLUMN affiliate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vestiq_clicks ADD COLUMN affiliate_network TEXT;
