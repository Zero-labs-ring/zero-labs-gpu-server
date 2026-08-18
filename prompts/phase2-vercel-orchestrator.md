# PHASE 2 — VERCEL ORCHESTRATOR + SUPABASE BACKEND
## Build the Smart Session Manager that Auto-Manages All Kaggle Accounts

---

## CONTEXT

You are building the core backend of Zero Labs — a Next.js app deployed on Vercel that automatically manages a pool of Kaggle accounts, fires GPU sessions headlessly via the Kaggle API, extracts tunnel URLs from kernel logs, and routes incoming AI requests to healthy model backends. This system must run 24/7 with zero manual intervention.

### Architecture Overview
```
Vercel Cron (every 5 min)
       │
       ▼
Orchestrator (Next.js API Route)
       │
       ├─── Supabase DB (session state, account pool, endpoints)
       │
       ├─── Kaggle API (push notebooks, poll status, read logs)
       │
       └─── Active Backend Pool:
                × 2 endpoints (100 concurrent)
               Pro:   1 session × 2 endpoints (36 concurrent)
               Ultra: 2 sessions × 1 endpoint each (12 concurrent)
```

### Account Rotation Strategy
```
15 total accounts:
  - 3 ACTIVE at any time (1 Pro, 2 Ultra)
  - 11 RESERVE (rotate in as sessions expire)
  
Session lifecycle:
  - Max session runtime: 11h (Kaggle hard limit)
  - Rotate at: 9h (2h buffer)
  - Warmup time needed: 8-15 min (model load + tunnel start)
  - Pre-fire next session at: 8h30m (30 min warmup buffer)
```

---

## TECH STACK

```
Framework:     Next.js 14+ (App Router)
Runtime:       Node.js 20
Deploy:        Vercel (hobby tier is fine — cron is available)
Database:      Supabase (PostgreSQL + Row Level Security)
Auth (admin):  Supabase Auth (email/password, single admin user)
Cron:          Vercel Cron Jobs (vercel.json config)
HTTP client:   axios or built-in fetch
Encryption:    Node crypto (AES-256-GCM for API key storage)
```

---

## SUPABASE SCHEMA

Run these SQL migrations in Supabase SQL editor in order:

### Migration 001 — kaggle_accounts table
```sql
CREATE TABLE kaggle_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  api_key_encrypted TEXT NOT NULL,       -- AES-256-GCM encrypted
  api_key_iv TEXT NOT NULL,              -- IV for decryption
  label TEXT,                            -- e.g. "Arjun's account"
  weekly_hours_used FLOAT DEFAULT 0,
  weekly_hours_reset_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  is_active BOOLEAN DEFAULT TRUE,        -- admin can disable accounts
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for picking accounts with most hours remaining
CREATE INDEX idx_accounts_hours ON kaggle_accounts (weekly_hours_used ASC)
WHERE is_active = TRUE;
```

### Migration 002 — sessions table
```sql
CREATE TYPE session_status AS ENUM (
  'queued',      -- kernel push initiated, not running yet
  'warming',     -- kernel is running, waiting for model to load
  'ready',       -- model loaded, tunnel URL extracted, serving traffic
  'expiring',    -- < 30 min left, replacement is warming up
  'dead',        -- session ended or crashed
  'error'        -- kernel failed to start or errored out
);

CREATE TYPE model_type AS ENUM ('pro', 'ultra');

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES kaggle_accounts(id),
  model model_type NOT NULL,
  status session_status DEFAULT 'queued',
  
  -- Kaggle kernel info
  kernel_slug TEXT,                      -- e.g. "zero-pro-server"
  kernel_run_id TEXT,                    -- Kaggle's run identifier
  
  -- Timing
  pushed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,               -- when kernel became "running"
  ready_at TIMESTAMPTZ,                 -- when model was loaded + tunnel ready
  expires_at TIMESTAMPTZ,               -- pushed_at + 9h (our soft limit)
  ended_at TIMESTAMPTZ,
  
  -- Endpoints (set when status = 'ready')
  endpoints JSONB,                       -- array of {gpu, port, tunnel_url, openai_api_url}
  total_concurrent_capacity INTEGER,
  
  -- Metadata
  error_message TEXT,
  raw_output JSONB,                      -- full parsed JSON from notebook output
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_model_status ON sessions (model, status);
CREATE INDEX idx_sessions_active ON sessions (status) WHERE status IN ('warming', 'ready', 'expiring');
```

