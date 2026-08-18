-- ============================================================
-- Zero Labs — Migration 003: 30h Weekly Quota & 2 Concurrent Sessions
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → Run)
-- ============================================================

-- 1. Update system config defaults for 30h quota and 2 concurrent sessions
INSERT INTO system_config (key, value, description) VALUES
  ('ACCOUNT_WEEKLY_QUOTA_H', '30', 'Max GPU hours per account per week on Kaggle'),
  ('MAX_CONCURRENT_SESSIONS_PER_ACCOUNT', '2', 'Max concurrent GPU sessions per Kaggle account'),
  ('SESSION_SOFT_LIMIT_H', '10', 'Max hours a session runs before graceful rotation (Kaggle max 10h)'),
  ('SESSION_HARD_LIMIT_H', '10.5', 'Hard cutoff limit in hours')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description;

-- 2. Update top10_accounts view for 30h quota
CREATE OR REPLACE VIEW top10_accounts AS
SELECT
  id,
  username,
  label,
  model_assignment,
  weekly_hours_used,
  rotation_count,
  last_used_at,
  GREATEST(0, 30.0 - weekly_hours_used) AS hours_remaining,
  is_active,
  (
    (weekly_hours_used / 30.0 * 100.0)
    + (rotation_count * 2.0)
    - COALESCE(EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 3600.0, 999.0) * 0.1
  ) AS stealth_score
FROM kaggle_accounts
WHERE is_active = TRUE
ORDER BY stealth_score ASC
LIMIT 10;

-- 3. Update get_account_hours_summary RPC for 30h quota
CREATE OR REPLACE FUNCTION get_account_hours_summary()
RETURNS TABLE(
  username TEXT,
  label TEXT,
  weekly_hours_used FLOAT,
  hours_remaining FLOAT,
  rotation_count INTEGER,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN,
  pct_used FLOAT
) LANGUAGE SQL AS $$
  SELECT
    username,
    label,
    weekly_hours_used,
    GREATEST(0, 30.0 - weekly_hours_used) AS hours_remaining,
    rotation_count,
    last_used_at,
    is_active,
    LEAST(100, ROUND((weekly_hours_used / 30.0 * 100)::NUMERIC, 1))::FLOAT AS pct_used
  FROM kaggle_accounts
  ORDER BY weekly_hours_used ASC;
$$;

-- 4. Verify Supabase Keepalive table / touch
CREATE OR REPLACE FUNCTION supabase_keepalive_pulse()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Touch gateway_urls
  UPDATE gateway_urls SET updated_at = NOW() WHERE is_healthy = TRUE;
  RETURN jsonb_build_object(
    'ok', true,
    'status', 'active',
    'ts', NOW(),
    'message', 'Supabase database keepalive pulse registered successfully'
  );
END;
$$;

-- Done!
