import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/accounts
 * Returns all accounts with quota status.
 * Tries new `accounts` table first, falls back to legacy `kaggle_accounts`.
 * Never exposes kaggle_key / api_key in responses.
 */
export async function GET() {
  try {
    // Query both tables and merge — new accounts table + legacy kaggle_accounts
    const [newResult, legacyResult] = await Promise.all([
      supabase
        .from('accounts')
        .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
        .order('quota_used_minutes', { ascending: true }),
      supabase
        .from('kaggle_accounts')
        .select('id, username, label, model_assignment, weekly_hours_used, weekly_hours_reset_at, rotation_count, last_used_at, is_active, created_at')
        .order('weekly_hours_used', { ascending: true }),
    ]);

    // New table accounts (with computed remaining)
    const newAccounts = (newResult.data ?? []).map((a: { quota_limit_minutes: number; quota_used_minutes: number }) => ({
      ...a,
      _source: 'v2',
      quota_remaining_minutes: a.quota_limit_minutes - a.quota_used_minutes,
    }));

    // Legacy accounts
    const legacyAccounts = legacyResult.data ?? [];

    // If we have legacy data, return it (dashboard expects this shape)
    // If we also have new accounts, append them
    if (legacyAccounts.length > 0) {
      return NextResponse.json([...legacyAccounts, ...newAccounts]);
    }

    // Only new accounts exist
    return NextResponse.json(newAccounts);
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/accounts
 * Adds a new Kaggle account to the pool.
 * Tries new `accounts` table first, falls back to legacy `kaggle_accounts`.
 * Body (new): { label, kaggle_username, kaggle_key, quota_limit_minutes? }
 * Body (legacy): { username, api_key, label?, model_assignment? }
 */
export async function POST(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const body = await req.json();

    // Try new table first
    const { label, kaggle_username, kaggle_key, quota_limit_minutes } = body;

    if (kaggle_username && kaggle_key) {
      // New schema insert
      const { data, error } = await supabase
        .from('accounts')
        .insert({
          label: (label || kaggle_username).trim(),
          kaggle_username: kaggle_username.trim().toLowerCase(),
          kaggle_key: kaggle_key.trim(),
          quota_limit_minutes: quota_limit_minutes ?? 1800,
          quota_used_minutes: 0,
          is_active: true,
        })
        .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
        .single();

      if (!error && data) {
        return NextResponse.json({
          ...data,
          quota_remaining_minutes: (data.quota_limit_minutes ?? 1800) - (data.quota_used_minutes ?? 0),
          message: 'Account added — will be picked up in the next scheduler tick',
        });
      }

      // If new table doesn't exist, fall through to legacy
    }

    // Legacy fallback: kaggle_accounts with encryption
    const username = body.username || body.kaggle_username;
    const api_key = body.api_key || body.apiKey || body.kaggle_key;
    const { model_assignment, is_active } = body;

    if (!username?.trim() || !api_key?.trim()) {
      return NextResponse.json({ error: 'username and api_key are required' }, { status: 400 });
    }

    // Dynamic import crypto only for legacy path
    const { encrypt } = await import('@/lib/crypto');
    const { encrypted, iv, tag } = encrypt(api_key.trim());

    const { data: legacyData, error: legacyErr } = await supabase
      .from('kaggle_accounts')
      .insert({
        username: username.trim().toLowerCase(),
        api_key_encrypted: encrypted,
        api_key_iv: iv,
        api_key_tag: tag,
        label: body.label?.trim() || null,
        model_assignment: model_assignment || 'both',
        is_active: is_active !== undefined ? is_active : true,
      })
      .select()
      .single();

    if (legacyErr) return NextResponse.json({ error: legacyErr.message }, { status: 500 });
    return NextResponse.json(legacyData);
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
