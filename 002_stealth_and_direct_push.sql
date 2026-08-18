-- ============================================================
-- Zero Labs — Migration 002 (UPGRADE ONLY)
-- ⚠️  Only run this if you ALREADY ran the OLD 001_initial_schema.sql
--    (the one WITHOUT rotation_count / last_seen_at / notebook_push_url).
--
-- If you are starting FRESH → only run 001_initial_schema.sql.
-- That file already includes everything in this file.
-- ============================================================

-- Add columns that didn't exist in the original 001
ALTER TABLE kaggle_accounts
  ADD COLUMN IF NOT EXISTS rotation_count  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at    TIMESTAMPTZ;

ALTER TABLE gateway_urls
  ADD COLUMN IF NOT EXISTS api_key         TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at    TIMESTAMPTZ DEFAULT NOW();

-- Add new indexes
CREATE INDEX IF NOT EXISTS idx_accounts_rotation
  ON kaggle_accounts (rotation_count ASC) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_gateway_healthy
  ON gateway_urls (model, endpoint_index) WHERE is_healthy = TRUE;

CREATE INDEX IF NOT EXISTS idx_session_log_account
  ON account_session_log (account_id, logged_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_account
  ON sessions (account_id)
  WHERE status IN ('queued', 'warming', 'ready', 'expiring');

-- New config keys
INSERT INTO system_config (key, value, description) VALUES
  ('NOTEBOOK_CALLBACK_SECRET',         'changeme_notebook_secret_here',
   'Secret the Kaggle notebook sends when POSTing its URL directly to Supabase'),
  ('STEALTH_MAX_SESSIONS_PER_ACCOUNT', '3',
   'Max sessions per account per week before hard-rotating to a fresh account'),
  ('STEALTH_ROTATE_AFTER_HOURS',       '8',
   'Prefer a fresh account after this many hours even if current has quota left')
ON CONFLICT (key) DO NOTHING;

-- ── Re-create all views and functions ──────────────────────
-- (These are idempotent — safe to run even if they already exist)

-- current_gateway
CREATE OR REPLACE VIEW current_gateway AS
SELECT
  model, endpoint_index, tunnel_url, openai_api_url,
  api_key, session_id, is_healthy,
  last_seen_at, last_health_check, updated_at
FROM gateway_urls
WHERE is_healthy = TRUE
ORDER BY model, endpoint_index;

-- live_endpoints
CREATE OR REPLACE VIEW live_endpoints AS
SELECT
  s.model,
  s.id                                    AS session_id,
  s.account_id,
  endpoint->>'tunnel_url'                 AS tunnel_url,
  endpoint->>'openai_api_url'             AS openai_api_url,
  (endpoint->>'port')::TEXT               AS port,
  (endpoint->>'max_concurrent')::INTEGER  AS max_concurrent,
  s.expires_at,
  s.total_concurrent,
  gw.tunnel_url                           AS gateway_tunnel_url,
  gw.openai_api_url                       AS gateway_api_url,
  gw.api_key                              AS gateway_api_key,
  gw.is_healthy                           AS gateway_healthy,
  gw.last_seen_at                         AS gateway_last_seen
FROM sessions s
CROSS JOIN LATERAL jsonb_array_elements(s.endpoints) AS endpoint
LEFT JOIN gateway_urls gw
  ON gw.model = s.model AND gw.endpoint_index = 0
WHERE s.status IN ('ready', 'expiring')
  AND s.endpoints IS NOT NULL;

-- session_timing
CREATE OR REPLACE VIEW session_timing AS
SELECT
  s.id, s.model, s.status,
  s.pushed_at, s.ready_at, s.expires_at,
  EXTRACT(EPOCH FROM (s.ready_at - s.pushed_at)) / 60  AS warmup_minutes,
  EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 60      AS minutes_remaining,
  CASE WHEN EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 60 < 25
       THEN TRUE ELSE FALSE END                        AS needs_prefire,
  a.username, a.label, a.weekly_hours_used, a.rotation_count
FROM sessions s
LEFT JOIN kaggle_accounts a ON s.account_id = a.id
WHERE s.status IN ('warming', 'ready', 'expiring');

-- top10_accounts
CREATE OR REPLACE VIEW top10_accounts AS
SELECT
  id, username, label, model_assignment,
  weekly_hours_used, rotation_count, last_used_at,
  GREATEST(0, 10.0 - weekly_hours_used) AS hours_remaining,
  is_active,
  (
    weekly_hours_used * 10.0
    + rotation_count * 2.0
    - COALESCE(EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 3600.0, 999.0) * 0.1
  ) AS stealth_score
FROM kaggle_accounts
WHERE is_active = TRUE
ORDER BY stealth_score ASC
LIMIT 10;

-- upsert_gateway_url
CREATE OR REPLACE FUNCTION upsert_gateway_url(
  p_model TEXT, p_index INTEGER, p_tunnel_url TEXT, p_session_id UUID
) RETURNS VOID LANGUAGE SQL AS $$
  INSERT INTO gateway_urls (
    model, endpoint_index, tunnel_url, openai_api_url,
    session_id, is_healthy, last_seen_at, updated_at
  ) VALUES (
    p_model, p_index, p_tunnel_url, p_tunnel_url || '/v1',
    p_session_id, TRUE, NOW(), NOW()
  )
  ON CONFLICT (model, endpoint_index) DO UPDATE SET
    tunnel_url = EXCLUDED.tunnel_url, openai_api_url = EXCLUDED.openai_api_url,
    session_id = EXCLUDED.session_id, is_healthy = TRUE,
    last_seen_at = NOW(), updated_at = NOW();
$$;

-- mark_gateway_unhealthy
CREATE OR REPLACE FUNCTION mark_gateway_unhealthy(p_model TEXT, p_index INTEGER)
RETURNS VOID LANGUAGE SQL AS $$
  UPDATE gateway_urls SET is_healthy = FALSE, last_health_check = NOW()
  WHERE model = p_model AND endpoint_index = p_index;
$$;

-- mark_stale_gateways
CREATE OR REPLACE FUNCTION mark_stale_gateways()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE gateway_urls SET is_healthy = FALSE, last_health_check = NOW()
  WHERE is_healthy = TRUE AND last_seen_at IS NOT NULL
    AND last_seen_at < NOW() - INTERVAL '15 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- notebook_push_url
CREATE OR REPLACE FUNCTION notebook_push_url(
  p_model TEXT, p_tunnel_url TEXT,
  p_session_id UUID DEFAULT NULL, p_api_key TEXT DEFAULT NULL, p_secret TEXT DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_secret TEXT;
BEGIN
  SELECT value INTO v_secret FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';
  IF v_secret IS DISTINCT FROM p_secret THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_secret');
  END IF;
  IF p_model NOT IN ('pro', 'ultra') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'model must be pro or ultra');
  END IF;
  IF p_tunnel_url NOT LIKE 'https://%' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tunnel_url must be https://');
  END IF;
  INSERT INTO gateway_urls (
    model, endpoint_index, tunnel_url, openai_api_url,
    session_id, api_key, is_healthy, last_seen_at, updated_at
  ) VALUES (
    p_model, 0, p_tunnel_url, p_tunnel_url || '/v1',
    p_session_id, p_api_key, TRUE, NOW(), NOW()
  )
  ON CONFLICT (model, endpoint_index) DO UPDATE SET
    tunnel_url = EXCLUDED.tunnel_url, openai_api_url = EXCLUDED.openai_api_url,
    session_id = COALESCE(EXCLUDED.session_id, gateway_urls.session_id),
    api_key    = COALESCE(EXCLUDED.api_key,    gateway_urls.api_key),
    is_healthy = TRUE, last_seen_at = NOW(), updated_at = NOW();
  IF p_session_id IS NOT NULL THEN
    UPDATE sessions SET status = 'ready', ready_at = COALESCE(ready_at, NOW()),
      updated_at = NOW()
    WHERE id = p_session_id AND status IN ('queued', 'warming');
  END IF;
  RETURN jsonb_build_object('ok', true, 'model', p_model, 'url', p_tunnel_url, 'ts', NOW());
END;
$$;

-- notebook_heartbeat
CREATE OR REPLACE FUNCTION notebook_heartbeat(p_model TEXT, p_secret TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_secret TEXT; v_rows INTEGER;
BEGIN
  SELECT value INTO v_secret FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';
  IF v_secret IS DISTINCT FROM p_secret THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_secret');
  END IF;
  UPDATE gateway_urls SET last_seen_at = NOW()
  WHERE model = p_model AND endpoint_index = 0 AND is_healthy = TRUE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'model', p_model, 'rows_updated', v_rows, 'ts', NOW());
END;
$$;

-- mark_account_used
CREATE OR REPLACE FUNCTION mark_account_used(p_account_id UUID)
RETURNS VOID LANGUAGE SQL AS $$
  UPDATE kaggle_accounts
  SET rotation_count = rotation_count + 1, last_used_at = NOW(), updated_at = NOW()
  WHERE id = p_account_id;
$$;

-- increment_weekly_hours
CREATE OR REPLACE FUNCTION increment_weekly_hours(p_account_id UUID, p_hours FLOAT)
RETURNS VOID LANGUAGE SQL AS $$
  UPDATE kaggle_accounts
  SET weekly_hours_used = weekly_hours_used + p_hours, updated_at = NOW()
  WHERE id = p_account_id;
$$;

-- get_account_hours_summary
CREATE OR REPLACE FUNCTION get_account_hours_summary()
RETURNS TABLE(
  username TEXT, label TEXT, weekly_hours_used FLOAT, hours_remaining FLOAT,
  rotation_count INTEGER, last_used_at TIMESTAMPTZ, is_active BOOLEAN, pct_used FLOAT
) LANGUAGE SQL AS $$
  SELECT username, label, weekly_hours_used,
    GREATEST(0, 10.0 - weekly_hours_used) AS hours_remaining,
    rotation_count, last_used_at, is_active,
    LEAST(100, ROUND((weekly_hours_used / 10.0 * 100)::NUMERIC, 1))::FLOAT AS pct_used
  FROM kaggle_accounts ORDER BY weekly_hours_used ASC;
$$;

-- ── DONE ────────────────────────────────────────────────────
