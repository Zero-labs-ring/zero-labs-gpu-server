-- ============================================================
-- ZERO LABS — MASTER CONSOLIDATED SQL MIGRATION
-- Run this in your Supabase Dashboard -> SQL Editor -> Run
-- Safe & idempotent (can be run multiple times)
-- ============================================================

-- ── 1. ENSURE COLUMNS & INDEXES EXIST ──────────────────────────
ALTER TABLE IF EXISTS kaggle_accounts
  ADD COLUMN IF NOT EXISTS rotation_count       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS weekly_hours_used    NUMERIC(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_hours_reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');

ALTER TABLE IF EXISTS gateway_urls
  ADD COLUMN IF NOT EXISTS api_key              TEXT DEFAULT 'zerotech13287',
  ADD COLUMN IF NOT EXISTS last_seen_at         TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_accounts_rotation
  ON kaggle_accounts (rotation_count ASC) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_gateway_healthy
  ON gateway_urls (model, endpoint_index) WHERE is_healthy = TRUE;

-- ── 2. SYSTEM CONFIGURATION & ZERO-SECRET SETTINGS ────────────
INSERT INTO system_config (key, value, description) VALUES
  ('NOTEBOOK_CALLBACK_SECRET',         '',
   'Secret for notebook callback (empty string disables secret check for zero-config mode)'),
  ('STEALTH_MAX_SESSIONS_PER_ACCOUNT', '2',
   'Max concurrent sessions per Kaggle account (allows 1 Pro + 1 Ultra simultaneously)'),
  ('STEALTH_ROTATE_AFTER_HOURS',       '10',
   'Max continuous session duration before graceful rotation'),
  ('KAGGLE_WEEKLY_QUOTA_HOURS',        '30',
   'Kaggle GPU weekly quota per account (30 hours/week)'),
  ('PRO_TARGET_SESSIONS',              '1',
   'Target active sessions for Titan Pro 9B'),
  ('ULTRA_TARGET_SESSIONS',            '1',
   'Target active sessions for Titan Ultra 27B')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description;

-- ── 3. VIEWS ──────────────────────────────────────────────────
DROP VIEW IF EXISTS live_endpoints CASCADE;
DROP VIEW IF EXISTS current_gateway CASCADE;

CREATE OR REPLACE VIEW current_gateway AS
SELECT
  model, endpoint_index, tunnel_url, openai_api_url,
  api_key, session_id, is_healthy,
  last_seen_at, last_health_check, updated_at
FROM gateway_urls
WHERE is_healthy = TRUE
  AND (last_seen_at IS NULL OR last_seen_at >= NOW() - INTERVAL '2 minutes')
ORDER BY model, endpoint_index;

CREATE OR REPLACE VIEW live_endpoints AS
SELECT
  s.model,
  s.id                                    AS session_id,
  s.kernel_slug,
  s.ready_at,
  s.created_at,
  COALESCE(g.tunnel_url,
    (s.endpoints->0->>'tunnel_url'))      AS tunnel_url,
  COALESCE(g.openai_api_url,
    (s.endpoints->0->>'openai_api_url'))  AS openai_api_url,
  COALESCE(g.is_healthy, TRUE)            AS is_healthy,
  g.last_seen_at,
  g.last_health_check
FROM sessions s
LEFT JOIN gateway_urls g
  ON g.model = s.model AND g.endpoint_index = 0
WHERE s.status = 'ready'
ORDER BY s.model, s.ready_at DESC;

-- ── 4. RPC FUNCTIONS (ZERO-SECRET DIRECT PUSH & HEARTBEAT) ────

-- Function: notebook_push_url
-- Called by Kaggle notebook on startup to register its Cloudflare tunnel.
CREATE OR REPLACE FUNCTION notebook_push_url(
  p_model TEXT,
  p_tunnel_url TEXT,
  p_session_id UUID DEFAULT NULL,
  p_api_key TEXT DEFAULT 'zerotech13287',
  p_secret TEXT DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
BEGIN
  -- Check optional secret (only enforces if non-empty secret is configured)
  SELECT value INTO v_secret FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';
  IF v_secret IS NOT NULL AND v_secret <> '' AND v_secret <> 'changeme_notebook_secret_here' THEN
    IF p_secret IS DISTINCT FROM v_secret THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_secret');
    END IF;
  END IF;

  IF p_model NOT IN ('pro', 'ultra') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'model must be pro or ultra');
  END IF;

  IF p_tunnel_url NOT LIKE 'https://%' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tunnel_url must be https://');
  END IF;

  -- Clean any old/mismatched URLs for this model
  DELETE FROM gateway_urls
  WHERE model = p_model AND (tunnel_url <> p_tunnel_url OR endpoint_index <> 0);

  -- Upsert gateway URL with fresh timestamp
  INSERT INTO gateway_urls (
    model, endpoint_index, tunnel_url, openai_api_url,
    session_id, api_key, is_healthy, last_seen_at, updated_at
  ) VALUES (
    p_model, 0, p_tunnel_url, rtrim(p_tunnel_url, '/') || '/v1',
    p_session_id, COALESCE(p_api_key, 'zerotech13287'), TRUE, NOW(), NOW()
  )
  ON CONFLICT (model, endpoint_index) DO UPDATE SET
    tunnel_url     = EXCLUDED.tunnel_url,
    openai_api_url = EXCLUDED.openai_api_url,
    session_id     = COALESCE(EXCLUDED.session_id, gateway_urls.session_id),
    api_key        = COALESCE(EXCLUDED.api_key, gateway_urls.api_key, 'zerotech13287'),
    is_healthy     = TRUE,
    last_seen_at   = NOW(),
    updated_at     = NOW();

  IF p_session_id IS NOT NULL THEN
    UPDATE sessions
    SET status = 'ready', ready_at = COALESCE(ready_at, NOW()), updated_at = NOW()
    WHERE id = p_session_id AND status IN ('queued', 'warming');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'model', p_model,
    'tunnel_url', p_tunnel_url,
    'status', 'live'
  );
