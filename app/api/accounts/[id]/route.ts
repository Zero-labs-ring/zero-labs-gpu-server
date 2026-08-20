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
 * Soft-disables the account (sets is_active=false).
 * Running sessions on this account finish naturally.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;

    const { data, error } = await supabase
      .from('accounts')
      .update({ is_active: false })
      .eq('id', id)
      .select('id, label, kaggle_username, is_active')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({
      message: `Account "${data.label}" disabled — running sessions will finish naturally`,
      account: data,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
