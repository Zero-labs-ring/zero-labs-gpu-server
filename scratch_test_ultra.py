import urllib.request
import json
import time

GPU_SERVER_URL = "http://localhost:3000"

def test_ultra():
    print("\n--- 1. Testing Live Endpoints for Ultra ---")
    req = urllib.request.Request(f"{GPU_SERVER_URL}/api/endpoints")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print("Endpoints Data:", json.dumps(data, indent=2))
            ultra_urls = data.get('ultra', [])
            is_healthy = data.get('healthy', {}).get('ultra', False)
            print(f"Ultra URLs: {ultra_urls}")
            print(f"Ultra Healthy: {is_healthy}")
    except urllib.error.HTTPError as e:
        print(f"Endpoints HTTP Error {e.code}: {e.read().decode('utf-8')}")
        return
        
    print("\n--- 2. Testing Chat Completion with Titan Ultra ---")
    chat_payload = {
        "model": "titan-ultra",
        "messages": [
            {"role": "user", "content": "Explain binary search in 2 short sentences."}
        ],
        "max_tokens": 128,
        "temperature": 0.7,
        "stream": False
    }
    req2 = urllib.request.Request(
        f"{GPU_SERVER_URL}/api/v1/chat/completions",
        data=json.dumps(chat_payload).encode('utf-8'),
        headers={"Content-Type": "application/json", "Authorization": "Bearer zerotech13287"}
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(req2, timeout=30) as resp2:
            body = resp2.read().decode('utf-8')
            res = json.loads(body)
            print(f"Status: {resp2.status} OK (in {time.time()-t0:.2f}s)")
            print("Response:", json.dumps(res, indent=2))
            reply = res.get('choices', [{}])[0].get('message', {}).get('content', '')
            print(f"\n✅ Titan Ultra Output:\n{reply}")
    except Exception as e:
        print(f"Ultra Chat Test Error: {e}")

if __name__ == "__main__":
    test_ultra()
