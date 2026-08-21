import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { startSession } from '@/lib/orchestrator';

export const dynamic = 'force-dynamic';
export const maxDuration = 18000;

/**
 * GET /api/sessions
 * Returns recent sessions from both new and legacy tables.
 */
export async function GET() {
  // Query both tables in parallel
  const [newResult, legacyResult] = await Promise.all([
    supabase
      .from('sessions')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(60),
    supabase
      .from('sessions_legacy')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(60),
  ]);

  const newSessions = newResult.data ?? [];
  const legacySessions = legacyResult.data ?? [];

  // Merge and return — legacy first (dashboard expects that shape), then new
  return NextResponse.json([...legacySessions, ...newSessions]);
}

/**
 * POST /api/sessions
 * Accepts both:
 *   - New format: { slot_id } → starts session for a slot
 *   - Legacy format: { model, account_id? } → fires session via old orchestrator
 */
export async function POST(req: NextRequest) {
  const body = await req.json();

  // New slot-based path with zero-gap manual rotation
  if (body.slot_id) {
    try {
      const { triggerManualHandoff } = await import('@/lib/orchestrator');
      const { success, session, message } = await triggerManualHandoff(body.slot_id);
      return NextResponse.json({ success, session, message }, { status: 200 });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Legacy model-based path (dashboard "Deploy Pro/Ultra Node" button)
  const { model, account_id } = body;
  if (!model || !['pro', 'ultra'].includes(model)) {
    return NextResponse.json({ error: 'model must be "pro" or "ultra"' }, { status: 400 });
  }

  try {
    // Dynamic import to avoid breaking if old orchestrator functions are removed
    const { KaggleClient } = await import('@/lib/kaggle');
    const { decrypt } = await import('@/lib/crypto');
    const { getConfigValue } = await import('@/lib/config');

    // Find account
    let account: Record<string, unknown> | null = null;
    if (account_id && account_id !== 'auto') {
      const { data } = await supabase
        .from('kaggle_accounts')
        .select('*')
        .eq('id', account_id)
        .single();
      account = data;
    } else {
      const { data: allAccounts } = await supabase
        .from('kaggle_accounts')
        .select('*')
        .eq('is_active', true)
        .order('weekly_hours_used', { ascending: true })
        .limit(1);
      account = allAccounts?.[0] ?? null;
    }

    if (!account) {
      return NextResponse.json({ success: false, message: 'No accounts available' });
    }

    const apiKey = decrypt(
      account.api_key_encrypted as string,
      account.api_key_iv as string,
      account.api_key_tag as string
    );
    const kaggle = new KaggleClient({ username: account.username as string, apiKey });

    const kernelSlug = await getConfigValue(`${model.toUpperCase()}_KERNEL_SLUG`, `zero-${model}-server-v3`);
    const softLimitMs = parseFloat(await getConfigValue('SESSION_SOFT_LIMIT_H', '10')) * 3600 * 1000;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + softLimitMs);

    // Insert session into legacy sessions table (sessions_legacy if renamed, or sessions)
    const tableName = 'sessions_legacy';
    let insertResult = await supabase
      .from(tableName)
      .insert({
        account_id: account.id,
        model,
        status: 'queued',
        kernel_slug: kernelSlug,
        pushed_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    // If sessions_legacy doesn't exist, the table wasn't renamed — skip the legacy push
    if (insertResult.error) {
      return NextResponse.json({
        success: false,
        message: `Legacy session table not available. Use slot-based orchestrator instead: POST /api/slots to create a slot.`,
      });
    }

    // Load the actual notebook file
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');

    const notebookFiles: Record<string, string[]> = {
      pro: ['pro_notebook_ornith9b_FIXED_v2.ipynb', 'pro_notebook.ipynb'],
      ultra: ['ultra_notebook.ipynb', 'Titan ultra.ipynb'],
    };
    const searchDirs = [
      join(process.cwd(), 'notebooks', 'active'),
      join(process.cwd(), 'push_dir'),
      join(process.cwd(), 'notebooks'),
    ];

    let notebook: any = null;
    for (const dir of searchDirs) {
      for (const file of notebookFiles[model] ?? []) {
        const p = join(dir, file);
        if (existsSync(p)) {
          try { notebook = JSON.parse(readFileSync(p, 'utf-8')); break; } catch { /* skip */ }
        }
      }
      if (notebook) break;
    }

    if (!notebook) {
      return NextResponse.json({ error: `No notebook file found for model "${model}"` }, { status: 500 });
    }

    // Inject SESSION_ID into the notebook so it can identify itself
    notebook.cells = notebook.cells || [];
    notebook.cells.unshift({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: [
        `# Auto-injected by zero-gpu-server orchestrator\n`,
        `SESSION_ID = "${insertResult.data.id}"\n`
      ]
    });

    // Push kernel with actual notebook content
    await kaggle.pushKernel(kernelSlug, notebook, 'NvidiaTeslaT4');

    await supabase
      .from(tableName)
      .update({ status: 'warming', started_at: new Date().toISOString() })
      .eq('id', insertResult.data.id);

    return NextResponse.json({
      success: true,
      message: `${model} session launched on @${account.username}`,
      session: insertResult.data,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * DELETE /api/sessions
 * Clear ended/failed session history.
 */
export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const all = searchParams.get('all') === 'true';

    if (all) {
      await supabase.from('sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      await supabase.from('sessions').delete().in('status', ['ended', 'failed']);
    }
    return NextResponse.json({ ok: true, message: 'Cleaned session history' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
