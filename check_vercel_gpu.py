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

def test_model_completion(model="pro", prompt="Explain quantum computing in one short sentence."):
    """2. Test live inference response via Vercel proxy"""
    url = f"{VERCEL_BASE_URL}/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 150,
        "temperature": 0.7
    }

    print(f"\nSending completion request to '{model}' model at Vercel...")
    print(f"Prompt: {prompt!r}\n")

    t0 = time.time()
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=45)
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

def main():
    print("==================================================")
    print("   ZERO LABS VERCEL PRODUCTION GPU TEST SCRIPT    ")
    print("==================================================\n")

    # Step 1: Check models list endpoint
    check_models()

    # Step 2: Test Pro model completion
    print("\n--- TEST 1: Titan Pro 9B Model ---")
    test_model_completion(model="pro", prompt="What is the speed of light in vacuum?")

    # Step 3: Test Ultra model completion
    print("\n--- TEST 2: Titan Ultra 27B Model ---")
    test_model_completion(model="ultra", prompt="Briefly summarize why GPUs are faster than CPUs for matrix operations.")

if __name__ == "__main__":
    main()
