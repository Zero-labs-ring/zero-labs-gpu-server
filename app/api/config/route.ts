import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

// GET /api/config — list all system_config rows
export async function GET() {
    const { data, error } = await supabase
        .from('system_config')
        .select('key, value, description')
        .order('key');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}
