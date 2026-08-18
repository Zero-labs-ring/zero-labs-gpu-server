import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface SearchServerStats {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  averageLatencyMs: number;
  lastQueryAt: string | null;
  recentQueries: Array<{
    query: string;
    resultsCount: number;
    latencyMs: number;
    timestamp: string;
    success: boolean;
  }>;
}

// In-memory telemetry for Search Server Traffic
const globalSearchStats: SearchServerStats = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  averageLatencyMs: 0,
  lastQueryAt: null,
  recentQueries: [],
};

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export async function searchWeb(query: string, limit = 5): Promise<SearchResultItem[]> {
  const cleanQ = query.trim();
  if (!cleanQ) return [];

  const results: SearchResultItem[] = [];

  // 1. Primary Engine: DuckDuckGo HTML Web Search (Global web search, instant, unblocked)
  try {
    const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQ)}`;
    const res = await fetch(ddgHtmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const html = await res.text();
      const blocks = html.split('<div class="result results_links');

      for (const block of blocks.slice(1)) {
        if (results.length >= limit) break;

        const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
        const linkMatch = block.match(/href="([^"]+)"/i);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);

        if (titleMatch && linkMatch) {
          const rawTitle = decodeHtmlEntities(titleMatch[1]);
          const rawLink = linkMatch[1];
          let cleanUrl = rawLink;
          if (rawLink.includes('uddg=')) {
            const match = rawLink.match(/uddg=([^&]+)/);
            if (match) cleanUrl = decodeURIComponent(match[1]);
          }

          const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1]) : '';

          if (rawTitle && cleanUrl.startsWith('http') && !results.some((r) => r.url === cleanUrl)) {
            results.push({
              title: rawTitle,
              url: cleanUrl,
              snippet: snippet || `Real-time web search result for ${cleanQ}`,
              source: 'DuckDuckGo Web Search',
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('DuckDuckGo Web Search warning:', err);
  }

  // 2. Secondary Engine: Google Search RSS Feed (Real-Time News)
  if (results.length < limit) {
    try {
      const gnewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQ)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(gnewsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9',
        },
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const xml = await res.text();
        const itemBlocks = xml.split('<item>').slice(1);

        for (const item of itemBlocks) {
          if (results.length >= limit) break;

          const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
          const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
          const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
          const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

          if (titleMatch && linkMatch) {
            const rawTitle = decodeHtmlEntities(titleMatch[1]);
            const url = decodeHtmlEntities(linkMatch[1]);
            const snippet = descMatch ? decodeHtmlEntities(descMatch[1]) : `Latest news and updates on ${cleanQ}`;
            let source = sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : '';

            if (!source && rawTitle.includes(' - ')) {
              const parts = rawTitle.split(' - ');
              source = parts[parts.length - 1];
            }

            if (url && rawTitle && !results.some((r) => r.url === url)) {
              results.push({
                title: rawTitle,
                url,
                snippet,
                source: source || 'Google Real-Time Search',
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('Google Real-Time Search warning:', err);
    }
  }

  // 3. Tertiary Engine: Wikipedia Search API
  if (results.length < limit) {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQ)}&format=json&utf8=1&srlimit=${limit}`;
      const wikiRes = await fetch(wikiUrl, {
        headers: { 'User-Agent': 'ZeroLabsSearch/2.0 (contact@zerolabs.org)' },
        signal: AbortSignal.timeout(3000),
      });

      if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        const items = wikiData?.query?.search || [];
        for (const item of items) {
          if (results.length >= limit) break;
          const title = item.title;
          const snippet = decodeHtmlEntities(item.snippet);
          const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

          if (!results.some((r) => r.url === url || r.title.toLowerCase() === title.toLowerCase())) {
            results.push({
              title,
              url,
              snippet: snippet || `Comprehensive encyclopedia article on ${title}`,
              source: 'wikipedia.org',
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

  return results;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || url.searchParams.get('query');
  const isStats = url.searchParams.get('stats') === 'true';
  const limit = parseInt(url.searchParams.get('limit') || '5', 10);

  if (isStats || !q) {
    return NextResponse.json({
      status: 'online',
      provider: 'Zero Search Server Engine (Multi-Source Live)',
      stats: globalSearchStats,
    });
  }

  const t0 = Date.now();
  try {
    const results = await searchWeb(q, limit);
    const latency = Date.now() - t0;

    // Update telemetry
    globalSearchStats.totalQueries++;
    globalSearchStats.successfulQueries++;
    globalSearchStats.lastQueryAt = new Date().toISOString();
    globalSearchStats.averageLatencyMs = Math.round(
      (globalSearchStats.averageLatencyMs * (globalSearchStats.totalQueries - 1) + latency) / globalSearchStats.totalQueries
    );
    globalSearchStats.recentQueries.unshift({
      query: q,
      resultsCount: results.length,
      latencyMs: latency,
      timestamp: new Date().toISOString(),
      success: true,
    });
    if (globalSearchStats.recentQueries.length > 20) globalSearchStats.recentQueries.pop();

    return NextResponse.json({
      query: q,
      count: results.length,
      latency_ms: latency,
      results,
    });
  } catch (err) {
    const latency = Date.now() - t0;
    globalSearchStats.totalQueries++;
    globalSearchStats.failedQueries++;
    globalSearchStats.recentQueries.unshift({
      query: q,
      resultsCount: 0,
      latencyMs: latency,
      timestamp: new Date().toISOString(),
      success: false,
    });
    return NextResponse.json({ error: String(err), query: q, results: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = await req.json();
    const q = body.q || body.query || '';
    const limit = body.limit || 5;

    if (!q) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const results = await searchWeb(q, limit);
    const latency = Date.now() - t0;

    globalSearchStats.totalQueries++;
    globalSearchStats.successfulQueries++;
    globalSearchStats.lastQueryAt = new Date().toISOString();
    globalSearchStats.averageLatencyMs = Math.round(
      (globalSearchStats.averageLatencyMs * (globalSearchStats.totalQueries - 1) + latency) / globalSearchStats.totalQueries
    );
    globalSearchStats.recentQueries.unshift({
      query: q,
      resultsCount: results.length,
      latencyMs: latency,
      timestamp: new Date().toISOString(),
      success: true,
    });
    if (globalSearchStats.recentQueries.length > 20) globalSearchStats.recentQueries.pop();

    return NextResponse.json({
      query: q,
      count: results.length,
      latency_ms: latency,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
