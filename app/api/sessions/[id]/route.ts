import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getKaggleClientForAccount } from '@/lib/kaggle';

// PATCH /api/sessions/[id] — update total_concurrent or other fields
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const body = await req.json();
    const allowed = ['total_concurrent', 'status'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
        if (k in body) update[k] = body[k];
    }

    const { error } = await supabase.from('sessions').update(update).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
}

// DELETE /api/sessions/[id] — kill a session
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // 1. Fetch session details to find tunnel URLs, kernel slug, account ID and model
    const { data: session } = await supabase
        .from('sessions')
        .select('model, endpoints, kernel_slug, account_id')
        .eq('id', id)
        .single();

    // 2. Mark session dead in database
    const { error } = await supabase
        .from('sessions')
        .update({
            status: 'dead',
            ended_at: new Date().toISOString(),
            error_message: 'Manually killed via dashboard',
            updated_at: new Date().toISOString()
        })
        .eq('id', id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 3. Mark gateway URLs unhealthy so traffic stops immediately
    if (session?.model) {
        await supabase
            .from('gateway_urls')
            .update({ is_healthy: false, updated_at: new Date().toISOString() })
            .eq('model', session.model);
    }

    // 4. Kaggle API does not provide a cancel endpoint; no action needed.
    // (previously attempted cancelKernel, now removed)

    // 5. Send instant shutdown signal to running Kaggle kernel through tunnel(s)
    if (session?.endpoints && Array.isArray(session.endpoints)) {
        const shutdownPromises = session.endpoints.map(async (ep: any) => {
            const tunnelUrl = ep.tunnel_url;
            if (tunnelUrl && typeof tunnelUrl === 'string' && tunnelUrl.startsWith('https://')) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3000);
                    await fetch(`${tunnelUrl.replace(/\/$/, '')}/shutdown`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal
                    }).catch(() => { /* ignore */ }).finally(() => clearTimeout(timeoutId));
                } catch {
                    // ignore network errors if tunnel is closing
                }
            }
        });
        await Promise.allSettled(shutdownPromises);
    }

    return NextResponse.json({ success: true, message: 'Session killed and shutdown signal sent' });
}
