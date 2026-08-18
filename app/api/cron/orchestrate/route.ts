import { NextRequest, NextResponse } from 'next/server';
import { runOrchestrationCycle } from '@/lib/orchestrator';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret');
  const expectedSecret = process.env.CRON_SECRET;

  if (expectedSecret && cronSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runOrchestrationCycle();
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      log: result.log,
    });
  } catch (err: unknown) {
    console.error('Orchestration cycle failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
