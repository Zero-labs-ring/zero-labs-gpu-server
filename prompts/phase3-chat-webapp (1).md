# PHASE 3 — ZERO LABS CHAT WEB APP
## Build the User-Facing Chat Interface (Claude/ChatGPT Style)

---

## CONTEXT — READ BEFORE BUILDING

You are building **Zero Labs Chat** — a separate Next.js web app (NOT the same project as the Phase 2 orchestrator) that users interact with to chat with the 3 AI models. This is the public-facing product. It connects to the Phase 2 orchestrator to discover live backend URLs, then proxies user messages directly to those backends for inference.

### The 3 Models Users See
| Internal Name | User-Facing Name | Tier | Default |
|---|---|---|---|
 **Zero Flash** | Free | No |
| Pro (Ornith 9B) | **Zero Pro** | Standard (default) | ✅ Yes |
| Ultra (Qwen3.6-27B) | **Zero Ultra** | Premium | No |

This mirrors Claude's Haiku → Sonnet (default) → Opus structure exactly. Pro is the default model that users see on first load.

### How This App Connects to the Backend
1. On startup (and every 60 seconds), call `GET {ORCHESTRATOR_URL}/api/endpoints` to get live tunnel URLs
2. Cache those URLs in memory
3. When user sends a message, proxy to the appropriate model's `openai_api_url` (OpenAI-compatible `/v1/chat/completions`)
4. Stream the response back to the user via SSE

The orchestrator URL is set in environment variables. The two apps are **completely separate deployments** — this app just calls the orchestrator's public API.

---

## TECH STACK

```
Framework:     Next.js 14+ (App Router)
Runtime:       Node.js 20
Deploy:        Vercel
Database:      Supabase (same Supabase project as Phase 2 — different tables)
Auth:          Supabase Auth (email/password + optional Google OAuth)
Streaming:     Server-Sent Events (SSE) via Next.js Route Handler
Styling:       Tailwind CSS + shadcn/ui
State:         Zustand (client state: active model, chat history)
Icons:         lucide-react
```

---

## SUPABASE SCHEMA (Add to the same Supabase project from Phase 2)

### Migration 006 — users table (extends Supabase auth.users)
```sql
-- Profile table that mirrors auth.users with our extra fields
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'standard', 'premium')),
  
  -- Token usage tracking
  flash_tokens_used BIGINT DEFAULT 0,
  pro_tokens_used BIGINT DEFAULT 0,
  ultra_tokens_used BIGINT DEFAULT 0,
  
  -- Monthly limits (null = unlimited for premium)
  flash_monthly_limit BIGINT DEFAULT 500000,   -- 500K tokens/month free
  pro_monthly_limit BIGINT DEFAULT 200000,     -- 200K tokens/month standard
  ultra_monthly_limit BIGINT DEFAULT 50000,    -- 50K tokens/month premium
  
  -- Reset tracking
  usage_reset_at TIMESTAMPTZ DEFAULT date_trunc('month', NOW()) + INTERVAL '1 month',
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO user_profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

### Migration 007 — conversations table
```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT DEFAULT 'New conversation',
  model TEXT NOT NULL CHECK (model IN ('flash', 'pro', 'ultra')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_user ON conversations (user_id, created_at DESC);
```

### Migration 008 — messages table
```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  
  -- Token tracking per message
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  
  -- Thinking trace (for Pro/Ultra with thinking enabled)
  thinking_content TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at ASC);
```

### Migration 009 — RLS Policies
```sql
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY "users see own profile" ON user_profiles
  FOR ALL USING (auth.uid() = id);

CREATE POLICY "users see own conversations" ON conversations
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "users see own messages" ON messages
  FOR ALL USING (
    conversation_id IN (
      SELECT id FROM conversations WHERE user_id = auth.uid()
    )
  );