### Migration 003 — model_endpoints view (convenience)
```sql
-- Live view of all currently-healthy endpoints grouped by model
CREATE VIEW live_endpoints AS
SELECT 
  s.model,
  s.id as session_id,
  s.account_id,
  endpoint->>'tunnel_url' as tunnel_url,
  endpoint->>'openai_api_url' as openai_api_url,
  (endpoint->>'gpu')::TEXT as gpu,
  s.expires_at,
  s.total_concurrent_capacity
FROM sessions s,
  jsonb_array_elements(s.endpoints) as endpoint
WHERE s.status IN ('ready', 'expiring');
```

### Migration 004 — account_session_log
```sql
-- Tracks hours consumed per account for weekly quota management
CREATE TABLE account_session_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES kaggle_accounts(id),
  session_id UUID REFERENCES sessions(id),
  hours_used FLOAT,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Migration 005 — Row Level Security (RLS)
```sql
-- All tables: only service role can write (Vercel uses SERVICE_ROLE_KEY)
ALTER TABLE kaggle_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically in Supabase
-- No additional policies needed for server-side access
-- Anon users cannot read any of these tables
```

---

## PROJECT STRUCTURE

```
zero-labs-orchestrator/           (Next.js project root)
├── app/
│   ├── api/
│   │   ├── cron/
│   │   │   └── orchestrate/
│   │   │       └── route.ts       ← MAIN CRON JOB
│   │   ├── sessions/
│   │   │   ├── route.ts           ← GET all sessions (admin)
│   │   │   └── [id]/route.ts     ← GET/DELETE session by id
│   │   ├── accounts/
│   │   │   ├── route.ts           ← GET all accounts / POST add account
│   │   │   └── [id]/route.ts     ← PATCH/DELETE account
│   │   └── endpoints/
│   │       └── route.ts           ← GET live endpoints (used by chat app)
│   └── layout.tsx
├── lib/
│   ├── supabase.ts                ← Supabase client (server-side)
│   ├── kaggle.ts                  ← Kaggle API client
│   ├── crypto.ts                  ← AES-256 encryption/decryption
│   ├── orchestrator.ts            ← Core orchestration logic
│   └── notebooks/
│       │       ├── pro_notebook.json      ← Notebook content (from Phase 1)
│       └── ultra_notebook.json    ← Notebook content (from Phase 1)
├── vercel.json
├── .env.local
└── package.json
```

---

## ENVIRONMENT VARIABLES

```bash
# .env.local (also add to Vercel dashboard)

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key  # NOT the anon key

# Encryption key for Kaggle API keys stored in DB
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=64_char_hex_string

# Cron security (Vercel sends this header to verify cron calls)
CRON_SECRET=random_secret_string

# Admin auth (used by admin dashboard in Phase 3)
ADMIN_EMAIL=your@email.com
```

---

## CORE LIBRARY FILES

### lib/crypto.ts — AES-256-GCM Encryption
```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    tag
  };
}

export function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

