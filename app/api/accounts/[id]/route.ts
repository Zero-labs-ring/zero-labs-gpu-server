import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/accounts/:id
 * Fetches a single account by ID.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Check kaggle_accounts table first
    const { data: legacyData, error: legacyErr } = await supabase
      .from('kaggle_accounts')
      .select('id, username, label, model_assignment, weekly_hours_used, weekly_hours_reset_at, rotation_count, last_used_at, is_active, created_at')
      .eq('id', id)
      .maybeSingle();

    if (!legacyErr && legacyData) {
      return NextResponse.json(legacyData);
    }

    // Check accounts table
    const { data, error } = await supabase
      .from('accounts')
      .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: data.id,
      username: data.kaggle_username,
      label: data.label,
      model_assignment: 'both',
      weekly_hours_used: (data.quota_used_minutes || 0) / 60,
      weekly_hours_reset_at: '',
      rotation_count: Math.floor((data.quota_used_minutes || 0) / 600),
      last_used_at: '',
      is_active: data.is_active,
      created_at: data.created_at,
      quota_remaining_minutes: data.quota_limit_minutes - data.quota_used_minutes,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/accounts/:id
 * Updates account fields across accounts or kaggle_accounts.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;
    const body = await req.json();
    const updates: Record<string, unknown> = {};

    if (body.label !== undefined) updates.label = body.label.trim();
    if (body.quota_used_minutes !== undefined) updates.quota_used_minutes = body.quota_used_minutes;
    if (body.quota_limit_minutes !== undefined) updates.quota_limit_minutes = body.quota_limit_minutes;
    if (body.is_active !== undefined) updates.is_active = body.is_active;

    // Try updating kaggle_accounts
    const legacyUpdates: Record<string, unknown> = {};
    if (body.label !== undefined) legacyUpdates.label = body.label.trim();
    if (body.is_active !== undefined) legacyUpdates.is_active = body.is_active;
    if (body.weekly_hours_used !== undefined) legacyUpdates.weekly_hours_used = body.weekly_hours_used;
    if (body.model_assignment !== undefined) legacyUpdates.model_assignment = body.model_assignment;

    const { data: legacyData } = await supabase
      .from('kaggle_accounts')
      .update(legacyUpdates)
      .eq('id', id)
      .select('id, username, label, model_assignment, weekly_hours_used, is_active')
      .maybeSingle();

    if (legacyData) {
      return NextResponse.json(legacyData);
    }

    // Try updating accounts table
    const { data, error } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', id)
      .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({
      ...data,
      quota_remaining_minutes: data.quota_limit_minutes - data.quota_used_minutes,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * DELETE /api/accounts/:id
 * Permanently removes or disables the account from either accounts or kaggle_accounts table.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;

    // 1. Try deleting from kaggle_accounts
    try {
      // Nullify references in sessions first if constraint exists
      await supabase.from('sessions').update({ account_id: null }).eq('account_id', id);
      await supabase.from('account_session_log').delete().eq('account_id', id);
    } catch { /* ignore foreign key cleanup */ }

    const { data: legacyData, error: legacyErr } = await supabase
      .from('kaggle_accounts')
      .delete()
      .eq('id', id)
      .select('id, username, label')
      .maybeSingle();

    if (!legacyErr && legacyData) {
      return NextResponse.json({
        message: `Account @${legacyData.username} deleted successfully`,
        account: legacyData,
      });
    }

    // 2. Try deleting from accounts table
    const { data, error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', id)
      .select('id, label, kaggle_username')
      .maybeSingle();

    if (!error && data) {
      return NextResponse.json({
        message: `Account "${data.label || data.kaggle_username}" deleted successfully`,
        account: data,
      });
    }

    // 3. Fallback: soft disable if hard delete has foreign key blocks
    const { data: softLegacy } = await supabase
      .from('kaggle_accounts')
      .update({ is_active: false })
      .eq('id', id)
      .select('id, username, label')
      .maybeSingle();

    if (softLegacy) {
      return NextResponse.json({
        message: `Account @${softLegacy.username} disabled`,
        account: softLegacy,
      });
    }

    const { data: softData } = await supabase
      .from('accounts')
      .update({ is_active: false })
      .eq('id', id)
      .select('id, label, kaggle_username')
      .maybeSingle();

    if (softData) {
      return NextResponse.json({
        message: `Account "${softData.label || softData.kaggle_username}" disabled`,
        account: softData,
      });
    }

    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