```

### Migration 010 — usage increment RPC
```sql
CREATE OR REPLACE FUNCTION increment_token_usage(
  p_user_id UUID,
  p_model TEXT,
  p_tokens BIGINT
)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER AS $$
  UPDATE user_profiles
  SET
    flash_tokens_used = CASE WHEN p_model = 'flash' THEN flash_tokens_used + p_tokens ELSE flash_tokens_used END,
    pro_tokens_used   = CASE WHEN p_model = 'pro'   THEN pro_tokens_used   + p_tokens ELSE pro_tokens_used   END,
    ultra_tokens_used = CASE WHEN p_model = 'ultra' THEN ultra_tokens_used + p_tokens ELSE ultra_tokens_used END,
    updated_at = NOW()
  WHERE id = p_user_id;
$$;
```

---

## PROJECT STRUCTURE

```
zero-labs-chat/                    (separate Next.js project)
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx         ← login form
│   │   └── signup/page.tsx        ← signup form
│   ├── (app)/
│   │   ├── layout.tsx             ← auth guard + sidebar layout
│   │   ├── page.tsx               ← redirect to /chat
│   │   ├── chat/
│   │   │   ├── page.tsx           ← new chat (no conversation selected)
│   │   │   └── [conversationId]/
│   │   │       └── page.tsx       ← active conversation
│   │   ├── settings/
│   │   │   └── page.tsx           ← user settings (display name, tier)
│   │   └── api-keys/
│   │       └── page.tsx           ← dev API key management (Phase 4)
│   ├── api/
│   │   ├── chat/
│   │   │   └── route.ts           ← SSE streaming proxy to backends
│   │   ├── conversations/
│   │   │   ├── route.ts           ← GET list / POST create
│   │   │   └── [id]/
│   │   │       ├── route.ts       ← GET / DELETE conversation
│   │   │       └── messages/
│   │   │           └── route.ts   ← GET messages for conversation
│   │   └── usage/
│   │       └── route.ts           ← GET current token usage for user
│   └── layout.tsx
├── components/
│   ├── chat/
│   │   ├── ChatWindow.tsx         ← main chat area
│   │   ├── MessageBubble.tsx      ← renders user + assistant messages
│   │   ├── MessageInput.tsx       ← textarea + send button + model picker
│   │   ├── ModelSelector.tsx      ← Pro / Ultra pill selector
│   │   ├── ThinkingIndicator.tsx  ← animated "thinking..." for Pro/Ultra
│   │   └── StreamingMessage.tsx   ← live-updating assistant message
│   ├── sidebar/
│   │   ├── Sidebar.tsx            ← left sidebar (conversation list)
│   │   ├── ConversationItem.tsx   ← single conversation in list
│   │   └── NewChatButton.tsx
│   └── ui/                        ← shadcn/ui components
├── lib/
│   ├── supabase/
│   │   ├── client.ts              ← browser Supabase client
│   │   └── server.ts              ← server Supabase client (cookies)
│   ├── endpoints.ts               ← orchestrator endpoint fetching + cache
│   ├── proxy.ts                   ← inference request proxying
│   └── tokens.ts                  ← token counting helper
├── stores/
│   └── chatStore.ts               ← Zustand store
├── middleware.ts                  ← auth protection
└── package.json
```

---

## ENVIRONMENT VARIABLES

```bash
# .env.local

# Supabase — SAME project as Phase 2, but use ANON key here (not service role)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

# For server-side writes (token increments etc), use service role
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Phase 2 orchestrator URL (your deployed Phase 2 Vercel app)
ORCHESTRATOR_URL=https://your-orchestrator.vercel.app
ORCHESTRATOR_API_SECRET=shared_secret_between_apps  # Phase 2 checks this header

# Public app config
NEXT_PUBLIC_APP_NAME=Zero Labs
NEXT_PUBLIC_APP_URL=https://zerolabs.ai
```

---

## CORE LIBRARY FILES

### lib/endpoints.ts — Backend Discovery with Caching
```typescript
// Fetches live model endpoints from the Phase 2 orchestrator
// Caches for 60 seconds to avoid hammering the orchestrator

interface ModelEndpoint {
  tunnel_url: string;
  openai_api_url: string;
  gpu: string;
  session_id: string;
}

