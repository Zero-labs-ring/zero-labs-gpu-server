# PHASE 4 — VERCEL API GATEWAY & "EVERYTHING MANAGER" (ZERO API)
## The Centralized API Server for Developers and Session Routing

---

## CONTEXT — READ BEFORE BUILDING

You are building the **Centralized Vercel API Gateway** (Phase 4) for Zero Labs. This acts as an OpenAI-compatible API Provider and the ultimate traffic controller for the Kaggle GPU architecture built in Phases 1 & 2. 

While Phase 2 (Orchestrator) manages the Kaggle bots and Phase 3 (Chat Webapp) is just a frontend for end users, **this Phase 4 system is the real backend brain that serves API traffic**.

### Core Requirements

1.  **OpenAI-Compatible `/v1/chat/completions` API:** Users (and your own Phase 3 Chat app) will ping this Endpoint. It must look and behave EXACTLY like OpenAI's API.
2.  **API Key Management for Users:** Developers can sign up on a dashboard, get a `sk-zero-...` API key, and receive $1 of free credit initially.
3.  **Low-Latency Traffic Routing (Avoiding Vercel Bottlenecks):** Vercel has execution timeouts and payload size limits. The Gateway must use Next.js Edge Functions streaming to pipe tokens directly from the Kaggle tunnels to the user without holding the entire response in memory.
4.  **Admin "Everything Manager" Dashboard:** A specific UI in this Vercel app where you (the admin) can add your 15 friends' Kaggle API keys into Supabase (integrating with the Phase 2 database table). 
5.  **Smart Session Load Balancing:** It reads the `live_endpoints` from Supabase (updated by Phase 2), calculates the math dynamically (Pro = ~36, Ultra = ~12), and routes incoming requests via Round-Robin or Least-Connections to the Cloudflared Tunnels.

---

## TECHNICAL ARCHITECTURE

### Separation of Duties
-   **Vercel:** Hosts the API Gateway Edge Functions, Admin Dashboard to enter Kaggle Keys, User Dashboard to get API Keys.
-   **Supabase (500MB DB tier):** Stores User API keys, token balances, and Admin Kaggle account pools.
-   **Kaggle (The GPU Farm):** Does the heavy lifting.
-   **Cloudflare Tunnels:** Piped directly to the Vercel Gateway.

### Edge Proxy Execution
By using Next.js **Edge Runtime** for the API routes, you bypass the standard serverless cold starts and memory limits. The Edge function authenticates the API key, checks Supabase token limits, picks the next healthy Cloudflare tunnel URL, and opens a raw HTTP stream proxy to the Kaggle GPU.

---

## SUPABASE SCHEMA (Phase 4 Additions)

Add these migrations to handle developer API keys and billing.

### Migration 010 — API Keys and Balances
```sql
CREATE TABLE developer_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT NOT NULL,
    credit_balance_usd DECIMAL(10,4) DEFAULT 1.0000, -- $1 free credit
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES developer_users(id),
    key_hash TEXT UNIQUE NOT NULL, -- SHA-256 hash of the generated key
    key_prefix TEXT NOT NULL,      -- e.g. "sk-zero-xyz12" for UI display
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES developer_users(id),
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost_usd DECIMAL(10,6),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## PROJECT STRUCTURE

```text
zero-labs-gateway/                 (Next.js App Router)
├── app/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── chat/completions/
│   │   │   │   └── route.ts       ← The EDGE streaming proxy router
│   │   │   └── models/
│   │   │       └── route.ts       ← Returns available models (Pro, Ultra)
│   ├── (admin)/
│   │   ├── dashboard/             ← "Everything Manager"
│   │   │   └── accounts/          ← Add Kaggle API keys here (UI for Phase 2)
│   ├── (developer)/
│   │   ├── keys/                  ← Dev UI to generate `sk-zero-...` keys
│   └── layout.tsx
├── lib/
│   ├── load-balancer.ts           ← Math to distribute users to tunnels
│   ├── billing.ts                 ← Edge function to deduct $ credits
│   └── edge-supabase.ts           ← Edge-compatible DB client
└── package.json
```

---

## CORE FILES TO IMPLEMENT

### 1. The Load Balancer (`lib/load-balancer.ts`)
This pulls the active nodes from the view created in Phase 2, tracking exactly how many ongoing requests exist for Pro and Ultra. 

```typescript
// Fetches the live Cloudflare tunnels from the DB, ensuring we do not 
// exceed the T2 maximum concurrencies you specified:

