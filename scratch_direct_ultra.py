import urllib.request
import json
import time

DIRECT_URL = "https://plaza-structure-richards-replacing.trycloudflare.com"

def test_direct_ultra():
    print(f"\n--- Testing Direct Ultra Node at {DIRECT_URL} ---")
    
    # Check Health
    try:
        with urllib.request.urlopen(f"{DIRECT_URL}/health", timeout=10) as r:
            print("Health:", r.read().decode())
    except Exception as e:
        print(f"Health check error: {e}")

    # Check Models
    try:
        with urllib.request.urlopen(f"{DIRECT_URL}/v1/models", timeout=10) as r:
            print("Models:", r.read().decode())
    except Exception as e:
        print(f"Models check error: {e}")

    # Test Chat Completion
    chat_payload = {
        "model": "titan-ultra",
        "messages": [
            {"role": "user", "content": "What is 2 + 2? Reply with just the number."}
        ],
        "max_tokens": 16,
        "temperature": 0.1,
        "stream": False
    }
    req = urllib.request.Request(
        f"{DIRECT_URL}/v1/chat/completions",
        data=json.dumps(chat_payload).encode('utf-8'),
        headers={"Content-Type": "application/json", "Authorization": "Bearer zerotech13287"}
    )
    try:
        t0 = time.time()
        print("Sending chat completion request (streaming=False)...")
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode('utf-8')
            res = json.loads(body)
            print(f"Status: {resp.status} OK (in {time.time()-t0:.2f}s)")
            print("Response:", json.dumps(res, indent=2))
            reply = res.get('choices', [{}])[0].get('message', {}).get('content', '')
            print(f"\n✅ Titan Ultra Direct Output:\n{reply}")
    except Exception as e:
        print(f"Direct Chat Completion Error: {e}")

if __name__ == "__main__":
    test_direct_ultra()
