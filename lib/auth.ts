import { NextRequest, NextResponse } from 'next/server';

/**
 * Verify the Authorization: Bearer <ORCHESTRATOR_SECRET> header.
 * Also accepts x-cron-secret header for backward compatibility with Vercel cron.
 * Returns null if authorized, or a 401 NextResponse if not.
 */
export function verifyOrchestratorAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.ORCHESTRATOR_SECRET;

  // If no secret configured, skip auth (dev mode)
  if (!secret) return null;

  // Check Bearer token
  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader === `Bearer ${secret}`) return null;

  // Check x-cron-secret (Vercel cron compat)
  const cronSecret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret') ?? '';
  if (cronSecret === secret) return null;

  return NextResponse.json(
    { error: 'Unauthorized — provide Authorization: Bearer <ORCHESTRATOR_SECRET>' },
    { status: 401 }
  );
}
