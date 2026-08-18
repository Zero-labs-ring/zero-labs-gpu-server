import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { tunnel_url, ...payload } = body;

        if (!tunnel_url) {
            return NextResponse.json({ error: 'tunnel_url is required' }, { status: 400 });
        }

        const base = tunnel_url.replace(/\/$/, '').replace(/\/v1$/, '');
        const target = `${base}/v1/chat/completions`;

        const apiKey = process.env.ZERO_API_KEY ?? 'zerotech13287';

        const upstream = await fetch(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        // Pass the response stream straight through
        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
            }
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
