import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { invalidateCache } from '@/lib/config';

// PUT /api/config/[key] — update a single config value
export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
    const { key } = await params;
    const { value } = await req.json();
    if (value === undefined) {
        return NextResponse.json({ error: 'value is required' }, { status: 400 });
    }

    const { error } = await supabase
        .from('system_config')
        .upsert({ key: key, value: String(value), updated_at: new Date().toISOString() });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Bust the in-memory config cache
    invalidateCache();

    return NextResponse.json({ success: true, key: key, value });
}
