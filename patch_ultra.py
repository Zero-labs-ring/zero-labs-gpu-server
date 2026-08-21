import json, os

path = os.path.join(os.path.dirname(__file__), 'notebooks', 'active', 'ultra_notebook.ipynb')
with open(path, 'r', encoding='utf-8') as f:
    nb = json.load(f)

# Cell 5: Model Loading with 128K (131,072) full context window
load_source = [
    "from llama_cpp import Llama\n",
    "\n",
    "USE_GPU = (num_gpus > 0)\n",
    "N_CTX = 131072  # 128K full context window\n",
    "\n",
    "def load_model():\n",
    "    ts = [0.5, 0.5] if num_gpus > 1 else None\n",
    "    attempts = [\n",
    "        {'n_ctx': N_CTX, 'n_gpu_layers': -1, 'tensor_split': ts, 'type_k': 8, 'type_v': 8, 'flash_attn': True, 'desc': 'Dual GPU 50/50 with 128K (131,072) context + Flash Attention + Q8 KV cache'},\n",
    "        {'n_ctx': 65536, 'n_gpu_layers': -1, 'tensor_split': ts, 'type_k': 8, 'type_v': 8, 'flash_attn': True, 'desc': 'Dual GPU 50/50 with 64K (65,536) context'},\n",
    "        {'n_ctx': 32768, 'n_gpu_layers': -1, 'tensor_split': ts, 'type_k': 8, 'type_v': 8, 'flash_attn': True, 'desc': 'Dual GPU 50/50 with 32K (32,768) context'},\n",
    "        {'n_ctx': 16384, 'n_gpu_layers': -1, 'tensor_split': ts, 'desc': 'Dual GPU 50/50 with 16K (16,384) context'},\n",
    "        {'n_ctx': 8192,  'n_gpu_layers': -1, 'tensor_split': ts, 'desc': 'Dual GPU 50/50 with 8K context'},\n",
    "        {'n_ctx': 4096,  'n_gpu_layers': -1, 'tensor_split': ts, 'desc': 'Dual GPU 50/50 with 4K context'}\n",
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
    "            if att.get('type_k') is not None:\n",
    "                kwargs['type_k'] = att['type_k']\n",
    "            if att.get('type_v') is not None:\n",
    "                kwargs['type_v'] = att['type_v']\n",
    "            if att.get('flash_attn') is not None:\n",
    "                kwargs['flash_attn'] = att['flash_attn']\n",
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

# Cell 6: FastAPI with 128K max_tokens
server_source = [
    "import uvicorn, threading, asyncio, time, json, uuid, urllib.request\nfrom fastapi import FastAPI, HTTPException, Request, Depends\nfrom fastapi.middleware.cors import CORSMiddleware\nfrom fastapi.responses import JSONResponse, StreamingResponse\nfrom pydantic import BaseModel\n\n# Metrics tracking\nmetrics = {'requests_served': 0, 'tokens_served': 0, 'start_time': time.time()}\n\ndef check_api_key(request: Request):\n    auth = request.headers.get('authorization', '')\n    x_key = request.headers.get('x-api-key', '')\n    if auth.startswith('Bearer '):\n        token = auth[len('Bearer '):].strip()\n        if token == API_KEY: return\n    if x_key and x_key == API_KEY: return\n    raise HTTPException(401, 'Invalid or missing API key')\n\ndef clean_reply(text):\n    text = (text or '').strip()\n    if '</think>' in text: text = text.split('</think>', 1)[-1].strip()\n    for tok in ['<|im_end|>', '<|endoftext|>', '<|eot|>', '</s>']:\n        if tok in text: text = text.split(tok, 1)[0].strip()\n    return text\n\ndef extract_text(resp):\n    try: return resp['choices'][0].get('message', {}).get('content', '') or resp['choices'][0].get('text', '')\n    except: return ''\n\ndef run_chat_sync(messages, max_tokens=131072, temp=0.7, top_p=0.9):\n    gen_kwargs = dict(max_tokens=max_tokens, temperature=max(temp, 1e-5), top_p=top_p, repeat_penalty=1.15,\n                      stop=['<|im_end|>', '<|endoftext|>', '</s>'])\n    for fmt in ['chatml', None]:\n        try:\n            kwargs = gen_kwargs.copy()\n            if fmt: kwargs['chat_format'] = fmt\n            with model_lock:\n                if fmt:\n                    resp = llm.create_chat_completion(messages=messages, **kwargs)\n                else:\n                    prompt = ''.join([f\"<|im_start|>{m['role']}\\n{m['content']}<|im_end|>\\n\" for m in messages]) + '<|im_start|>assistant\\n'\n                    resp = llm(prompt, echo=False, **kwargs)\n            reply = clean_reply(extract_text(resp))\n            if reply: return reply\n        except Exception:\n            continue\n    return 'Sorry, generation failed.'\n\napp = FastAPI(title='Zero Ultra Server — Titan Ultra API')\napp.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])\n\nclass ChatReq(BaseModel):\n    model: str = 'titan-ultra'\n    messages: list\n    max_tokens: Optional[int] = 131072\n    max_new_tokens: Optional[int] = None\n    temperature: Optional[float] = 0.7\n    top_p: Optional[float] = 0.9\n    stream: Optional[bool] = False\n    stop: Optional[Union[str, List[str]]] = None\n\n@app.get('/health')\ndef health():\n    return {'status': 'ok', 'model': MODEL_NAME, 'engine': 'llama-cpp-python', 'gpu': USE_GPU, 'gpus': num_gpus}\n\n@app.get('/v1/models')\ndef models():\n    return {\n        'object': 'list',\n        'data': [\n            {'id': 'titan-ultra', 'object': 'model', 'owned_by': 'zerolabs'},\n            {'id': 'ultra', 'object': 'model', 'owned_by': 'zerolabs'}\n        ]\n    }\n\n@app.get('/metrics')\ndef get_metrics():\n    return {\n        'model': MODEL_NAME,\n        'uptime_s': round(time.time() - metrics['start_time'], 1),\n        'requests_served': metrics['requests_served'],\n        'tokens_served': metrics['tokens_served']\n    }\n\n@app.post('/v1/chat/completions', dependencies=[Depends(check_api_key)])\nasync def openai_chat_completions(req: ChatReq):\n    msgs = [{'role': m.get('role', 'user'), 'content': str(m.get('content', ''))} if isinstance(m, dict) else {'role': m.role, 'content': str(m.content)} for m in req.messages]\n    req_id = f'chatcmpl-{uuid.uuid4().hex[:12]}'\n    created_ts = int(time.time())\n    requested_tokens = req.max_tokens or req.max_new_tokens or 131072\n    eff_tokens = min(max(int(requested_tokens), 512), 131072)\n    \n    if req.stream:\n        async def event_generator():\n            loop = asyncio.get_running_loop()\n            init_chunk = {\n                'id': req_id, 'object': 'chat.completion.chunk', 'created': created_ts,\n                'model': req.model,\n                'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]\n            }\n            yield f'data: {json.dumps(init_chunk)}\\n\\n'\n            \n            def _gen_sync():\n                with model_lock:\n                    try:\n                        return list(llm.create_chat_completion(\n                            messages=msgs,\n                            max_tokens=eff_tokens,\n                            temperature=max(req.temperature or 0.7, 1e-5),\n                            top_p=req.top_p or 0.9,\n                            stream=True,\n                            stop=req.stop or ['<|im_end|>', '<|endoftext|>', '</s>']\n                        ))\n                    except Exception:\n                        return None\n\n            stream_chunks = await loop.run_in_executor(None, _gen_sync)\n            metrics['requests_served'] += 1\n\n            if stream_chunks is not None:\n                for sc in stream_chunks:\n                    choice = sc.get('choices', [{}])[0]\n                    delta = choice.get('delta', {})\n                    text_delta = delta.get('content', '')\n                    finish = choice.get('finish_reason')\n                    if text_delta:\n                        metrics['tokens_served'] += 1\n                        chunk = {\n                            'id': req_id, 'object': 'chat.completion.chunk', 'created': created_ts,\n                            'model': req.model,\n                            'choices': [{'index': 0, 'delta': {'content': text_delta}, 'finish_reason': None}]\n                        }\n                        yield f'data: {json.dumps(chunk)}\\n\\n'\n                    if finish:\n                        break\n            else:\n                reply = await loop.run_in_executor(None, lambda: run_chat_sync(msgs, eff_tokens, req.temperature or 0.7, req.top_p or 0.9))\n                words = reply.split(' ')\n                metrics['tokens_served'] += len(words)\n                for i, w in enumerate(words):\n                    chunk_str = w if i == len(words) - 1 else w + ' '\n                    chunk = {\n                        'id': req_id, 'object': 'chat.completion.chunk', 'created': created_ts,\n                        'model': req.model,\n                        'choices': [{'index': 0, 'delta': {'content': chunk_str}, 'finish_reason': None}]\n                    }\n                    yield f'data: {json.dumps(chunk)}\\n\\n'\n                    await asyncio.sleep(0.005)\n\n            done_chunk = {\n                'id': req_id, 'object': 'chat.completion.chunk', 'created': created_ts,\n                'model': req.model,\n                'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]\n            }\n            yield f'data: {json.dumps(done_chunk)}\\n\\n'\n            yield 'data: [DONE]\\n\\n'\n\n        return StreamingResponse(\n            event_generator(),\n            media_type='text/event-stream',\n            headers={\n                'Cache-Control': 'no-cache, no-transform',\n                'Connection': 'keep-alive',\n                'X-Accel-Buffering': 'no'\n            }\n        )\n    else:\n        loop = asyncio.get_running_loop()\n        reply = await loop.run_in_executor(None, lambda: run_chat_sync(msgs, eff_tokens, req.temperature or 0.7, req.top_p or 0.9))\n        metrics['requests_served'] += 1\n        metrics['tokens_served'] += len(reply.split())\n        return {\n            'id': req_id, 'object': 'chat.completion', 'created': created_ts, 'model': req.model,\n            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'}],\n            'usage': {'prompt_tokens': 0, 'completion_tokens': len(reply.split()), 'total_tokens': len(reply.split())}\n        }\n\n@app.post('/chat')\ndef chat_legacy(req: ChatReq):\n    msgs = [{'role': m.get('role', 'user'), 'content': str(m.get('content', ''))} if isinstance(m, dict) else {'role': m.role, 'content': str(m.content)} for m in req.messages]\n    reply = run_chat_sync(msgs, req.max_tokens or 131072, req.temperature or 0.7, req.top_p or 0.9)\n    return {'reply': reply}\n\nPORT = 8000\ndef serve():\n    config = uvicorn.Config(app, host='0.0.0.0', port=PORT, log_level='info', workers=1,\n                           timeout_keep_alive=120, timeout_graceful_shutdown=10)\n    server = uvicorn.Server(config)\n    server.run()\n\nthreading.Thread(target=serve, daemon=True).start()\nprint(f'Server thread launched on port {PORT}')\n\n# Verify local server UP before proceeding\nserver_ready = False\nfor _ in range(30):\n    try:\n        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=3) as r:\n            if r.status == 200:\n                print(f'✅ Server UP at http://127.0.0.1:{PORT}/health: {r.read().decode()}')\n                server_ready = True\n                break\n    except Exception:\n        time.sleep(1)\n\nif not server_ready:\n    print('❌ Warning: FastAPI server failed to respond on port', PORT)\n"
]

nb['cells'][5]['source'] = load_source
nb['cells'][6]['source'] = server_source

with open(path, 'w', encoding='utf-8') as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)

print("Successfully updated notebooks/active/ultra_notebook.ipynb with 128K max_tokens!")

