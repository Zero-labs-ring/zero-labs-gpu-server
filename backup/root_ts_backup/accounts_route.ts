import { NextResponse } from 'next/server';
import { supabase } from '@/supabase';

// GET /api/accounts — list all kaggle accounts
export async function GET() {
    const { data, error } = await supabase
        .from('kaggle_accounts')
        .select('id,username,label,model_assignment,weekly_hours_used,weekly_hours_reset_at,rotation_count,last_used_at,is_active,created_at')
        .order('weekly_hours_used', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}

// POST /api/accounts — add a new kaggle account (encrypts API key)
export async function POST(req: Request) {
    const body = await req.json();
    const { username, api_key, label, model_assignment, is_active } = body;

    if (!username?.trim() || !api_key?.trim()) {
        return NextResponse.json({ error: 'username and api_key are required' }, { status: 400 });
    }

    // Encrypt the API key using the crypto module
    const { encrypt } = await import('@/crypto');
    const { encrypted, iv, tag } = encrypt(api_key);

    const { data, error } = await supabase
        .from('kaggle_accounts')
        .insert({
            username: username.trim(),
            api_key_encrypted: encrypted,
            api_key_iv: iv,
            api_key_tag: tag,
            label: label?.trim() || null,
            model_assignment: model_assignment || 'both',
            is_active: is_active !== undefined ? is_active : true,
        })
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}
