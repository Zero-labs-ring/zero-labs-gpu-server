import { supabase } from './supabase';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION TIMING CONSTANTS (hardcoded — never user-configurable)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TOTAL_SESSION_DURATION_MIN = 600;      // 10 hours
const KAGGLE_TIMEOUT_SECONDS = 36000;        // --timeout=36000
const WARMUP_DURATION_MIN = 10;
const EFFECTIVE_SERVE_TIME_MIN = 590;
const HANDOFF_TRIGGER_AT_MIN = 580;          // start new session 20 min before timeout

const KAGGLE_API_BASE = process.env.KAGGLE_API_BASE || 'https://www.kaggle.com/api/v1';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
interface Account {
  id: string;
  label: string;
  kaggle_username: string;
  kaggle_key: string;
  quota_used_minutes: number;
  quota_limit_minutes: number;
  is_active: boolean;
}

interface Slot {
  id: string;
  slot_index: number;
  notebook_slug: string;
  is_enabled: boolean;
}

interface Session {
  id: string;
  slot_id: string;
  account_id: string;
  kernel_ref: string | null;
  started_at: string;
  handoff_trigger_at: string;
  timeout_at: string;
  ended_at: string | null;
  status: 'warming' | 'serving' | 'handoff_pending' | 'ended' | 'failed';
}

interface TickResult {
  slot_id: string;
  slot_index: number;
  action: string;
  session_id?: string;
  error?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Build Kaggle auth header (HTTP Basic)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function kaggleAuthHeader(username: string, key: string): string {
  const encoded = Buffer.from(`${username}:${key}`).toString('base64');
  return `Basic ${encoded}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. getAvailableAccount
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function getAvailableAccount(excludeIds: string[]): Promise<Account | null> {
  let query = supabase
    .from('accounts')
    .select('*')
    .eq('is_active', true)
    .order('quota_used_minutes', { ascending: true }); // most remaining = lowest used first (when limit is same)

  const { data: allAccounts, error } = await query;

  if (error || !allAccounts || allAccounts.length === 0) {
    return null;
  }

  // Filter: enough quota (>=600 min remaining) and not in exclude list
  // Order by most remaining quota DESC = (limit - used) DESC
  const eligible = allAccounts
    .filter((a: Account) => {
      const remaining = a.quota_limit_minutes - a.quota_used_minutes;
      return remaining >= TOTAL_SESSION_DURATION_MIN && !excludeIds.includes(a.id);
    })
    .sort((a: Account, b: Account) => {
      const remA = a.quota_limit_minutes - a.quota_used_minutes;
      const remB = b.quota_limit_minutes - b.quota_used_minutes;
      return remB - remA; // DESC — greedily pick most remaining
    });

  return eligible.length > 0 ? eligible[0] : null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. startSession with Automatic Cascade
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function startSession(
  slotId: string,
  retryCount: number = 0,
  excludedAccountIds: string[] = []
): Promise<Session | null> {
  // Prevent infinite retry loop (max 5 cascade attempts)
  if (retryCount >= 5) {
    console.error(`[orchestrator] ❌ Max cascade retry limit (5) reached for slot ${slotId}`);
    return null;
  }

  // Get slot
  const { data: slot, error: slotErr } = await supabase
    .from('slots')
    .select('*')
    .eq('id', slotId)
    .single();

  if (slotErr || !slot) {
    console.error(`[orchestrator] Slot ${slotId} not found:`, slotErr?.message);
    return null;
  }

  // Get all account IDs currently running an active session
  const { data: activeSessions } = await supabase
    .from('sessions')
    .select('account_id')
    .in('status', ['warming', 'serving', 'handoff_pending']);

  const busyAccountIds = [
    ...new Set([
      ...(activeSessions ?? []).map((s: { account_id: string }) => s.account_id),
      ...excludedAccountIds,
    ]),
  ];

  // Find available account (exclude busy ones — one account = max one session)
  const account = await getAvailableAccount(busyAccountIds);

  if (!account) {
    console.warn(`[orchestrator] ⚠️ Slot ${slot.slot_index}: No eligible accounts available in pool (quota_exhausted)`);
    return null;
  }

  const now = new Date();
  const handoffAt = new Date(now.getTime() + HANDOFF_TRIGGER_AT_MIN * 60 * 1000);
  const timeoutAt = new Date(now.getTime() + TOTAL_SESSION_DURATION_MIN * 60 * 1000);

  // Push to Kaggle API
  let kernelRef: string | null = null;
  try {
    const pushBody = {
      id: (slot as Slot).notebook_slug,
      language: 'python',
      kernel_type: 'notebook',
      enable_gpu: true,
      enable_internet: true,
      timeout: KAGGLE_TIMEOUT_SECONDS,
    };

    const response = await fetch(`${KAGGLE_API_BASE}/kernels/push`, {
      method: 'POST',
      headers: {
        'Authorization': kaggleAuthHeader(account.kaggle_username, account.kaggle_key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pushBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Kaggle push failed (${response.status}): ${errText}`);
    }

    const pushResult = await response.json();
    kernelRef = pushResult.ref || pushResult.slug || null;
  } catch (err: any) {
    const errMessage = String(err?.message || err);
    console.error(`[orchestrator] ❌ Kaggle push failed for slot ${slot.slot_index}, account ${account.label}:`, errMessage);

    // If quota is exhausted or account error, update account in DB so we don't try it again today
    if (errMessage.toLowerCase().includes('quota') || errMessage.includes('429') || errMessage.includes('400')) {
      console.warn(`[orchestrator] ⚠️ Account ${account.label} hit Kaggle GPU quota limit. Marking quota exhausted.`);
      await supabase
        .from('accounts')
        .update({ quota_used_minutes: account.quota_limit_minutes || 1800 })
        .eq('id', account.id);
    }

    // Insert failed session record
    await supabase.from('sessions').insert({
      slot_id: slotId,
      account_id: account.id,
      kernel_ref: null,
      started_at: now.toISOString(),
      handoff_trigger_at: handoffAt.toISOString(),
      timeout_at: timeoutAt.toISOString(),
      status: 'failed',
    });

    // 🚀 AUTOMATIC FAILOVER CASCADE: Immediately try the next best available Kaggle account!
    console.log(`[orchestrator] 🔀 Auto-cascading to next Kaggle account for slot ${slot.slot_index} (attempt ${retryCount + 1}/5)...`);
    return startSession(slotId, retryCount + 1, [...busyAccountIds, account.id]);
  }

  // Insert session row
  const { data: session, error: insertErr } = await supabase
    .from('sessions')
    .insert({
      slot_id: slotId,
      account_id: account.id,
      kernel_ref: kernelRef,
      started_at: now.toISOString(),
      handoff_trigger_at: handoffAt.toISOString(),
      timeout_at: timeoutAt.toISOString(),
      status: 'warming',
    })
    .select()
    .single();

  if (insertErr || !session) {
    console.error(`[orchestrator] ❌ Failed to insert session:`, insertErr?.message);
    return null;
  }

  // Deduct 600 min from account quota (full session cost regardless)
  await supabase
    .from('accounts')
    .update({
      quota_used_minutes: account.quota_used_minutes + TOTAL_SESSION_DURATION_MIN,
    })
    .eq('id', account.id);

  console.log(
    `[orchestrator] 🚀 Session started successfully: slot=${slot.slot_index} account=${account.label} ` +
    `kernel=${kernelRef} handoff_at=${handoffAt.toISOString()}`
  );

  return session as Session;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. triggerHandoff & triggerManualHandoff
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function triggerHandoff(
  slotId: string,
  targetAccountId?: string
): Promise<{ newSession: Session | null; oldSessionEnded: boolean }> {
  // Get current active session for this slot
  const { data: oldSessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('slot_id', slotId)
    .in('status', ['warming', 'serving', 'handoff_pending'])
    .order('started_at', { ascending: false })
    .limit(1);

  const oldSession = oldSessions?.[0] ?? null;

  // Start NEW session first on the next best account (zero-gap guarantee)
  const newSession = await startSession(slotId);

  if (newSession && oldSession) {
    // Mark old session as ended
    await supabase
      .from('sessions')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
      })
      .eq('id', oldSession.id);

    console.log(`[orchestrator] 🔄 Handoff complete: slot ${slotId} — old=${oldSession.id} → new=${newSession.id}`);
    return { newSession, oldSessionEnded: true };
  }

  if (!newSession && oldSession) {
    // No account available — log alert but don't kill old session
    console.warn(`[orchestrator] ⚠️ Handoff failed for slot ${slotId}: no accounts available (quota_exhausted)`);
    return { newSession: null, oldSessionEnded: false };
  }

  return { newSession, oldSessionEnded: false };
}

