import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { searchWeb, SearchResultItem } from '@/app/api/search/route';
import { getEnvOrThrow } from '@/lib/env-check';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

interface ChatMessage {
  role: string;
  content: string;
}

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

// Helper to look up active live endpoint for a model
async function getLiveEndpoint(
  model: 'pro' | 'ultra',
  defaultApiKey: string
): Promise<{ url: string; apiKey: string; gwId?: string } | null> {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // 1. Check gateway_urls (fresh within 10 minutes)
    const { data: gw } = await supabase
      .from('gateway_urls')
      .select('id, tunnel_url, openai_api_url, api_key, is_healthy, last_seen_at')
      .eq('model', model)
      .eq('is_healthy', true)
      .gte('last_seen_at', tenMinutesAgo)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (gw?.tunnel_url) {
      const base = gw.tunnel_url.replace(/\/$/, '').replace(/\/v1$/, '');
      return {
        url: `${base}/v1/chat/completions`,
        apiKey: gw.api_key || defaultApiKey,
        gwId: gw.id,
      };
    }

    // 2. Fallback: check gateway_urls updated within 15 minutes if healthy
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: gwAny } = await supabase
      .from('gateway_urls')
      .select('id, tunnel_url, api_key')
      .eq('model', model)
      .eq('is_healthy', true)
      .gte('updated_at', fifteenMinutesAgo)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (gwAny?.tunnel_url) {
      const base = gwAny.tunnel_url.replace(/\/$/, '').replace(/\/v1$/, '');
      return {
        url: `${base}/v1/chat/completions`,
        apiKey: gwAny.api_key || defaultApiKey,
        gwId: gwAny.id,
      };
    }

    // 3. Fallback: check sessions_legacy or sessions table
    const { data: sessLegacy } = await supabase
      .from('sessions_legacy')
      .select('endpoints')
      .eq('model', model)
      .in('status', ['ready', 'serving', 'warming'])
      .not('endpoints', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessLegacy?.endpoints && Array.isArray(sessLegacy.endpoints) && sessLegacy.endpoints.length > 0) {
      const ep = sessLegacy.endpoints[0];
      const tunnel = ep.tunnel_url || (ep.openai_api_url ? ep.openai_api_url.replace(/\/v1$/, '') : null);
      if (tunnel) {
        const base = tunnel.replace(/\/$/, '');
        return {
          url: `${base}/v1/chat/completions`,
          apiKey: defaultApiKey,
        };
      }
    }
  } catch (err) {
    console.error('Error finding live endpoint:', err);
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const defaultApiKey = getEnvOrThrow('ZERO_API_KEY');
    if (!isAuthorized(req, defaultApiKey) && !hasValidAdminSession(req) && !isLocalDevRequest(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      model: rawModel = 'pro',
      messages = [],
      stream = false,
      temperature = 0.7,
      ...extra
    } = body;

    // Lift max_tokens ceiling to 128K (131,072) with dynamic query-aware calculation
    const lastUserPrompt = messages.length > 0 ? (messages[messages.length - 1]?.content || '') : '';
    const isComplexQuery = /\b(code|function|script|class|python|html|react|app|build|implement|debug|algorithm|sql|file|program|explain in detail|full)\b/i.test(lastUserPrompt);
    const rawTokens = body.max_tokens ?? body.max_new_tokens ?? body.maxTokens ?? (extra as Record<string, unknown>)?.max_tokens ?? (extra as Record<string, unknown>)?.max_new_tokens;
    const requestedMaxTokens = rawTokens ? Number(rawTokens) : (isComplexQuery ? 131072 : 131072);
    const effectiveMaxTokens = Math.min(Math.max(Number(requestedMaxTokens) || 131072, 512), 131072);

    // Check if web search should be activated across all parameter conventions
    const enableSearch = Boolean(
      body.web_search ?? body.webSearch ?? body.search ?? (extra as Record<string, unknown>)?.web_search ?? (extra as Record<string, unknown>)?.webSearch ?? false
    );
    const isSearchModel = String(rawModel).toLowerCase().includes('search');
    const shouldUseSearch = enableSearch || isSearchModel;

    // Normalize model to 'pro' or 'ultra'
    let targetModel: 'pro' | 'ultra' = 'pro';
    if (String(rawModel).toLowerCase().includes('ultra')) {
      targetModel = 'ultra';
    }

    let processedMessages: ChatMessage[] = [...messages];
    let searchResults: SearchResultItem[] = [];

    // Web Search Augmentation (Search Server integration)
    if (shouldUseSearch && processedMessages.length > 0) {
      const lastUserIdx = processedMessages.map(m => m.role).lastIndexOf('user');
      const lastUserMsg = lastUserIdx >= 0 ? processedMessages[lastUserIdx].content : '';

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

            // 1. Prepend or update system instruction
            const sysIdx = processedMessages.findIndex(m => m.role === 'system');
            if (sysIdx >= 0) {
              processedMessages[sysIdx] = {
                role: 'system',
                content: `${processedMessages[sysIdx].content}\n\n${searchSystemInstruction}`,
              };
            } else {
              processedMessages.unshift({
                role: 'system',
                content: searchSystemInstruction,
              });
            }

            // 2. Attach real-time search context directly to the active user prompt
            const updatedUserIdx = processedMessages.map(m => m.role).lastIndexOf('user');
            if (updatedUserIdx >= 0) {
              const origQuery = processedMessages[updatedUserIdx].content;
              processedMessages[updatedUserIdx] = {
                role: 'user',
                content: `=== REAL-TIME WEB SEARCH RESULTS ===\n${searchContext}\n=== END SEARCH RESULTS ===\n\nUser Question: ${origQuery}`,
              };
            }
          }
        } catch (sErr) {
          console.warn('Search augmentation failed:', sErr);
        }
      }
    }

    // Resolve live upstream tunnel endpoint from Supabase
    const liveTarget = await getLiveEndpoint(targetModel, defaultApiKey);
    if (!liveTarget) {
      return NextResponse.json({
        error: `No live GPU endpoint is currently active for model '${targetModel}'. Please start a GPU session in the dashboard.`,
        model: targetModel,
        status: 'unavailable',
      }, { status: 503 });
    }

    // Proxy request to Kaggle live tunnel with safe error handling
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(liveTarget.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${liveTarget.apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel === 'pro' ? 'ornith-9b' : 'titan-ultra',
          messages: processedMessages,
          temperature,
          max_tokens: effectiveMaxTokens,
          stream,
          ...extra,
        }),
        signal: req.signal,
      });
    } catch (fetchErr: unknown) {
      console.error(`Failed to reach upstream GPU tunnel ${liveTarget.url}:`, fetchErr);
      // Mark stale gateway as unhealthy
      if (liveTarget.gwId) {
        await supabase.from('gateway_urls').update({ is_healthy: false }).eq('id', liveTarget.gwId);
      }
      // 🚀 Auto-trigger orchestrator failover in background to spin up next account
      try {
        const { runSchedulerTick } = await import('@/lib/orchestrator');
        runSchedulerTick().catch(e => console.error('[failover] Auto-spinup error:', e));
      } catch {}

      return NextResponse.json({
        error: `GPU node at ${liveTarget.url} is unreachable or offline. Automatic failover triggered to next account. Please retry shortly.`,
        model: targetModel,
        status: 'unreachable',
        auto_failover: true,
      }, { status: 503 });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      // Mark stale gateway as unhealthy if upstream returns 5xx or 530 tunnel error
      if (liveTarget.gwId && [500, 502, 503, 504, 530].includes(upstreamRes.status)) {
        await supabase.from('gateway_urls').update({ is_healthy: false }).eq('id', liveTarget.gwId);
        // 🚀 Auto-trigger orchestrator failover in background to spin up next account
        try {
          const { runSchedulerTick } = await import('@/lib/orchestrator');
          runSchedulerTick().catch(e => console.error('[failover] Auto-spinup error:', e));
        } catch {}
      }
      return NextResponse.json({
        error: `Upstream GPU error (${upstreamRes.status}): ${errText}`,
      }, { status: upstreamRes.status });
    }

    // Direct streaming response pass-through
    if (stream) {
      const headers = new Headers();
      headers.set('Content-Type', 'text/event-stream; charset=utf-8');
      headers.set('Cache-Control', 'no-cache, no-transform');
      headers.set('Connection', 'keep-alive');
      headers.set('X-Accel-Buffering', 'no');
      if (searchResults.length > 0) {
        headers.set('X-Search-Sources-Count', String(searchResults.length));
      }

      if (searchResults.length > 0 && upstreamRes.body) {
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

        return new Response(upstreamRes.body.pipeThrough(transformStream), {
          status: 200,
          headers,
        });
      }

      return new Response(upstreamRes.body, {
        status: 200,
        headers,
      });
    }

    // Non-streaming JSON response
    const json = await upstreamRes.json();
    if (searchResults.length > 0) {
      json.search_sources = searchResults;
    }
    return NextResponse.json(json);
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
