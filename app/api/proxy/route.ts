import { NextRequest, NextResponse } from 'next/server';
import { getEnvOrThrow } from '@/lib/env-check';
import crypto from 'crypto';

function isAuthorized(req: NextRequest, expectedApiKey: string): boolean {
    const auth = req.headers.get('authorization') ?? '';
    const xApiKey = req.headers.get('x-api-key') ?? '';

    const bearer = auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : '';
    const presented = bearer || xApiKey.trim();
    if (!presented) return false;

    const a = Buffer.from(presented);
    const b = Buffer.from(expectedApiKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasValidAdminSession(req: NextRequest): boolean {
    const token = req.cookies.get('zero_admin_session')?.value ?? '';
    if (!token) return false;

    try {
        const user = getEnvOrThrow('ADMIN_USERNAME');
        const pass = getEnvOrThrow('ADMIN_PASSWORD');
        const secret = getEnvOrThrow('ENCRYPTION_KEY');
        const expected = crypto.createHmac('sha256', secret).update(`${user}:${pass}`).digest('hex');

        const a = Buffer.from(token);
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function isLocalDevRequest(req: NextRequest): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    if (process.env.ALLOW_INSECURE_LOCAL_DEV_AUTH_BYPASS !== 'true') return false;
    const host = (req.headers.get('host') ?? '').toLowerCase();
    const origin = (req.headers.get('origin') ?? '').toLowerCase();
    const referer = (req.headers.get('referer') ?? '').toLowerCase();

    const localHosts = ['localhost:3000', '127.0.0.1:3000', '[::1]:3000'];
    const localOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'];

    return localHosts.includes(host)
        && localOrigins.some((o) => (origin ? origin.startsWith(o) : referer.startsWith(o)));
}

export async function POST(req: NextRequest) {
    try {
        const apiKey = getEnvOrThrow('ZERO_API_KEY');
        if (!isAuthorized(req, apiKey) && !hasValidAdminSession(req) && !isLocalDevRequest(req)) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { tunnel_url, ...payload } = body;

        if (!tunnel_url) {
            return NextResponse.json({ error: 'tunnel_url is required' }, { status: 400 });
        }

        const base = tunnel_url.replace(/\/$/, '').replace(/\/v1$/, '');
        const target = `${base}/v1/chat/completions`;

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
