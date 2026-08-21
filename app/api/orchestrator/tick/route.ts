import { NextRequest, NextResponse } from 'next/server';
import { runSchedulerTick } from '@/lib/orchestrator';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

/**
 * POST /api/orchestrator/tick
 * Called by Vercel cron every 15 minutes.
 * Runs the scheduler tick: starts missing sessions, triggers handoffs,
 * promotes warming→serving, retries failed sessions.
 */
export async function POST(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const results = await runSchedulerTick();

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      slots: results,
      summary: {
        total_slots: results.length,
        actions: results.reduce((acc, r) => {
          acc[r.action] = (acc[r.action] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
    });
  } catch (err: unknown) {
    console.error('[tick] Scheduler tick failed:', err);
    return NextResponse.json(
      { error: 'Scheduler tick failed', details: String(err) },
      { status: 500 }
    );
  }
}

// Also support GET for Vercel cron (which sends GET by default)
export async function GET(req: NextRequest) {
  return POST(req);
}