// Helper for manual trigger (e.g. user clicks "Deploy" or restarts a slot)
export async function triggerManualHandoff(slotId: string): Promise<{ success: boolean; session: Session | null; message: string }> {
  const { newSession, oldSessionEnded } = await triggerHandoff(slotId);
  if (newSession) {
    return {
      success: true,
      session: newSession,
      message: oldSessionEnded
        ? `Successfully rotated to new Kaggle account (${newSession.account_id}) and ended previous session.`
        : `Successfully launched new Kaggle session on account (${newSession.account_id}).`,
    };
  }
  return {
    success: false,
    session: null,
    message: 'No Kaggle accounts with sufficient quota available in the pool.',
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. runSchedulerTick with Dead Node Detection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function runSchedulerTick(): Promise<TickResult[]> {
  const results: TickResult[] = [];
  const now = new Date();
  const deadHeartbeatThreshold = new Date(now.getTime() - 4 * 60 * 1000).toISOString(); // 4 minutes stale

  // Get all enabled slots
  const { data: enabledSlots, error: slotsErr } = await supabase
    .from('slots')
    .select('*')
    .eq('is_enabled', true)
    .order('slot_index', { ascending: true });

  if (slotsErr || !enabledSlots) {
    console.error('[orchestrator] Failed to fetch slots:', slotsErr?.message);
    return [{ slot_id: '', slot_index: -1, action: 'error', error: slotsErr?.message ?? 'Unknown error' }];
  }

  for (const slot of enabledSlots as Slot[]) {
    try {
      // Get current active session for this slot
      const { data: activeSessions } = await supabase
        .from('sessions')
        .select('*')
        .eq('slot_id', slot.id)
        .in('status', ['warming', 'serving', 'handoff_pending'])
        .order('started_at', { ascending: false })
        .limit(1);

      const currentSession = activeSessions?.[0] as Session | undefined;

      if (!currentSession) {
        // No active session → start one
        const session = await startSession(slot.id);
        results.push({
          slot_id: slot.id,
          slot_index: slot.slot_index,
          action: session ? 'started_new_session' : 'quota_exhausted',
          session_id: session?.id,
        });
        continue;
      }

      const sessionStartedAt = new Date(currentSession.started_at);
      const handoffTriggerAt = new Date(currentSession.handoff_trigger_at);
      const minutesSinceStart = (now.getTime() - sessionStartedAt.getTime()) / (60 * 1000);

      // ── CHECK 1: Failed session → Auto-retry via cascade handoff
      if (currentSession.status === 'failed') {
        console.warn(`[orchestrator] 🚨 Found failed session ${currentSession.id} on slot ${slot.slot_index}. Triggering failover...`);
        const { newSession } = await triggerHandoff(slot.id);
        results.push({
          slot_id: slot.id,
          slot_index: slot.slot_index,
          action: newSession ? 'retried_failed_session_auto_failover' : 'retry_failed_quota_exhausted',
          session_id: newSession?.id,
        });
        continue;
      }

      // ── CHECK 2: Dead Node Detection (Serving session missing heartbeats > 4 mins)
      if (currentSession.status === 'serving' && minutesSinceStart > 12) {
        const { data: gwList } = await supabase
          .from('gateway_urls')
          .select('is_healthy, last_seen_at')
          .gte('last_seen_at', deadHeartbeatThreshold)
          .limit(1);

        const hasRecentHeartbeat = gwList && gwList.length > 0;
        if (!hasRecentHeartbeat) {
          console.warn(`[orchestrator] 🚨 DEAD NODE DETECTED on slot ${slot.slot_index} (no heartbeat for >4m). Triggering auto-failover...`);
          // Mark dead session as failed
          await supabase
            .from('sessions')
            .update({ status: 'failed', ended_at: now.toISOString() })
            .eq('id', currentSession.id);

          const { newSession } = await triggerHandoff(slot.id);
          results.push({
            slot_id: slot.id,
            slot_index: slot.slot_index,
            action: newSession ? 'dead_node_auto_failover_success' : 'dead_node_failover_quota_exhausted',
            session_id: newSession?.id,
          });
          continue;
        }
      }

      // ── CHECK 3: Scheduled handoff time reached
      if (now >= handoffTriggerAt && currentSession.status !== 'handoff_pending') {
        await supabase
          .from('sessions')
          .update({ status: 'handoff_pending' })
          .eq('id', currentSession.id);

        const { newSession } = await triggerHandoff(slot.id);
        results.push({
          slot_id: slot.id,
          slot_index: slot.slot_index,
          action: newSession ? 'handoff_triggered' : 'handoff_failed_quota_exhausted',
          session_id: newSession?.id,
        });
        continue;
      }

      // ── CHECK 4: Warming → Serving promotion (after warmup window)
      if (currentSession.status === 'warming' && minutesSinceStart >= WARMUP_DURATION_MIN) {
        await supabase
          .from('sessions')
          .update({ status: 'serving' })
          .eq('id', currentSession.id);

        results.push({
          slot_id: slot.id,
          slot_index: slot.slot_index,
          action: 'promoted_to_serving',
          session_id: currentSession.id,
        });
        continue;
      }

      // Healthy session
      results.push({
        slot_id: slot.id,
        slot_index: slot.slot_index,
        action: 'healthy_serving',
        session_id: currentSession.id,
      });
    } catch (err) {
      console.error(`[orchestrator] Error processing slot ${slot.slot_index}:`, err);
      results.push({
        slot_id: slot.id,
        slot_index: slot.slot_index,
        action: 'error',
        error: String(err),
      });
    }
  }

  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. resetAllQuotas
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function resetAllQuotas(): Promise<{ reset_count: number; timestamp: string }> {
  const timestamp = new Date().toISOString();

  // 1. Reset accounts table
  const { data: accountsData } = await supabase
    .from('accounts')
    .update({ quota_used_minutes: 0 })
    .eq('is_active', true)
    .select('id');

  // 2. Reset legacy kaggle_accounts table
  const { data: kaggleAccountsData } = await supabase
    .from('kaggle_accounts')
    .update({
      weekly_hours_used: 0,
      weekly_hours_reset_at: timestamp,
    })
    .eq('is_active', true)
    .select('id');

  const count = (accountsData?.length ?? 0) + (kaggleAccountsData?.length ?? 0);

  console.log(`[orchestrator] 🔄 Weekly Saturday quota reset: ${count} accounts zeroed at ${timestamp}`);

  return { reset_count: count, timestamp };
}