interface EndpointCache {
    pro: ModelEndpoint[];
  ultra: ModelEndpoint[];
  fetchedAt: number;
}

let cache: EndpointCache | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

// Round-robin state per model
const rrIndex: Record<string, number> = { pro: 0, ultra: 0 };

export async function getEndpoint(model: 'pro' | 'ultra'): Promise<string> {
  // Refresh cache if stale or empty
  if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    const res = await fetch(`${process.env.ORCHESTRATOR_URL}/api/endpoints`, {
      headers: { 'x-api-secret': process.env.ORCHESTRATOR_API_SECRET! },
      next: { revalidate: 0 }, // always fresh on server
    });
    
    if (!res.ok) throw new Error('Failed to fetch endpoints from orchestrator');
    
    const data = await res.json();
    cache = {
      pro: data.endpoints.pro || [],
      ultra: data.endpoints.ultra || [],
      fetchedAt: Date.now(),
    };
  }
  
  const endpoints = cache[model];
  if (!endpoints || endpoints.length === 0) {
    throw new Error(`No ${model} backend available. Model may be offline.`);
  }
  
  // Round-robin selection
  const idx = rrIndex[model] % endpoints.length;
  rrIndex[model] = idx + 1;
  
  return endpoints[idx].openai_api_url;
}

export async function getSystemHealth(): Promise<{ pro: boolean; ultra: boolean }> {
  try {
    const res = await fetch(`${process.env.ORCHESTRATOR_URL}/api/endpoints`, {
      headers: { 'x-api-secret': process.env.ORCHESTRATOR_API_SECRET! },
    });
    const data = await res.json();
    return data.healthy || { pro: false, ultra: false };
  } catch {
    return { pro: false, ultra: false };
  }
}
```

### app/api/chat/route.ts — SSE Streaming Proxy
```typescript
// This is the core inference route. It:
// 1. Validates the user is authenticated
// 2. Checks they're within token limits
// 3. Gets the backend URL for the requested model
// 4. Forwards the request and streams the response back as SSE

import { NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getEndpoint } from '@/lib/endpoints';

