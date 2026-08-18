-- ============================================================
-- Zero Labs — COMPLETE Supabase Schema
-- ⚡ PASTE THIS ENTIRE FILE into Supabase SQL Editor and RUN IT.
-- Safe to re-run: uses IF NOT EXISTS + ON CONFLICT DO UPDATE
-- ============================================================
-- Tables:
--   system_config      — all runtime config (replaces .env)
--   kaggle_accounts    — encrypted API keys + rotation tracking
--   sessions           — lifecycle of each Kaggle kernel run
--   metrics_events     — per-request token/latency telemetry
--   account_session_log— GPU hours ledger per session
--   gateway_urls       — stable production URL registry
--
-- Views:
--   current_gateway    — live healthy gateway URLs
--   live_endpoints     — active sessions with gateway data
--   session_timing     — warmup + expiry math
--   top10_accounts     — best accounts for stealth rotation
--
-- Functions (RPC):
--   upsert_gateway_url(model, index, tunnel_url, session_id)
--   mark_gateway_unhealthy(model, index)
--   mark_stale_gateways()               → INTEGER
--   notebook_push_url(...)              → JSONB  ← called by Kaggle notebook
--   notebook_heartbeat(model, secret)   → JSONB  ← called every 5 min
--   mark_account_used(account_id)
--   increment_weekly_hours(account_id, hours)
--   get_account_hours_summary()         → TABLE
-- ============================================================


-- ── EXTENSIONS ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()


-- ── 1. system_config ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed all default values (DO UPDATE so re-running is idempotent
-- but YOUR custom values are NOT overwritten — only new keys inserted)
INSERT INTO system_config (key, value, description) VALUES
  ('KAGGLE_ACCELERATOR',              'gpuT4x2',
   'GPU type: gpuT4x2 | NvidiaTeslaT4 | NvidiaTeslaP100'),
  ('PRO_TARGET_SESSIONS',             '1',
   'How many Pro sessions to keep running simultaneously'),
  ('ULTRA_TARGET_SESSIONS',           '1',
   'How many Ultra sessions to keep running simultaneously'),
  ('PRO_MAX_CONCURRENT',              '64',
   'Max concurrent requests for Pro (2×T4 × 32 each)'),
  ('ULTRA_MAX_CONCURRENT',            '8',
   'Max concurrent requests for Ultra'),
  ('SESSION_SOFT_LIMIT_H',            '9.5',
   'Soft limit hours — fire replacement session when reached (Kaggle hard cap = 11h)'),
  ('PREFIRE_BUFFER_MIN',              '25',
   'Minutes before expiry to start a replacement session (warmup takes ~22 min)'),
  ('ACCOUNT_GPU_CAP_H',              '10',
   'Max GPU hours per account per week before it is rotated out'),
  ('PRO_WARMUP_MIN',                  '22',
   'Expected Pro notebook warm-up time in minutes'),
  ('ULTRA_WARMUP_MIN',                '10',
   'Expected Ultra vLLM warm-up time in minutes'),
  ('HF_TOKEN',                        '',
   'HuggingFace token — required for private model repos (e.g. ZEROLABS1/ornith-9b-merged-v5)'),
  ('ZERO_API_KEY',                    'auto',
   'Bearer token for notebook /v1/* endpoints. "auto" = random per session'),
  ('CRON_SECRET',                     'changeme_cron_secret_here',
   'Secret sent in X-Cron-Secret header to authorize Vercel cron calls'),
  ('PRO_KERNEL_SLUG',                 'zero-pro-server',
   'Kaggle kernel slug for the Pro notebook (must match kernel on your Kaggle account)'),
  ('ULTRA_KERNEL_SLUG',               'zero-ultra-server',
   'Kaggle kernel slug for the Ultra notebook'),
  ('NOTEBOOK_CALLBACK_SECRET',        'changeme_notebook_secret_here',
   'Secret the Kaggle notebook sends when POSTing its URL directly to Supabase'),
  ('STEALTH_MAX_SESSIONS_PER_ACCOUNT','3',
   'Max sessions per account per week before hard-rotating to a fresh account'),
  ('STEALTH_ROTATE_AFTER_HOURS',      '8',
   'Prefer a fresh account after this many hours even if current account has quota left')