END;
$$;

-- Function: notebook_heartbeat
-- Called every minute by the notebook to keep last_seen_at fresh and receive termination orders.
CREATE OR REPLACE FUNCTION notebook_heartbeat(
  p_model TEXT,
  p_secret TEXT DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_is_healthy BOOLEAN;
  v_session_id UUID;
  v_session_status TEXT;
BEGIN
  -- 1. Check current gateway state
  SELECT is_healthy, session_id INTO v_is_healthy, v_session_id
  FROM gateway_urls
  WHERE model = p_model AND endpoint_index = 0;

  -- 2. If session is dead or explicitly marked unhealthy, signal notebook to terminate
  IF v_session_id IS NOT NULL THEN
    SELECT status::TEXT INTO v_session_status FROM sessions WHERE id = v_session_id;
    IF v_session_status IN ('dead', 'error', 'completed', 'cancelled') THEN
      RETURN jsonb_build_object('ok', true, 'terminate', true, 'reason', 'session_terminated', 'model', p_model);
    END IF;
  END IF;

  IF v_is_healthy IS FALSE THEN
    RETURN jsonb_build_object('ok', true, 'terminate', true, 'reason', 'gateway_unhealthy', 'model', p_model);
  END IF;

  -- 3. If healthy, keep timestamp fresh
  UPDATE gateway_urls
  SET last_seen_at = NOW(), is_healthy = TRUE, updated_at = NOW()
  WHERE model = p_model AND endpoint_index = 0;

  RETURN jsonb_build_object('ok', true, 'terminate', false, 'model', p_model, 'heartbeat_at', NOW());
END;
$$;

-- Function: keepalive_ping
-- Touches system_config to prevent Supabase 7-day pause.
CREATE OR REPLACE FUNCTION keepalive_ping()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE system_config
  SET updated_at = NOW()
  WHERE key = 'KAGGLE_WEEKLY_QUOTA_HOURS';
  
  RETURN jsonb_build_object('ok', true, 'timestamp', NOW(), 'status', 'database_kept_active');
END;
$$;

-- ── 5. PRE-REGISTER ACTIVE TITAN PRO TUNNEL (FROM RECENT RUN) ──
INSERT INTO gateway_urls (
  model, endpoint_index, tunnel_url, openai_api_url,
  api_key, is_healthy, last_seen_at, updated_at
) VALUES (
  'pro', 0,
  'https://dale-hostel-conclude-shipped.trycloudflare.com',
  'https://dale-hostel-conclude-shipped.trycloudflare.com/v1',
  'zerotech13287',
  TRUE,
  NOW(),
  NOW()
)
ON CONFLICT (model, endpoint_index) DO UPDATE SET
  tunnel_url     = EXCLUDED.tunnel_url,
  openai_api_url = EXCLUDED.openai_api_url,
  api_key        = EXCLUDED.api_key,
  is_healthy     = TRUE,
  last_seen_at   = NOW(),
  updated_at     = NOW();