export const runtime = 'nodejs'; // NOT edge — need full Node.js for crypto

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  
  // 1. Auth check
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // 2. Parse request body
  const { 
    messages,          // [{role, content}] full conversation history
    model = 'pro',     // 'pro' | 'ultra'
    conversationId,    // for saving messages
    thinkingEnabled = false, // Pro/Ultra only
  } = await req.json();
  
  // 3. Check token limit
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  
  if (!profile) return new Response('Profile not found', { status: 404 });
  
  const modelUsedKey = `${model}_tokens_used` as keyof typeof profile;
  const modelLimitKey = `${model}_monthly_limit` as keyof typeof profile;
  const used = (profile[modelUsedKey] as number) || 0;
  const limit = (profile[modelLimitKey] as number) || 0;
  
  if (used >= limit) {
    return new Response(
      JSON.stringify({ error: 'token_limit_exceeded', model }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // 4. Get backend endpoint
  let backendUrl: string;
  try {
    backendUrl = await getEndpoint(model as 'pro' | 'ultra');
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'model_unavailable', message: String(e) }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // 5. Build the request to the backend
  const modelNameMap = { pro: 'titan-pro', ultra: 'titan-ultra' };
  
  const backendBody: Record<string, unknown> = {
    model: modelNameMap[model as keyof typeof modelNameMap],
    messages,
    stream: true,
    max_tokens: model === 'ultra' ? 8192 : 4096,
  };
  
  // Add thinking for Pro/Ultra if enabled
  if (thinkingEnabled && model !== undefined) {
    backendBody.thinking = { type: 'enabled', budget_tokens: 2048 };
  }
  
  // 6. Forward to backend and stream back
  const backendRes = await fetch(`${backendUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backendBody),
  });
  
  if (!backendRes.ok) {
    const errText = await backendRes.text();
    return new Response(
      JSON.stringify({ error: 'backend_error', details: errText }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  // 7. Stream response back to client with token tracking
  let completionTokens = 0;
  const promptTokens = Math.ceil(
    messages.reduce((acc: number, m: { content: string }) => acc + m.content.length, 0) / 4
  );
  
  const stream = new ReadableStream({
    async start(controller) {
      const reader = backendRes.body!.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          controller.enqueue(value);
          
          // Extract text for token counting
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) {
                  fullResponse += delta;
                  completionTokens += Math.ceil(delta.length / 4);
                }
              } catch {}
            }
          }
        }
      } finally {
        controller.close();
        
        // Save message and update token usage (fire and forget)
        const totalTokens = promptTokens + completionTokens;
        
        Promise.all([
          // Save assistant message
          conversationId ? supabase.from('messages').insert({
            conversation_id: conversationId,
            role: 'assistant',
            content: fullResponse,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          }) : Promise.resolve(),
          
          // Increment token usage
          supabase.rpc('increment_token_usage', {
            p_user_id: user.id,
            p_model: model,
            p_tokens: totalTokens,
          }),
        ]).catch(console.error);
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

---

## UI COMPONENTS

### components/chat/ModelSelector.tsx — Model Picker (Pro / Ultra)
```tsx
// Pill-style model selector, same feel as Claude's model dropdown

  {
    id: 'pro',
    name: 'Zero Pro',
    description: 'Balanced · Reasoning',
    icon: Brain,
    color: 'bg-blue-50 text-blue-700 hover:bg-blue-100',
    activeColor: 'bg-blue-600 text-white',
    thinkingSupported: true,
  },
  {
    id: 'ultra',
    name: 'Zero Ultra',
    description: 'Powerful · Premium',
    icon: Sparkles,
    color: 'bg-purple-50 text-purple-700 hover:bg-purple-100',
    activeColor: 'bg-purple-600 text-white',
    thinkingSupported: true,
  },
] as const;

interface Props {
  selectedModel: 'pro' | 'ultra';
  onSelect: (model: 'pro' | 'ultra') => void;
  thinkingEnabled: boolean;
  onThinkingToggle: (v: boolean) => void;
}

export function ModelSelector({ selectedModel, onSelect, thinkingEnabled, onThinkingToggle }: Props) {
  const activeModel = MODELS.find(m => m.id === selectedModel)!;
  
  return (
    <div className="flex items-center gap-2">
      {/* Model pills */}
      <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-full p-1">
        {MODELS.map(model => {
          const Icon = model.icon;
          const isActive = model.id === selectedModel;
          return (
            <button
              key={model.id}
              onClick={() => onSelect(model.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                isActive ? model.activeColor : model.color
              }`}
            >
              <Icon size={14} />
              {model.name}
            </button>
          );
        })}
      </div>
      
      {/* Thinking toggle — only for Pro and Ultra */}
      {activeModel.thinkingSupported && (
        <button
          onClick={() => onThinkingToggle(!thinkingEnabled)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
            thinkingEnabled
              ? 'bg-amber-100 text-amber-800 border-amber-200'
              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
          }`}
        >
          <Brain size={14} />
          Think
        </button>
      )}
    </div>
  );
}
```

### components/chat/MessageBubble.tsx — Message Rendering
```tsx
// Renders user and assistant messages
// Assistant messages support markdown (use react-markdown)
// Thinking content is collapsible

'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

interface Props {
  role: 'user' | 'assistant';
  content: string;
  thinkingContent?: string;
  isStreaming?: boolean;
}

export function MessageBubble({ role, content, thinkingContent, isStreaming }: Props) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-3">
          <p className="text-sm whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[80%] space-y-2">
        {/* Thinking trace (collapsible) */}
        {thinkingContent && (
          <button
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600"
          >
            <Brain size={12} />
            <span>Thinking trace</span>
            {thinkingExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        {thinkingContent && thinkingExpanded && (
          <div className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
            {thinkingContent}
          </div>
        )}
        
        {/* Main response */}
        <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
          <div className="prose prose-sm max-w-none text-gray-800">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}
```

### components/chat/MessageInput.tsx — Input Area
```tsx
'use client';

import { useState, useRef, KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';

interface Props {
  onSend: (message: string) => void;
  isStreaming: boolean;
  onStop: () => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, isStreaming, onStop, disabled }: Props) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  const handleSend = () => {
    if (!input.trim() || isStreaming || disabled) return;
    onSend(input.trim());
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };
  
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
  
  const handleInput = () => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  };
  
  return (
    <div className="flex items-end gap-3 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm focus-within:border-blue-300 focus-within:ring-1 focus-within:ring-blue-300">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder="Message Zero Labs..."
        rows={1}
        disabled={disabled}
        className="flex-1 resize-none bg-transparent outline-none text-sm text-gray-800 placeholder-gray-400 min-h-[24px] max-h-[200px]"
      />
      <button
        onClick={isStreaming ? onStop : handleSend}
        disabled={!isStreaming && (!input.trim() || disabled)}
        className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-all bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400"
      >
        {isStreaming ? <Square size={14} fill="white" /> : <Send size={14} />}
      </button>
    </div>
  );
}
```

### stores/chatStore.ts — Zustand Global State
```typescript
import { create } from 'zustand';

type Model = 'pro' | 'ultra';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinkingContent?: string;
  isStreaming?: boolean;
}

interface ChatStore {
  // Model selection
  selectedModel: Model;
  thinkingEnabled: boolean;
  setModel: (model: Model) => void;
  setThinking: (v: boolean) => void;
  
  // Active conversation
  conversationId: string | null;
  messages: Message[];
  isStreaming: boolean;
  
  // Actions
  setConversationId: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateLastAssistantMessage: (content: string, thinking?: string) => void;
  setStreaming: (v: boolean) => void;
  clearChat: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  selectedModel: 'pro',
  thinkingEnabled: false,
  setModel: (model) => set({ selectedModel: model }),
  setThinking: (v) => set({ thinkingEnabled: v }),
  
  conversationId: null,
  messages: [],
  isStreaming: false,
  
  setConversationId: (id) => set({ conversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set(state => ({ messages: [...state.messages, message] })),
  updateLastAssistantMessage: (content, thinking) => set(state => {
    const messages = [...state.messages];
    const lastIdx = messages.length - 1;
    if (messages[lastIdx]?.role === 'assistant') {
      messages[lastIdx] = { ...messages[lastIdx], content, thinkingContent: thinking };
    }
    return { messages };
  }),
  setStreaming: (v) => set({ isStreaming: v }),
  clearChat: () => set({ messages: [], conversationId: null }),
}));
```

### components/chat/ChatWindow.tsx — Main Chat Orchestration
```tsx
'use client';

import { useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useChatStore } from '@/stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { ModelSelector } from './ModelSelector';
import { ThinkingIndicator } from './ThinkingIndicator';

export function ChatWindow() {
  const {
    selectedModel, thinkingEnabled, setModel, setThinking,
    conversationId, messages, isStreaming,
    addMessage, updateLastAssistantMessage, setStreaming, setConversationId,
  } = useChatStore();
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
  const handleSend = async (content: string) => {
    // Add user message
    const userMessage = { id: uuidv4(), role: 'user' as const, content };
    addMessage(userMessage);
    
    // Placeholder assistant message
    const assistantId = uuidv4();
    addMessage({ id: assistantId, role: 'assistant', content: '', isStreaming: true });
    setStreaming(true);
    
    abortControllerRef.current = new AbortController();
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({ role: m.role, content: m.content })),
          model: selectedModel,
          conversationId,
          thinkingEnabled: thinkingEnabled && selectedModel !== undefined,
        }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        if (err.error === 'token_limit_exceeded') {
          updateLastAssistantMessage('⚠️ You have reached your monthly token limit for this model. Please upgrade your plan or wait for your usage to reset.');
        } else if (err.error === 'model_unavailable') {
          updateLastAssistantMessage('⚠️ This model is temporarily offline. Please try again in a few minutes.');
        }
        return;
      }
      
      // Stream the response
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let accumulatedThinking = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta;
            
            if (delta?.content) accumulated += delta.content;
            if (delta?.reasoning_content) accumulatedThinking += delta.reasoning_content;
            
            updateLastAssistantMessage(accumulated, accumulatedThinking || undefined);
          } catch {}
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        updateLastAssistantMessage('⚠️ Connection error. Please try again.');
      }
    } finally {
      setStreaming(false);
    }
  };
  
  const handleStop = () => {
    abortControllerRef.current?.abort();
    setStreaming(false);
  };
  
  const isThinkingState = isStreaming && messages[messages.length - 1]?.content === '';
  
  return (
    <div className="flex flex-col h-full">
      {/* Model selector at top */}
      <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
        <ModelSelector
          selectedModel={selectedModel}
          onSelect={setModel}
          thinkingEnabled={thinkingEnabled}
          onThinkingToggle={setThinking}
        />
      </div>
      
      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-2">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-3">
            <div className="text-4xl">⚡</div>
            <h2 className="text-xl font-semibold text-gray-800">Zero Labs</h2>
            <p className="text-gray-400 text-sm max-w-xs">
              Start a conversation with Pro or Ultra
            </p>
          </div>
        )}
        
        {messages.map(msg => (
          msg.isStreaming && isThinkingState
            ? <ThinkingIndicator key={msg.id} model={selectedModel} />
            : <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                thinkingContent={msg.thinkingContent}
                isStreaming={msg.isStreaming}
              />
        ))}
        <div ref={scrollRef} />
      </div>
      
      {/* Input area */}
      <div className="border-t border-gray-100 px-4 py-4">
        <MessageInput
          onSend={handleSend}
          isStreaming={isStreaming}
          onStop={handleStop}
        />
        <p className="text-center text-xs text-gray-400 mt-2">
          Zero Labs can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
