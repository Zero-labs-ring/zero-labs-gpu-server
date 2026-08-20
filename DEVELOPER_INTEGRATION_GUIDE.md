# 📘 Zero Labs Unified Cloud & GPU Hub — Developer Integration Guide

Welcome to the **Zero Labs Unified Developer Documentation**. This guide provides complete, production-ready code examples and API reference for integrating with:
1. **Live Web Search Engine API** (`/api/search`)
2. **Model Selector API** (`/api/v1/models`)
3. **OpenAI-Compatible Chat Completions & Streaming API** (`/v1/chat/completions`)
4. **Search-Augmented AI Generation (RAG)**

---

## 🔑 Permanent Credentials & Base URLs

| Service | URL / Value | Authentication |
| :--- | :--- | :--- |
| **API Base URL** | `https://zero-gpu-server.vercel.app` | — |
| **OpenAI Compatible Base URL** | `https://zero-gpu-server.vercel.app/v1` | `Bearer zerotech13287` |
| **API Key** | `zerotech13287` | Header: `Authorization: Bearer zerotech13287` |
| **Search Engine Endpoint** | `https://zero-gpu-server.vercel.app/api/search` | *Public / No Auth Required* |

---

## 🧠 Part 1: Models & Model Selection API

### 1.1 List All Available Models
Retrieve the dynamic list of available models and their capabilities.

- **Endpoint**: `GET /api/v1/models` (or `GET /v1/models`)
- **Headers**: `Authorization: Bearer zerotech13287`

#### cURL Request:
```bash
curl https://zero-gpu-server.vercel.app/api/v1/models \
  -H "Authorization: Bearer zerotech13287"
```

#### JSON Response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "titan-pro",
      "name": "Titan Pro 9B",
      "object": "model",
      "description": "High-throughput dual-T4 Titan Pro 9B model with MTP acceleration (64 max batch).",
      "context_window": 118000,
      "tier": "standard"
    },
    {
      "id": "pro",
      "name": "Titan Pro 9B (Short Alias)",
      "object": "model",
      "description": "Alias for Titan Pro 9B.",
      "context_window": 118000,
      "tier": "standard"
    },
    {
      "id": "titan-ultra",
      "name": "Titan Ultra 27B",
      "object": "model",
      "description": "Ultra-reasoning Titan Ultra 27B Q4_K_M model with dual-T4 GPU offloading.",
      "context_window": 118000,
      "tier": "premium"
    },
    {
      "id": "ultra",
      "name": "Titan Ultra 27B (Short Alias)",
      "object": "model",
      "description": "Alias for Titan Ultra 27B.",
      "context_window": 118000,
      "tier": "premium"
    },
    {
      "id": "search-pro",
      "name": "Titan Pro + Live Web Search",
      "object": "model",
      "description": "Titan Pro augmented with live real-time internet search context and citations.",
      "context_window": 118000,
      "tier": "standard"
    },
    {
      "id": "search-ultra",
      "name": "Titan Ultra + Live Web Search",
      "object": "model",
      "description": "Titan Ultra deep reasoning with real-time web search retrieval.",
      "context_window": 118000,
      "tier": "premium"
    }
  ]
}
```

---

## 🔍 Part 2: Live Real-Time Web Search API

The Search Engine provides unblocked, low-latency (<500ms) real-time web search results extracted across global feeds with clean titles, publisher metadata, and snippets.

- **Endpoint**: `GET /api/search`
- **Method**: `GET`
- **Authentication**: None required

### Query Parameters:
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `q` or `query` | `string` | **Yes** | Search keywords | `q=latest+ai+models` |
| `limit` | `number` | Optional | Number of results (1–10, default: `5`) | `limit=3` |

---

### 2.1 Python Search Example (No External Dependencies)
```python
import urllib.request
import urllib.parse
import json

def web_search(query: str, limit: int = 5) -> dict:
    url = f"https://zero-gpu-server.vercel.app/api/search?q={urllib.parse.quote(query)}&limit={limit}"
    with urllib.request.urlopen(url) as response:
        return json.loads(response.read().decode('utf-8'))

# Example Query
results = web_search("latest quantum computing milestones", limit=3)
print(f"Total Results: {results['count']} (Fetched in {results['latency_ms']}ms)\n")

for i, item in enumerate(results['results'], 1):
    print(f"[{i}] {item['title']}")
    print(f"    Source: {item['source']}")
    print(f"    URL:    {item['url']}")
    print(f"    Text:   {item['snippet']}\n")
