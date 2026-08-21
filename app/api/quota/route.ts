import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET() {
  try {
    const [newResult, legacyResult, gatewayResult] = await Promise.all([
      supabase
        .from('accounts')
        .select('id, label, kaggle_username, quota_used_minutes, quota_limit_minutes, is_active, created_at')
        .order('quota_used_minutes', { ascending: true }),
      supabase
        .from('kaggle_accounts')
        .select('id, username, label, model_assignment, weekly_hours_used, is_active, created_at')
        .order('weekly_hours_used', { ascending: true }),
      supabase
        .from('gateway_urls')
        .select('model, tunnel_url, is_healthy, last_seen_at')
        .eq('is_healthy', true),
    ]);

    const activeTunnels: Record<string, string> = {};
    for (const gw of gatewayResult.data ?? []) {
      if (gw.tunnel_url) {
        activeTunnels[gw.model] = gw.tunnel_url;
      }
    }

    const mergedMap = new Map<string, {
      id: string;
      username: string;
      label: string;
      weekly_hours_used: number;
      quota_limit_hours: number;
      available_hours: number;
      available_hours_formatted: string;
      used_hours_formatted: string;
      utilization_percentage: number;
      is_active: boolean;
      tpu_available_hours: number;
      ai_daily_available: number;
      ai_monthly_available: number;
      active_cluster_node?: string;
    }>();

    // 1. Process legacy accounts
    for (const a of legacyResult.data ?? []) {
      const uname = a.username;
      const usedH = Number(a.weekly_hours_used || 0);
      const limitH = 30.0;
      const availH = Math.max(0, limitH - usedH);
      const availWholeH = Math.floor(availH);
      const availM = Math.floor((availH - availWholeH) * 60);

      const usedWholeH = Math.floor(usedH);
      const usedM = Math.floor((usedH - usedWholeH) * 60);

      mergedMap.set(uname, {
        id: a.id,
        username: uname,
        label: a.label || uname,
        weekly_hours_used: usedH,
        quota_limit_hours: limitH,
        available_hours: availH,
        available_hours_formatted: `${availWholeH}h ${availM > 0 ? `${availM}m ` : ''}available of 30h`,
        used_hours_formatted: `${usedWholeH}h ${usedM}m`,
        utilization_percentage: Math.min(100, Math.max(0, (usedH / limitH) * 100)),
        is_active: a.is_active !== false,
        tpu_available_hours: 20,
        ai_daily_available: 10.0,
        ai_monthly_available: 100.0,
      });
    }

    // 2. Process v2 accounts
    for (const a of newResult.data ?? []) {
      const uname = a.kaggle_username;
      const usedH = (Number(a.quota_used_minutes) || 0) / 60.0;
      const limitH = (Number(a.quota_limit_minutes) || 1800.0) / 60.0;
      const availH = Math.max(0, limitH - usedH);
      const availWholeH = Math.floor(availH);
      const availM = Math.floor((availH - availWholeH) * 60);

      const usedWholeH = Math.floor(usedH);
      const usedM = Math.floor((usedH - usedWholeH) * 60);

      if (mergedMap.has(uname)) {
        const item = mergedMap.get(uname)!;
        if (usedH > item.weekly_hours_used) {
          item.weekly_hours_used = usedH;
          item.available_hours = availH;
          item.available_hours_formatted = `${availWholeH}h ${availM > 0 ? `${availM}m ` : ''}available of 30h`;
          item.used_hours_formatted = `${usedWholeH}h ${usedM}m`;
          item.utilization_percentage = Math.min(100, Math.max(0, (usedH / limitH) * 100));
        }
      } else {
        mergedMap.set(uname, {
          id: a.id,
          username: uname,
          label: a.label || uname,
          weekly_hours_used: usedH,
          quota_limit_hours: limitH,
          available_hours: availH,
          available_hours_formatted: `${availWholeH}h ${availM > 0 ? `${availM}m ` : ''}available of 30h`,
          used_hours_formatted: `${usedWholeH}h ${usedM}m`,
          utilization_percentage: Math.min(100, Math.max(0, (usedH / limitH) * 100)),
          is_active: a.is_active !== false,
          tpu_available_hours: 20,
          ai_daily_available: 10.0,
          ai_monthly_available: 100.0,
        });
      }
    }

    const accountsList = Array.from(mergedMap.values());
    const totalCapacity = accountsList.length * 30.0;
    const totalUsed = accountsList.reduce((acc, a) => acc + a.weekly_hours_used, 0);
    const totalAvailable = Math.max(0, totalCapacity - totalUsed);

    return NextResponse.json({
      status: 'ok',
      accounts: accountsList,
      summary: {
        total_accounts: accountsList.length,
        total_capacity_hours: totalCapacity,
        total_used_hours: totalUsed,
        total_available_hours: totalAvailable,
        pool_utilization_percentage: totalCapacity > 0 ? (totalUsed / totalCapacity) * 100 : 0,
      },
      active_cluster_tunnels: activeTunnels,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
