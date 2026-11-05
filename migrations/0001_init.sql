-- AI Travel Planner initial schema. All timestamps are UTC ISO-8601 strings, which sort lexically.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  name TEXT,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  password_hash TEXT NOT NULL,
  email_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX idx_users_created ON users(created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  claimed_by_user_id TEXT,
  claimed_at TEXT
);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, purpose);

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id),
  title TEXT,
  destination TEXT,
  start_date TEXT,
  end_date TEXT,
  duration_days INTEGER,
  adults INTEGER,
  children_ages TEXT NOT NULL DEFAULT '[]',
  budget_amount REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  interests TEXT NOT NULL DEFAULT '[]',
  pace TEXT,
  constraints TEXT,
  lodging TEXT,
  dest_lat REAL,
  dest_lng REAL,
  cover_photo_name TEXT,
  cover_photo_attribution TEXT,
  itinerary TEXT NOT NULL DEFAULT '{"overview":null,"tips":[],"days":[]}',
  day_count INTEGER NOT NULL DEFAULT 0,
  busy_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((user_id IS NULL) <> (guest_id IS NULL))
);
CREATE INDEX idx_trips_user ON trips(user_id, updated_at);
CREATE INDEX idx_trips_guest ON trips(guest_id, updated_at);
CREATE INDEX idx_trips_created ON trips(created_at);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_trip ON messages(trip_id, seq);

CREATE TABLE itinerary_versions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  itinerary TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_versions_trip ON itinerary_versions(trip_id, seq);

-- Usage rows deliberately have no foreign keys: they must outlive deleted users and trips.
-- See README "User deletion".
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'places')),
  provider TEXT NOT NULL,
  model_or_endpoint TEXT NOT NULL,
  sku TEXT,
  operation TEXT NOT NULL,
  user_id TEXT,
  guest_id TEXT,
  trip_id TEXT,
  trip_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  http_status INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  billable_units REAL,
  input_cost REAL,
  cached_input_cost REAL,
  output_cost REAL,
  estimated_cost REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  pricing_version TEXT,
  pricing_snapshot TEXT,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX idx_usage_created ON usage_records(created_at);
CREATE INDEX idx_usage_kind_created ON usage_records(kind, created_at);
CREATE INDEX idx_usage_user ON usage_records(user_id, created_at);
CREATE INDEX idx_usage_guest ON usage_records(guest_id, created_at);
CREATE INDEX idx_usage_trip ON usage_records(trip_id, created_at);

-- Rows are append-only: a rate change inserts a new row, so old usage keeps its own version id.
CREATE TABLE pricing_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'places')),
  sku TEXT NOT NULL,
  input_per_million REAL,
  cached_input_per_million REAL,
  output_per_million REAL,
  per_1000_units REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_note TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX idx_pricing_sku ON pricing_rates(kind, sku, id);

INSERT INTO pricing_rates (kind, sku, input_per_million, cached_input_per_million, output_per_million, source_note, created_at, created_by)
VALUES ('llm', 'gpt-4o-mini', 0.15, 0.075, 0.60, 'OpenAI list price, standard tier, checked 2026-11-05', '2026-11-05T00:00:00.000Z', 'migration');
INSERT INTO pricing_rates (kind, sku, per_1000_units, source_note, created_at, created_by)
VALUES ('places', 'places.text_search_enterprise', 35.00, 'Google Maps Platform list price, first tier, no free-usage cap applied, checked 2026-11-05', '2026-11-05T00:00:00.000Z', 'migration');
INSERT INTO pricing_rates (kind, sku, per_1000_units, source_note, created_at, created_by)
VALUES ('places', 'places.photo', 7.00, 'Google Maps Platform list price, first tier, no free-usage cap applied, checked 2026-11-05', '2026-11-05T00:00:00.000Z', 'migration');

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES
  ('daily_cost_cap_usd', '25', '2026-11-05T00:00:00.000Z', 'migration'),
  ('guest_ai_requests_per_day', '40', '2026-11-05T00:00:00.000Z', 'migration'),
  ('user_ai_requests_per_day', '150', '2026-11-05T00:00:00.000Z', 'migration'),
  ('guest_places_requests_per_day', '120', '2026-11-05T00:00:00.000Z', 'migration'),
  ('user_places_requests_per_day', '500', '2026-11-05T00:00:00.000Z', 'migration');

CREATE TABLE place_cache (
  cache_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE api_metrics (
  bucket TEXT NOT NULL,
  route_group TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, route_group)
);

CREATE TABLE error_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  path TEXT,
  request_id TEXT
);
CREATE INDEX idx_errors_created ON error_logs(created_at);

-- Administrator identities are entirely separate from application users.
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  last_login_at TEXT
);

-- Bootstrap administrator: admin / admin, stored only as a hash and unusable until replaced.
-- This migration runs once, so a deleted bootstrap account is never recreated.
INSERT INTO admins (id, username, password_hash, status, must_change_password, created_at, updated_at, created_by)
VALUES (
  'adm_bootstrap',
  'admin',
  'scrypt$32768$8$1$vqTQJ+x1kYcYL035W//qQw==$QVjsRxGzmoMA/1JcFDh0DcaUi+2x0k9uBMZkd7YfyfI=',
  'active', 1, '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', 'migration'
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

-- actor_username is a snapshot, so audit rows survive deletion of the administrator.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  actor_admin_id TEXT,
  actor_username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  ip_hash TEXT
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
