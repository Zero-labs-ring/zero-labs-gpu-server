import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/endpoints — returns live endpoints from gateway_urls with 2m staleness check
export async function GET() {
    try {
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

        // 1. Primary source: gateway_urls table
        const { data: gateways } = await supabase
            .from('gateway_urls')
            .select('model, tunnel_url, openai_api_url, is_healthy, last_seen_at')
            .eq('is_healthy', true);

        const pro: string[] = [];
        const ultra: string[] = [];

        for (const gw of gateways ?? []) {
            const url = gw.openai_api_url || (gw.tunnel_url ? `${gw.tunnel_url}/v1` : null);
            if (!url) continue;
            if (gw.model === 'pro') pro.push(url);
            else if (gw.model === 'ultra') ultra.push(url);
        }

        // 2. Fallback: check active sessions
        if (pro.length === 0 || ultra.length === 0) {
            const { data: sessions } = await supabase
                .from('sessions')
                .select('model, endpoints, status')
                .in('status', ['ready', 'serving'])
                .not('endpoints', 'is', null);

            for (const s of sessions ?? []) {
                const eps: Array<{ openai_api_url?: string; tunnel_url?: string }> = s.endpoints ?? [];
                for (const ep of eps) {
                    const epUrl = ep.openai_api_url || (ep.tunnel_url ? `${ep.tunnel_url}/v1` : null);
                    if (epUrl) {
                        if (s.model === 'pro' && !pro.includes(epUrl)) {
                            pro.push(epUrl);
                        } else if (s.model === 'ultra' && !ultra.includes(epUrl)) {
                            ultra.push(epUrl);
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
    } catch (err: unknown) {
        return NextResponse.json({
            pro: [],
            ultra: [],
            healthy: { pro: false, ultra: false },
            error: String(err),
        });
    }
}
