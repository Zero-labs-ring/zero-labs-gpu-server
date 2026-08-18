# PHASE 1 — KAGGLE NOTEBOOK TEMPLATES
## Build 2 Production Kaggle Notebooks for Zero Labs AI Inference

---

## PRE-PHASE 1 (METHODOLOGY): LOOP ENGINEERING

Before building the full automated infrastructure, we will use an iterative **"Loop Engineering"** approach to ensure stability. We will NOT build everything at once. Instead, we will build, test, and fix components systematically.

**The Loop Engineering Process:**
1. **Minimal Vercel Admin**: First, get a simple Vercel admin frontend running just to input and manage the Kaggle API key.
2. **Single Model Notebook**: Build and deploy the Kaggle notebook for a **single model** (e.g., the Pro model) first.
3. **AI Autonomous Debugging (The Loop)**: We will run the notebook using the Kaggle API. I (the AI) will read the kernel output logs directly through the terminal. If it fails, I will edit the notebook and retry. This loop repeats until the model successfully starts and serves requests.
4. **Scale to Other Models**: Once the first model works and is saved, we repeat this loop for the remaining model (Ultra).
5. **Terminal Chat Verification**: We will verify the account, API, and tunnel are working by sending chat requests directly from the terminal.
6. **Build Remaining Infrastructure**: Only after this core loop is fully tested and proven will we build the rest of the Vercel orchestrator logic (cron jobs, database) and the Chat Web App around it.

---

## CONTEXT — READ BEFORE BUILDING

You are building 2 Kaggle notebook `.ipynb` files that serve as AI inference backends for a multi-model AI platform called **Zero Labs**. These notebooks run headless on Kaggle's free GPU infrastructure (2× NVIDIA T4, 16GB VRAM each = 32GB total per session). A Vercel orchestrator will push these notebooks via the Kaggle API and parse their output to extract tunnel URLs.

### The 2 Models
| Notebook | Model | Serving Engine | Architecture |
|---|---|---|---|
| `pro_notebook.ipynb` | Ornith 1.0-9B (`ZEROLABS1/ornith-9b-merged-v5`) | FastAPI + PyTorch + BitsAndBytes NF4 | Qwen3.5 hybrid architecture (64 max batch / 32 per GPU) |
| `ultra_notebook.ipynb` | Qwen3.6-27B AWQ INT4 + LoRA | Standard mainline vLLM TP=2 | Qwen3.5 architecture |

### Session Layout
```


PRO SESSION (1 Kaggle account, 2×T4):
  GPU0 (T4-0): Instance 1 (Ornith 9B bnb 4-bit), port 8000 → up to 32 concurrent requests
  GPU1 (T4-1): Instance 2 (Ornith 9B bnb 4-bit), port 8001 → up to 32 concurrent requests
  Bearer Token Security: Authorization: Bearer <ZERO_API_KEY> required on /v1/* endpoints
  cloudflared tunnel: maps both ports → 2 URLs printed

ULTRA SESSION (2 Kaggle accounts, each with 2×T4):
  GPU0+GPU1 combined tensor-parallel: vLLM instance, port 8000 → ~5-8 concurrent
  cloudflared tunnel: 1 URL printed
```

---

## NOTEBOOK 1: `pro_notebook.ipynb`

### Overview
Loads `ZEROLABS1/ornith-9b-merged-v5` weights, performs on-disk/meta checkpoint diagnosis & LoRA/key remapping checks, loads 4-bit (bitsandbytes NF4) model instances per GPU, runs FastAPI OpenAI-compatible inference servers with SSE streaming and per-request Bearer authentication (`ZERO_API_KEY`), starts cloudflared tunnels, and outputs structured JSON delimiters (`===ZERO_LABS_OUTPUT_START===`).

