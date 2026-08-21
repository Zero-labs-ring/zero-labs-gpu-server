import { NextRequest, NextResponse } from 'next/server';
import { runSchedulerTick } from '@/lib/orchestrator';

export const dynamic = 'force-dynamic';
export const maxDuration = 18000;

/**
 * GET /api/cron/orchestrate
 * Legacy cron route — redirects to the new orchestrator tick.
 * Kept for backward compatibility during migration.
 */
export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret');
  const expectedSecret = process.env.CRON_SECRET || process.env.ORCHESTRATOR_SECRET;

  if (expectedSecret && cronSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const results = await runSchedulerTick();
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      slots: results,
    });
  } catch (err: unknown) {
    console.error('Orchestration cycle failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
