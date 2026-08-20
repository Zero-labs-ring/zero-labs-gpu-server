import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { startSession } from '@/lib/orchestrator';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/slots
 * Returns all slots with their current session status.
 */
export async function GET(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { data: slots, error } = await supabase
      .from('slots')
      .select('*')
      .order('slot_index', { ascending: true });

    if (error) throw new Error(error.message);

    // Attach current active session to each slot
    const { data: activeSessions } = await supabase
      .from('sessions')
      .select('*')
      .in('status', ['warming', 'serving', 'handoff_pending']);

    const sessionsBySlot = new Map<string, unknown>();
    for (const session of activeSessions ?? []) {
      // Keep the most recent one per slot
      if (!sessionsBySlot.has(session.slot_id)) {
        sessionsBySlot.set(session.slot_id, session);
      }
    }

    const result = (slots ?? []).map((slot: { id: string; slot_index: number; notebook_slug: string; is_enabled: boolean; created_at: string }) => ({
      ...slot,
      current_session: sessionsBySlot.get(slot.id) ?? null,
    }));

    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/slots
 * Creates a new slot and immediately starts a session for it.
 * Body: { notebook_slug: string, slot_index?: number }
 */
export async function POST(req: NextRequest) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const body = await req.json();
    const { notebook_slug, slot_index } = body;

    if (!notebook_slug?.trim()) {
      return NextResponse.json(
        { error: 'notebook_slug is required' },
        { status: 400 }
      );
    }

    // Auto-assign slot_index if not given
    let assignedIndex = slot_index;
    if (assignedIndex === undefined || assignedIndex === null) {
      const { data: maxSlot } = await supabase
        .from('slots')
        .select('slot_index')
        .order('slot_index', { ascending: false })
        .limit(1)
        .single();

      assignedIndex = (maxSlot?.slot_index ?? -1) + 1;
    }

    // Insert slot
    const { data: slot, error } = await supabase
      .from('slots')
      .insert({
        slot_index: assignedIndex,
        notebook_slug: notebook_slug.trim(),
        is_enabled: true,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Immediately start a session for this slot
    const session = await startSession(slot.id);

    return NextResponse.json({
      slot,
      initial_session: session,
      message: session
        ? `Slot ${assignedIndex} created and session started`
        : `Slot ${assignedIndex} created but no accounts available — will retry next tick`,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
