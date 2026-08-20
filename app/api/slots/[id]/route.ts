import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyOrchestratorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/slots/:id
 * Updates slot config.
 * Body: { notebook_slug?: string, is_enabled?: boolean }
 * If is_enabled toggled to false: marks current session as handoff_pending
 * and lets it die naturally at timeout.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;
    const body = await req.json();
    const updates: Record<string, unknown> = {};

    if (body.notebook_slug !== undefined) {
      updates.notebook_slug = body.notebook_slug.trim();
    }

    if (body.is_enabled !== undefined) {
      updates.is_enabled = body.is_enabled;

      // If disabling: mark current active session as handoff_pending
      // so it finishes naturally but no new session starts after
      if (body.is_enabled === false) {
        const { data: activeSessions } = await supabase
          .from('sessions')
          .select('id')
          .eq('slot_id', id)
          .in('status', ['warming', 'serving']);

        if (activeSessions && activeSessions.length > 0) {
          const sessionIds = activeSessions.map((s: { id: string }) => s.id);
          await supabase
            .from('sessions')
            .update({ status: 'handoff_pending' })
            .in('id', sessionIds);
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update' },
        { status: 400 }
      );
    }

    const { data: slot, error } = await supabase
      .from('slots')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!slot) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    return NextResponse.json(slot);
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * DELETE /api/slots/:id
 * Soft-disables the slot. Running session expires naturally.
 * Does NOT kill running session — lets it expire at its timeout.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = verifyOrchestratorAuth(req);
  if (authErr) return authErr;

  try {
    const { id } = await params;

    const { data: slot, error } = await supabase
      .from('slots')
      .update({ is_enabled: false })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!slot) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    return NextResponse.json({
      message: `Slot ${slot.slot_index} disabled — current session will expire naturally`,
      slot,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
