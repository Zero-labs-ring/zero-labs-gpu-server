import json, os

path = r'c:\Users\rohit\Downloads\zero-gpu-server\notebooks\active\ultra_notebook.ipynb'
with open(path, 'r', encoding='utf-8') as f:
    nb = json.load(f)

# Cell 3: Dependencies
dep_source = [
    "print('[1/3] Installing FastAPI, Uvicorn, SSE-Starlette, HuggingFace Hub...')\n",
    "run('pip install -q --upgrade \"fastapi>=0.110\" \"uvicorn>=0.29\" \"pydantic>=2.6\" \"sse-starlette>=1.8\" \"huggingface_hub==0.25.2\" \"httpx>=0.27\"', check=True)\n",
    "\n",
    "print('[2/3] Installing llama-cpp-python with CUDA acceleration...')\n",
    "res = run('pip install -q llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124')\n",
    "if 'Successfully' not in res:\n",
    "    res = run('pip install -q llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu122')\n",
    "if 'Successfully' not in res:\n",
    "    res = run('pip install -q llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121')\n",
    "if 'Successfully' not in res:\n",
    "    print('Fallback: Building llama-cpp-python with CUDA support...')\n",
    "    run('CMAKE_ARGS=\"-DGGML_CUDA=on\" pip install -q llama-cpp-python --no-cache-dir')\n",
    "\n",
    "print('[3/3] Installing cloudflared...')\n",
    "run('wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared')\n",
    "\n",
    "import fastapi, uvicorn\n",
    "print(f'✅ Dependencies ready: fastapi={fastapi.__version__}, uvicorn={uvicorn.__version__}')\n"
]

# Cell 5: Model Loading
load_source = [
    "from llama_cpp import Llama\n",
    "\n",
    "USE_GPU = (num_gpus > 0)\n",
    "N_CTX = 4096\n",
    "\n",
    "def load_model():\n",
    "    ts = [0.5, 0.5] if num_gpus > 1 else None\n",
    "    attempts = [\n",
    "        {'n_ctx': N_CTX, 'n_gpu_layers': -1, 'tensor_split': ts, 'desc': f'Dual GPU tensor split 50/50 (n_ctx={N_CTX})'},\n",
    "        {'n_ctx': 2048,  'n_gpu_layers': -1, 'tensor_split': ts, 'desc': f'Dual GPU tensor split 50/50 (n_ctx=2048)'},\n",
    "        {'n_ctx': N_CTX, 'n_gpu_layers': 35, 'tensor_split': ts, 'desc': f'Partial offload 35 layers (tensor_split={ts})'},\n",
    "        {'n_ctx': 2048,  'n_gpu_layers': 25, 'tensor_split': ts, 'desc': 'Partial offload 25 layers'}\n",
    "    ]\n",
    "    for i, att in enumerate(attempts):\n",
    "        try:\n",
    "            print(f'Loading Attempt {i+1} ({att[\"desc\"]}): n_ctx={att[\"n_ctx\"]}, gpu_layers={att[\"n_gpu_layers\"]}...')\n",
    "            kwargs = {\n",
    "                'model_path': MODEL_PATH,\n",
    "                'n_ctx': att['n_ctx'],\n",
    "                'n_batch': 512,\n",
    "                'n_gpu_layers': att['n_gpu_layers'],\n",
    "                'n_threads': os.cpu_count() or 4,\n",
    "                'verbose': False\n",
    "            }\n",
    "            if att.get('tensor_split') is not None:\n",
    "                kwargs['tensor_split'] = att['tensor_split']\n",
    "            model = Llama(**kwargs)\n",
    "            return model\n",
    "        except Exception as e:\n",
    "            print(f'Attempt {i+1} failed: {e}')\n",
    "    raise RuntimeError('All model loading attempts failed.')\n",
    "\n",
    "print('Loading Titan Ultra into memory...')\n",
    "llm = load_model()\n",
    "model_lock = threading.Lock()\n",
    "\n",
    "# Sanity Generation Test\n",
    "print('Running sanity test inference...')\n",
    "test_out = llm('Hello! Answer in 1 short sentence:', max_tokens=32, temperature=0.7)\n",
    "print('✅ Sanity Output:', test_out['choices'][0]['text'].strip())\n",
    "print(f'✅ {MODEL_NAME} loaded and validated successfully!')\n"
]

nb['cells'][3]['source'] = dep_source
nb['cells'][5]['source'] = load_source

with open(path, 'w', encoding='utf-8') as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)

print("Successfully updated notebooks/active/ultra_notebook.ipynb with dual GPU tensor_split and CUDA wheel fallbacks!")
