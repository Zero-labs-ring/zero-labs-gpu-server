import requests
import json
import time

# Vercel Production Gateway Base URL
VERCEL_BASE_URL = "https://zero-labs-gpu-server.vercel.app"
API_KEY = "zerotech13287"

def check_models():
    """1. List all available models from Vercel"""
    url = f"{VERCEL_BASE_URL}/api/v1/models"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    print("Checking available models at:", url)
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            print("AVAILABLE MODELS:")
            models = r.json().get("data", [])
            for m in models:
                print(f"  • {m['id']} -> {m['name']} ({m.get('description', '')})")
            return True
        else:
            print(f"Failed to list models ({r.status_code}):", r.text)
            return False
    except Exception as e:
        print("Error connecting to models API:", e)
        return False

def test_model_completion(model="pro", prompt="Explain quantum computing in one short sentence.", max_tokens=8192):
    """2. Test live inference response via Vercel proxy"""
    url = f"{VERCEL_BASE_URL}/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.7
    }

    print(f"\nSending completion request to '{model}' model at Vercel (max_tokens={max_tokens})...")
    print(f"Prompt: {prompt!r}\n")

    t0 = time.time()
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=120)
        elapsed = time.time() - t0

        if r.status_code == 200:
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            print(f"SUCCESS! Response received in {elapsed:.2f}s:")
            print("=" * 60)
            print(content)
            print("=" * 60)
            return True
        else:
            print(f"Error ({r.status_code}) in {elapsed:.2f}s:")
            print(r.text)
            return False
    except Exception as e:
        print(f"Request failed: {e}")
        return False

def test_model_streaming(model="pro", prompt="Write a complete Python script to calculate Fibonacci numbers with memoization and benchmarking.", max_tokens=8192):
    """3. Test live SSE streaming response via Vercel proxy"""
    url = f"{VERCEL_BASE_URL}/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "stream": True
    }

    print(f"\nSending streaming request to '{model}' model at Vercel (max_tokens={max_tokens})...")
    t0 = time.time()
    try:
        r = requests.post(url, json=payload, headers=headers, stream=True, timeout=180)
        if r.status_code != 200:
            print(f"Streaming Error ({r.status_code}):", r.text)
            return False

        print("Streaming response:")
        print("-" * 60)
        full_text = ""
        tok_count = 0
        for line in r.iter_lines():
            if not line:
                continue
            line_str = line.decode("utf-8")
            if line_str.startswith("data: "):
                data_part = line_str[6:].strip()
                if data_part == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_part)
                    delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        print(delta, end="", flush=True)
                        full_text += delta
                        tok_count += 1
                except Exception:
                    pass
        elapsed = time.time() - t0
        print("\n" + "-" * 60)
        print(f"Stream finished in {elapsed:.2f}s (~{tok_count} chunks/tokens).")
        return True
    except Exception as e:
        print(f"Streaming request failed: {e}")
        return False

def main():
    print("==================================================")
    print("   ZERO LABS VERCEL PRODUCTION GPU TEST SCRIPT    ")
    print("==================================================\n")

    # Step 1: Check models list endpoint
    check_models()

    # Step 2: Test Pro model streaming
    print("\n--- TEST 1: Titan Pro 9B Model (Streaming 8K tokens ceiling) ---")
    test_model_streaming(model="pro", prompt="Explain the difference between TCP and UDP with examples.")

    # Step 3: Test Ultra model completion
    print("\n--- TEST 2: Titan Ultra 27B Model (Completion) ---")
    test_model_completion(model="ultra", prompt="Briefly summarize why GPUs are faster than CPUs for matrix operations.")

if __name__ == "__main__":
    main()
