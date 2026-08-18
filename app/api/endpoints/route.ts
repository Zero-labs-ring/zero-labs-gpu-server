import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/endpoints — returns live endpoints from gateway_urls with 2m staleness check
export async function GET() {
    // A tunnel is only healthy if seen within the last 2 minutes (heartbeat runs every 60s)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    // 1. Primary source: gateway_urls table
    const { data: gateways, error: gwErr } = await supabase
        .from('gateway_urls')
        .select('model, tunnel_url, openai_api_url, is_healthy, last_seen_at')
        .eq('is_healthy', true)
        .gte('last_seen_at', twoMinutesAgo);

    if (gwErr) return NextResponse.json({ error: gwErr.message }, { status: 500 });

    const pro: string[] = [];
    const ultra: string[] = [];

    for (const gw of gateways ?? []) {
        const url = gw.openai_api_url || (gw.tunnel_url ? `${gw.tunnel_url}/v1` : null);
        if (!url) continue;
        if (gw.model === 'pro') pro.push(url);
        else if (gw.model === 'ultra') ultra.push(url);
    }

    // 2. Fallback: check active sessions table where status = 'ready'
    if (pro.length === 0 || ultra.length === 0) {
        const { data: sessions } = await supabase
            .from('sessions')
            .select('model, endpoints, status')
            .eq('status', 'ready')
            .not('endpoints', 'is', null);

        for (const s of sessions ?? []) {
            const eps: Array<{ openai_api_url: string }> = s.endpoints ?? [];
            for (const ep of eps) {
                if (ep.openai_api_url) {
                    if (s.model === 'pro' && !pro.includes(ep.openai_api_url)) {
                        pro.push(ep.openai_api_url);
                    } else if (s.model === 'ultra' && !ultra.includes(ep.openai_api_url)) {
                        ultra.push(ep.openai_api_url);
                    }
                }
            }
        }
    }

    return NextResponse.json({
        pro,
        ultra,
        healthy: {
            pro: pro.length > 0,
            ultra: ultra.length > 0,
        },
    });
}