```

---

### 2.2 JavaScript / TypeScript Search Example (Browser & Node.js)
```typescript
async function searchWeb(query: string, limit: number = 5) {
  const res = await fetch(
    `https://zero-gpu-server.vercel.app/api/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );
  const data = await res.json();
  return data;
}

// Example usage
searchWeb('space exploration discoveries', 3).then(data => {
  console.log(`Fetched in ${data.latency_ms}ms:`, data.results);
});
```

---

## 💬 Part 3: OpenAI-Compatible LLM Chat API

The `/v1/chat/completions` endpoint is a drop-in replacement for OpenAI API. It routes directly to your **2x Tesla T4 Kaggle GPU instances** with auto load balancing.

- **Base URL**: `https://zero-gpu-server.vercel.app/v1`
- **Endpoint**: `POST /v1/chat/completions` (or `/api/v1/chat/completions`)
- **Header**: `Authorization: Bearer zerotech13287`

---

### 3.1 Python Integration using Official `openai` Library

Install the official OpenAI package:
```bash
pip install openai
```

Run this code:
```python
from openai import OpenAI

# 1. Point client to Zero Labs gateway
client = OpenAI(
    base_url="https://zero-gpu-server.vercel.app/v1",
    api_key="zerotech13287"
)

# -------------------------------------------------------------
# Scenario A: Ultra-Fast Streaming Chat with Titan Pro 9B
# -------------------------------------------------------------
print("=== TITAN PRO 9B STREAMING ===")
stream = client.chat.completions.create(
    model="titan-pro", # or "pro"
    messages=[
        {"role": "user", "content": "Explain microservices vs monolith architecture in 3 bullet points."}
    ],
    temperature=0.7,
    max_tokens=8192, # Supports up to 131,072 (128K) tokens
    stream=True
)

for chunk in stream:
    text = chunk.choices[0].delta.content or ""
    print(text, end="", flush=True)

print("\n\n" + "="*50 + "\n")

# -------------------------------------------------------------
# Scenario B: Deep Analytical Reasoning with Titan Ultra 27B
# -------------------------------------------------------------
print("=== TITAN ULTRA 27B STREAMING ===")
stream_ultra = client.chat.completions.create(
    model="titan-ultra", # or "ultra"
    messages=[
        {"role": "user", "content": "Solve: If a car travels at 60 mph for 2.5 hours, then 40 mph for 1.5 hours, what is its average speed?"}
    ],
    temperature=0.5,
    max_tokens=16384, # Supports up to 131,072 (128K) tokens
    stream=True
)

for chunk in stream_ultra:
    text = chunk.choices[0].delta.content or ""
    print(text, end="", flush=True)
```

---

### 3.2 JavaScript / TypeScript Integration using Official `openai` npm

Install the package:
```bash
npm install openai
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://zero-gpu-server.vercel.app/v1',
  apiKey: 'zerotech13287',
});

async function run() {
  const stream = await client.chat.completions.create({
    model: 'titan-pro', // or 'titan-ultra', 'search-pro', 'search-ultra'
    messages: [
      { role: 'user', content: 'Write a TypeScript function to debounce an async API call.' }
    ],
    temperature: 0.7,
    max_tokens: 8192, // Supports up to 131,072 (128K) tokens
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

run().catch(console.error);
```

---

### 3.3 Raw cURL Request (Streaming SSE)
```bash
curl -N -X POST https://zero-gpu-server.vercel.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer zerotech13287" \
  -d '{
    "model": "titan-pro",
    "messages": [
      {"role": "user", "content": "What is the speed of light in miles per hour?"}
    ],
    "temperature": 0.7,
    "max_tokens": 8192,
    "stream": true
  }'
```

---

## 🌐 Part 4: Real-Time Web Search Augmentation (RAG)

You can activate live web search directly in your completions in two ways:

### Option 1: Use Search Models (Zero Configuration)
Simply specify `model: "search-pro"` or `model: "search-ultra"`:
```python
response = client.chat.completions.create(
    model="search-pro",
    messages=[
        {"role": "user", "content": "What were today's major technology news headlines?"}
    ],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Option 2: Pass `web_search: true` with any Model
```python
response = client.chat.completions.create(
    model="titan-ultra",
    messages=[
        {"role": "user", "content": "What is the latest score in the Champions League?"}
    ],
    extra_body={"web_search": True},
    stream=True
)
```

---

## ⚙️ Part 5: Error Codes & Handling

| Status Code | Meaning | Resolution |
| :--- | :--- | :--- |
| **`200 OK`** | Success | Response returned / streaming active |
| **`401 Unauthorized`** | Invalid API Key | Ensure `Authorization: Bearer zerotech13287` is passed |
| **`503 Service Unavailable`** | No GPU Online | The Kaggle GPU node is sleeping/offline. Open [https://zero-gpu-server.vercel.app](https://zero-gpu-server.vercel.app) and click **"Start GPU Node"**. It turns live in ~3 minutes |
| **`502 Bad Gateway`** | Tunnel Warming | The GPU tunnel is establishing connection; retry in 5–10 seconds |
