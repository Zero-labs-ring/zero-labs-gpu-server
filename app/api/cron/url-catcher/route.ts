import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret');
  const expectedSecret = process.env.CRON_SECRET;

  if (expectedSecret && cronSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Mark stale gateways that haven't sent a heartbeat in >15 min
    const { error: staleErr } = await supabase.rpc('mark_stale_gateways');
    if (staleErr) {
      console.warn('mark_stale_gateways RPC warning:', staleErr.message);
    }

    // 2. Query active sessions and refresh endpoints if missing
    const { data: liveGateways } = await supabase
      .from('gateway_urls')
      .select('*')
      .eq('is_healthy', true);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      healthy_gateways: liveGateways?.length ?? 0,
    });
  } catch (err: unknown) {
    console.error('URL catcher cron failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
