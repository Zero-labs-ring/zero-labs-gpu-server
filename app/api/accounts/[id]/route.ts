import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/accounts/:id
 * Updates account fields.
 * Body: { label?, quota_used_minutes?, quota_limit_minutes?, is_active? }
 * Never accepts kaggle_key updates via this route for safety.
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

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update (allowed: label, quota_used_minutes, quota_limit_minutes, is_active)' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', id)
      .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
      .single();

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
 * Permanently removes or deletes the account from either accounts or kaggle_accounts table.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;

    // Try deleting from kaggle_accounts first
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

    // Next try deleting from accounts table
    const { data, error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', id)
      .select('id, label, kaggle_username')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data && !legacyData) {
      // Also attempt soft-delete / fallback if row is somehow referenced or check if error occurred
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({
      message: `Account "${data?.label || data?.kaggle_username}" deleted successfully`,
      account: data,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
