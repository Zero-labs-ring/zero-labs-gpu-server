import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { encrypt } from '@/lib/crypto';

// PATCH /api/accounts/[id]
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const body = await req.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if ('label' in body) update.label = body.label;
    if ('model_assignment' in body) update.model_assignment = body.model_assignment;
    if ('is_active' in body) update.is_active = body.is_active;
    if ('weekly_hours_used' in body) update.weekly_hours_used = body.weekly_hours_used;

    // Re-encrypt API key if provided
    if (body.api_key?.trim()) {
        const { encrypted, iv, tag } = encrypt(body.api_key.trim());
        update.api_key_encrypted = encrypted;
        update.api_key_iv = iv;
        update.api_key_tag = tag;
    }

    const { error } = await supabase.from('kaggle_accounts').update(update).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
}

// DELETE /api/accounts/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { error } = await supabase.from('kaggle_accounts').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
}