// - Pro: 36 concurrent across 2 GPUs
// - Ultra: 12 concurrent across 2 GPUs (Tensor Parallel = 2)
export async function getBestEndpoint(model: 'pro' | 'ultra'): Promise<string> {
    // Logic: Fetch grouped active endpoints from Supabase.
    // Use an unpredictable Round-Robin or random pick from the active arrays
    // to distribute the Vercel load perfectly across the Kaggle clones.
}
```

### 2. The Edge OpenAI API Proxy (`app/api/v1/chat/completions/route.ts`)
This is the heart of the system. It MUST run on the Edge to prevent Vercel 10s timeouts limits.

```typescript
import { NextRequest } from 'next/server';
import { getBestEndpoint } from '@/lib/load-balancer';

export const runtime = 'edge'; // CRITICAL: Run on Edge to avoid timeouts

export async function POST(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    // 1. Extract API Key (sk-zero-...)
    // 2. Hash key & Verify in Supabase via Edge Client
    // 3. Check developer credit balance (reject if < $0.00)
    
    // 4. Parse request body
    const body = await req.json();
    const model = body.model; // e.g. "titan-pro-9b"
    
    // 5. Route to correct Kaggle load-balanced tunnel
    const targetUrl = await getBestEndpoint(model);
    
    // 6. Proxy the request natively via fetch (keeps streaming intact)
    const response = await fetch(`${targetUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer placeholder' // vLLM doesn't care, but needed for format
        },
        body: JSON.stringify(body)
    });

    // 7. Stream the Kaggle response DIRECTLY to the Vercel Client.
    // This allows seamless zero-latency streaming matching OpenAI precisely.
    // NOTE: Log token counts in a non-blocking `waitUntil` context to bill the user!
    
    return new Response(response.body, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform'
        }
    });
}
```

### 3. The "Everything Manager" Admin Page (`app/(admin)/dashboard/accounts/page.tsx`)
The user interface where you can add your 15 friends' Kaggle accounts.
It directly inserts rows into the `kaggle_accounts` table from Phase 2.

```tsx
// Provide a form matching this structure:
export default function ManageKaggleAccounts() {
    // Add Account Form:
    // - Username: [_______]
    // - API Key (from Kaggle): [_______]
    // Save encrypts via API and sends to Supabase!
    
    // Dashboard Stats:
    // Display realtime count showing:
    // 
    // Active Pro Tunnels: [X/2]
    // Active Ultra Tunnels: [X/2]
}
```

---

## IMPORTANT DIRECTIVES FOR THE AI BUILDING THIS

1.  **Enforce Edge Streaming:** Standard Vercel Serverless Functions have a 10s–60s timeout depending on tier. LLM inference takes longer. You MUST enforce `export const runtime = 'edge'` in the API proxy.
2.  **Stateless Request Modification:** The API Gateway MUST pass through SSE (Server-Sent Events) exactly as it receives them from the vLLM/Llama.cpp Kaggle servers. Do not attempt to buffer or "read" the stream completely before sending it.
3.  **Cost Billing:** You must hook into `waitUntil()` or use a background queue in Edge to asynchronously update the `api_usage_logs` table after the stream closes, deducting from the $1 credit. 
4.  **No touching Phase 3:** Do not put chat UI layouts here. This app provides the `api.yourdomain.com` Developer endpoints and the internal Admin account manager. Phase 3 (The Web Chat) connects to THIS app's `/v1/chat/completions`.