ON CONFLICT (key) DO NOTHING;   -- ← never overwrites your custom values


-- ── 2. kaggle_accounts ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS kaggle_accounts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username               TEXT NOT NULL UNIQUE,
  api_key_encrypted      TEXT NOT NULL,
  api_key_iv             TEXT NOT NULL,
  api_key_tag            TEXT NOT NULL,
  label                  TEXT,
  model_assignment       TEXT DEFAULT 'both'
                         CHECK (model_assignment IN ('pro', 'ultra', 'both')),
  weekly_hours_used      FLOAT DEFAULT 0,
  weekly_hours_reset_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  rotation_count         INTEGER DEFAULT 0,   -- total sessions ever fired on this account
  last_used_at           TIMESTAMPTZ,         -- when last session was pushed
  is_active              BOOLEAN DEFAULT TRUE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns to existing installs (idempotent)
ALTER TABLE kaggle_accounts
  ADD COLUMN IF NOT EXISTS rotation_count  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at    TIMESTAMPTZ;

-- Index: fast lookup of best account to use next
CREATE INDEX IF NOT EXISTS idx_accounts_active_hours
  ON kaggle_accounts (weekly_hours_used ASC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_accounts_rotation
  ON kaggle_accounts (rotation_count ASC)
  WHERE is_active = TRUE;


-- ── 3. sessions ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE session_status AS ENUM
    ('queued', 'warming', 'ready', 'expiring', 'dead', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID REFERENCES kaggle_accounts(id) ON DELETE SET NULL,
  model            TEXT NOT NULL CHECK (model IN ('pro', 'ultra')),
  status           session_status DEFAULT 'queued',
  kernel_slug      TEXT,
  pushed_at        TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  ready_at         TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  endpoints        JSONB,          -- array of {port, tunnel_url, openai_api_url, max_concurrent}
  total_concurrent INTEGER,
  error_message    TEXT,
  raw_output       JSONB,          -- full parsed notebook output JSON
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_model_status
  ON sessions (model, status);

CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions (status)
  WHERE status IN ('warming', 'ready', 'expiring');

CREATE INDEX IF NOT EXISTS idx_sessions_account
  ON sessions (account_id)
  WHERE status IN ('queued', 'warming', 'ready', 'expiring');


-- ── 4. metrics_events ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS metrics_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model             TEXT NOT NULL,
  session_id        UUID REFERENCES sessions(id) ON DELETE SET NULL,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms        INTEGER,
  status            TEXT DEFAULT 'success'
                    CHECK (status IN ('success', 'error', 'timeout')),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_model_time
  ON metrics_events (model, created_at DESC);


-- ── 5. account_session_log ──────────────────────────────────

CREATE TABLE IF NOT EXISTS account_session_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID REFERENCES kaggle_accounts(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  hours_used  FLOAT,
  logged_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_log_account
  ON account_session_log (account_id, logged_at DESC);


-- ── 6. gateway_urls ─────────────────────────────────────────
-- Single row per (model, endpoint_index).
-- The public-facing stable API URL NEVER changes.
-- Only the underlying tunnel_url rotates when a new notebook fires.

CREATE TABLE IF NOT EXISTS gateway_urls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model             TEXT NOT NULL CHECK (model IN ('pro', 'ultra')),
  endpoint_index    INTEGER DEFAULT 0,
  tunnel_url        TEXT NOT NULL,
  openai_api_url    TEXT NOT NULL,
  api_key           TEXT,           -- Bearer token from the notebook
  session_id        UUID REFERENCES sessions(id) ON DELETE SET NULL,
  is_healthy        BOOLEAN DEFAULT TRUE,
  last_health_check TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ DEFAULT NOW(), -- updated by notebook heartbeat
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (model, endpoint_index)
);

-- Add new columns to existing installs (idempotent)
ALTER TABLE gateway_urls
  ADD COLUMN IF NOT EXISTS api_key      TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_gateway_healthy
  ON gateway_urls (model, endpoint_index)
  WHERE is_healthy = TRUE;


-- ── 7. RLS (Row Level Security) ──────────────────────────────
-- Service role key bypasses RLS automatically — app uses service role.
-- Anon/public never reaches these tables.

ALTER TABLE system_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaggle_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_session_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_urls        ENABLE ROW LEVEL SECURITY;


-- ── 8. VIEWS ────────────────────────────────────────────────

-- current_gateway: live healthy gateway rows (what the proxy uses)
CREATE OR REPLACE VIEW current_gateway AS
SELECT
  model,
  endpoint_index,
  tunnel_url,
  openai_api_url,
  api_key,
  session_id,
  is_healthy,
  last_seen_at,
  last_health_check,
  updated_at
FROM gateway_urls
WHERE is_healthy = TRUE
ORDER BY model, endpoint_index;


-- live_endpoints: active sessions joined with gateway data
CREATE OR REPLACE VIEW live_endpoints AS
SELECT
  s.model,
  s.id                                          AS session_id,
  s.account_id,
  endpoint->>'tunnel_url'                       AS tunnel_url,
  endpoint->>'openai_api_url'                   AS openai_api_url,
  (endpoint->>'port')::TEXT                     AS port,
  (endpoint->>'max_concurrent')::INTEGER        AS max_concurrent,
  s.expires_at,
  s.total_concurrent,
  -- Stable gateway info (the URL you give to users)
  gw.tunnel_url                                 AS gateway_tunnel_url,
  gw.openai_api_url                             AS gateway_api_url,
  gw.api_key                                    AS gateway_api_key,
  gw.is_healthy                                 AS gateway_healthy,
  gw.last_seen_at                               AS gateway_last_seen
FROM sessions s
CROSS JOIN LATERAL jsonb_array_elements(s.endpoints) AS endpoint
LEFT JOIN gateway_urls gw
  ON gw.model = s.model
 AND gw.endpoint_index = 0
WHERE s.status IN ('ready', 'expiring')
  AND s.endpoints IS NOT NULL;


-- session_timing: warmup and expiry math for the orchestrator dashboard
CREATE OR REPLACE VIEW session_timing AS
SELECT
  s.id,
  s.model,
  s.status,
  s.pushed_at,
  s.ready_at,
  s.expires_at,
  EXTRACT(EPOCH FROM (s.ready_at - s.pushed_at)) / 60  AS warmup_minutes,
  EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 60      AS minutes_remaining,
  CASE
    WHEN EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 60 < 25
    THEN TRUE ELSE FALSE
  END                                                   AS needs_prefire,
  a.username,
  a.label,
  a.weekly_hours_used,
  a.rotation_count
FROM sessions s
LEFT JOIN kaggle_accounts a ON s.account_id = a.id
WHERE s.status IN ('warming', 'ready', 'expiring');


-- top10_accounts: best candidates for next session (stealth rotation)
CREATE OR REPLACE VIEW top10_accounts AS
SELECT
  id,
  username,
  label,
  model_assignment,
  weekly_hours_used,
  rotation_count,
  last_used_at,
  GREATEST(0, 10.0 - weekly_hours_used) AS hours_remaining,
  is_active,
  -- Stealth score: lower = better to use next
  --   primary:   fewest GPU hours used this week
  --   secondary: fewest total lifetime sessions
  --   tertiary:  least recently used (prefer rested accounts)
  (
    weekly_hours_used * 10.0
    + rotation_count * 2.0
    - COALESCE(
        EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 3600.0,
        999.0   -- never used = best candidate
      ) * 0.1
  ) AS stealth_score
FROM kaggle_accounts
WHERE is_active = TRUE
ORDER BY stealth_score ASC
LIMIT 10;


-- ── 9. FUNCTIONS ────────────────────────────────────────────

-- upsert_gateway_url: called by url-catcher cron
CREATE OR REPLACE FUNCTION upsert_gateway_url(
  p_model      TEXT,
  p_index      INTEGER,
  p_tunnel_url TEXT,
  p_session_id UUID
) RETURNS VOID LANGUAGE SQL AS $$
  INSERT INTO gateway_urls (
    model, endpoint_index, tunnel_url, openai_api_url,
    session_id, is_healthy, last_seen_at, updated_at
  ) VALUES (
    p_model, p_index, p_tunnel_url, p_tunnel_url || '/v1',
    p_session_id, TRUE, NOW(), NOW()
  )
  ON CONFLICT (model, endpoint_index) DO UPDATE SET
    tunnel_url     = EXCLUDED.tunnel_url,
    openai_api_url = EXCLUDED.openai_api_url,
    session_id     = EXCLUDED.session_id,
    is_healthy     = TRUE,
    last_seen_at   = NOW(),
    updated_at     = NOW();
$$;


-- mark_gateway_unhealthy: called by url-catcher health check
CREATE OR REPLACE FUNCTION mark_gateway_unhealthy(
  p_model  TEXT,
  p_index  INTEGER
) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE gateway_urls
  SET is_healthy = FALSE, last_health_check = NOW()
  WHERE model = p_model AND endpoint_index = p_index;
$$;


-- mark_stale_gateways: called by url-catcher — marks stale if no heartbeat for 15 min
CREATE OR REPLACE FUNCTION mark_stale_gateways()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE gateway_urls
  SET is_healthy = FALSE, last_health_check = NOW()
  WHERE is_healthy = TRUE
    AND last_seen_at IS NOT NULL
    AND last_seen_at < NOW() - INTERVAL '15 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


-- notebook_push_url: called directly by the Kaggle notebook via Supabase REST API
-- POST /rest/v1/rpc/notebook_push_url
-- Body: { "p_model":"pro", "p_tunnel_url":"https://xyz.trycloudflare.com",
--         "p_api_key":"sk-...", "p_session_id":null, "p_secret":"your_secret" }
CREATE OR REPLACE FUNCTION notebook_push_url(
  p_model      TEXT,
  p_tunnel_url TEXT,
  p_session_id UUID    DEFAULT NULL,
  p_api_key    TEXT    DEFAULT NULL,
  p_secret     TEXT    DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
BEGIN
  -- Validate notebook secret (prevents random internet calls from registering URLs)
  SELECT value INTO v_secret
  FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';

  IF v_secret IS DISTINCT FROM p_secret THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_secret',
      'hint', 'Set NOTEBOOK_CALLBACK_SECRET in Kaggle Secrets to match system_config'
    );
  END IF;

  -- Validate model
  IF p_model NOT IN ('pro', 'ultra') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'model must be pro or ultra');
  END IF;

  -- Validate tunnel URL format
  IF p_tunnel_url NOT LIKE 'https://%' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tunnel_url must be https://');
  END IF;

  -- Upsert gateway_urls row
  INSERT INTO gateway_urls (
    model, endpoint_index, tunnel_url, openai_api_url,
    session_id, api_key, is_healthy, last_seen_at, updated_at
  ) VALUES (
    p_model, 0,
    p_tunnel_url,
    p_tunnel_url || '/v1',
    p_session_id,
    p_api_key,
    TRUE,
    NOW(),
    NOW()
  )
  ON CONFLICT (model, endpoint_index) DO UPDATE SET
    tunnel_url     = EXCLUDED.tunnel_url,
    openai_api_url = EXCLUDED.openai_api_url,
    -- Only update session_id / api_key if new values provided
    session_id     = COALESCE(EXCLUDED.session_id,  gateway_urls.session_id),
    api_key        = COALESCE(EXCLUDED.api_key,     gateway_urls.api_key),
    is_healthy     = TRUE,
    last_seen_at   = NOW(),
    updated_at     = NOW();

  -- Promote session to ready if session_id was provided
  IF p_session_id IS NOT NULL THEN
    UPDATE sessions SET
      status     = 'ready',
      ready_at   = COALESCE(ready_at, NOW()),
      updated_at = NOW()
    WHERE id = p_session_id
      AND status IN ('queued', 'warming');
  END IF;

  RETURN jsonb_build_object(
    'ok',    true,
    'model', p_model,
    'url',   p_tunnel_url,
    'ts',    NOW()
  );
END;
$$;


-- notebook_heartbeat: keeps last_seen_at fresh (called every 5 min from notebook)
-- POST /rest/v1/rpc/notebook_heartbeat
-- Body: { "p_model":"pro", "p_secret":"your_secret" }
CREATE OR REPLACE FUNCTION notebook_heartbeat(
  p_model  TEXT,
  p_secret TEXT DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
  v_rows   INTEGER;
BEGIN
  SELECT value INTO v_secret
  FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';

  IF v_secret IS DISTINCT FROM p_secret THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_secret');
  END IF;

  UPDATE gateway_urls
  SET last_seen_at = NOW()
  WHERE model = p_model AND endpoint_index = 0 AND is_healthy = TRUE;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',   true,
    'model', p_model,
    'rows_updated', v_rows,
    'ts',   NOW()
  );
END;
$$;


-- mark_account_used: update stealth rotation tracking after firing a session
CREATE OR REPLACE FUNCTION mark_account_used(p_account_id UUID)
RETURNS VOID LANGUAGE SQL AS $$
  UPDATE kaggle_accounts
  SET
    rotation_count = rotation_count + 1,
    last_used_at   = NOW(),
    updated_at     = NOW()
  WHERE id = p_account_id;
$$;


-- increment_weekly_hours: add GPU hours when a session ends
CREATE OR REPLACE FUNCTION increment_weekly_hours(
  p_account_id UUID,
  p_hours      FLOAT
) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE kaggle_accounts
  SET
    weekly_hours_used = weekly_hours_used + p_hours,
    updated_at        = NOW()
  WHERE id = p_account_id;
$$;


-- get_account_hours_summary: quick stats for all accounts
CREATE OR REPLACE FUNCTION get_account_hours_summary()
RETURNS TABLE(
  username          TEXT,
  label             TEXT,
  weekly_hours_used FLOAT,
  hours_remaining   FLOAT,
  rotation_count    INTEGER,
  last_used_at      TIMESTAMPTZ,
  is_active         BOOLEAN,
  pct_used          FLOAT
) LANGUAGE SQL AS $$
  SELECT
    username,
    label,
    weekly_hours_used,
    GREATEST(0, 10.0 - weekly_hours_used)                                   AS hours_remaining,
    rotation_count,
    last_used_at,
    is_active,
    LEAST(100, ROUND((weekly_hours_used / 10.0 * 100)::NUMERIC, 1))::FLOAT  AS pct_used
  FROM kaggle_accounts
  ORDER BY weekly_hours_used ASC;
$$;


-- ── 10. POST-SETUP INSTRUCTIONS ─────────────────────────────
-- After running this SQL, go to the SQL editor and run:
--
-- 1. Set your real cron secret:
--    UPDATE system_config SET value = 'your_secret_32chars'
--    WHERE key = 'CRON_SECRET';
--
-- 2. Set your real notebook callback secret:
--    UPDATE system_config SET value = 'your_secret_32chars'
--    WHERE key = 'NOTEBOOK_CALLBACK_SECRET';
--
-- 3. Set your HuggingFace token:
--    UPDATE system_config SET value = 'hf_your_token'
--    WHERE key = 'HF_TOKEN';
--
-- 4. Check everything looks right:
--    SELECT key, value, description FROM system_config ORDER BY key;
--
-- ── COMPLETE ────────────────────────────────────────────────