### lib/kaggle.ts — Kaggle API Client
```typescript
// Kaggle uses HTTP Basic Auth: username:api_key (base64 encoded)

interface KaggleAccount {
  username: string;
  apiKey: string;
}

interface KernelPushPayload {
  currentRunningVersion?: number;
  source: string;         // notebook JSON as string
  totalVotes?: number;
  language: string;       // "python"
  kernelType: string;     // "notebook"
  isPrivate: boolean;
  enableGpu: boolean;
  enableInternet: boolean;
  categoryIds: string[];
  datasetDataSources: string[];
  kernelDataSources: string[];
  competitionDataSources: string[];
}

export class KaggleClient {
  private baseUrl = 'https://www.kaggle.com/api/v1';
  private authHeader: string;
  
  constructor(private account: KaggleAccount) {
    const credentials = Buffer.from(`${account.username}:${account.apiKey}`).toString('base64');
    this.authHeader = `Basic ${credentials}`;
  }
  
  private async request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kaggle API ${method} ${path} failed: ${response.status} ${text}`);
    }
    
    return response.json();
  }
  
  async pushKernel(kernelSlug: string, notebookContent: object, modelType: 'pro' | 'ultra') {
    // kernelSlug format: "zero-pro-server", "zero-ultra-server"
    const payload = {
      currentRunningVersion: 1,
      source: JSON.stringify(notebookContent),
      language: 'python',
      kernelType: 'notebook',
      isPrivate: true,
      enableGpu: true,
      accelerator: 'gpuT4x2', // FORCE Kaggle to provision 2x NVIDIA T4 GPUs
      enableInternet: true,
      categoryIds: [],
      datasetDataSources: [],
      kernelDataSources: [],
      competitionDataSources: [],
    };
    
    return this.request('POST', `/kernels/push`, payload);
  }
  
  async getKernelStatus(username: string, kernelSlug: string) {
    // Returns: { status: 'running'|'complete'|'error'|'queued', ... }
    return this.request('GET', `/kernels/${username}/${kernelSlug}`);
  }
  
  async getKernelOutput(username: string, kernelSlug: string): Promise<string> {
    // Returns log output of the running kernel
    const result = await this.request('GET', `/kernels/${username}/${kernelSlug}/output`);
    // result.files[0].data contains the stdout text
    return result?.files?.[0]?.data || result?.log || '';
  }
  
  async listKernels(username: string) {
    return this.request('GET', `/kernels?ownerSlug=${username}&pageSize=20`);
  }
}

export function parseNotebookOutput(rawOutput: string): Record<string, unknown> | null {
  // Extract JSON between our delimiters
  const startMarker = '===ZERO_LABS_OUTPUT_START===';
  const endMarker = '===ZERO_LABS_OUTPUT_END===';
  
  const startIdx = rawOutput.indexOf(startMarker);
  const endIdx = rawOutput.indexOf(endMarker);
  
  if (startIdx === -1 || endIdx === -1) return null;
  
  const jsonStr = rawOutput.slice(startIdx + startMarker.length, endIdx).trim();
  
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
```

### lib/supabase.ts — Server-Side Supabase Client
```typescript
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false }
  }
);
```

### lib/orchestrator.ts — Core Logic
```typescript
import { supabase } from './supabase';
import { KaggleClient, parseNotebookOutput } from './kaggle';
import { decrypt } from './crypto';

import proNotebook from './notebooks/pro_notebook.json';
import ultraNotebook from './notebooks/ultra_notebook.json';

type ModelType = 'pro' | 'ultra';

// How many active sessions each model needs
const TARGET_SESSIONS: Record<ModelType, number> = {
  pro: 1,
  ultra: 2,
};

const KERNEL_SLUGS: Record<ModelType, string> = {
    pro: 'zero-pro-server',
  ultra: 'zero-ultra-server',
};

const NOTEBOOKS: Record<ModelType, object> = {
    pro: proNotebook,
  ultra: ultraNotebook,
};

// Soft session time limit (9h = 32400s)
const SESSION_SOFT_LIMIT_MS = 9 * 60 * 60 * 1000;
// Pre-fire replacement this many ms before soft limit
const PREFIRE_BEFORE_MS = 30 * 60 * 1000;  // 30 min

export async function runOrchestrationCycle(): Promise<void> {
  console.log('[Orchestrator] Starting cycle...');
  
  for (const model of ['pro', 'ultra'] as ModelType[]) {
    await manageModelSessions(model);
  }
  
  // Also: update weekly hours tracking
  await updateWeeklyHours();
  
  console.log('[Orchestrator] Cycle complete');
}

