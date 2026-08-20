import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/status
 * Returns full system overview:
 *  - All slots with current session info
 *  - All accounts with quota status
 *  - System health summary
 */
export async function GET(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    // Fetch all slots
    const { data: slots, error: slotsErr } = await supabase
      .from('slots')
      .select('*')
      .order('slot_index', { ascending: true });

    if (slotsErr) throw new Error(`Failed to fetch slots: ${slotsErr.message}`);

    // Fetch all active sessions
    const { data: activeSessions, error: sessionsErr } = await supabase
      .from('sessions')
      .select('*')
      .in('status', ['warming', 'serving', 'handoff_pending'])
      .order('started_at', { ascending: false });

    if (sessionsErr) throw new Error(`Failed to fetch sessions: ${sessionsErr.message}`);

    // Fetch all accounts (exclude kaggle_key from response)
    const { data: accounts, error: accountsErr } = await supabase
      .from('accounts')
      .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
      .order('quota_used_minutes', { ascending: true });

    if (accountsErr) throw new Error(`Failed to fetch accounts: ${accountsErr.message}`);

    // Build slot status with current session
    const sessionsBySlot = new Map<string, typeof activeSessions>();
    for (const session of activeSessions ?? []) {
      if (!sessionsBySlot.has(session.slot_id)) {
        sessionsBySlot.set(session.slot_id, []);
      }
      sessionsBySlot.get(session.slot_id)!.push(session);
    }

    const slotStatuses = (slots ?? []).map((slot: { id: string; slot_index: number; notebook_slug: string; is_enabled: boolean }) => {
      const sessions = sessionsBySlot.get(slot.id) ?? [];
      const currentSession = sessions[0] ?? null;

      return {
        id: slot.id,
        slot_index: slot.slot_index,
        notebook_slug: slot.notebook_slug,
        is_enabled: slot.is_enabled,
        current_session: currentSession
          ? {
              id: currentSession.id,
              account_id: currentSession.account_id,
              status: currentSession.status,
              kernel_ref: currentSession.kernel_ref,
              started_at: currentSession.started_at,
              handoff_trigger_at: currentSession.handoff_trigger_at,
              timeout_at: currentSession.timeout_at,
              minutes_running: Math.round(
                (Date.now() - new Date(currentSession.started_at).getTime()) / 60000
              ),
            }
          : null,
      };
    });

    // Account status with remaining quota
    const accountStatuses = (accounts ?? []).map((a: { id: string; label: string; kaggle_username: string; quota_used_minutes: number; quota_limit_minutes: number; is_active: boolean }) => ({
      id: a.id,
      label: a.label,
      kaggle_username: a.kaggle_username,
      quota_used_minutes: a.quota_used_minutes,
      quota_remaining_minutes: a.quota_limit_minutes - a.quota_used_minutes,
      quota_limit_minutes: a.quota_limit_minutes,
      is_active: a.is_active,
    }));

    // System health summary
    const enabledSlots = slotStatuses.filter(s => s.is_enabled);
    const slotsWithActiveSessions = enabledSlots.filter(s => s.current_session !== null);
    const totalQuotaRemaining = accountStatuses
      .filter((a: { is_active: boolean }) => a.is_active)
      .reduce((sum: number, a: { quota_remaining_minutes: number }) => sum + a.quota_remaining_minutes, 0);

    const health = {
      status: slotsWithActiveSessions.length === enabledSlots.length ? 'healthy' : 'degraded',
      enabled_slots: enabledSlots.length,
      active_sessions: slotsWithActiveSessions.length,
      slots_without_sessions: enabledSlots.length - slotsWithActiveSessions.length,
      total_accounts: accountStatuses.length,
      active_accounts: accountStatuses.filter((a: { is_active: boolean }) => a.is_active).length,
      total_quota_remaining_minutes: totalQuotaRemaining,
      total_quota_remaining_hours: Math.round(totalQuotaRemaining / 60 * 10) / 10,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json({
      health,
      slots: slotStatuses,
      accounts: accountStatuses,
    });
  } catch (err: unknown) {
    console.error('[status] Failed to fetch system status:', err);
    return NextResponse.json(
      { error: 'Failed to fetch system status', details: String(err) },
      { status: 500 }
    );
  }
}
