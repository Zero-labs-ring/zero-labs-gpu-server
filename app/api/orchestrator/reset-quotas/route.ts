import { NextRequest, NextResponse } from 'next/server';
import { resetAllQuotas } from '@/lib/orchestrator';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/orchestrator/reset-quotas
 * Called by Vercel cron every Saturday at midnight UTC.
 * Resets quota_used_minutes to 0 for all active accounts.
 */
export async function POST(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const result = await resetAllQuotas();

    return NextResponse.json({
      success: true,
      message: `Weekly quota reset complete — ${result.reset_count} accounts zeroed`,
      ...result,
    });
  } catch (err: unknown) {
    console.error('[reset-quotas] Quota reset failed:', err);
    return NextResponse.json(
      { error: 'Quota reset failed', details: String(err) },
      { status: 500 }
    );
  }
}

// Support GET for Vercel cron
export async function GET(req: NextRequest) {
  return POST(req);
}
