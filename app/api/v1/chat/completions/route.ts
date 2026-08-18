import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { searchWeb, SearchResultItem } from '@/app/api/search/route';

export const dynamic = 'force-dynamic';

interface ChatMessage {
  role: string;
  content: string;
}

// Helper to look up active live endpoint for a model
async function getLiveEndpoint(model: 'pro' | 'ultra'): Promise<{ url: string; apiKey: string; gwId?: string } | null> {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    // 1. Check gateway_urls (fresh within 2 minutes)
    const { data: gw } = await supabase
      .from('gateway_urls')
      .select('id, tunnel_url, openai_api_url, api_key, is_healthy, last_seen_at')
      .eq('model', model)
      .eq('is_healthy', true)
      .gte('last_seen_at', twoMinutesAgo)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (gw?.tunnel_url) {
      const base = gw.tunnel_url.replace(/\/$/, '').replace(/\/v1$/, '');
      return {
        url: `${base}/v1/chat/completions`,
        apiKey: gw.api_key || process.env.ZERO_API_KEY || 'zerotech13287',
        gwId: gw.id,
      };
    }

    // 2. Fallback: check active sessions table where status = 'ready'
    const { data: sess } = await supabase
      .from('sessions')
      .select('endpoints, model, status')
      .eq('model', model)
      .eq('status', 'ready')
      .not('endpoints', 'is', null)
      .order('ready_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sess?.endpoints && Array.isArray(sess.endpoints) && sess.endpoints.length > 0) {
      const ep = sess.endpoints[0];
      const tunnel = ep.tunnel_url || (ep.openai_api_url ? ep.openai_api_url.replace(/\/v1$/, '') : null);
      if (tunnel) {
        const base = tunnel.replace(/\/$/, '');
        return {
          url: `${base}/v1/chat/completions`,
          apiKey: process.env.ZERO_API_KEY || 'zerotech13287',
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
    const body = await req.json();
    const {
      model: rawModel = 'pro',
      messages = [],
      stream = false,
      temperature = 0.7,
      max_tokens = 512,
      web_search: enableSearch = false,
      ...extra
    } = body;

    // Check if web search should be activated
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
      const lastUserMsg = [...processedMessages].reverse().find(m => m.role === 'user')?.content || '';
      if (lastUserMsg) {
        try {
          searchResults = await searchWeb(lastUserMsg, 5);
          if (searchResults.length > 0) {
            const searchContext = searchResults.map((r, i) =>
              `[${i + 1}] "${r.title}"\nSource: ${r.url}\n${r.snippet}`
            ).join('\n\n');

            const searchSystemPrompt =
              `You are an advanced AI assistant with real-time internet access powered by the Zero Search Server.\n` +
              `Use the following fresh search results to provide an accurate, up-to-date answer. ` +
              `Cite your sources using bracketed numbers like [1], [2] corresponding to the search results.\n\n` +
              `=== REAL-TIME SEARCH RESULTS ===\n${searchContext}\n=== END SEARCH RESULTS ===`;

            // Prepend or update system message
            const sysIdx = processedMessages.findIndex(m => m.role === 'system');
            if (sysIdx >= 0) {
              processedMessages[sysIdx] = {
                role: 'system',
                content: `${processedMessages[sysIdx].content}\n\n${searchSystemPrompt}`,
              };
            } else {
              processedMessages.unshift({
                role: 'system',
                content: searchSystemPrompt,
              });
            }
          }
        } catch (sErr) {
          console.warn('Search augmentation failed:', sErr);
        }
      }
    }

    // Resolve live upstream tunnel endpoint from Supabase
    const liveTarget = await getLiveEndpoint(targetModel);
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
          max_tokens,
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
      return NextResponse.json({
        error: `GPU node at ${liveTarget.url} is unreachable or offline. Please start a new session in the dashboard.`,
        model: targetModel,
        status: 'unreachable',
      }, { status: 503 });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
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
      if (searchResults.length > 0) {
        headers.set('X-Search-Sources-Count', String(searchResults.length));
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
