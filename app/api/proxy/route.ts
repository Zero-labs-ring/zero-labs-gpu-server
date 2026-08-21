import { NextRequest, NextResponse } from 'next/server';
import { getEnvOrThrow } from '@/lib/env-check';
import { searchWeb } from '@/app/api/search/route';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 18000;

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

        const rawModel = String(payload.model || '');
        const enableSearch = Boolean(payload.web_search ?? payload.webSearch ?? payload.search ?? false);
        const isSearchModel = rawModel.toLowerCase().includes('search');
        const shouldUseSearch = enableSearch || isSearchModel;

        let searchResults: Array<{ title: string; url: string; snippet: string; source?: string }> = [];

        if (shouldUseSearch && Array.isArray(payload.messages) && payload.messages.length > 0) {
            const lastUserIdx = payload.messages.map((m: { role: string }) => m.role).lastIndexOf('user');
            const lastUserMsg = lastUserIdx >= 0 ? payload.messages[lastUserIdx].content : '';
            if (lastUserMsg) {
                try {
                    searchResults = await searchWeb(lastUserMsg, 5);
                    if (searchResults.length > 0) {
                        const searchContext = searchResults.map((r, i) =>
                            `[${i + 1}] "${r.title}"\nSource: ${r.url}\n${r.snippet}`
                        ).join('\n\n');

                        const searchSystemInstruction =
                            `You are an advanced AI assistant with real-time internet access powered by Zero Search Server.\n` +
                            `Fresh search results have been retrieved and attached to the user's query.\n` +
                            `Use these search results to provide an accurate, up-to-date answer and cite sources using bracketed numbers like [1], [2].`;

                        const sysIdx = payload.messages.findIndex((m: { role: string }) => m.role === 'system');
                        if (sysIdx >= 0) {
                            payload.messages[sysIdx] = {
                                role: 'system',
                                content: `${payload.messages[sysIdx].content}\n\n${searchSystemInstruction}`,
                            };
                        } else {
                            payload.messages.unshift({
                                role: 'system',
                                content: searchSystemInstruction,
                            });
                        }

                        const updatedUserIdx = payload.messages.map((m: { role: string }) => m.role).lastIndexOf('user');
                        if (updatedUserIdx >= 0) {
                            const origQuery = payload.messages[updatedUserIdx].content;
                            payload.messages[updatedUserIdx] = {
                                role: 'user',
                                content: `=== REAL-TIME WEB SEARCH RESULTS ===\n${searchContext}\n=== END SEARCH RESULTS ===\n\nUser Question: ${origQuery}`,
                            };
                        }
                    }
                } catch (sErr) {
                    console.warn('[proxy] Search augmentation failed:', sErr);
                }
            }
        }

        const requestedMaxTokens = payload.max_tokens ?? payload.max_new_tokens ?? 131072;
        payload.max_tokens = Math.min(Math.max(Number(requestedMaxTokens) || 131072, 512), 131072);

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

        const headers = new Headers();
        headers.set('Content-Type', upstream.headers.get('Content-Type') || 'text/event-stream');
        headers.set('Cache-Control', 'no-cache, no-transform');
        headers.set('Connection', 'keep-alive');
        headers.set('X-Accel-Buffering', 'no');
        if (searchResults.length > 0) {
            headers.set('X-Search-Sources-Count', String(searchResults.length));
        }

        if (searchResults.length > 0 && upstream.body) {
            const encoder = new TextEncoder();
            const initialChunk = encoder.encode(
                `data: ${JSON.stringify({ type: 'search_sources', search_sources: searchResults })}\n\n`
            );
            const transformStream = new TransformStream({
                start(controller) {
                    controller.enqueue(initialChunk);
                },
                transform(chunk, controller) {
                    controller.enqueue(chunk);
                },
            });

            return new Response(upstream.body.pipeThrough(transformStream), {
                status: upstream.status,
                headers,
            });
        }

        // Pass the response stream straight through
        return new Response(upstream.body, {
            status: upstream.status,
            headers,
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