```

---

## AUTH PAGES

### app/(auth)/login/page.tsx
```tsx
// Standard login form using Supabase Auth
// Fields: email, password
// Links to /signup
// On success: redirect to /chat

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  
  const handleLogin = async () => {
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push('/chat');
    }
  };
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-6">
        <div className="text-center">
          <div className="text-3xl mb-2">⚡</div>
          <h1 className="text-xl font-bold text-gray-900">Zero Labs</h1>
          <p className="text-sm text-gray-400 mt-1">Sign in to continue</p>
        </div>
        
        <div className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-all"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
        
        <p className="text-center text-sm text-gray-400">
          No account?{' '}
          <Link href="/signup" className="text-blue-600 hover:underline">
            Sign up free
          </Link>
        </p>
      </div>
    </div>
  );
}
```

### middleware.ts — Auth Protection
```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { get: (name) => req.cookies.get(name)?.value, set: () => {}, remove: () => {} } }
  );
  
  const { data: { session } } = await supabase.auth.getSession();
  
  // Redirect unauthenticated users to /login
  const isAuthPage = req.nextUrl.pathname.startsWith('/login') || req.nextUrl.pathname.startsWith('/signup');
  
  if (!session && !isAuthPage) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  
  if (session && isAuthPage) {
    return NextResponse.redirect(new URL('/chat', req.url));
  }
  
  return res;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

