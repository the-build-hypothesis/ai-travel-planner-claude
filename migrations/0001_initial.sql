-- AI Travel Planner — initial schema.
-- Conventions: all timestamps are INTEGER milliseconds since the Unix epoch (UTC).
-- IDs are random UUIDs (TEXT). Secrets/tokens are only ever stored as SHA-256 hashes.

-- ───────────────────────── Application users ─────────────────────────
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  email_verified_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  password_changed_at INTEGER
);
CREATE INDEX idx_users_created ON users(created_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Guests: the browser holds a random 256-bit token in an HttpOnly cookie;
-- only its hash is stored. claimed_by_user_id is set when a guest's trips were
-- migrated to an account.
CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  claimed_by_user_id TEXT,
  claimed_at INTEGER
);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);

-- ───────────────────────── Trips & conversation ─────────────────────────
-- Exactly one owner: user_id OR guest_id.
CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  destination TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',   -- JSON TripPreferences
  itinerary TEXT,                           -- JSON Itinerary (validated)
  itinerary_version INTEGER NOT NULL DEFAULT 0,
  day_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((user_id IS NOT NULL AND guest_id IS NULL) OR (user_id IS NULL AND guest_id IS NOT NULL))
);
CREATE INDEX idx_trips_user ON trips(user_id, updated_at);
CREATE INDEX idx_trips_guest ON trips(guest_id, updated_at);
CREATE INDEX idx_trips_created ON trips(created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  meta TEXT,               -- JSON: e.g. { changedDays: [3], kind: 'ask' }
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_trip ON messages(trip_id, created_at);

-- ───────────────────────── Usage & cost accounting ─────────────────────────
-- Deliberately no foreign keys: usage history is retained after users/trips
-- are deleted (see README "User deletion").
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  provider TEXT NOT NULL,             -- 'openai' | 'google_places'
  model TEXT,                         -- LLM model id or Places SKU
  endpoint TEXT NOT NULL,             -- e.g. 'chat.completions', 'places:searchText'
  operation TEXT NOT NULL,            -- e.g. 'trip_chat', 'place_enrich', 'place_search'
  user_id TEXT,
  guest_id TEXT,
  trip_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  http_status INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  units INTEGER NOT NULL DEFAULT 0,   -- billable requests/units
  cost_usd REAL,                      -- NULL when pricing unknown
  currency TEXT NOT NULL DEFAULT 'USD',
  pricing_version TEXT,
  pricing_detail TEXT,                -- JSON snapshot of the rates applied
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX idx_usage_created ON usage_events(created_at);
CREATE INDEX idx_usage_user ON usage_events(user_id, created_at);
CREATE INDEX idx_usage_guest ON usage_events(guest_id, created_at);
CREATE INDEX idx_usage_trip ON usage_events(trip_id);

-- Configurable pricing assumptions. Each usage event snapshots the rates used,
-- so editing this table never rewrites historical costs.
CREATE TABLE pricing_rules (
  id TEXT PRIMARY KEY,                -- e.g. 'openai:gpt-4o-mini'
  provider TEXT NOT NULL,
  item TEXT NOT NULL,                 -- model id or SKU
  description TEXT,
  input_per_mtok REAL,
  cached_input_per_mtok REAL,
  output_per_mtok REAL,
  per_1000_requests REAL,
  version TEXT NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

INSERT INTO pricing_rules (id, provider, item, description, input_per_mtok, cached_input_per_mtok, output_per_mtok, per_1000_requests, version, source, updated_at, updated_by) VALUES
 ('openai:gpt-4o-mini', 'openai', 'gpt-4o-mini', 'GPT-4o mini', 0.15, 0.075, 0.60, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-4o', 'openai', 'gpt-4o', 'GPT-4o', 2.50, 1.25, 10.00, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-4.1', 'openai', 'gpt-4.1', 'GPT-4.1', 2.00, 0.50, 8.00, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-4.1-mini', 'openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 0.40, 0.10, 1.60, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-4.1-nano', 'openai', 'gpt-4.1-nano', 'GPT-4.1 nano', 0.10, 0.025, 0.40, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-5', 'openai', 'gpt-5', 'GPT-5', 1.25, 0.125, 10.00, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-5-mini', 'openai', 'gpt-5-mini', 'GPT-5 mini', 0.25, 0.025, 2.00, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('openai:gpt-5-nano', 'openai', 'gpt-5-nano', 'GPT-5 nano', 0.05, 0.005, 0.40, NULL, '2026-11-04.1', 'OpenAI public API pricing (standard tier), captured at build time', 1762214400000, 'migration'),
 ('google_places:text_search_enterprise', 'google_places', 'text_search_enterprise', 'Places API (New) Text Search — Enterprise SKU (field mask includes rating/opening hours)', NULL, NULL, NULL, 35.00, '2026-11-04.1', 'Google Maps Platform list price per 1,000 requests, before monthly free usage caps', 1762214400000, 'migration');

-- ───────────────────────── Operational monitoring ─────────────────────────
CREATE TABLE app_errors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  method TEXT,
  path TEXT,
  status INTEGER,
  code TEXT,
  message TEXT
);
CREATE INDEX idx_app_errors_created ON app_errors(created_at);

-- Fixed-window rate limiter counters.
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- Cache of Google Places lookups (reduces billable requests).
CREATE TABLE places_cache (
  query_hash TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);

-- ───────────────────────── Administrative identity (separate) ─────────────────────────
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT,
  last_login_at INTEGER,
  password_changed_at INTEGER
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

-- Append-only audit log. No UPDATE/DELETE path exists in the application;
-- triggers additionally reject modification.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  admin_id TEXT,
  admin_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Bootstrap administrator (spec §5.2): username 'admin', initial password 'admin',
-- stored only as a PBKDF2-SHA256 hash, flagged must_change_password. Created once by
-- this migration; never recreated by application code.
INSERT INTO admins (id, username, username_normalized, password_hash, must_change_password, status, created_at, updated_at, created_by)
VALUES ('00000000-0000-4000-8000-000000000001', 'admin', 'admin',
        'pbkdf2-sha256$100000$c70UI-pnWT5gWTq8jULz6g$ykr-lbySteKW2xoh09Kuu-lzp3d9zZ5_STAuyAlyS1U',
        1, 'active', 1762214400000, 1762214400000, 'bootstrap-migration');
