-- ============================================================
-- ZERO LABS — SLOT-BASED ORCHESTRATOR v2 MIGRATION
-- Run in Supabase Dashboard → SQL Editor → Run
-- Creates: accounts, slots, sessions (new), config
-- Updates: notebook_push_url RPC function
-- Safe & idempotent
-- ============================================================

-- ── 0. BACKUP OLD TABLES (safe rename) ──────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions' AND table_schema = 'public') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'model' AND table_schema = 'public')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'slot_id' AND table_schema = 'public')
    THEN
      ALTER TABLE sessions RENAME TO sessions_legacy;
      RAISE NOTICE 'Renamed old sessions → sessions_legacy';
    END IF;
  END IF;
END $$;

-- ── 1. ACCOUNTS — Kaggle account pool ───────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text NOT NULL,
  kaggle_username       text NOT NULL,
  kaggle_key            text NOT NULL,
  quota_used_minutes    int DEFAULT 0,
  quota_limit_minutes   int DEFAULT 1800,
  is_active             bool DEFAULT true,
  created_at            timestamptz DEFAULT now()
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_accounts_active_quota
  ON accounts (is_active, quota_used_minutes)
  WHERE is_active = true;

-- ── 2. SLOTS — Parallel session slots ───────────────────────

CREATE TABLE IF NOT EXISTS slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_index       int UNIQUE NOT NULL,
  notebook_slug    text NOT NULL,
  is_enabled       bool DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE slots ENABLE ROW LEVEL SECURITY;

-- ── 3. SESSIONS — Session history and state (NEW schema) ────

CREATE TABLE IF NOT EXISTS sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id              uuid REFERENCES slots(id),
  account_id           uuid REFERENCES accounts(id),
  kernel_ref           text,
  started_at           timestamptz NOT NULL,
  handoff_trigger_at   timestamptz NOT NULL,
  timeout_at           timestamptz NOT NULL,
  ended_at             timestamptz,
  status               text DEFAULT 'warming'
  -- status values: warming | serving | handoff_pending | ended | failed
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_sessions_slot_status
  ON sessions (slot_id, status);

CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions (status)
  WHERE status IN ('warming', 'serving', 'handoff_pending');

CREATE INDEX IF NOT EXISTS idx_sessions_account_active
  ON sessions (account_id, status)
  WHERE status IN ('warming', 'serving', 'handoff_pending');

-- ── 4. CONFIG — Global configuration ────────────────────────

CREATE TABLE IF NOT EXISTS config (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

ALTER TABLE config ENABLE ROW LEVEL SECURITY;

-- ── 5. SEED DEFAULTS ────────────────────────────────────────

INSERT INTO config (key, value) VALUES
  ('default_session_duration_minutes', '600'),
  ('quota_reset_day', 'saturday'),
  ('handoff_buffer_minutes', '20')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ── 6. RPC FUNCTION FIX: notebook_push_url ──────────────────

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
  -- Check optional secret
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'system_config' AND table_schema = 'public') THEN
    SELECT value INTO v_secret FROM system_config WHERE key = 'NOTEBOOK_CALLBACK_SECRET';
    IF v_secret IS NOT NULL AND v_secret <> '' AND v_secret <> 'changeme_notebook_secret_here' THEN
      IF p_secret IS DISTINCT FROM v_secret THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_secret');
      END IF;
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

  -- Update session status safely for legacy or new sessions table
  IF p_session_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions_legacy' AND table_schema = 'public') THEN
      UPDATE sessions_legacy
      SET status = 'ready', ready_at = COALESCE(ready_at, NOW()), updated_at = NOW()
      WHERE id = p_session_id AND status IN ('queued', 'warming');
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions' AND table_schema = 'public') THEN
      UPDATE sessions
      SET status = 'serving'
      WHERE id = p_session_id AND status = 'warming';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'model', p_model,
    'tunnel_url', p_tunnel_url,
    'status', 'live'
  );
END;
$$;

-- ============================================================
-- MIGRATION COMPLETE
-- Run this query in Supabase Dashboard -> SQL Editor
-- ============================================================
