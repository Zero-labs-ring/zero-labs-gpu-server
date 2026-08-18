import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { runOrchestrationCycle } from '@/lib/orchestrator';
import { getConfig } from '@/lib/config';

// GET /api/sessions
export async function GET() {
  const { data, error } = await supabase
    .from('sessions')
    .select('*, kaggle_accounts(username, label)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/sessions — fire a new session manually
export async function POST(req: NextRequest) {
  const { model } = await req.json();
  if (!model || !['pro', 'ultra'].includes(model)) {
    return NextResponse.json({ error: 'model must be "pro" or "ultra"' }, { status: 400 });
  }

  try {
    // Trigger orchestration — it will fire the session
    const result = await runOrchestrationCycle();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