### High-Level Cell Breakdown:
1. **GPU Check**: Verifies 2x NVIDIA T4 GPUs available via `nvidia-smi`.
2. **Secrets & API Key Loader**: Loads `HF_TOKEN` and `ZERO_API_KEY` from Kaggle secrets (or generates random session key).
3. **Dependencies Installation**: Installs `transformers>=5.5.0`, `bitsandbytes>=0.43.3`, `fastapi`, `uvicorn`, `sse-starlette`, `accelerate`, and optional `flash-linear-attention` / `causal-conv1d`.
4. **Cloudflared Installation**: Downloads latest binary to `/usr/local/bin/cloudflared`.
5. **Model Download & Checkpoint Diagnostic**: Downloads `ZEROLABS1/ornith-9b-merged-v5` to `/kaggle/working/ornith-9b`. Runs pre-load safetensors key verification & LoRA state-dict remapping diagnosis.
6. **Model Loading & Warmup**: Loads 4-bit quantized instances into `cuda:0` and `cuda:1` via `BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4')`. Runs sanity generation pass.
7. **FastAPI & Batched Streamer Engine**: Runs async queue-backed batched streamer (`MAX_BATCH=32`, `QUEUE_DEPTH=96`), streaming OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints protected by Bearer API Key.
8. **Tunnel & Output Contract**: Starts cloudflared tunnel threads for ports 8000 and 8001, outputs structured JSON bounded by `===ZERO_LABS_OUTPUT_START===` and `===ZERO_LABS_OUTPUT_END===`.
9. **Keep-Alive & Health Monitoring**: Heartbeat loop every 5 minutes with automatic graceful rotation at 9 hours.

---

## NOTEBOOK 2: `ultra_notebook.ipynb`

### Overview
Loads Qwen3.6-27B AWQ INT4 base with the Zero Labs LoRA adapter, runs 1 vLLM instance with tensor-parallel-size=2 (spans both T4s), single cloudflared tunnel, prints structured JSON output.

### Cell 1 — GPU Check (same pattern)

### Cell 2 — cloudflared Install (same)

### Cell 3 — vLLM Install (same as Pro)

### Cell 4 — Download Base Model + LoRA
```python
import os
from huggingface_hub import snapshot_download

HF_TOKEN = os.environ.get("HF_TOKEN", "")
BASE_CACHE = "/kaggle/working/models/qwen3-27b-awq"
LORA_CACHE = "/kaggle/working/models/titan-ultra-lora"

# Download AWQ base (Qwen3.6-27B community AWQ quant — check HF for this)
# If community AWQ doesn't exist yet, use: "Qwen/Qwen3.6-27B-AWQ" or similar
BASE_REPO = "Qwen/Qwen3.6-27B-AWQ"  # UPDATE if a community quant exists on HF
LORA_REPO = "ZEROLABS1/titan-ultra-lora"  # Your LoRA adapter

for cache, repo, name in [(BASE_CACHE, BASE_REPO, "Base AWQ"), (LORA_CACHE, LORA_REPO, "LoRA")]:
    if not os.path.exists(f"{cache}/config.json"):
        print(f"Downloading {name} from {repo}...")
        snapshot_download(
            repo_id=repo,
            local_dir=cache,
            token=HF_TOKEN if HF_TOKEN else None
        )
        print(f"{name} download complete")
    else:
        print(f"{name} cached at {cache}")
```

### Cell 5 — Start Single vLLM Instance (Tensor Parallel 2)
```python
import subprocess, os, time, requests

SERVER_PORT = 8000
MAX_CONCURRENT = 8  # Ultra is premium, lower concurrency is expected

cmd = [
    "python", "-m", "vllm.entrypoints.openai.api_server",
    "--model", BASE_CACHE,
    "--port", str(SERVER_PORT),
    "--host", "0.0.0.0",
    "--tensor-parallel-size", "2",          # CRITICAL: span both T4s
    "--gpu-memory-utilization", "0.92",
    "--max-num-seqs", str(MAX_CONCURRENT),
    "--max-model-len", "32768",             # Ultra gets more context
    "--quantization", "awq",
    "--reasoning-parser", "qwen3",
    "--enable-prefix-caching",
    "--enable-lora",                        # Enable LoRA loading
    "--lora-modules", f"titan-ultra={LORA_CACHE}",  # Load your LoRA
    "--disable-log-requests",
    "--served-model-name", "titan-ultra",
]

env = os.environ.copy()
env["CUDA_VISIBLE_DEVICES"] = "0,1"  # Both GPUs

log_file = open("/kaggle/working/ultra_server.log", "w")
proc = subprocess.Popen(cmd, env=env, stdout=log_file, stderr=log_file)
print(f"vLLM Ultra started, PID {proc.pid}")

print("Waiting for Ultra to initialize (3-5 min for 27B model)...")
for attempt in range(40):  # up to ~5 min
    time.sleep(8)
    if proc.poll() is not None:
        # Process died
        with open("/kaggle/working/ultra_server.log") as f:
            print("FATAL - Server died. Log:", f.read()[-3000:])
        raise RuntimeError("vLLM process died during startup")
    try:
        resp = requests.get(f"http://localhost:{SERVER_PORT}/health", timeout=5)
        if resp.status_code == 200:
            print(f"✓ Ultra server healthy after {(attempt+1)*8}s")
            break
    except:
        print(f"  Still loading... ({(attempt+1)*8}s)")
else:
    raise RuntimeError("FATAL: Ultra server did not become healthy in time")
```

