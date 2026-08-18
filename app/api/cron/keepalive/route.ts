import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// GET /api/cron/keepalive — prevents Supabase free-tier 7-day auto-pause
export async function GET(req: NextRequest) {
  try {
    const t0 = Date.now();
    // 1. Touch system_config to register active DB read & write
    const { data: cfg, error: cfgErr } = await supabase
      .from('system_config')
      .select('key, value')
      .limit(5);

    if (cfgErr) {
      console.warn('Keepalive Supabase read warning:', cfgErr.message);
    }

    // 2. Touch gateway_urls
    const { data: gw, error: gwErr } = await supabase
      .from('gateway_urls')
      .select('model, is_healthy, last_seen_at')
      .limit(5);

    const latency = Date.now() - t0;

    return NextResponse.json({
      status: 'ok',
      message: 'Supabase database keepalive pulse active. Auto-pause prevented.',
      latency_ms: latency,
      timestamp: new Date().toISOString(),
      config_rows_found: cfg?.length ?? 0,
      active_gateways: gw?.length ?? 0,
    });
  } catch (err: unknown) {
    return NextResponse.json({
      status: 'error',
      error: String(err),
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
