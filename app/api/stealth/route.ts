import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/stealth — returns rotation ranked accounts (tries top10_accounts view, falls back to direct query)
export async function GET() {
    // 1. Try top10_accounts database view if exists
    const { data: viewData, error: viewErr } = await supabase
        .from('top10_accounts')
        .select('*');

    if (!viewErr && viewData && viewData.length > 0) {
        return NextResponse.json(viewData);
    }

    // 2. Fallback: compute dynamically from accounts & kaggle_accounts
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

    const legacyList = (legacyResult.data ?? []).map(a => {
        const used = Number(a.weekly_hours_used || 0);
        return {
            id: a.id,
            username: a.username,
            label: a.label || '',
            weekly_hours_used: used,
            hours_remaining: Math.max(0, 30.0 - used),
            rotation_count: Number(a.rotation_count || 0),
            last_used_at: a.last_used_at || a.created_at,
            is_active: a.is_active,
        };
    });

    const newList = (newResult.data ?? []).map(a => {
        const used = (a.quota_used_minutes || 0) / 60;
        return {
            id: a.id,
            username: a.kaggle_username,
            label: a.label || '',
            weekly_hours_used: used,
            hours_remaining: Math.max(0, 30.0 - used),
            rotation_count: Math.floor((a.quota_used_minutes || 0) / 600),
            last_used_at: a.created_at,
            is_active: a.is_active,
        };
    });

    const combined = [...legacyList, ...newList].sort((a, b) => a.weekly_hours_used - b.weekly_hours_used);
    return NextResponse.json(combined);
}
