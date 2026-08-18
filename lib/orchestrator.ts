import { supabase } from './supabase';
import { KaggleClient, parseNotebookOutput, extractTunnelUrls, getKaggleClientForAccount } from './kaggle';
import { decrypt } from './crypto';
import { getConfigValue, getConfig } from './config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

type ModelType = 'pro' | 'ultra';

function loadNotebook(model: ModelType): object {
  const possibleFilenames = model === 'pro'
    ? ['pro_notebook_ornith9b_FIXED_v2.ipynb', 'pro_notebook.ipynb']
    : ['ultra_notebook.ipynb', 'Titan ultra.ipynb', 'titan_ultra_gguf_pipeline_v4.ipynb'];

  const possibleDirs = [
    join(process.cwd(), 'notebooks', 'active'),
    join(process.cwd(), 'push_dir'),
    join(process.cwd(), 'notebooks'),
  ];

  for (const dir of possibleDirs) {
    for (const file of possibleFilenames) {
      const p = join(dir, file);
      if (existsSync(p)) {
        try {
          return JSON.parse(readFileSync(p, 'utf-8'));
        } catch { /* continue */ }
      }
    }
  }

  // Fallback empty kernel template if running in serverless cloud without local filesystem notebooks
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10.0' }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

export async function runOrchestrationCycle(): Promise<{ log: string[] }> {
  const log: string[] = [];
  const cfg = await getConfig();

  const targets: Record<ModelType, number> = {
    pro: parseInt(cfg['PRO_TARGET_SESSIONS'] ?? '1', 10),
    ultra: parseInt(cfg['ULTRA_TARGET_SESSIONS'] ?? '1', 10),
  };

  for (const model of ['pro', 'ultra'] as ModelType[]) {
    const msgs = await manageModel(model, targets[model], cfg);
    log.push(...msgs);
  }

  // Reset weekly hours for accounts whose reset_at has passed
  await supabase
    .from('kaggle_accounts')
    .update({
      weekly_hours_used: 0,
      weekly_hours_reset_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    })
    .lt('weekly_hours_reset_at', new Date().toISOString());

  return { log };
}

export async function fireSingleSession(model: ModelType): Promise<{ success: boolean; message: string; log: string[] }> {
  const cfg = await getConfig();
  const log: string[] = [];
  await fireNewSession(model, cfg, log);
  const isOk = !log.some(l => l.includes('❌'));
  return {
    success: isOk,
    message: log.join(' | '),
    log,
  };
}

async function manageModel(
  model: ModelType,
  target: number,
  cfg: Record<string, string>
): Promise<string[]> {
  const log: string[] = [];
  const softLimitMs = parseFloat(cfg['SESSION_SOFT_LIMIT_H'] ?? '9') * 3600 * 1000;
  const prefireMs = parseFloat(cfg['PREFIRE_BUFFER_MIN'] ?? '30') * 60 * 1000;

  const { data: active } = await supabase
    .from('sessions')
    .select('*')
    .eq('model', model)
    .in('status', ['queued', 'warming', 'ready', 'expiring']);

  log.push(`[${model}] ${active?.length ?? 0}/${target} sessions active`);

  // Health check each active session
  for (const session of active ?? []) {
    await checkSessionHealth(session, log);
  }

  // Re-count after health checks
  const { data: fresh } = await supabase
    .from('sessions')
    .select('id, expires_at, status')
    .eq('model', model)
    .in('status', ['queued', 'warming', 'ready', 'expiring']);

  const freshCount = fresh?.length ?? 0;

  // Check if any need pre-firing
  const needsPrefire = (fresh ?? []).some((s: { expires_at: string | null }) => {
    if (!s.expires_at) return false;
    const left = new Date(s.expires_at).getTime() - Date.now();
    return left < prefireMs;
  });

  const toFire = Math.max(0, target - freshCount);
  if (toFire > 0) {
    log.push(`[${model}] Firing ${toFire} new session(s)`);
    for (let i = 0; i < toFire; i++) {
      await fireNewSession(model, cfg, log);
    }
  }

  if (needsPrefire) {
    log.push(`[${model}] Pre-firing overlap session`);
    await fireNewSession(model, cfg, log);
  }

  return log;
}

async function checkSessionHealth(
  session: Record<string, unknown>,
  log: string[]
): Promise<void> {
  const kaggle = await getKaggleClientForAccount(session.account_id as string);
  if (!kaggle) {
    await markDead(session.id as string, 'Account not found');
    return;
  }

  try {
    const { data: account } = await supabase
      .from('kaggle_accounts')
      .select('username')
      .eq('id', session.account_id)
      .single();

    const username = account?.username ?? '';
    const slug = session.kernel_slug as string;

    const statusRes = await kaggle.getKernelStatus(username, slug);

    if (statusRes.status === 'error' || statusRes.status === 'complete') {
      await markDead(session.id as string, `Kernel ${statusRes.status}: ${statusRes.failureReason ?? ''}`);
      log.push(`[session ${session.id}] Marked dead: ${statusRes.status}`);
      return;
    }

    // If warming → try to grab output and extract URL
    if (session.status === 'warming' && statusRes.status === 'running') {
      const raw = await kaggle.getKernelOutput(username, slug);
      const parsed = parseNotebookOutput(raw);

      if (parsed && parsed.status === 'ready') {
        await supabase
          .from('sessions')
          .update({
            status: 'ready',
            ready_at: new Date().toISOString(),
            endpoints: parsed.endpoints,
            total_concurrent: parsed.total_concurrent_capacity,
            raw_output: parsed,
            updated_at: new Date().toISOString(),
          })
          .eq('id', session.id);
        log.push(`[session ${session.id}] ✅ Now READY — endpoints extracted`);
        return;
      }

      // Fallback: regex URL extraction
      const urls = extractTunnelUrls(raw);
      if (urls.length > 0) {
        const endpoints = urls.map((url, i) => ({
          port: 8000 + i,
          tunnel_url: url,
          openai_api_url: `${url}/v1`,
          max_concurrent: 32,
        }));
        await supabase
          .from('sessions')
          .update({
            status: 'ready',
            ready_at: new Date().toISOString(),
            endpoints,
            total_concurrent: endpoints.length * 32,
            updated_at: new Date().toISOString(),
          })
          .eq('id', session.id);
        log.push(`[session ${session.id}] ✅ READY via regex fallback: ${urls.join(', ')}`);
      }
    }

    // Mark expiring if < prefire window
    if (session.status === 'ready' && session.expires_at) {
      const left = new Date(session.expires_at as string).getTime() - Date.now();
      if (left < 30 * 60 * 1000) {
        await supabase
          .from('sessions')
          .update({ status: 'expiring', updated_at: new Date().toISOString() })
          .eq('id', session.id);
        log.push(`[session ${session.id}] Marked EXPIRING`);
      }
    }

    // Hard 11h limit
    if (session.pushed_at) {
      const age = Date.now() - new Date(session.pushed_at as string).getTime();
      if (age > 11 * 3600 * 1000) {
        await markDead(session.id as string, 'Exceeded 11h hard limit');
        log.push(`[session ${session.id}] Killed: 11h limit`);
      }
    }
  } catch (err) {
    log.push(`[session ${session.id}] Health check error: ${err}`);
  }
}

async function fireNewSession(
  model: ModelType,
  cfg: Record<string, string>,
  log: string[]
): Promise<void> {
  const maxConcurrentPerAccount = parseInt(cfg['MAX_CONCURRENT_SESSIONS_PER_ACCOUNT'] ?? '2', 10);
  const weeklyQuotaH = parseFloat(cfg['ACCOUNT_WEEKLY_QUOTA_H'] ?? '30');

  // Count active sessions per account
  const { data: activeSessions } = await supabase
    .from('sessions')
    .select('account_id, kernel_slug')
    .in('status', ['queued', 'warming', 'ready', 'expiring']);

  const sessionCounts: Record<string, number> = {};
  const existingSlugs: Record<string, string[]> = {};
  for (const s of activeSessions ?? []) {
    if (!s.account_id) continue;
    sessionCounts[s.account_id] = (sessionCounts[s.account_id] || 0) + 1;
    existingSlugs[s.account_id] = existingSlugs[s.account_id] || [];
    if (s.kernel_slug) existingSlugs[s.account_id].push(s.kernel_slug);
  }

  // Fetch all active accounts matching model assignment
  const { data: allAccounts } = await supabase
    .from('kaggle_accounts')
    .select('*')
    .eq('is_active', true)
    .in('model_assignment', [model, 'both'])
    .lt('weekly_hours_used', weeklyQuotaH)
    .order('weekly_hours_used', { ascending: true });

  if (!allAccounts || allAccounts.length === 0) {
    log.push(`[${model}] ❌ No active accounts with remaining weekly quota (< ${weeklyQuotaH}h)`);
    return;
  }

  // Filter for accounts with < maxConcurrentPerAccount active sessions
  const availableAccounts = allAccounts.filter(
    (a: { id: string }) => (sessionCounts[a.id] || 0) < maxConcurrentPerAccount
  );

  const account = availableAccounts.length > 0 ? availableAccounts[0] : allAccounts[0];

  const apiKey = decrypt(account.api_key_encrypted, account.api_key_iv, account.api_key_tag);
  const kaggle = new KaggleClient({ username: account.username, apiKey });

  const baseSlug = cfg[`${model.toUpperCase()}_KERNEL_SLUG`] ?? `zero-${model}-server`;
  // If account already has a session with baseSlug, append index suffix
  const accountSlugs = existingSlugs[account.id] || [];
  let kernelSlug = baseSlug;
  if (accountSlugs.includes(baseSlug)) {
    kernelSlug = `${baseSlug}-2`;
  }

  const accelerator = 'NvidiaTeslaT4'; // HARDCODED 2xT4 shape
  const softLimitMs = parseFloat(cfg['SESSION_SOFT_LIMIT_H'] ?? '10') * 3600 * 1000;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + softLimitMs);

  const { data: newSession, error: insertErr } = await supabase
    .from('sessions')
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

  if (insertErr || !newSession) {
    log.push(`[${model}] ❌ Failed to insert session: ${insertErr?.message}`);
    return;
  }

  try {
    const notebook = loadNotebook(model) as any;
    
    // Inject SESSION_ID into the notebook so it can identify itself to Supabase
    notebook.cells.unshift({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: [
        `# Auto-injected by zero-gpu-server orchestrator\n`,
        `SESSION_ID = "${newSession.id}"\n`
      ]
    });

    await kaggle.pushKernel(kernelSlug, notebook, accelerator);

    await supabase
      .from('sessions')
      .update({
        status: 'warming',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', newSession.id);

    // Track account rotation for stealth
    await supabase.rpc('mark_account_used', { p_account_id: account.id });

    log.push(`[${model}] 🚀 Kernel pushed: @${account.username}/${kernelSlug} (slot ${(sessionCounts[account.id] || 0) + 1}/${maxConcurrentPerAccount}) → session ${newSession.id}`);
  } catch (err) {
    log.push(`[${model}] ❌ Push failed: ${err}`);
    await markDead(newSession.id, String(err));
  }
}

async function markDead(sessionId: string, reason: string): Promise<void> {
  const { data: session } = await supabase
    .from('sessions')
    .select('account_id, pushed_at')
    .eq('id', sessionId)
    .single();

  if (session?.pushed_at) {
    const hoursUsed = (Date.now() - new Date(session.pushed_at).getTime()) / 3600000;
    await supabase.from('account_session_log').insert({
      account_id: session.account_id,
      session_id: sessionId,
      hours_used: hoursUsed,
    });
    await supabase.rpc('increment_weekly_hours', {
      p_account_id: session.account_id,
      p_hours: hoursUsed,
    });
  }

  await supabase
    .from('sessions')
    .update({
      status: 'dead',
      ended_at: new Date().toISOString(),
      error_message: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}