---

## SIDEBAR — CONVERSATION HISTORY

### components/sidebar/Sidebar.tsx
```tsx
// Left sidebar showing conversation list
// New Chat button at top
// Conversations grouped by: Today / Yesterday / Last 7 days / Older
// Click conversation → loads it into chat window
// Hover conversation → show delete button

'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { PlusCircle, Trash2, Zap, Brain, Sparkles } from 'lucide-react';

interface Conversation {
  id: string;
  title: string;
  model: 'pro' | 'ultra';
  created_at: string;
}

const MODEL_ICONS = { pro: Brain, ultra: Sparkles };
const MODEL_COLORS = { pro: 'text-blue-400', ultra: 'text-purple-400' };

export function Sidebar() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const router = useRouter();
  const params = useParams();
  const activeId = params?.conversationId as string;
  
  useEffect(() => {
    fetch('/api/conversations')
      .then(r => r.json())
      .then(setConversations)
      .catch(console.error);
  }, []);
  
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeId === id) router.push('/chat');
  };
  
  return (
    <div className="w-64 border-r border-gray-100 h-full flex flex-col bg-gray-50">
      <div className="p-4">
        <button
          onClick={() => router.push('/chat')}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-all"
        >
          <PlusCircle size={16} />
          New conversation
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {conversations.map(conv => {
          const Icon = MODEL_ICONS[conv.model];
          return (
            <div
              key={conv.id}
              onClick={() => router.push(`/chat/${conv.id}`)}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                activeId === conv.id ? 'bg-white shadow-sm' : 'hover:bg-white hover:shadow-sm'
              }`}
            >
              <Icon size={13} className={MODEL_COLORS[conv.model]} />
              <span className="flex-1 text-sm text-gray-700 truncate">{conv.title}</span>
              <button
                onClick={e => handleDelete(conv.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
      
      {/* User area at bottom */}
      <div className="p-4 border-t border-gray-100">
        <button
          onClick={() => router.push('/settings')}
          className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-white hover:text-gray-700 transition-all"
        >
          Settings & Usage
        </button>
      </div>
    </div>
  );
}
```

---

## API ROUTES

### app/api/conversations/route.ts
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

// GET — list user's conversations
export async function GET() {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json([], { status: 401 });
  
  const { data } = await supabase
    .from('conversations')
    .select('id, title, model, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  
  return NextResponse.json(data || []);
}

// POST — create new conversation, returns id
export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  
  const { model, firstMessage } = await req.json();
  
  // Generate title from first 50 chars of first message
  const title = firstMessage?.slice(0, 50) + (firstMessage?.length > 50 ? '...' : '') || 'New conversation';
  
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id, model, title })
    .select('id')
    .single();
  
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  
  return NextResponse.json({ id: data.id });
}
```

