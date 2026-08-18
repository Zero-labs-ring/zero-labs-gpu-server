import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

// GET /api/stealth — returns top10_accounts view
export async function GET() {
    const { data, error } = await supabase
        .from('top10_accounts')
        .select('*');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
}
