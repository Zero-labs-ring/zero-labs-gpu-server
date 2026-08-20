import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Helper: try to find and update a session in either table
async function findSessionTable(id: string): Promise<'sessions' | 'sessions_legacy' | null> {
  try {
    const { data: newSession } = await supabase
      .from('sessions')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (newSession) return 'sessions';
  } catch { /* ignore */ }

  try {
    const { data: legacySession } = await supabase
      .from('sessions_legacy')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (legacySession) return 'sessions_legacy';
  } catch { /* ignore */ }

  return null;
}

// PATCH /api/sessions/[id] — update fields
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  const table = await findSessionTable(id);
  if (!table) return NextResponse.json({ success: true, message: 'Session not found or already removed' });

  const allowed = ['total_concurrent', 'status'];
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (k in body) update[k] = body[k];
  }

  const { error } = await supabase.from(table).update(update).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

// DELETE /api/sessions/[id] — kill a session
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const table = await findSessionTable(id);
  if (!table) return NextResponse.json({ success: true, message: 'Session already killed or removed' });

  // Fetch session details
  const { data: session } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .single();

  // Mark session dead/ended
  const endStatus = table === 'sessions' ? 'ended' : 'dead';
  const { error } = await supabase
    .from(table)
    .update({
      status: endStatus,
      ended_at: new Date().toISOString(),
      ...(table === 'sessions_legacy' ? { error_message: 'Manually killed via dashboard' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mark gateway URLs unhealthy (legacy sessions)
  if (session?.model) {
    await supabase
      .from('gateway_urls')
      .update({ is_healthy: false, updated_at: new Date().toISOString() })
      .eq('model', session.model);
  }

  // Send shutdown signal to tunnel endpoints (legacy sessions)
  if (session?.endpoints && Array.isArray(session.endpoints)) {
    const shutdownPromises = session.endpoints.map(async (ep: any) => {
      const tunnelUrl = ep.tunnel_url;
      if (tunnelUrl && typeof tunnelUrl === 'string' && tunnelUrl.startsWith('https://')) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          await fetch(`${tunnelUrl.replace(/\/$/, '')}/shutdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
          }).catch(() => { /* ignore */ }).finally(() => clearTimeout(timeoutId));
        } catch {
          // ignore network errors if tunnel is closing
        }
      }
    });
    await Promise.allSettled(shutdownPromises);
  }

  return NextResponse.json({ success: true, message: 'Session killed' });
}