---

## PACKAGE.JSON DEPENDENCIES

```json
{
  "dependencies": {
    "next": "^14.2.0",
    "@supabase/supabase-js": "^2.43.0",
    "@supabase/ssr": "^0.3.0",
    "zustand": "^4.5.0",
    "react-markdown": "^9.0.0",
    "lucide-react": "^0.383.0",
    "uuid": "^10.0.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.4.0"
  }
}
```

---

## USAGE DISPLAY (Settings Page)

### app/(app)/settings/page.tsx
```tsx
// Show the user their current token usage with progress bars

// Pro: X / 200,000 tokens used this month  
// Ultra: X / 50,000 tokens used this month
// Reset date
// Account tier badge
// Display name editing
```

Build a clean settings page that:
1. Fetches `GET /api/usage` (returns their `user_profiles` row)
2. Shows 3 progress bars (one per model)
3. Shows tier badge (Free / Standard / Premium)
4. Allows editing display name
5. Has a "Get API Key" link → `/api-keys` page

---

## DELIVERABLES FOR THIS PHASE

1. Complete Next.js project with all files in the structure above
2. All 4 SQL migrations (006–010) ready for Supabase SQL Editor
3. `middleware.ts` — auth protection
4. `app/(auth)/login/page.tsx` — login page
5. `app/(auth)/signup/page.tsx` — signup page (mirrors login, uses `signUp`)
6. `app/(app)/layout.tsx` — Sidebar + auth guard
7. `app/(app)/chat/page.tsx` — new chat landing
8. `app/(app)/chat/[conversationId]/page.tsx` — loads conversation messages
9. `app/(app)/settings/page.tsx` — usage + profile
10. All components in `components/chat/` and `components/sidebar/`
11. `stores/chatStore.ts` — Zustand store
12. `lib/endpoints.ts` — backend discovery
13. `lib/supabase/client.ts` and `lib/supabase/server.ts`
14. All API routes (`/api/chat`, `/api/conversations`, `/api/usage`)
15. `package.json`, `tailwind.config.ts`, `tsconfig.json`

The app must be fully working: users can sign up, pick a model, chat, see streaming responses, and view their usage.