async function manageModelSessions(model: ModelType): Promise<void> {
  // 1. Get all current non-dead sessions for this model
  const { data: activeSessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('model', model)
    .in('status', ['queued', 'warming', 'ready', 'expiring']);
  
  const currentCount = activeSessions?.length || 0;
  const target = TARGET_SESSIONS[model];
  
  console.log(`[${model}] ${currentCount}/${target} sessions active`);
  
  // 2. Check each active session
  for (const session of activeSessions || []) {
    await checkSessionHealth(session);
  }
  
  // 3. Check if any sessions need pre-firing (< 30min before expiry)
  const needsPrefire = activeSessions?.some(s => {
    if (!s.expires_at || s.status === 'dead' || s.status === 'error') return false;
    const timeLeft = new Date(s.expires_at).getTime() - Date.now();
    return timeLeft < PREFIRE_BEFORE_MS;
  });
  
  // 4. Re-count alive sessions after health checks
  const { data: freshSessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('model', model)
    .in('status', ['queued', 'warming', 'ready', 'expiring']);
  
  const freshCount = freshSessions?.length || 0;
  
  // 5. Fire new sessions if needed
  const sessionsToFire = Math.max(0, target - freshCount);
  if (sessionsToFire > 0 || needsPrefire) {
    console.log(`[${model}] Firing ${sessionsToFire} new session(s)${needsPrefire ? ' (pre-fire for overlap)' : ''}`);
    for (let i = 0; i < sessionsToFire; i++) {
      await fireNewSession(model);
    }
    if (needsPrefire) {
      await fireNewSession(model);  // overlap session
    }
  }
}

async function checkSessionHealth(session: Record<string, unknown>): Promise<void> {
  // Get account credentials
  const { data: account } = await supabase
    .from('kaggle_accounts')
    .select('*')
    .eq('id', session.account_id)
    .single();
  
  if (!account) {
    await markSessionDead(session.id as string, 'Account not found');
    return;
  }
  
  const apiKey = decrypt(account.api_key_encrypted, account.api_key_iv, account.api_key_tag);
  const kaggle = new KaggleClient({ username: account.username, apiKey });
  
  try {
    const status = await kaggle.getKernelStatus(account.username, session.kernel_slug as string);
    
    if (status.status === 'error' || status.status === 'complete') {
      await markSessionDead(session.id as string, `Kernel ${status.status}`);
      return;
    }
    
    // If warming → try to get output and parse URL
    if (session.status === 'warming' && status.status === 'running') {
      const output = await kaggle.getKernelOutput(account.username, session.kernel_slug as string);
      const parsed = parseNotebookOutput(output);
      
      if (parsed && parsed.status === 'ready') {
        // Mark as ready with endpoints!
        await supabase
          .from('sessions')
          .update({
            status: 'ready',
            ready_at: new Date().toISOString(),
            endpoints: parsed.endpoints,
            total_concurrent_capacity: parsed.total_concurrent_capacity,
            raw_output: parsed,
            updated_at: new Date().toISOString(),
          })
          .eq('id', session.id);
        
        console.log(`[${session.model}] Session ${session.id} is now READY`);
      }
    }
    
    // Check if approaching expiry
    if (session.status === 'ready' && session.expires_at) {
      const timeLeft = new Date(session.expires_at as string).getTime() - Date.now();
      if (timeLeft < PREFIRE_BEFORE_MS) {
        await supabase
          .from('sessions')
          .update({ status: 'expiring', updated_at: new Date().toISOString() })
          .eq('id', session.id);
      }
    }
    
    // Mark truly dead sessions (past 11h hard limit)
    if (session.pushed_at) {
      const age = Date.now() - new Date(session.pushed_at as string).getTime();
      if (age > 11 * 60 * 60 * 1000) {
        await markSessionDead(session.id as string, 'Exceeded 11h hard limit');
      }
    }
    
  } catch (err) {
    console.error(`[${session.model}] Health check failed for session ${session.id}:`, err);
  }
}

async function fireNewSession(model: ModelType): Promise<void> {
  // Pick account with most weekly hours remaining and not currently running this model
  const { data: usedAccountIds } = await supabase
    .from('sessions')
    .select('account_id')
    .in('status', ['queued', 'warming', 'ready', 'expiring']);
  
  const usedIds = (usedAccountIds || []).map((s: { account_id: string }) => s.account_id);
  
  // Pick account not currently in use, with lowest weekly_hours_used
  let query = supabase
    .from('kaggle_accounts')
    .select('*')
    .eq('is_active', true)
    .order('weekly_hours_used', { ascending: true })
    .limit(1);
  
  // Exclude accounts already running sessions UNLESS we must (all accounts busy)
  if (usedIds.length > 0) {
    query = query.not('id', 'in', `(${usedIds.join(',')})`);
  }
  
  const { data: accounts } = await query;
  
  if (!accounts || accounts.length === 0) {
    console.error(`[${model}] No available accounts! All accounts may be in use.`);
    return;
  }
  
  const account = accounts[0];
  const apiKey = decrypt(account.api_key_encrypted, account.api_key_iv, account.api_key_tag);
  const kaggle = new KaggleClient({ username: account.username, apiKey });
  
  // Create session record
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SOFT_LIMIT_MS);
  
  const { data: newSession } = await supabase
    .from('sessions')
    .insert({
      account_id: account.id,
      model,
      status: 'queued',
      kernel_slug: KERNEL_SLUGS[model],
      pushed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();
  
  if (!newSession) {
    console.error(`[${model}] Failed to create session record`);
    return;
  }
  
  // Push the kernel to Kaggle
  try {
    await kaggle.pushKernel(KERNEL_SLUGS[model], NOTEBOOKS[model], model);
    
    await supabase
      .from('sessions')
      .update({
        status: 'warming',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', newSession.id);
    
    console.log(`[${model}] Kernel pushed for account ${account.username}, session ${newSession.id}`);
    
  } catch (err) {
    console.error(`[${model}] Failed to push kernel:`, err);
    await markSessionDead(newSession.id, String(err));
  }
}

async function markSessionDead(sessionId: string, reason: string): Promise<void> {
  const { data: session } = await supabase
    .from('sessions')
    .select('account_id, pushed_at')
    .eq('id', sessionId)
    .single();
  
  if (session?.pushed_at) {
    const hoursUsed = (Date.now() - new Date(session.pushed_at).getTime()) / 3600000;
    
    // Log hours consumed
    await supabase.from('account_session_log').insert({
      account_id: session.account_id,
      session_id: sessionId,
      hours_used: hoursUsed,
    });
    
    // Update account's weekly hours
    await supabase.rpc('increment_weekly_hours', {
      account_id: session.account_id,
      hours: hoursUsed,
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

async function updateWeeklyHours(): Promise<void> {
  // Reset weekly_hours_used for accounts whose reset_at has passed
  await supabase
    .from('kaggle_accounts')
    .update({
      weekly_hours_used: 0,
      weekly_hours_reset_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    })
    .lt('weekly_hours_reset_at', new Date().toISOString());
}

// Supabase RPC function to add (not overwrite) hours:
// CREATE OR REPLACE FUNCTION increment_weekly_hours(account_id UUID, hours FLOAT)
// RETURNS VOID LANGUAGE SQL AS $$
//   UPDATE kaggle_accounts 
//   SET weekly_hours_used = weekly_hours_used + hours,
//       updated_at = NOW()
//   WHERE id = account_id;
// $$;
```

---

## API ROUTES

### app/api/cron/orchestrate/route.ts — Main Cron Job
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { runOrchestrationCycle } from '@/lib/orchestrator';

export const maxDuration = 300; // 5 min max (Vercel hobby: 10s, Pro: 300s)

export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron, not a random requester
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  try {
    await runOrchestrationCycle();
    return NextResponse.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Orchestration cycle failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

### app/api/accounts/route.ts — Account Management
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { encrypt } from '@/lib/crypto';
import { KaggleClient } from '@/lib/kaggle';

// GET /api/accounts — list all accounts (redacted keys)
export async function GET() {
  const { data } = await supabase
    .from('kaggle_accounts')
    .select('id, username, label, weekly_hours_used, weekly_hours_reset_at, is_active, created_at')
    .order('created_at', { ascending: true });
  
  return NextResponse.json(data);
}

// POST /api/accounts — add new account
export async function POST(req: NextRequest) {
  const { username, apiKey, label } = await req.json();
  
  if (!username || !apiKey) {
    return NextResponse.json({ error: 'username and apiKey required' }, { status: 400 });
  }
  
  // Validate the Kaggle credentials actually work before saving
  const kaggle = new KaggleClient({ username, apiKey });
  try {
    await kaggle.listKernels(username);
  } catch {
    return NextResponse.json({ error: 'Invalid Kaggle credentials' }, { status: 400 });
  }
  
  // Encrypt the API key
  const { encrypted, iv, tag } = encrypt(apiKey);
  
  const { data, error } = await supabase
    .from('kaggle_accounts')
    .insert({
      username,
      api_key_encrypted: encrypted,
      api_key_iv: iv,
      api_key_tag: tag,
      label: label || username,
    })
    .select('id, username, label')
    .single();
  
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  
  return NextResponse.json({ success: true, account: data });
}
```

### app/api/endpoints/route.ts — Live Endpoint Discovery (Used by Chat App)
```typescript
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

// GET /api/endpoints — returns current live endpoints grouped by model
// This is called by the chat app to know where to route requests
export async function GET() {
  const { data } = await supabase
    .from('live_endpoints')
    .select('*');
  
  // Group by model
  const grouped: Record<string, unknown[]> = { pro: [], ultra: [] };
  for (const endpoint of data || []) {
    grouped[endpoint.model]?.push(endpoint);
  }
  
  return NextResponse.json({
    endpoints: grouped,
    timestamp: new Date().toISOString(),
    // Overall system health
    healthy: {
            pro: (grouped.pro?.length || 0) > 0,
      ultra: (grouped.ultra?.length || 0) > 0,
    }
  });
}
```

### app/api/sessions/route.ts — Session Listing (Admin)
```typescript
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data } = await supabase
    .from('sessions')
    .select(`
      *,
      kaggle_accounts (username, label)
    `)
    .order('created_at', { ascending: false })
    .limit(50);
  
  return NextResponse.json(data);
}
```

---

## vercel.json — Cron Configuration

```json
{
  "crons": [
    {
      "path": "/api/cron/orchestrate",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

**Important Vercel note:** Cron jobs on Hobby tier only support `"0 * * * *"` (hourly). For every-5-minute crons, you need Vercel Pro ($20/mo) OR use an external free cron service like:
- **cron-job.org** (free, calls your URL every 5 min)
- **EasyCron** (free tier)

Add a `CRON_SECRET` env var and verify the `x-cron-secret` header. External cron services pass it as a query param instead — adapt accordingly.

---

## SUPABASE RPC FUNCTION

Run in Supabase SQL Editor:
```sql
CREATE OR REPLACE FUNCTION increment_weekly_hours(p_account_id UUID, p_hours FLOAT)
RETURNS VOID LANGUAGE SQL AS $$
  UPDATE kaggle_accounts 
  SET weekly_hours_used = weekly_hours_used + p_hours,
      updated_at = NOW()
  WHERE id = p_account_id;
$$;
```

---

## LOAD BALANCING LOGIC (for Chat App Integration)

The chat app should call `/api/endpoints` on startup and cache for 60 seconds. When routing a request:

```typescript
// Round-robin across available endpoints for each model
const endpointCache: Record<string, { endpoints: unknown[]; lastIdx: Record<string, number> }> = {};

async function getEndpoint(model: 'pro' | 'ultra'): Promise<string> {
  const cache = endpointCache[model];
  const endpoints = cache?.endpoints || [];
  
  if (endpoints.length === 0) throw new Error(`No ${model} endpoints available`);
  
  // Round-robin
  const idx = (cache.lastIdx[model] || 0) % endpoints.length;
  cache.lastIdx[model] = idx + 1;
  
  return (endpoints[idx] as { openai_api_url: string }).openai_api_url;
}
```

---

## PACKAGE.JSON DEPENDENCIES

```json
{
  "dependencies": {
    "next": "^14.2.0",
    "@supabase/supabase-js": "^2.43.0",
    "typescript": "^5.4.0"
  }
}
```

No extra HTTP client library needed — use native `fetch` (Node 20 has it built-in).

---

## DELIVERABLES FOR THIS PHASE

1. Complete Next.js project with all files in the structure above
2. `lib/supabase.ts` — server client
3. `lib/crypto.ts` — encryption/decryption
4. `lib/kaggle.ts` — Kaggle API client + output parser
5. `lib/orchestrator.ts` — full orchestration cycle logic
6. All API routes (`/api/cron/orchestrate`, `/api/accounts`, `/api/endpoints`, `/api/sessions`)
7. `vercel.json` with cron config
8. SQL migration files (001 through 005) ready to paste into Supabase SQL Editor
9. Supabase RPC function SQL
10. `.env.local.example` with all required env vars listed and documented

Test the orchestrator with a mock Kaggle client that returns fake responses before deploying. Write `lib/kaggle.mock.ts` for this purpose.