### Cell 6 — Tunnel + Structured Output (Ultra)
```python
import subprocess, re, threading, json, time

tunnel_url = None

def get_tunnel():
    global tunnel_url
    cmd = f"cloudflared tunnel --url http://localhost:{SERVER_PORT} --no-autoupdate 2>&1"
    proc = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url_pattern = re.compile(r'https://[a-z0-9\-]+\.trycloudflare\.com')
    for line in proc.stdout:
        match = url_pattern.search(line)
        if match:
            tunnel_url = match.group(0)
            break

t = threading.Thread(target=get_tunnel)
t.start()

deadline = time.time() + 60
while time.time() < deadline:
    if tunnel_url: break
    time.sleep(2)

assert tunnel_url, "FATAL: Could not get tunnel URL"

output = {
    "model": "ultra",
    "model_id": "ZEROLABS1/titan-ultra",
    "engine": "vllm-tp2",
    "status": "ready",
    "endpoints": [
        {
            "gpu": "0+1",
            "port": SERVER_PORT,
            "tunnel_url": tunnel_url,
            "openai_api_url": f"{tunnel_url}/v1",
            "max_concurrent_seqs": MAX_CONCURRENT,
            "thinking_enabled": True,
            "lora_loaded": "titan-ultra"
        }
    ],
    "total_concurrent_capacity": MAX_CONCURRENT,
    "session_started_at": time.time()
}

print("\n\n===ZERO_LABS_OUTPUT_START===")
print(json.dumps(output, indent=2))
print("===ZERO_LABS_OUTPUT_END===\n\n")
```

### Cell 7 — Keep-Alive (same pattern)

---

## KAGGLE SECRETS SETUP (All Notebooks)

Each notebook reads these environment variables from Kaggle Secrets:
- `HF_TOKEN` — Hugging Face token for private model downloads

### Setting Kaggle Secrets
Add via Kaggle UI: Settings → Add-ons → Secrets, or via API:
```bash
kaggle secrets create --name HF_TOKEN --value "hf_your_token_here"
```

In notebooks, access with:
```python
from kaggle_secrets import UserSecretsClient
secrets = UserSecretsClient()
HF_TOKEN = secrets.get_secret("HF_TOKEN")
```

---

## KERNEL METADATA FILES

Create one `kernel-metadata.json` per notebook for API-based pushing:

---

## OUTPUT FORMAT CONTRACT

The orchestrator in Phase 2 will look for these delimiters in kernel output logs:
```
===ZERO_LABS_OUTPUT_START===
{JSON}
===ZERO_LABS_OUTPUT_END===
```

The JSON must always have:
- `model`: `"pro"` | `"ultra"`
- `status`: `"ready"` | `"error"`
- `endpoints[].openai_api_url`: full URL including `/v1`
- `total_concurrent_capacity`: integer
- `session_started_at`: Unix timestamp

If the notebook hits an error before printing output, it must print:
```python
error_output = {"model": "pro", "status": "error", "error": str(e)}
print("===ZERO_LABS_OUTPUT_START===")
print(json.dumps(error_output))
print("===ZERO_LABS_OUTPUT_END===")
```

---

## DELIVERABLES FOR THIS PHASE

1. `pro_notebook.ipynb` — fully working, all 7 cells
2. `ultra_notebook.ipynb` — fully working, all 7 cells
4. `pro-metadata.json`
4. `ultra-metadata.json`
5. `test_notebooks.py` — local test script that validates notebook JSON structure and checks all required cells are present

Each notebook must be a valid `.ipynb` JSON file with proper cell metadata. Test that they parse correctly before marking this phase done.
