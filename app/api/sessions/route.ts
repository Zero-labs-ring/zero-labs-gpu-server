import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { runOrchestrationCycle, fireSingleSession } from '@/lib/orchestrator';

// GET /api/sessions
export async function GET() {
    const { data, error } = await supabase
        .from('sessions')
        .select('*, kaggle_accounts(username, label)')
        .order('created_at', { ascending: false })
        .limit(60);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}

// POST /api/sessions — manually fire an individual model session
export async function POST(req: Request) {
    const { model } = await req.json();
    if (!model || !['pro', 'ultra'].includes(model)) {
        return NextResponse.json({ error: 'model must be "pro" or "ultra"' }, { status: 400 });
    }
    try {
        const result = await fireSingleSession(model as 'pro' | 'ultra');
        return NextResponse.json({ ...result });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}

// DELETE /api/sessions — clear inactive / dead session history
export async function DELETE(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const all = searchParams.get('all') === 'true';

        if (all) {
            await supabase.from('sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        } else {
            await supabase.from('sessions').delete().in('status', ['dead', 'completed', 'cancelled', 'error']);
        }
        return NextResponse.json({ ok: true, message: 'Cleaned session history' });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
